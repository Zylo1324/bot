// Importaciones principales y dependencias del bot de WhatsApp
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ensureEnvLoaded = () => {
  const envPath = resolve(process.cwd(), '.env');
  if (process.env.GEMINI_API_KEY || !existsSync(envPath)) return;

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

const SERVICES = {
  disney: 'Disney Premium + ESPN ➜ Perfil S/5',
  hbomax: 'HBO Max Platino ➜ Perfil S/5',
  prime: 'Prime Video ➜ Perfil S/4',
  chatgpt: 'ChatGPT Plus ➜ Compartido S/10 | Cuenta completa S/20 (incluye Canva gratis)',
  perplexity: 'Perplexity ➜ Cuenta S/8',
  gemini: 'Gemini + Veo 3 (1 año) ➜ Cuenta S/30',
  capcut: 'Capcut ➜ Cuenta S/15',
  turnitin: 'Turnitin Estudiante ➜ Cuenta S/15',
  ytpremium: 'YouTube Premium + YT Music ➜ A tu correo S/5',
  directv: 'DirecTV ➜ Activación S/15',
  luna: 'Luna (Gaming) ➜ Cuenta S/20',
  scribd: 'Scribd Premium ➜ Cuenta S/4',
  canva: 'Canva ➜ Cuenta S/4',
  vip: 'Grupo VIP ➜ S/20'
};

const SYNONYMS = {
  disney: ['disney', 'disney+', 'disney plus', 'disneyplus', 'espn', 'espn+', 'espnplus', 'star plus', 'star+'],
  hbomax: ['hbo max', 'hbomax', 'hbo', 'max app', 'max latino'],
  prime: ['prime video', 'primevideo', 'amazon prime', 'amazon prime video', 'amazon video'],
  chatgpt: ['chatgpt', 'chat gpt', 'gpt', 'openai', 'chat gpt plus', 'chatgpt plus'],
  perplexity: ['perplexity', 'perplexity ai', 'perplexity pro'],
  gemini: ['gemini', 'google gemini', 'gemini advanced', 'veo 3', 'veo3'],
  capcut: ['capcut', 'cap cut', 'capcut pro'],
  turnitin: ['turnitin', 'turn it in'],
  ytpremium: ['youtube premium', 'yt premium', 'youtube music', 'youtube music premium', 'yt music', 'ytmusic'],
  directv: ['directv', 'direct tv', 'direct tv go', 'dtv'],
  luna: ['luna', 'amazon luna'],
  scribd: ['scribd', 'scribd premium'],
  canva: ['canva', 'canva pro'],
  vip: ['vip', 'grupo vip', 'grupo premium']
};

const SERVICES_FULL_LIST = Object.values(SERVICES)
  .map((service) => `• ${service}`)
  .join('\n');

const PRICE_KEYWORDS = [
  'precio',
  'precios',
  'lista',
  'lista de precios',
  'servicios',
  'servicio',
  'cuanto cuesta',
  'cuánto cuesta',
  'cuanto sale',
  'cuánto sale',
  'costos',
  'tarifas',
  'planes',
  'catalogo',
  'catálogo'
];

const toPlain = (value) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

function localDetect(text) {
  const normalized = text.toLowerCase();
  const plain = toPlain(text);
  const haystack = [normalized, plain];

  for (const [service, synonyms] of Object.entries(SYNONYMS)) {
    const normalizedSynonyms = synonyms.map((syn) => ({
      raw: syn,
      plain: toPlain(syn)
    }));
    const found = normalizedSynonyms.some(({ raw, plain: synonymPlain }) =>
      haystack.some((candidate) =>
        candidate.includes(raw) || candidate.includes(synonymPlain)
      )
    );
    if (found) {
      return { intent: 'service', service };
    }
  }

  const priceDetected = PRICE_KEYWORDS.some((keyword) =>
    haystack.some((candidate) => candidate.includes(keyword))
  );

  if (priceDetected) {
    return { intent: 'prices', service: null };
  }

  return { intent: 'unknown', service: null };
}

async function geminiDetect(text, timeoutMs = 1800) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini API key not configured');
  }

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const synonymsTable = Object.entries(SYNONYMS)
    .map(([service, words]) => `${service}: ${words.join(', ')}`)
    .join('\n');

  const detectionPromise = (async () => {
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                'Clasifica la intención del siguiente mensaje de WhatsApp.',
                'Responde únicamente en JSON con este esquema exacto:',
                '{ "intent": "prices" | "service" | "unknown", "service": "disney" | "hbomax" | "prime" | "chatgpt" | "perplexity" | "gemini" | "capcut" | "turnitin" | "ytpremium" | "directv" | "luna" | "scribd" | "canva" | "vip" | null }',
                'Si el usuario pregunta por precios generales, usa intent "prices" y service null.',
                'Si menciona un servicio específico, usa intent "service" y la clave correspondiente.',
                'Si no hay suficiente contexto, responde intent "unknown" y service null.',
                'Sinónimos permitidos por servicio:',
                synonymsTable,
                `Mensaje: """${text}"""`
              ].join('\n')
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json'
      }
    });

    const responseText = result.response?.text?.() ?? '';
    if (!responseText) {
      throw new Error('Gemini response empty');
    }

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (error) {
      throw new Error('Gemini response not valid JSON');
    }

    const intents = new Set(['prices', 'service', 'unknown']);
    if (!parsed || !intents.has(parsed.intent)) {
      throw new Error('Gemini response missing intent');
    }

    const rawService = parsed.service === 'null' ? null : parsed.service;
    const service = rawService === undefined ? null : rawService;
    if (service !== null && !Object.prototype.hasOwnProperty.call(SERVICES, service)) {
      throw new Error('Gemini response service out of range');
    }

    return { intent: parsed.intent, service };
  })();

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gemini detect timeout')), timeoutMs);
    detectionPromise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function detectIntent(text) {
  try {
    return await geminiDetect(text);
  } catch (error) {
    console.warn('Fallo la detección con Gemini, usando detector local:', error?.message || error);
    return localDetect(text);
  }
}

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
    const contactName = (m.pushName ?? '').trim();
    const greeting = contactName ? `¡Hola ${contactName}!` : '¡Hola!';

    try {
      if (!lower.startsWith(COMMAND_PREFIX)) {
        const { intent, service } = await detectIntent(normalized);

        if (intent === 'prices') {
          const variants = [
            `${greeting} Te comparto nuestros servicios disponibles:\n${SERVICES_FULL_LIST}`,
            `${greeting} Estos son los precios actualizados:\n${SERVICES_FULL_LIST}`,
            `${greeting} Aquí tienes la lista completa para que elijas lo que prefieras:\n${SERVICES_FULL_LIST}`
          ];
          const message = variants[Math.floor(Math.random() * variants.length)];
          await sendTextHuman(sock, from, message, 1800);
          return;
        }

        if (intent === 'service' && service && SERVICES[service]) {
          const message = `${greeting} Sí 💫, ${SERVICES[service]}. ¿Deseas continuar con la compra o tienes otra duda?`;
          await sendTextHuman(sock, from, message, 1700);
          return;
        }

        const fallbackMessage = `${greeting} ¿Quieres ver 1) precios y servicios o 2) consultar un servicio específico?`;
        await sendTextHuman(sock, from, fallbackMessage, 1600);
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
