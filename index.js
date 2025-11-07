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
import { loadInstructions } from './lib/instructionManager.js';
import { detectService, wantsCatalog } from './lib/intents.js';
import { limitWords, verticalize } from './lib/guardrails.js';

const INSTRUCTIONS = loadInstructions('./config/SUPER_ZYLO_INSTRUCTIONS_VENTAS.md');
console.log('[prompts] Cargado SUPER_ZYLO_INSTRUCTIONS_VENTAS.md:', INSTRUCTIONS.slice(0, 120), '…');

const REQUIRED_ENV = ['GROQ_API_KEY'];
const AUTH_FOLDER = './auth_state';

const conversationState = new Map(); // chatId -> { greetedByName: boolean, askedName: boolean }

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

function deriveFallbackName(message) {
  const explicitName = message?.message?.contactMessage?.displayName?.trim();
  if (explicitName) return explicitName;

  const pn = message?.pushName?.trim();
  if (pn) return pn;

  const jid = message?.key?.participant || message?.key?.remoteJid || '';
  const phone = jid.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') || '';
  return phone.length >= 6 ? phone : null;
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
    const joinedText = effectiveTexts.join('\n').trim();
    const userText = joinedText || effectiveTexts.join('\n');

    const ctx = message || {};
    const fallbackName = deriveFallbackName(message);
    const customerName =
      ctx?.user?.name ||
      ctx?.from?.name ||
      ctx?.profileName ||
      ctx?.waName ||
      ctx?.metadata?.name ||
      fallbackName ||
      null;

    const state = conversationState.get(chatId) || { greetedByName: false, askedName: false };
    let greetingPrefix = '';

    if (customerName && !state.greetedByName) {
      greetingPrefix = greetByName(customerName);
      state.greetedByName = true;
      state.askedName = true;
    } else if (!customerName && !state.askedName) {
      greetingPrefix = greetByName(null);
      state.askedName = true;
    }

    conversationState.set(chatId, state);

    const messages = buildMessages(userText);

    await sock.presenceSubscribe?.(chatId).catch(() => {});
    await sock.sendPresenceUpdate?.('composing', chatId).catch(() => {});
    const completionText = await askLLM(messages[1].content, {
      systemPrompt: messages[0].content,
      chatId
    });

    const sanitizedReply = toMarkdownBlocks(completionText);
    let combined = sanitizedReply;

    if (greetingPrefix) {
      combined = `${greetingPrefix}\n${combined}`.trim();
    }

    const verticalized = verticalize(combined, 3);
    const limited = limitWords(verticalized.replace(/\n/g, ' __NL__ '), 30);
    const finalReply = toMarkdownBlocks(
      limited.replace(/__NL__/g, '\n').replace(/\s*\n\s*/g, '\n')
    );

    const shouldSendImage = wantsCatalog(userText) && !detectService(userText);

    if (shouldSendImage) {
      await sock.sendMessage(chatId, {
        image: { url: 'assets/Servicios.jpg' },
        caption: finalReply
      });
    } else {
      await sock.sendMessage(chatId, { text: finalReply });
    }
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
