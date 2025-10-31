const SESSION_TTL_MS = 30 * 60_000;
const STAGES = new Set(['inicio', 'descubrimiento', 'propuesta', 'cierre', 'pago_pendiente', 'confirmado']);

const STAGE_PRIORITY = {
  inicio: 0,
  descubrimiento: 1,
  propuesta: 2,
  cierre: 3,
  pago_pendiente: 4,
  confirmado: 5
};

const PURCHASE_KEYWORDS = [
  /(precio|cu[aá]nt[oa]|cuesta|vale|tarifa)/i,
  /(compr(ar|o)|adquirir|contratar|suscripci[óo]n|activar)/i,
  /(quiero|necesito|busco|me interesa|me gustar[ií]a)/i,
  /(confirmar|cerrar|agendar|reservar)/i,
  /(pago|transfer(ir|encia)|deposit[oó]|yape)/i,
  /(pag[ée]|envi[eé]|adjunto).*(comprobante|voucher|captura)/i
];

const CLOSE_KEYWORDS = /(confirm(o|ar)|listo|cerramos|cierre|reserva)/i;
const PAYMENT_REQUEST_KEYWORDS = /(pago|transfer(ir|encia)|deposit[oó]|yape|plin|metodo de pago|m[eé]todo de pago)/i;
const PAYMENT_CONFIRMED_KEYWORDS = /(ya|acabo|reci[ée]n|listo).*(pagu[eé]|transfer[ií]|yape[eé]|dep[oó]sit[oó])/i;
const PLAN_KEYWORDS = /(plan|paquete|premium|mensual|anual|full|completo)/i;

const NAME_PATTERNS = [
  /\bme\s+llamo\s+([a-zñáéíóúü' -]{2,40})/i,
  /\bmi\s+nombre\s+es\s+([a-zñáéíóúü' -]{2,40})/i,
  /\bsoy\s+([a-zñáéíóúü' -]{2,40})/i
];

const PRODUCT_KEYWORDS = {
  disney: 'Disney+ Premium',
  hbo: 'HBO Max',
  prime: 'Prime Video',
  amazon: 'Prime Video',
  chatgpt: 'ChatGPT Plus',
  gpt: 'ChatGPT Plus',
  perplexity: 'Perplexity',
  canva: 'Canva Pro',
  gemini: 'Gemini + Veo',
  turnitin: 'Turnitin',
  youtube: 'YouTube Premium',
  direc: 'DirecTV',
  capcut: 'CapCut Pro',
  luna: 'Luna',
  grupo: 'Grupo VIP',
  vip: 'Grupo VIP'
};

const sessionStore = new Map();
const interactionLogs = [];

function sanitize(text = '') {
  return typeof text === 'string' ? text.trim() : '';
}

function getUserId(state = {}) {
  return state.userId || state.chatId || state.id || null;
}

function createFreshSession() {
  return {
    name: null,
    interest: null,
    plan: null,
    stage: 'inicio',
    lastIntent: null,
    offTopicCount: 0,
    hasPurchaseIntent: false
  };
}

function getSession(userId) {
  if (!userId) {
    return createFreshSession();
  }

  const now = Date.now();
  const entry = sessionStore.get(userId);
  if (entry && entry.expiresAt > now) {
    return entry.session;
  }

  const session = createFreshSession();
  sessionStore.set(userId, { session, expiresAt: now + SESSION_TTL_MS });
  return session;
}

function persistSession(userId, session) {
  if (!userId) return;
  sessionStore.set(userId, { session, expiresAt: Date.now() + SESSION_TTL_MS });
}

function extractName(text) {
  for (const pattern of NAME_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const cleaned = match[1].replace(/\s+/g, ' ').trim();
      if (cleaned && cleaned.length >= 2 && cleaned.length <= 40) {
        return cleaned
          .split(' ')
          .slice(0, 2)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
          .join(' ');
      }
    }
  }
  return null;
}

function detectProduct(lowerText) {
  for (const [needle, product] of Object.entries(PRODUCT_KEYWORDS)) {
    if (lowerText.includes(needle)) {
      return product;
    }
  }
  return null;
}

function detectPlan(text) {
  if (!PLAN_KEYWORDS.test(text)) {
    return null;
  }

  const match = /(plan|paquete)\s+([a-z0-9ñáéíóúü+-]{2,20})/i.exec(text);
  if (match?.[2]) {
    return match[2].toUpperCase();
  }
  if (/mensual/i.test(text)) return 'MENSUAL';
  if (/anual/i.test(text)) return 'ANUAL';
  if (/premium/i.test(text)) return 'PREMIUM';
  return 'ESPECIAL';
}

function hasPurchaseIntent(text) {
  return PURCHASE_KEYWORDS.some((pattern) => pattern.test(text));
}

function pickStage(currentStage, text) {
  if (PAYMENT_CONFIRMED_KEYWORDS.test(text)) return 'confirmado';
  if (PAYMENT_REQUEST_KEYWORDS.test(text)) return 'pago_pendiente';
  if (CLOSE_KEYWORDS.test(text)) return 'cierre';
  if (PLAN_KEYWORDS.test(text)) return 'propuesta';
  if (hasPurchaseIntent(text)) return 'descubrimiento';
  return currentStage || 'inicio';
}

function upgradeStage(previous, next) {
  if (!STAGES.has(next)) return previous;
  if (!STAGES.has(previous)) return next;
  return STAGE_PRIORITY[next] >= STAGE_PRIORITY[previous] ? next : previous;
}

function ensureShort(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 24) {
    return text;
  }
  return words.slice(0, 24).join(' ');
}

function buildReply(session) {
  const product = session.interest || 'el servicio';
  switch (session.stage) {
    case 'descubrimiento':
      return [
        ensureShort(`Genial ${session.name ? session.name + ',' : ''} ${product} está disponible hoy mismo.`),
        ensureShort('¿Te comparto los pasos para que confirmes rápido?')
      ];
    case 'propuesta':
      return [
        ensureShort(`Te recomiendo el plan ${session.plan || 'premium digital'} con entrega inmediata.`),
        ensureShort('Incluye soporte y garantía. ¿Lo confirmamos ahora?')
      ];
    case 'cierre':
      return [
        ensureShort(`Perfecto, dejamos ${product} listo para ti.`),
        ensureShort('¿Te paso el método de pago para cerrar hoy?')
      ];
    case 'pago_pendiente':
      return [
        ensureShort('Puedes completar con Yape 942632719 a nombre de Jair.'),
        ensureShort('Envíame la constancia apenas lo tengas para activarlo en minutos.')
      ];
    case 'confirmado':
      return [
        ensureShort(`Pago recibido, activaré ${product} en breves minutos.`),
        ensureShort('Gracias por confiar, te aviso apenas quede listo.')
      ];
    default:
      return [
        ensureShort(`Estoy aquí para ayudarte a elegir ${product}.`),
        ensureShort('¿Qué detalle necesitas para avanzar con la compra?')
      ];
  }
}

function logInteraction(chatId, intent, product, stage) {
  interactionLogs.push({
    timestamp: new Date().toISOString(),
    chatId: chatId || null,
    intent,
    producto: product || null,
    stage
  });
}

export function composeReplies(fullText, state = {}) {
  const text = sanitize(fullText);
  if (!text) {
    logInteraction(getUserId(state), 'sin_texto', null, 'inicio');
    return [];
  }

  const userId = getUserId(state);
  const session = getSession(userId);
  const lower = text.toLowerCase();

  const name = extractName(text);
  if (name) {
    session.name = name;
  }

  const product = detectProduct(lower) || session.interest;
  if (product) {
    session.interest = product;
  }

  const plan = detectPlan(text);
  if (plan) {
    session.plan = plan;
  }

  const intentDetected = hasPurchaseIntent(text);
  const nextStage = pickStage(session.stage, text);

  if (!intentDetected && session.stage === 'inicio') {
    logInteraction(userId, 'sin_intencion', session.interest, session.stage);
    return [];
  }

  if (!intentDetected) {
    session.offTopicCount += 1;
    const message = session.offTopicCount > 1
      ? 'Cuando desees confirmar, te paso el método de pago 😉'
      : 'Te ayudo con tu compra. ¿Qué servicio confirmamos hoy?';
    logInteraction(userId, 'cambio_tema', session.interest, session.stage);
    persistSession(userId, session);
    return [message];
  }

  session.offTopicCount = 0;
  session.hasPurchaseIntent = true;
  session.stage = upgradeStage(session.stage, nextStage);
  session.lastIntent = nextStage;

  persistSession(userId, session);
  logInteraction(userId, 'intencion_compra', session.interest, session.stage);

  const replies = buildReply(session);
  if (state && typeof state === 'object') {
    state.name = session.name;
    state.interest = session.interest;
    state.plan = session.plan;
    state.stage = session.stage;
  }
  return replies;
}

export function getInteractionLogs() {
  return [...interactionLogs];
}

export function __unsafeClearSessions() {
  sessionStore.clear();
}

export function __unsafeGetSession(userId) {
  return sessionStore.get(userId)?.session || null;
}
