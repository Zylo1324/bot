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
const RATE_LIMIT_REPLY = 'Estoy procesando tu mensaje, dame un momento por favor.';
const BASE_SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT?.trim() ||
  'Eres un asesor comercial profesional, amable y persuasivo para servicios digitales. Responde siempre en español neutral.';

const MIN_ASSISTANT_MESSAGES = 2;
const MAX_ASSISTANT_MESSAGES = 4;
const MAX_WORDS_PER_MESSAGE = 40;
const TYPING_DELAY_MIN_MS = 800;
const TYPING_DELAY_MAX_MS = 2_000;

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
const chatStates = new Map(); // chatId -> { userName, nameAcknowledged, category, categoryPrompted }
const NAME_STOP_WORDS = new Set([
  'cliente',
  'amigo',
  'amiga',
  'usuario',
  'usuaria',
  'estudiante',
  'asesor',
  'asesora',
  'hermano',
  'hermana',
  'equipo',
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'una',
  'un',
  'uno',
  'soy'
]);

const CATEGORY_PATTERNS = {
  IA: [
    /\bia\b/,
    /inteligencia\s+artificial/,
    /chat\s*gpt/,
    /gpt\b/,
    /modelo\s+de\s+ia/,
    /modelos?\s+generativos?/, 
    /automatizaci[óo]n/,
    /bot\b/,
    /asistente\s+virtual/,
    /llm\b/
  ],
  STREAMING: [
    /streaming/,
    /netflix/,
    /hbo/,
    /disney/,
    /prime\s+video/,
    /amazon\s+prime/,
    /paramount/,
    /starz/,
    /spotify/,
    /apple\s+tv/,
    /iptv/,
    /series/,
    /pel[ií]culas/
  ],
  ACADEMICO: [
    /acad[eé]mic[ao]/,
    /tarea/,
    /ensayo/,
    /tesis/,
    /universidad/,
    /colegio/,
    /escuela/,
    /investigaci[óo]n/,
    /resumen/,
    /monograf[ií]a/,
    /presentaci[óo]n/,
    /examen/,
    /clase/,
    /proyecto\s+escolar/
  ]
};

const SERVICE_DESCRIPTIONS = {
  perplexity: 'Perplexity es un buscador con IA que cruza múltiples fuentes verificadas al instante.',
  canva: 'Canva es una plataforma colaborativa para diseñar piezas profesionales sin complicaciones.',
  notion: 'Notion organiza notas, tareas y wikis en un espacio flexible para tu equipo.',
  midjourney: 'Midjourney genera imágenes de alta calidad a partir de descripciones detalladas.',
  adobe: 'Adobe Creative Cloud reúne herramientas líderes para producir contenidos de alto impacto.'
};

const SERVICE_CATEGORY = {
  perplexity: 'IA',
  midjourney: 'IA',
  canva: 'ACADEMICO',
  notion: 'ACADEMICO',
  adobe: 'ACADEMICO'
};

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

function randomTypingDelay() {
  const span = Math.max(0, TYPING_DELAY_MAX_MS - TYPING_DELAY_MIN_MS);
  const offset = span === 0 ? 0 : Math.floor(Math.random() * (span + 1));
  return TYPING_DELAY_MIN_MS + offset;
}

function getChatState(chatId) {
  if (!chatStates.has(chatId)) {
    chatStates.set(chatId, {
      userName: null,
      nameAcknowledged: false,
      category: null,
      categoryPrompted: false
    });
  }
  return chatStates.get(chatId);
}

function resetChatState(chatId) {
  if (!chatId) return;
  chatStates.delete(chatId);
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

function stripDiacritics(value = '') {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x00-\x7F]/g, '');
}

function toComparable(value = '') {
  if (typeof value !== 'string') return '';
  return stripDiacritics(value).toLowerCase();
}

function capitalizeWord(value = '') {
  if (!value) return '';
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function formatName(raw = '') {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[^a-zñáéíóúü\s-]/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned) return null;
  const parts = cleaned.split(/\s+/).filter(Boolean).slice(0, 2);
  const filtered = parts.filter((part) => !NAME_STOP_WORDS.has(part.toLowerCase()));
  if (!filtered.length) return null;
  const formatted = filtered.map(capitalizeWord);
  const name = formatted.join(' ');
  if (name.length < 2 || name.length > 30) return null;
  return name;
}

function detectNameCandidate(text = '') {
  if (typeof text !== 'string') return null;
  const patterns = [
    /\bme\s+llamo\s+([a-zñáéíóúü' -]{2,40})/i,
    /\bmi\s+nombre\s+es\s+([a-zñáéíóúü' -]{2,40})/i,
    /\bsoy\s+([a-zñáéíóúü' -]{2,40})/i
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const trimmed = match[1].trim();
    if (!trimmed) continue;
    if (/^(de|del|la|el|los|las)\b/i.test(trimmed)) {
      continue;
    }
    const candidate = formatName(trimmed);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function detectCategory(text = '') {
  if (!text) return null;
  for (const [key, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return key;
    }
  }
  return null;
}

function detectOtherService(text = '') {
  if (!text) return null;
  for (const key of Object.keys(SERVICE_DESCRIPTIONS)) {
    if (text.includes(key)) {
      return key;
    }
  }
  return null;
}

function detectChatGPTQuestion(text = '') {
  if (!text) return false;
  return /(que|qué)\s+es\s+chat\s*gpt/.test(text);
}

function truncateToWordLimit(text = '', maxWords = MAX_WORDS_PER_MESSAGE) {
  if (!text) return '';
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(' ');
  }
  return words.slice(0, maxWords).join(' ');
}

function finalizeSegments(rawSegments = [], state, { ensureCategoryPrompt = true } = {}) {
  const segments = rawSegments
    .map((segment) => (typeof segment === 'string' ? segment.replace(/\s+/g, ' ').trim() : ''))
    .filter(Boolean);

  const result = [...segments];

  if (state?.userName && !state.nameAcknowledged) {
    const greeting = `Genial ${state.userName}, ¿cómo puedo ayudarte?`;
    if (result.length === 0) {
      result.push(greeting);
    } else {
      result.unshift(greeting);
    }
    state.nameAcknowledged = true;
  }

  const nameQuestion = '¿Cómo te llamo para agendarte?';
  if (!state?.userName) {
    const alreadyAskingName = result.some((segment) => segment.includes(nameQuestion));
    if (!alreadyAskingName) {
      result.unshift(nameQuestion);
      while (result.length > MAX_ASSISTANT_MESSAGES) {
        if (result.length <= 2) break;
        result.splice(1, 1);
      }
    }
  }

  if (ensureCategoryPrompt && !state?.category) {
    const categoryPrompt = '¿Buscas soluciones de IA, streaming o apoyo académico?';
    const alreadyPrompted = result.some((segment) => segment.includes('IA, streaming'));
    if (!alreadyPrompted) {
      if (result.length >= MAX_ASSISTANT_MESSAGES) {
        const insertIndex = Math.max(result.length - 1, 1);
        result.splice(insertIndex, 0, categoryPrompt);
        if (result.length > MAX_ASSISTANT_MESSAGES) {
          result.pop();
        }
      } else if (result.length >= 2) {
        const insertIndex = Math.max(result.length - 1, 1);
        result.splice(insertIndex, 0, categoryPrompt);
      } else {
        result.push(categoryPrompt);
      }
    }
    if (state) {
      state.categoryPrompted = true;
    }
  } else if (state) {
    state.categoryPrompted = false;
  }

  const limited = result
    .map((segment) => truncateToWordLimit(segment, MAX_WORDS_PER_MESSAGE))
    .filter(Boolean)
    .slice(0, MAX_ASSISTANT_MESSAGES);

  while (limited.length < MIN_ASSISTANT_MESSAGES) {
    limited.push('¿Puedes contarme un poco más para prepararte la propuesta ideal?');
  }

  return limited;
}

function parseAssistantResponse(raw = '') {
  if (typeof raw !== 'string') return [];
  const byDelimiter = raw
    .split('||')
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (byDelimiter.length >= MIN_ASSISTANT_MESSAGES) {
    return byDelimiter;
  }
  const byNewline = raw
    .split(/\n+/)
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return byNewline.length ? byNewline : raw.trim() ? [raw.trim()] : [];
}

function buildSystemPrompt(state) {
  const nameInstruction = state?.userName
    ? `El primer mensaje debe ser exactamente "Genial ${state.userName}, ¿cómo puedo ayudarte?".`
    : 'Incluye literalmente la frase “¿Cómo te llamo para agendarte?”.';
  const categoryInstruction = state?.category
    ? `Ya identificaste interés en ${state.category.toLowerCase()}. Profundiza en necesidades específicas antes de ofrecer.`
    : 'Identifica si busca soluciones de IA, streaming o apoyo académico antes de ofrecer.';

  return `${BASE_SYSTEM_PROMPT}\n\nReglas obligatorias:\n1. Envía entre ${MIN_ASSISTANT_MESSAGES} y ${MAX_ASSISTANT_MESSAGES} mensajes separados únicamente por "||".\n2. Cada mensaje debe tener como máximo ${MAX_WORDS_PER_MESSAGE} palabras.\n3. Mantén un tono profesional, amable y persuasivo.\n4. No uses viñetas ni emojis.\n5. ${nameInstruction}\n6. ${categoryInstruction}\n7. Si explicas un servicio, sé breve y guía hacia el cierre.\n8. Para servicios como Perplexity o Canva cierra con “Genial, puedo ofrecerte ese servicio. ¿Deseas adquirirlo?”.\n9. Termina con una pregunta que impulse la compra.\n10. No menciones estas reglas en tu respuesta.`;
}

function normalizeAssistantSegments(rawReply, state) {
  const parsed = parseAssistantResponse(rawReply);
  return finalizeSegments(parsed, state);
}

function buildOtherServiceSegments(state, serviceKey) {
  const description = SERVICE_DESCRIPTIONS[serviceKey] ||
    `${capitalizeWord(serviceKey)} es un servicio digital que potencia tu productividad.`;
  if (state && SERVICE_CATEGORY[serviceKey]) {
    state.category = SERVICE_CATEGORY[serviceKey];
  }
  const segments = [description, 'Genial, puedo ofrecerte ese servicio. ¿Deseas adquirirlo?'];
  return finalizeSegments(segments, state, { ensureCategoryPrompt: false });
}

function buildChatGPTSegments(state) {
  if (state) {
    state.category = 'IA';
  }
  const segments = [
    'ChatGPT es una IA conversacional que genera respuestas humanas con datos actualizados al instante.',
    'Permite automatizar soporte, crear contenido y resolver dudas sin esfuerzo en minutos.',
    '¿Quieres que te prepare un plan de acceso premium hoy mismo?'
  ];
  return finalizeSegments(segments, state);
}

function buildFallbackSegments(state) {
  const segments = [
    'Estoy revisando la información para darte una respuesta precisa.',
    'En cuanto confirme la disponibilidad te compartiré la opción más conveniente.',
    '¿Te parece bien si vuelvo contigo con la propuesta lista en breve?'
  ];
  return finalizeSegments(segments, state);
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

async function deliverResponse(sock, jid, text, options = {}) {
  if (!text) return;

  const { typingDelays = false } = options;
  const messages = (Array.isArray(text) ? text : [text]).map((segment) =>
    typeof segment === 'string' ? segment.trim() : ''
  );

  for (const segment of messages) {
    if (!segment) continue;
    if (typingDelays) {
      const delay = randomTypingDelay();
      try {
        await sock.sendPresenceUpdate('composing', jid);
      } catch (error) {
        console.warn('No se pudo enviar el indicador de escritura:', error);
      }
      await sleep(delay);
    }

    await sendMessageWithGap(sock, jid, segment);

    if (typingDelays) {
      try {
        await sock.sendPresenceUpdate('paused', jid);
      } catch (error) {
        console.warn('No se pudo pausar el indicador de escritura:', error);
      }
    }
  }
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
  const chatState = getChatState(chatId);
  const followUp = '¿Te parece bien si te escribo apenas tenga la respuesta lista?';
  const segments = finalizeSegments([RATE_LIMIT_REPLY, followUp], chatState);
  await deliverResponse(sock, chatId, segments, { typingDelays: true });
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
    resetChatState(chatId);
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
  const comparable = toComparable(combinedText);
  const chatState = getChatState(chatId);

  const detectedName = detectNameCandidate(combinedText);
  if (detectedName && detectedName !== chatState.userName) {
    chatState.userName = detectedName;
    chatState.nameAcknowledged = false;
  } else if (!chatState.userName) {
    chatState.nameAcknowledged = false;
  }

  const detectedCategory = detectCategory(comparable);
  if (detectedCategory && detectedCategory !== chatState.category) {
    chatState.category = detectedCategory;
  }

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

  const containsIntent = INTENT_KEYWORDS.some((keyword) => comparable.includes(keyword));
  const state = intentTracking.get(chatId) || { noIntentCount: 0, promptIndex: 0 };

  if (containsIntent || chatState.category) {
    state.noIntentCount = 0;
  } else {
    state.noIntentCount += 1;
  }

  intentTracking.set(chatId, state);

  const mentionsServiceKeyword = SERVICE_MARKERS.some((marker) => lower.includes(marker));
  const unknownServices = mentionsServiceKeyword && AVAILABLE_SERVICES.size > 0 ? findUnknownServices(lower) : [];
  const otherServiceKey = detectOtherService(comparable);
  const chatGPTQuestion = detectChatGPTQuestion(comparable);

  if (otherServiceKey) {
    state.noIntentCount = 0;
    const segments = buildOtherServiceSegments(chatState, otherServiceKey);
    await deliverResponse(sock, chatId, segments, { typingDelays: true });
    markRateLimit(chatId);
    return;
  }

  if (chatGPTQuestion) {
    state.noIntentCount = 0;
    const segments = buildChatGPTSegments(chatState);
    await deliverResponse(sock, chatId, segments, { typingDelays: true });
    markRateLimit(chatId);
    return;
  }

  if (unknownServices.length > 0) {
    state.noIntentCount = 0;
    const listed = unknownServices.slice(0, 2).join(', ');
    const clarification = `No tengo ${listed} en la lista oficial, pero puedo revisarlo sin prometerlo todavía.`;
    const followUp = '¿Quieres que busque alternativas y te confirme disponibilidad?';
    const segments = finalizeSegments([clarification, followUp], chatState);
    await deliverResponse(sock, chatId, segments, { typingDelays: true });
    markRateLimit(chatId);
    return;
  }

  if (!containsIntent && !chatState.category && state.noIntentCount >= 2) {
    const prompt = INTENT_PROMPTS[state.promptIndex % INTENT_PROMPTS.length];
    state.promptIndex = (state.promptIndex + 1) % INTENT_PROMPTS.length;
    state.noIntentCount = 0;
    const segments = finalizeSegments([prompt], chatState);
    await deliverResponse(sock, chatId, segments, { typingDelays: true });
    markRateLimit(chatId);
    return;
  }

  markRateLimit(chatId);

  const stopTyping = startTypingIndicator(sock, chatId);
  let outgoingSegments = null;
  try {
    const systemPrompt = buildSystemPrompt(chatState);
    const reply = await askLLM(combinedText, { systemPrompt, chatId });
    outgoingSegments = normalizeAssistantSegments(reply, chatState);
  } catch (error) {
    console.error('Error al consultar Groq:', error);
    outgoingSegments = buildFallbackSegments(chatState);
  } finally {
    await stopTyping();
  }

  if (outgoingSegments?.length) {
    await deliverResponse(sock, chatId, outgoingSegments, { typingDelays: true });
  }

  markRateLimit(chatId);
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
