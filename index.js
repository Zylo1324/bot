import 'dotenv/config';
import process from 'node:process';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

import { askLLM, resetChatMemory, hasChatHistory } from './lib/groq.js';

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
const MESSAGE_INACTIVITY_TIMEOUT_MS = 7_000;

const RAW_INTENT_KEYWORDS = process.env.INTENT_KEYWORDS
  ? process.env.INTENT_KEYWORDS.split(',')
  : [
      'precio',
      'cuenta',
      'comprar',
      'pago',
      'servicio',
      'activar',
      'chatgpt',
      'canva',
      'premium',
      'confirmar',
      'catálogo',
      'catalogo'
    ];
const INTENT_KEYWORDS = RAW_INTENT_KEYWORDS.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);
const INTENT_PROMPTS = [
  '¿Qué servicio deseas confirmar?',
  '¿Te paso el método de pago?'
];
const SERVICE_MARKERS = ['servicio', 'servicios', 'cuenta', 'cuentas', 'plan', 'planes', 'activar', 'catálogo'];
const AVAILABLE_SERVICES = new Set(
  (process.env.AVAILABLE_SERVICES || '')
    .split(',')
    .map((service) => service.trim().toLowerCase())
    .filter(Boolean)
);

const processedMessageIds = new Set();
const lastSentAt = new Map();
const rateLimitWindow = new Map();
const rateLimitWarnedAt = new Map();
const pendingMessages = new Map(); // key -> { chatId, senderId, messages: [{ text, messageTimestamp }], timer, sock }
const intentTracking = new Map(); // chatId -> { noIntentCount, promptIndex }
const greetedChats = new Set();

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

async function deliverResponse(sock, jid, text, { skipGreeting = false } = {}) {
  if (!text) return;

  const trimmed = text.trim();
  if (!trimmed) return;

  let outgoing = trimmed;
  if (!skipGreeting && !hasChatHistory(jid) && !greetedChats.has(jid)) {
    outgoing = `Hola 👋\n${outgoing}`;
    greetedChats.add(jid);
  } else if (!skipGreeting && !greetedChats.has(jid)) {
    greetedChats.add(jid);
  }

  await sendMessageWithGap(sock, jid, outgoing);
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
  await deliverResponse(sock, chatId, RATE_LIMIT_REPLY, { skipGreeting: true });
}

async function handleCommand({ sock, chatId, command, messageTimestamp }) {
  if (command === '/ping') {
    const messageMs = Number(messageTimestamp || 0) * 1000;
    const latency = messageMs ? Math.max(0, Date.now() - messageMs) : 0;
    const reply = latency ? `pong 🏓 (${latency} ms)` : 'pong 🏓';
    await deliverResponse(sock, chatId, reply, { skipGreeting: true });
    markRateLimit(chatId);
    return;
  }

  if (command === '/reset') {
    resetChatMemory(chatId);
    greetedChats.delete(chatId);
    for (const [key, entry] of pendingMessages.entries()) {
      if (entry.chatId !== chatId) continue;
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      pendingMessages.delete(key);
    }
    intentTracking.delete(chatId);
    await deliverResponse(sock, chatId, 'Memoria del chat reiniciada.', { skipGreeting: true });
    markRateLimit(chatId);
    return;
  }

  await deliverResponse(sock, chatId, 'Comando no reconocido. Usa /ping o /reset.', { skipGreeting: true });
  markRateLimit(chatId);
}

function buildPendingKey(chatId, senderId) {
  return `${chatId}::${senderId || chatId}`;
}

function queuePendingMessage({ chatId, senderId, text, messageTimestamp, sock }) {
  if (!text) return;

  const normalizedSender = senderId || chatId;
  const key = buildPendingKey(chatId, normalizedSender);
  for (const [existingKey, pending] of [...pendingMessages.entries()]) {
    if (pending.chatId !== chatId) continue;
    if (pending.senderId === normalizedSender) continue;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pendingMessages.delete(existingKey);
    void processPendingMessages(existingKey, pending);
  }
  const entry = pendingMessages.get(key) || {
    chatId,
    senderId: normalizedSender,
    messages: [],
    timer: null,
    sock
  };

  entry.chatId = chatId;
  entry.senderId = normalizedSender;
  entry.messages.push({ text, messageTimestamp });
  entry.sock = sock;

  if (entry.timer) {
    clearTimeout(entry.timer);
  }

  entry.timer = setTimeout(() => {
    entry.timer = null;
    void processPendingMessages(key);
  }, MESSAGE_INACTIVITY_TIMEOUT_MS);
  entry.timer.unref?.();

  pendingMessages.set(key, entry);
}

function findUnknownServices(lowerText) {
  const unknownServices = new Set();
  const servicePattern = /(?:servicio|cuenta|plan|activar|catálogo)\s+(?:de\s+)?([a-z0-9ñáéíóúü ._-]{2,40})/giu;
  let match;
  while ((match = servicePattern.exec(lowerText)) !== null) {
    const rawCandidate = match[1];
    const candidate = rawCandidate.replace(/[^a-z0-9ñáéíóúü ]+/giu, ' ').trim();
    if (!candidate) continue;
    const normalized = candidate.replace(/\s+/g, ' ').trim();
    const isKnown = [...AVAILABLE_SERVICES].some((service) => {
      if (!service) return false;
      return normalized.includes(service) || service.includes(normalized);
    });
    if (!isKnown) {
      unknownServices.add(normalized);
    }
  }
  return [...unknownServices];
}

async function processPendingMessages(key, entryOverride) {
  const entry = entryOverride ?? pendingMessages.get(key);
  if (!entry) return;

  if (!entryOverride) {
    pendingMessages.delete(key);
  } else if (pendingMessages.get(key) === entry) {
    pendingMessages.delete(key);
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
  }

  const { chatId, messages, sock } = entry;
  if (!sock || !messages.length) return;

  const combinedText = messages
    .map(({ text }) => text)
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!combinedText) return;

  const lower = combinedText.toLowerCase();

  if (isRateLimited(chatId)) {
    await maybeWarnRateLimit(sock, chatId);
    const last = rateLimitWindow.get(chatId) || 0;
    const elapsed = Date.now() - last;
    const wait = Math.max(250, RATE_LIMIT_WINDOW_MS - elapsed);
    pendingMessages.set(key, entry);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void processPendingMessages(key);
    }, wait);
    entry.timer.unref?.();
    return;
  }

  const containsIntent = INTENT_KEYWORDS.some((keyword) => lower.includes(keyword));
  const state = intentTracking.get(chatId) || { noIntentCount: 0, promptIndex: 0 };

  if (containsIntent) {
    state.noIntentCount = 0;
  } else {
    state.noIntentCount += 1;
  }

  intentTracking.set(chatId, state);

  const mentionsServiceKeyword = SERVICE_MARKERS.some((marker) => lower.includes(marker));
  const unknownServices = mentionsServiceKeyword && AVAILABLE_SERVICES.size > 0 ? findUnknownServices(lower) : [];

  if (unknownServices.length > 0) {
    state.noIntentCount = 0;
    const prompt =
      'No tengo ese servicio en la lista. Cuéntame cuál necesitas y reviso si puedo conseguirlo, sin prometerlo todavía.';
    await deliverResponse(sock, chatId, prompt);
    markRateLimit(chatId);
    return;
  }

  if (!containsIntent && state.noIntentCount >= 2) {
    const prompt = INTENT_PROMPTS[state.promptIndex % INTENT_PROMPTS.length];
    state.promptIndex = (state.promptIndex + 1) % INTENT_PROMPTS.length;
    state.noIntentCount = 0;
    await deliverResponse(sock, chatId, prompt);
    markRateLimit(chatId);
    return;
  }

  markRateLimit(chatId);

  const stopTyping = startTypingIndicator(sock, chatId);
  try {
    const reply = await askLLM(combinedText, { systemPrompt: SYSTEM_PROMPT, chatId });
    await deliverResponse(sock, chatId, reply);
  } catch (error) {
    console.error('Error al consultar Groq:', error);
    await deliverResponse(sock, chatId, FALLBACK_REPLY);
  } finally {
    await stopTyping();
    markRateLimit(chatId);
  }
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
    await handleCommand({ sock, chatId, command: lower.split(/\s+/)[0], messageTimestamp });
    return;
  }

  const senderId = key.participant || chatId;
  queuePendingMessage({ chatId, senderId, text, messageTimestamp, sock });
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
