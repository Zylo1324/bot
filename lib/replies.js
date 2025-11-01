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
  disney: 'Disney+ Premium + ESPN',
  hbo: 'HBO Max',
  prime: 'Prime Video',
  amazon: 'Prime Video',
  chatgpt: 'ChatGPT',
  gpt: 'ChatGPT',
  perplexity: 'Perplexity AI',
  canva: 'Canva',
  gemini: 'Gemini + Veo 3',
  turnitin: 'Turnitin',
  youtube: 'YouTube Premium + Music',
  direc: 'DirecTV',
  capcut: 'CapCut',
  luna: 'Luna (Gaming)',
  grupo: 'Grupo VIP',
  vip: 'Grupo VIP',
  sora: 'Sora',
  scribd: 'Scribd'
};

const SERVICE_DETAILS = {
  'ChatGPT': [
    'ChatGPT compartida S/10: acceso inmediato, un dispositivo, soporte completo. 😉',
    'ChatGPT completa S/20: privada a tu correo, incluye Canva gratis y varios dispositivos. 💎',
    '¿Listo para asegurar la opción ideal y recibirla al toque? 😄'
  ],
  'Sora': [
    'Sora S/15: generador de video IA con acceso premium original. 🎬',
    'Entrega inmediata y garantía activa, perfecto para proyectos creativos. ✨',
    '¿La confirmamos y te la envío hoy mismo? 😄'
  ],
  'Perplexity AI': [
    'Perplexity AI S/8: cuenta completa ilimitada, ideal para investigación veloz. 🔍',
    'Garantía y soporte directo después del pago. 🤝',
    '¿Quieres que la active ahora mismo? 😄'
  ],
  'Gemini + Veo 3': [
    'Gemini + Veo 3 S/30: cuenta completa 1 año, IA visual y texto avanzada. 🚀',
    'Uso privado con garantía mensual y soporte personalizado. 🛡️',
    '¿Cerramos la activación hoy? 😄'
  ],
  'Turnitin': [
    'Turnitin S/15: cuenta completa con verificación de plagio ilimitada. 📚',
    'Ideal para tesis y trabajos, entrega inmediata tras pago. ✅',
    '¿Lo aseguramos en este momento? 😄'
  ],
  'Grupo VIP': [
    'Grupo VIP S/20: aprende a crear y vender cuentas premium paso a paso. 🧠',
    'Incluye estrategias IA y acompañamiento directo. 💼',
    '¿Te uno al grupo ahora mismo? 😄'
  ],
  'Canva': [
    'Canva S/4: cuenta a tu correo, acceso pro ilimitado y plantillas premium. 🎨',
    'Garantía y soporte inmediato tras el pago. ✅',
    '¿Quieres activarla ya mismo? 😄'
  ],
  'CapCut': [
    'CapCut S/15: cuenta completa para edición premium sin restricciones. 🎬',
    'Incluye todos los efectos y almacenamiento en la nube. ☁️',
    '¿Confirmamos y lo activo hoy? 😄'
  ],
  'Disney+ Premium + ESPN': [
    'Disney+ Premium + ESPN S/5: perfil con todo el contenido premium. 🍿',
    'Funciona en una pantalla con garantía y soporte inmediato. ✅',
    '¿Te reservo el perfil ahora? 😄'
  ],
  'HBO Max': [
    'HBO Max S/5: perfil premium con estrenos y clásicos listos para ver. 🎥',
    'Entrega rápida y soporte ante cualquier duda. ✅',
    '¿Te lo activo hoy mismo? 😄'
  ],
  'Prime Video': [
    'Prime Video S/4: perfil premium con todo el catálogo y calidad HD. 🎬',
    'Incluye soporte y garantía durante el periodo activo. 🛡️',
    '¿Apartamos tu perfil ahora? 😄'
  ],
  'YouTube Premium + Music': [
    'YouTube Premium + Music S/5: se activa directo a tu correo. 🎧',
    'Disfruta sin anuncios y con descargas offline al instante. 📲',
    '¿Quieres que lo configure de una vez? 😄'
  ],
  'DirecTV': [
    'DirecTV S/15: activación directa en tu TV con canales completos. 📺',
    'Incluye soporte para la instalación inmediata. 🛠️',
    '¿Programamos la activación hoy mismo? 😄'
  ],
  'Luna (Gaming)': [
    'Luna Gaming S/20: acceso premium a la biblioteca completa en la nube. 🎮',
    'Uso estable y soporte para configuración. ✅',
    '¿Te activo la cuenta ahora mismo? 😄'
  ],
  'Scribd': [
    'Scribd S/4: cuenta completa con libros y audiolibros ilimitados. 📚',
    'Se activa en minutos y cuenta con garantía mensual. ✅',
    '¿Deseas confirmarla hoy? 😄'
  ]
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
  if (words.length <= 30) {
    return words.join(' ');
  }
  return words.slice(0, 30).join(' ');
}

function buildProposalMessages(session) {
  const details = session.interest && SERVICE_DETAILS[session.interest];
  if (details) {
    return details.map(ensureShort);
  }
  return [
    ensureShort('Cada servicio es individual, sin planes Plus ni Pro, todo 100% original. ✨'),
    ensureShort('Incluye entrega inmediata, soporte y garantía activa tras tu pago. ✅'),
    ensureShort('¿Confirmamos el que prefieras y lo recibes hoy? 😄')
  ];
}

function buildReply(session) {
  const product = session.interest || 'el servicio';
  switch (session.stage) {
    case 'descubrimiento':
      return [
        ensureShort(`Genial ${session.name ? session.name + ' ' : ''}${product} está listo con entrega inmediata. 😎`),
        ensureShort('¿Te paso los pasos para comprarlo al toque? 🛒')
      ];
    case 'propuesta':
      return buildProposalMessages(session);
    case 'cierre':
      return [
        ensureShort(`Perfecto, reservo ${product} para ti ahora mismo. 😃`),
        ensureShort('¿Te comparto el método de pago y cerramos hoy? 💳')
      ];
    case 'pago_pendiente':
      return [
        ensureShort('Paga por Yape 942632719 a nombre de Jair, también Plin, PayPal, Binance o transferencia. 💰'),
        ensureShort('Envíame la captura apenas pagues y lo activo en minutos. ⚡')
      ];
    case 'confirmado':
      return [
        ensureShort(`Pago confirmado, activaré ${product} en minutos y te aviso. 🚀`),
        ensureShort('Gracias por confiar en SUPER ZYLO, disfruta la experiencia. 🙌')
      ];
    default:
      return [
        ensureShort(`Hola ${session.name ? session.name : '👋'} soy tu asesor SUPER ZYLO, listo con ${product}. 🤝`),
        ensureShort('Cuéntame qué necesitas saber y te ayudo a comprarlo ya. 🙂')
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
      : 'Te ayudo con tu compra. ¿Qué servicio confirmamos hoy? 🙂';
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
