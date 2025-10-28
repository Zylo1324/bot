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
import process from 'node:process';

import { runSelfCheck } from './scripts/selfcheck.mjs';

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

const AUTH_FOLDER = './auth_state';
const COMMAND_PREFIX = '/';
const NETWORK_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN']);

const SERVICE_KEYWORDS = new Map([
  ['web', 'sitios web a medida'],
  ['página', 'sitios web a medida'],
  ['paginas', 'sitios web a medida'],
  ['ecommerce', 'tiendas en línea'],
  ['tienda', 'tiendas en línea'],
  ['ads', 'campañas de anuncios'],
  ['anuncio', 'campañas de anuncios'],
  ['meta', 'campañas de anuncios'],
  ['instagram', 'gestión de redes sociales'],
  ['facebook', 'gestión de redes sociales'],
  ['seo', 'optimización SEO'],
  ['posicionamiento', 'optimización SEO']
]);

const PRICE_KEYWORDS = ['precio', 'cuánto', 'coste', 'costo', 'vale', 'tarifa', 'plan', 'planes', 'presupuesto'];

const fallbackResponses = {
  pricing: [
    (name) =>
      `${name ? `Hola ${name}! ` : '¡Hola! '}Tenemos planes flexibles desde $99 al mes e incluyen soporte dedicado. ¿Te preparo un resumen con la promo vigente y agendamos una llamada corta? 🙂`,
    (name) =>
      `${name ? `Hola ${name}! ` : '¡Hola! '}Gracias por tu interés. Podemos armarte una propuesta con descuento de bienvenida y dejar todo listo hoy mismo. ¿Te envío la comparativa de planes para que elijas el ideal?`
  ],
  service: [
    (name, service) =>
      `${name ? `Hola ${name}! ` : '¡Hola! '}Justo ayudamos a clientes con ${service || 'el servicio que buscas'}. Podemos iniciar con un diagnóstico rápido y entregarte una propuesta personalizada. ¿Agendamos una breve llamada?`,
    (name, service) =>
      `${name ? `Hola ${name}! ` : '¡Hola! '}Podemos encargarnos de ${service || 'tu proyecto'} y acompañarte hasta el lanzamiento. ¿Te comparto casos de éxito y avanzamos con una reunión esta semana? 🚀`
  ],
  general: [
    (name) =>
      `${name ? `Hola ${name}! ` : '¡Hola! '}Estoy listo para ayudarte y encontrar la solución que mejor se adapte. ¿Te parece si coordinamos una llamada para definir próximos pasos?`,
    (name) =>
      `${name ? `Hola ${name}! ` : '¡Hola! '}Encantado de conocerte. Cuéntame lo que necesitas y preparo una propuesta concreta para que tomes decisión hoy mismo. ¿Agendamos una charla rápida?`
  ]
};

const analyzeMessage = (text) => {
  const lower = text.toLowerCase();
  const intent = PRICE_KEYWORDS.some((keyword) => lower.includes(keyword))
    ? 'pricing'
    : Array.from(SERVICE_KEYWORDS.keys()).some((keyword) => lower.includes(keyword))
    ? 'service'
    : 'general';

  let serviceFocus = null;
  for (const [keyword, label] of SERVICE_KEYWORDS.entries()) {
    if (lower.includes(keyword)) {
      serviceFocus = label;
      break;
    }
  }

  return { intent, serviceFocus };
};

const selectFallbackResponse = ({ name, intent, serviceFocus }) => {
  const group = fallbackResponses[intent] || fallbackResponses.general;
  const template = group[Math.floor(Math.random() * group.length)];
  return template(name, serviceFocus);
};

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

let openaiClient = null;
if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
  openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL
  });
}

class ChatCompletionError extends Error {
  constructor(message, { status, code, isRetryable, originalError } = {}) {
    super(message);
    this.name = 'ChatCompletionError';
    this.status = status;
    this.code = code;
    this.isRetryable = Boolean(isRetryable);
    this.originalError = originalError;
  }
}

const normalizeOpenAIError = (error) => {
  if (error instanceof ChatCompletionError) {
    return error;
  }

  const status = error?.status ?? error?.response?.status ?? error?.cause?.statusCode ?? null;
  const code = error?.code ?? error?.cause?.code ?? error?.error?.code ?? null;
  const isNetwork = code && NETWORK_ERROR_CODES.has(code);
  const isRetryable = Boolean((status && status >= 500) || status === 408 || isNetwork);

  return new ChatCompletionError(error?.message || 'Error al invocar el modelo.', {
    status,
    code,
    isRetryable,
    originalError: error
  });
};

const buildModelMessages = ({
  contactName,
  text,
  intent,
  serviceFocus
}) => {
  const modelIntentSummary = [
    `Nombre reportado: ${contactName || 'desconocido'}.`,
    `Intención detectada: ${intent}.`,
    serviceFocus ? `Servicio mencionado: ${serviceFocus}.` : 'Sin servicio concreto detectado.',
    'Objetivo: guiar con calidez, responder dudas y llevar al cierre con una propuesta clara.'
  ].join('\n');

  return [
    {
      role: 'system',
      content:
        'Eres un vendedor experto, amable, empático y convincente. Habla en español natural, usa como máximo dos emojis oportunos, evita sonar robótico y varía tus frases. Saluda usando el nombre del cliente solo la primera vez. Identifica si busca precios o un servicio específico y ofrece siguientes pasos concretos orientados al cierre.'
    },
    {
      role: 'system',
      content: modelIntentSummary
    },
    {
      role: 'user',
      content: text
    }
  ];
};

const getModelName = () => process.env.MODEL || 'glm-4.5';

const callChatCompletion = async (messages) => {
  if (!openaiClient) {
    throw new ChatCompletionError('Cliente de OpenAI no configurado.', {
      code: 'config',
      status: 0,
      isRetryable: false
    });
  }

  const model = getModelName();
  const maxAttempts = 3;
  let delay = 600;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const completion = await openaiClient.chat.completions.create({
        model,
        messages,
        temperature: 0.75,
        presence_penalty: 0.4,
        frequency_penalty: 0.4
      });

      const response = completion.choices?.[0]?.message?.content?.trim();
      if (!response) {
        throw new ChatCompletionError('La respuesta del modelo llegó vacía.', {
          status: completion?.status ?? 502,
          code: 'empty_response',
          isRetryable: attempt < maxAttempts
        });
      }

      return response;
    } catch (error) {
      const normalized = normalizeOpenAIError(error);
      const { status, code, isRetryable } = normalized;
      console.error(
        '[Modelo] Error en intento %d: status=%s code=%s mensaje=%s',
        attempt,
        status ?? 'n/a',
        code ?? 'n/a',
        normalized.message
      );

      if (isRetryable && attempt < maxAttempts) {
        await sleep(delay + jitter(200, 600));
        delay *= 2;
        continue;
      }

      throw normalized;
    }
  }

  throw new ChatCompletionError('No se pudo obtener respuesta del modelo tras varios intentos.', {
    status: 504,
    code: 'max_retries',
    isRetryable: false
  });
};

const responderIA = async ({ contactName, text }) => {
  const analysis = analyzeMessage(text);

  if (fallbackMode) {
    return selectFallbackResponse({
      name: contactName,
      intent: analysis.intent,
      serviceFocus: analysis.serviceFocus
    });
  }

  const messages = buildModelMessages({
    contactName,
    text,
    intent: analysis.intent,
    serviceFocus: analysis.serviceFocus
  });

  return callChatCompletion(messages);
};

const handledConnectionIssue = (type) => {
  switch (type) {
    case 'auth':
      return 'Se detectó un problema de autenticación (401).';
    case 'quota':
      return 'Se detectaron límites o cuotas (403/429).';
    case 'network':
      return 'Se detectó un problema de red/DNS.';
    default:
      return 'Se detectó un fallo en el autodiagnóstico inicial.';
  }
};

let fallbackMode = false;
let fallbackReason = null;

const activateFallback = (reason) => {
  if (fallbackMode) return;
  fallbackMode = true;
  fallbackReason = reason;
  console.warn('Activando modo fallback local: %s', reason);
};

const runStartupSelfCheck = async () => {
  try {
    const result = await runSelfCheck({ silent: true });
    if (!result.ok) {
      activateFallback(handledConnectionIssue(result.type));
      console.error('[Selfcheck] %s', result.message);
    } else {
      console.log('[Selfcheck] Conexión verificada. Modelos detectados:', result.models.join(', ') || 'no especificados');
    }
  } catch (error) {
    activateFallback('Se detectó un error inesperado en el autodiagnóstico inicial.');
    console.error('[Selfcheck] Error inesperado.', error);
  }
};

await runStartupSelfCheck();

async function sendFallbackTechnicalIssue(sock, chatId) {
  await sendTextHuman(
    sock,
    chatId,
    'Estoy con inconvenientes técnicos temporales. ¿Te parece si vuelvo a intentar en un minuto?',
    1200
  );
}

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
      if (fallbackMode && fallbackReason) {
        console.warn('Modo fallback activo: %s', fallbackReason);
      }
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

        const reply = await responderIA({ contactName, text: normalized });
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
        await sendTextHuman(sock, from, 'Planes desde $99/mes con soporte premium incluido.', 1500);
        return;
      }

      if (cmd === '/soporte') {
        await sendTextHuman(sock, from, 'Contacta a soporte. Deja tu mensaje y te respondemos en breve.', 1700);
        return;
      }

      if (cmd === '/info') {
        await sendTextHuman(sock, from, 'Bot con Baileys y Node.js (demo).', 1400);
        return;
      }

      await sendTextHuman(sock, from, 'Comando no reconocido. Usa /cmds', 1600);
    } catch (error) {
      const normalizedError = normalizeOpenAIError(error);
      console.error('Error al procesar un mensaje:', {
        status: normalizedError.status,
        code: normalizedError.code,
        message: normalizedError.message
      });

      if (normalizedError.status === 401) {
        console.warn('Detalle: Token inválido o expirado (401).');
        activateFallback(handledConnectionIssue('auth'));
      } else if (normalizedError.status === 403 || normalizedError.status === 429) {
        console.warn('Detalle: Restricción o cuota (status %s).', normalizedError.status);
        activateFallback(handledConnectionIssue('quota'));
      } else if (NETWORK_ERROR_CODES.has(normalizedError.code)) {
        console.warn('Detalle: Posible problema de red (%s).', normalizedError.code);
        activateFallback(handledConnectionIssue('network'));
      } else if (normalizedError.code === 'config') {
        activateFallback('Configuración incompleta del cliente OpenAI.');
      }

      await sendFallbackTechnicalIssue(sock, from);
    }
  });
};

// Punto de entrada principal del script
startBot().catch((error) => {
  console.error('No fue posible iniciar el bot:', error);
});
