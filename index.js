import 'dotenv/config';
import process from 'node:process';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import PQueue from 'p-queue';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

import { askLLM, resetChatMemory } from './lib/groq.js';
import { loadInstructions } from './lib/instructionManager.js';
import { detectService, wantsCatalog } from './lib/intents.js';
import { limitWords, verticalize } from './lib/guardrails.js';

const INSTRUCTIONS = loadInstructions('./config/SUPER_ZYLO_INSTRUCTIONS_VENTAS.md');
console.log('[prompts] Cargado SUPER_ZYLO_INSTRUCTIONS_VENTAS.md:', INSTRUCTIONS.slice(0, 120), '…');

const REQUIRED_ENV = ['GROQ_API_KEY'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SESSION_FOLDER = process.env.SESSION_FOLDER || join(__dirname, 'bot_sessions');
const SERVICES_IMAGE_PATH = join(__dirname, 'assets', 'Servicios.jpg');
const conversationState = new Map(); // chatId -> { askedName: boolean, greetedByName: boolean }

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

function greetByName(name) {
  if (!name) return '¡Hola! 😄 ¿Cómo te llamas? Así puedo ayudarte mejor.';
  return `¡Hola ${name}! 😄 Cuéntame, ¿qué servicio deseas adquirir hoy?`;
}

function buildMessages(userText) {
  return [
    { role: 'system', content: INSTRUCTIONS },
    { role: 'user', content: userText }
  ];
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
      conversationState.delete(chatId);
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

    await sock.presenceSubscribe?.(chatId).catch(() => {});
    await sock.sendPresenceUpdate?.('composing', chatId).catch(() => {});

    const baseContext = message || {};
    const detectedName =
      baseContext?.user?.name ||
      baseContext?.from?.name ||
      baseContext?.profileName ||
      baseContext?.waName ||
      baseContext?.metadata?.name ||
      null;
    const fallbackName = getName(message);
    const resolvedName = detectedName || (fallbackName && fallbackName !== 'amigo' ? fallbackName : null);

    const state = conversationState.get(chatId) || { askedName: false, greetedByName: false };
    const shouldAskName = !resolvedName && !state.askedName;
    const shouldGreetByName = Boolean(resolvedName) && !state.greetedByName;
    const shouldGreet = shouldAskName || shouldGreetByName;
    const greeting = shouldAskName
      ? greetByName(null)
      : shouldGreetByName
        ? greetByName(resolvedName)
        : '';

    const messages = buildMessages(`Mensaje(s) del cliente:\n${userText}`);
    const modelReply = await askLLM(messages[1].content, {
      systemPrompt: messages[0].content,
      chatId
    });

    let combined = shouldGreet ? `${greeting}\n${modelReply}` : modelReply;
    combined = toMarkdownBlocks(combined);
    combined = verticalize(combined, 3);
    combined = limitWords(combined, 30);
    combined = verticalize(combined, 3);

    const shouldSendImage = wantsCatalog(userText) && !detectService(userText);
    const outgoingPayload = shouldSendImage
      ? { image: { url: SERVICES_IMAGE_PATH }, caption: combined }
      : { text: combined };

    await sock.sendMessage(chatId, outgoingPayload);

    conversationState.set(chatId, {
      askedName: state.askedName || shouldAskName,
      greetedByName: state.greetedByName || shouldGreetByName
    });
    await sock.sendPresenceUpdate?.('paused', chatId).catch(() => {});
  } catch (error) {
    console.error('handler error:', error);
    await sock.sendMessage(chatId, {
      text: 'Hubo un detalle técnico. Intentemos de nuevo en un momento ⚙️'
    });
    await sock.sendPresenceUpdate?.('paused', chatId).catch(() => {});
  }
}

async function startWA() {
  if (!existsSync(SESSION_FOLDER)) {
    mkdirSync(SESSION_FOLDER, { recursive: true });
  }
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
  const { version } = await fetchLatestBaileysVersion();
  console.log('🔍 Versión de WhatsApp Web detectada:', Array.isArray(version) ? version.join('.') : version);

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: true,
    browser: ['Windows', 'Chrome', '10'],
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 20_000,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update || {};

    if (connection === 'open') {
      console.log('✅ Conectado correctamente a WhatsApp Web');
      return;
    }

    if (connection === 'close') {
      const error = lastDisconnect?.error;
      const statusCode =
        error instanceof Boom
          ? error.output?.statusCode
          : error?.output?.statusCode ?? lastDisconnect?.error?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        console.log('🚪 Sesión cerrada permanentemente, borra bot_sessions y reescanea.');
        return;
      }

      console.log('⚠️ Conexión cerrada. Reintentando...');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try {
        await startWA();
      } catch (reconnectError) {
        console.error('Error al intentar reconectar:', reconnectError);
      }
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

startWA().catch((error) => {
  console.error('No fue posible iniciar el bot:', error);
});
