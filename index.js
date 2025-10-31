import 'dotenv/config';
import process from 'node:process';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import PQueue from 'p-queue';

import { fastGroq } from './lib/groq.js';

const REQUIRED_ENV = ['GROQ_API_KEY'];
const AUTH_FOLDER = './auth_state';

const missingEnv = REQUIRED_ENV.filter((key) => {
  const value = process.env[key];
  return typeof value !== 'string' || value.trim() === '';
});

if (missingEnv.length > 0) {
  console.error('Faltan variables de entorno requeridas: %s', missingEnv.join(', '));
  process.exit(1);
}

// --- helpers ---
const queue = new PQueue({ concurrency: 3 });
const burstBuffer = new Map(); // chatId -> { texts: [], timer: NodeJS.Timeout }

function getName(message) {
  const pn = message?.pushName?.trim();
  if (pn) return pn;
  const jid = message?.key?.participant || message?.key?.remoteJid || '';
  const phone = jid.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') || 'amigo';
  return phone.length >= 6 ? phone : 'amigo';
}

function toMarkdownBlocks(text) {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function varyPrefix(name) {
  const arr = [
    `¡Genial, *${name}*!`,
    `Hola *${name}* 👋`,
    `Perfecto, *${name}*!`,
    `Encantado, *${name}*!`,
    `Listo, *${name}*!`
  ];
  return arr[Math.floor(Math.random() * arr.length)];
}

function extractTextContent(message = {}) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    ''
  );
}

function bufferMessage(sock, message) {
  const txt = extractTextContent(message?.message);
  const from = message?.key?.remoteJid;
  if (!from || !txt || message?.key?.fromMe || from === 'status@broadcast') {
    return;
  }

  const item = burstBuffer.get(from) || { texts: [], timer: null };
  item.texts.push(txt.trim());
  if (item.timer) clearTimeout(item.timer);
  item.timer = setTimeout(() => {
    const bundle = item.texts.slice();
    burstBuffer.delete(from);
    queue.add(() => processBundle(sock, from, message, bundle));
  }, 900);
  item.timer.unref?.();
  burstBuffer.set(from, item);
}

async function processBundle(sock, chatId, message, texts) {
  try {
    const name = getName(message);
    const userText = texts.join('\n— ');

    const prompt = `
Eres *asesor de ventas* de Super Zylo. Habla en *tono profesional y amable*, directo.
Reglas de estilo:
- Siempre usa *Markdown* (negritas, listas, saltos de línea).
- Usa *emojis sutiles* (máx 2 por párrafo).
- Personaliza con el nombre del cliente si lo tienes: *${name}*.
- No repitas las mismas frases: usa sinónimos y reformula.
- Responde en *párrafos cortos* y *viñetas*.
- Si hacen varias preguntas, *responde todas*.
- Si la consulta no es de ventas, redirígela con elegancia hacia la compra.

Catálogo breve (para referencia; no lo recites completo):
- ChatGPT Plus: compartida (S/10) y completa (S/20, incluye Canva).
- Disney+ Premium + ESPN (perfil).
- HBO Max (perfil). Prime Video (perfil).
- YouTube Premium + Music (a su correo).
- Canva (a su correo). Capcut (cuenta completa).
- Perplexity (cuenta). Gemini + Veo 3 (cuenta 1 año).
- Turnitin (cuenta). DirecTV (activación a TV). Luna (juegos).
- Grupo VIP (S/20).

Política de cierre:
- Tras resolver la duda, ofrece *pago por Yape 942632719 (Jair)* y pide *captura*.
- Si dice “no sé” o divaga, propone 2–3 opciones claras y pregunta *¿cuál te va mejor?*.

Ahora responde *bonito*, con markdown y variación.
Mensaje(s) del cliente:
${userText}
    `.trim();

    const modelReply = await fastGroq(prompt);

    const reply = toMarkdownBlocks(`${varyPrefix(name)}\n\n${modelReply}`);

    await sock.sendMessage(chatId, { text: reply });
  } catch (error) {
    console.error('handler error:', error);
    await sock.sendMessage(chatId, {
      text: 'Hubo un detalle técnico. Intentemos de nuevo en un momento ⚙️'
    });
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Escanea el siguiente código QR para vincular la sesión:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('Bot conectado correctamente.');
      return;
    }

    if (connection === 'close') {
      const error = lastDisconnect?.error;
      const statusCode =
        error && error instanceof Boom ? error.output?.statusCode : lastDisconnect?.error?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        console.log('La sesión se cerró de forma permanente. Elimina auth_state para reautenticar.');
        return;
      }

      if (statusCode === 515) {
        console.log('🌀 Reinicio requerido (515). Esperando 5s antes de reintentar...');
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      } else {
        console.log('⚠️ Desconexión detectada. Reintentando...');
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }

      startBot().catch((err) => console.error('Error al reconectar el bot:', err));
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    if (!Array.isArray(messages)) return;
    for (const message of messages) {
      try {
        bufferMessage(sock, message);
      } catch (error) {
        console.error('Error al bufferizar un mensaje:', error);
      }
    }
  });

  return sock;
}

startBot().catch((error) => {
  console.error('No fue posible iniciar el bot:', error);
});
