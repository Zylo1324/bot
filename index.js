
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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { askLLM, resetChatMemory } from './lib/groq.js';

const REQUIRED_ENV = ['GROQ_API_KEY'];
const AUTH_FOLDER = './auth_state';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVICES_IMAGE_PATH = join(__dirname, 'assets', 'Servicios.jpg');
const IMAGE_COOLDOWN_MS = 5 * 60_000;
const SERVICE_KEYWORDS = [
  'servicio',
  'servicios',
  'plan',
  'planes',
  'catálogo',
  'catalogo',
  'ofertas',
  'ofreces',
  'ofrecen',
  'quiero adquirir',
  'quiero un servicio',
  'quiero contratar',
  'muéstrame los servicios',
  'muestrame los servicios',
  'mostrar servicios',
  'que tienen',
  'qué tienen',
  'que opciones',
  'qué opciones'
];

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
const lastServiceImageSent = new Map(); // chatId -> timestamp

const COMMAND_PATTERNS = {
  reset: /^\s*\/reset\b/i,
  ping: /^\s*\/ping\b/i
};

function toMarkdownBlocks(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return '';

  const collapsedBold = normalized.replace(/\*{4,}/g, '**').replace(/_{4,}/g, '__');
  const noDuplicateSpaces = collapsedBold.replace(/[ \t]{2,}/g, ' ');
  return noDuplicateSpaces;
}

function enforceWordLimit(text, limit = 30) {
  if (!text) return text;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length <= limit) return text;
  let trimmed = tokens.slice(0, limit).join(' ');
  const boldMarkers = (trimmed.match(/\*\*/g) || []).length;
  if (boldMarkers % 2 !== 0) {
    trimmed += '**';
  }
  const italicMarkers = (trimmed.match(/_/g) || []).length;
  if (italicMarkers % 2 !== 0) {
    trimmed += '_';
  }
  const strikeMarkers = (trimmed.match(/~/g) || []).length;
  if (strikeMarkers % 2 !== 0) {
    trimmed += '~';
  }
  return trimmed;
}

function shouldSendServicesImage(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return false;
  }

  const combined = texts.join(' ').toLowerCase();
  if (!combined) return false;

  return SERVICE_KEYWORDS.some((keyword) => combined.includes(keyword));
}

async function maybeSendServicesImage(sock, chatId, texts) {
  if (!shouldSendServicesImage(texts)) {
    return;
  }

  const now = Date.now();
  const lastSent = lastServiceImageSent.get(chatId) || 0;
  if (now - lastSent < IMAGE_COOLDOWN_MS) {
    return;
  }

  await sock
    .sendMessage(chatId, {
      image: { url: SERVICES_IMAGE_PATH },
      caption: 'Te envío las opciones 😊 ¿Cuál deseas?'
    })
    .catch((error) => {
      console.error('No se pudo enviar la imagen de servicios:', error);
    });

  lastServiceImageSent.set(chatId, now);
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
      lastServiceImageSent.delete(chatId);
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
    const userText = effectiveTexts
      .map((entry, index) => `• (${index + 1}) ${entry}`)
      .join('\n');

    await maybeSendServicesImage(sock, chatId, effectiveTexts);

    await sock.presenceSubscribe?.(chatId).catch(() => {});
    await sock.sendPresenceUpdate?.('composing', chatId).catch(() => {});
    const systemPrompt = `
Eres el asistente de ventas oficial de SUPER ZYLO.

Reglas estrictas:
- Responde en español natural, máximo 30 palabras por mensaje, con tono amable, claro y persuasivo usando 1 o 2 emojis.
- Une todos los mensajes recientes del cliente y responde en un único bloque.
- Emplea Markdown simple; usa **negritas** solo cuando aporte claridad.
- Si detectas frases como "quiero un servicio", "quiero adquirir" o "muéstrame los servicios", confirma que enviaste la imagen Servicios.jpg con el texto "Te envío las opciones 😊 ¿Cuál deseas?" y vuelve a preguntar qué desea.
- Al mencionar un servicio específico, describe únicamente ese servicio (precio y beneficios) y cierra invitando al pago seguro.
- Nunca enumeres servicios separados por comas ni listes más de tres; cada servicio debe ir en su propia línea.
- Si piden detalles de planes, explica: "Cuentas completas: privadas, multi-dispositivo.", "Cuentas compartidas: 4–5 personas, un dispositivo.", "Perfiles: premium, no cuenta completa." y motiva la compra.
- Resalta entrega en 5-10 minutos y garantía mensual cuando avances al cierre.
- Acepta pagos por Yape 942632719 (Jair), Plin, PayPal, Binance o transferencia; solicita captura del pago más el servicio elegido antes de entregar.
- Redirige con empatía cualquier tema ajeno preguntando qué servicio desea adquirir hoy.
- Evita tecnicismos y mantén foco total en guiar al cliente hacia la compra.
    `.trim();

    const modelReply = await askLLM(
      `Mensaje(s) del cliente:\n${userText}`,
      {
        systemPrompt,
        chatId
      }
    );

    const reply = enforceWordLimit(toMarkdownBlocks(modelReply));

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
