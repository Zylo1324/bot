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

import { askLLM, resetChatMemory } from './lib/groq.js';

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
const queue = new PQueue({ concurrency: 1 });
const burstBuffer = new Map(); // chatId -> { texts: [], timer: NodeJS.Timeout }

const COMMAND_PATTERNS = {
  reset: /^\s*\/reset\b/i,
  ping: /^\s*\/ping\b/i
};

function getName(message) {
  const pn = message?.pushName?.trim();
  if (pn) return pn;
  const jid = message?.key?.participant || message?.key?.remoteJid || '';
  const phone = jid.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') || 'amigo';
  return phone.length >= 6 ? phone : 'amigo';
}

function toMarkdownBlocks(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return '';

  const collapsedBold = normalized.replace(/\*{4,}/g, '**').replace(/_{4,}/g, '__');
  const noDuplicateSpaces = collapsedBold.replace(/[ \t]{2,}/g, ' ');
  return noDuplicateSpaces;
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
  }, 450);
  item.timer.unref?.();
  burstBuffer.set(from, item);
}

async function handleCommands(sock, chatId, rawTexts) {
  const trimmed = rawTexts.map((text) => text.trim()).filter(Boolean);
  const remaining = [];
  let handled = false;

  for (const text of trimmed) {
    if (COMMAND_PATTERNS.reset.test(text)) {
      handled = true;
      resetChatMemory(chatId);
      await sock.sendMessage(chatId, {
        text: 'Memoria del chat reiniciada. Cuéntame qué servicio necesitas y lo cerramos rápido ✅'
      });
      continue;
    }

    if (COMMAND_PATTERNS.ping.test(text)) {
      handled = true;
      await sock.sendMessage(chatId, { text: 'Pong 🏓 listo para ayudarte con tu compra.' });
      continue;
    }

    remaining.push(text);
  }

  return { handled, remaining };
}

async function processBundle(sock, chatId, message, texts) {
  try {
    const { handled, remaining } = await handleCommands(sock, chatId, texts);
    if (handled && remaining.length === 0) {
      return;
    }

    const effectiveTexts = remaining.length > 0 ? remaining : texts;
    const name = getName(message);
    const userText = effectiveTexts
      .map((entry, index) => `• (${index + 1}) ${entry}`)
      .join('\n');

    await sock.presenceSubscribe?.(chatId).catch(() => {});
    await sock.sendPresenceUpdate?.('composing', chatId).catch(() => {});
    const systemPrompt = `
Eres asesor de ventas senior de Super Zylo. Tu objetivo es descubrir la intención real del cliente y llevarlo rápido a concretar la compra.

Instrucciones clave:
- Prioriza entender el contexto del mensaje. Si solo saluda o es ambiguo, responde con una pregunta breve que lo acerque a elegir un servicio.
- Usa Markdown válido para WhatsApp: negritas con **texto** y blockquotes con '>'. Jamás dupliques las marcas de negrita.
- Incorpora emojis contextuales (máximo 2 por bloque o párrafo) y nunca los repitas al inicio de cada línea.
- Menciona a ${name} una única vez y solo si ayuda a personalizar. No inventes nombres.
- Presenta el catálogo en microsecciones tipo *- Categoría:* seguidas de líneas en blockquote con el beneficio y precio. Elige solo lo relevante a la consulta.
- Sé persuasivo y directo, enfocándote en cerrar: ofrece siguientes pasos o método de pago Yape 942632719 (Jair) cuando detectes interés.
- Si surgen dudas técnicas, respóndelas con precisión y enlázalas con una propuesta de compra.
- No inventes datos ni promociones inexistentes. Si no tienes información, ofrece verificar antes de cerrar la venta.

Catálogo de referencia (resume solo lo oportuno):
- Entretenimiento: Disney+ Premium + ESPN (perfil S/5), HBO Max (perfil S/5), Prime Video (perfil S/4).
- Productividad: ChatGPT Plus (compartida S/10, completa S/20 con Canva), Perplexity (cuenta), Canva Pro, CapCut Pro.
- Otros: YouTube Premium + Music (correo), Gemini + Veo 3 (cuenta anual), Turnitin, DirecTV (activación), Luna (juegos), Grupo VIP (S/20).

Política de cierre:
- Luego de resolver la duda, invita a confirmar preguntando «¿Lo confirmamos ahora?» u otra variante y menciona el pago por Yape con captura.
- Cuando el cliente se muestra indeciso, ofrece 2 o 3 opciones concretas y pregunta cuál prefiere.

Responde siempre en español con bloques cortos y claros.
    `.trim();

    const modelReply = await askLLM(
      `Mensaje(s) del cliente:\n${userText}`,
      {
        systemPrompt,
        chatId
      }
    );

    const reply = toMarkdownBlocks(modelReply);

    await sock.sendMessage(chatId, { text: reply });
    await sock.sendPresenceUpdate?.('paused', chatId).catch(() => {});
  } catch (error) {
    console.error('handler error:', error);
    await sock.sendMessage(chatId, {
      text: 'Hubo un detalle técnico. Intentemos de nuevo en un momento ⚙️'
    });
    await sock.sendPresenceUpdate?.('paused', chatId).catch(() => {});
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
