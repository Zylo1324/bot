// Importaciones principales y dependencias del bot de WhatsApp
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import OpenAI from 'openai';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ensureEnvLoaded = () => {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!key || rest.length === 0) continue;
    const value = rest.join('=').trim();
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
};

ensureEnvLoaded();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const lastSentAt = new Map(); // jid -> timestamp
const MIN_GAP_MS = 1200; // 1.2s mínimo entre mensajes por chat

async function sendTextHuman(sock, to, body, typingMs = 1500) {
  const now = Date.now();
  const last = lastSentAt.get(to) || 0;
  const wait = Math.max(0, MIN_GAP_MS - (now - last));
  if (wait > 0) await sleep(wait);

  await sock.sendPresenceUpdate('composing', to);
  await sleep(typingMs + jitter(200, 800));
  await sock.sendPresenceUpdate('paused', to);

  await sock.sendMessage(to, { text: body });
  lastSentAt.set(to, Date.now());
}

const handled = new Set(); // anti-duplicados

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL
});

async function responderIA(mensajeCliente) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  if (!process.env.MODEL) {
    throw new Error('MODEL no configurado');
  }

  const completion = await openai.chat.completions.create({
    model: process.env.MODEL,
    messages: [
      {
        role: 'system',
        content:
          'Eres un vendedor experto, amable, empático y convincente. Usas emojis, tono natural y guías al cliente a cerrar la compra. No suenes robótico ni repitas frases.'
      },
      { role: 'user', content: mensajeCliente }
    ]
  });

  const response = completion.choices?.[0]?.message?.content?.trim();
  if (!response) {
    throw new Error('La respuesta del modelo llegó vacía');
  }

  return response;
}

// Definición de constantes globales para configurar el comportamiento del bot
const AUTH_FOLDER = './auth_state';
const COMMAND_PREFIX = '/';

// Utilidad para obtener el texto sin importar el tipo de mensaje recibido
const getMessageText = (message = {}) => {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  return null;
};

// Inicializa la conexión, gestiona el QR y controla los eventos del socket
const startBot = async () => {
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
        console.log('La conexión se cerró. Intentando reconectar automáticamente...');
        startBot();
      } else {
        console.log('La sesión se cerró de forma permanente. Borra la carpeta auth_state para iniciar nuevamente.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages?.[0];
    if (!m || m.key.fromMe) return;

    const from = m.key.remoteJid;
    if (!from || from === 'status@broadcast') return;

    const id = m.key.id;
    if (!id || handled.has(id)) return;
    handled.add(id);
    setTimeout(() => handled.delete(id), 60_000);

    const text = getMessageText(m.message) ?? '';
    if (!text) return;

    const normalized = text.trim();
    if (!normalized) return;

    const lower = normalized.toLowerCase();
    try {
      if (!lower.startsWith(COMMAND_PREFIX)) {
        const contactName = (m.pushName ?? '').trim();
        const messageForModel = contactName
          ? `Cliente ${contactName}: ${normalized}`
          : normalized;
        const reply = await responderIA(messageForModel);
        await sendTextHuman(sock, from, reply, 1800);
        return;
      }

      const cmd = lower.split(/\s+/)[0];

      if (cmd === '/cmds') {
        const menu = [
          'Comandos disponibles:',
          '• /precios',
          '• /soporte',
          '• /info'
        ].join('\n');
        await sendTextHuman(sock, from, menu, 1800);
        return;
      }

      if (cmd === '/precios') {
        await sendTextHuman(sock, from, 'Planes desde $10 (demo).', 1500);
        return;
      }

      if (cmd === '/soporte') {
        await sendTextHuman(sock, from, 'Contacta a soporte. Deja tu mensaje.', 1700);
        return;
      }

      if (cmd === '/info') {
        await sendTextHuman(sock, from, 'Bot con Baileys y Node.js (demo).', 1400);
        return;
      }

      await sendTextHuman(sock, from, 'Comando no reconocido. Usa /cmds', 1600);
    } catch (error) {
      console.error('Error al procesar un mensaje:', error);
      try {
        await sendTextHuman(
          sock,
          from,
          'Lo siento, estoy teniendo inconvenientes técnicos en este momento. ¿Podrías intentar nuevamente en unos instantes?',
          1200
        );
      } catch (sendError) {
        console.error('No se pudo enviar el mensaje de error:', sendError);
      }
    }
  });
};

// Punto de entrada principal del script
startBot().catch((error) => {
  console.error('No fue posible iniciar el bot:', error);
});
