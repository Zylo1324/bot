// Importaciones principales y dependencias del bot de WhatsApp
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

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
        await sendTextHuman(sock, from, 'Modo comandos. Escribe /cmds', 1600);
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
    }
  });
};

// Punto de entrada principal del script
startBot().catch((error) => {
  console.error('No fue posible iniciar el bot:', error);
});
