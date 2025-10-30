import 'dotenv/config';
import process from 'node:process';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

import { askLLM, resetChatMemory } from './lib/groq.js';

const REQUIRED_ENV = ['GROQ_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((key) => {
  const value = process.env[key];
  return typeof value !== 'string' || value.trim() === '';
});

if (missingEnv.length > 0) {
  console.error('Faltan variables de entorno requeridas: %s', missingEnv.join(', '));
  process.exit(1);
}

const AUTH_FOLDER = './auth_state';
const COMMAND_PREFIX = '/';
const FALLBACK_REPLY = 'Ahora mismo no puedo responder, inténtalo otra vez.';
const RATE_LIMIT_REPLY = 'Estoy procesando tu mensaje, dame un segundo 🙏';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT?.trim() || 'Eres un asistente útil, amable y preciso. Responde en español.';

const MIN_SEND_GAP_MS = 1_200;
const RATE_LIMIT_WINDOW_MS = 2_000;
const MESSAGE_CACHE_TTL_MS = 5 * 60_000;

const processedMessageIds = new Set();
const lastSentAt = new Map();
const rateLimitWindow = new Map();
const rateLimitWarnedAt = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scheduleMessageCleanup(id) {
  if (!id) return;
  const timeout = setTimeout(() => processedMessageIds.delete(id), MESSAGE_CACHE_TTL_MS);
  timeout.unref?.();
}

function markMessageProcessed(id) {
  if (!id) return;
  processedMessageIds.add(id);
  scheduleMessageCleanup(id);
}

function extractText(message = {}) {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.buttonsResponseMessage?.selectedDisplayText) {
    return message.buttonsResponseMessage.selectedDisplayText;
  }
  if (message.listResponseMessage?.title) {
    return message.listResponseMessage.title;
  }
  return null;
}

async function sendMessageWithGap(sock, jid, text) {
  const now = Date.now();
  const last = lastSentAt.get(jid) || 0;
  const wait = Math.max(0, MIN_SEND_GAP_MS - (now - last));
  if (wait > 0) {
    await sleep(wait);
  }

  await sock.sendMessage(jid, { text });
  lastSentAt.set(jid, Date.now());
}

function startTypingIndicator(sock, jid) {
  let stopped = false;

  const pushTyping = async () => {
    try {
      await sock.sendPresenceUpdate('composing', jid);
    } catch (error) {
      console.warn('No se pudo enviar el indicador de escritura:', error);
    }
  };

  void pushTyping();
  const interval = setInterval(() => {
    if (!stopped) {
      void pushTyping();
    }
  }, 7_000);
  interval.unref?.();

  return async () => {
    stopped = true;
    clearInterval(interval);
    try {
      await sock.sendPresenceUpdate('paused', jid);
    } catch (error) {
      console.warn('No se pudo pausar el indicador de escritura:', error);
    }
  };
}

function isRateLimited(chatId) {
  const last = rateLimitWindow.get(chatId) || 0;
  return Date.now() - last < RATE_LIMIT_WINDOW_MS;
}

function markRateLimit(chatId) {
  rateLimitWindow.set(chatId, Date.now());
}

async function maybeWarnRateLimit(sock, chatId) {
  const now = Date.now();
  const lastWarn = rateLimitWarnedAt.get(chatId) || 0;
  if (now - lastWarn < RATE_LIMIT_WINDOW_MS) return;
  rateLimitWarnedAt.set(chatId, now);
  await sendMessageWithGap(sock, chatId, RATE_LIMIT_REPLY);
}

async function handleCommand({ sock, chatId, command, messageTimestamp }) {
  if (command === '/ping') {
    const messageMs = Number(messageTimestamp || 0) * 1000;
    const latency = messageMs ? Math.max(0, Date.now() - messageMs) : 0;
    const reply = latency ? `pong 🏓 (${latency} ms)` : 'pong 🏓';
    await sendMessageWithGap(sock, chatId, reply);
    return;
  }

  if (command === '/reset') {
    resetChatMemory(chatId);
    await sendMessageWithGap(sock, chatId, 'Memoria del chat reiniciada.');
    return;
  }

  await sendMessageWithGap(sock, chatId, 'Comando no reconocido. Usa /ping o /reset.');
}

async function handleIncomingMessage({ sock, message }) {
  const { key, message: content, messageTimestamp } = message;
  if (!key || key.fromMe) return;

  const chatId = key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return;

  if (processedMessageIds.has(key.id)) return;
  // FIX: Evitamos responder dos veces al mismo mensaje y romper bucles de eco.
  markMessageProcessed(key.id);

  const rawText = extractText(content);
  if (!rawText) return;

  const text = rawText.trim();
  if (!text) return;

  const lower = text.toLowerCase();

  if (lower.startsWith(COMMAND_PREFIX)) {
    markRateLimit(chatId);
    await handleCommand({ sock, chatId, command: lower.split(/\s+/)[0], messageTimestamp });
    return;
  }

  if (isRateLimited(chatId)) {
    await maybeWarnRateLimit(sock, chatId);
    return;
  }

  markRateLimit(chatId);

  const stopTyping = startTypingIndicator(sock, chatId);
  try {
    const reply = await askLLM(text, { systemPrompt: SYSTEM_PROMPT, chatId });
    await sendMessageWithGap(sock, chatId, reply);
  } catch (error) {
    // FIX: Registro centralizado de errores de Groq con fallback amigable.
    console.error('Error al consultar Groq:', error);
    await sendMessageWithGap(sock, chatId, FALLBACK_REPLY);
  } finally {
    await stopTyping();
    markRateLimit(chatId);
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

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Escanea el siguiente código QR para vincular la sesión:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('Bot conectado correctamente.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('La conexión se cerró. Intentando reconectar...');
        setTimeout(() => {
          startBot().catch((error) => console.error('Error al reconectar el bot:', error));
        }, 2_000).unref?.();
      } else {
        console.log('La sesión se cerró de forma permanente. Elimina auth_state para reautenticar.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const [message] = messages || [];
    if (!message) return;

    try {
      await handleIncomingMessage({ sock, message });
    } catch (error) {
      console.error('Error no controlado al procesar un mensaje:', error);
    }
  });

  return sock;
}

startBot().catch((error) => {
  console.error('No fue posible iniciar el bot:', error);
});
