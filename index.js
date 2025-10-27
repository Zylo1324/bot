// Importaciones principales y dependencias del bot de WhatsApp
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

// Definición de constantes globales para configurar el comportamiento del bot
const AUTH_FOLDER = './auth_state';
const COMMAND_PREFIX = '/';

// Tabla de respuestas disponibles para cada comando soportado
const COMMAND_RESPONSES = {
  '/cmds': `Comandos disponibles:\n/cmds - Lista de comandos\n/precios - Información de planes\n/soporte - Contactar soporte\n/info - Información del bot`,
  '/precios': 'Planes desde $10',
  '/soporte': 'Contacta al soporte técnico',
  '/info': 'Soy un bot hecho con Baileys y Node.js'
};

// Utilidad para obtener el texto sin importar el tipo de mensaje recibido
const getMessageText = (message = {}) => {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  return null;
};

// Responde a los mensajes entrantes en función del comando detectado
const handleIncomingMessage = async (sock, msg) => {
  const text = getMessageText(msg.message);
  if (!text || msg.key.fromMe) return;

  const normalizedText = text.trim();
  const chatId = msg.key.remoteJid;

  if (!normalizedText.startsWith(COMMAND_PREFIX)) {
    await sock.sendMessage(chatId, { text: 'Modo comandos. Escribe /cmds' });
    return;
  }

  const command = normalizedText.toLowerCase();
  const response = COMMAND_RESPONSES[command];

  if (response) {
    await sock.sendMessage(chatId, { text: response });
  } else {
    await sock.sendMessage(chatId, { text: 'Comando no reconocido. Escribe /cmds' });
  }
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
    const [msg] = messages;
    if (!msg) return;

    try {
      await handleIncomingMessage(sock, msg);
    } catch (error) {
      console.error('Error al procesar un mensaje:', error);
    }
  });
};

// Punto de entrada principal del script
startBot().catch((error) => {
  console.error('No fue posible iniciar el bot:', error);
});
