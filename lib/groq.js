import process from 'node:process';

const BASE_URL = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const MAX_TURNS = 10;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2;

const chatMemory = new Map(); // chatId -> [{ role, content }]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeContent(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function getHistory(chatId) {
  return chatMemory.get(chatId) || [];
}

function storeHistory(chatId, history) {
  const trimmed = history.slice(-MAX_TURNS);
  chatMemory.set(chatId, trimmed);
}

export function resetChatMemory(chatId) {
  chatMemory.delete(chatId);
}

function ensureApiKey() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Falta la variable de entorno GROQ_API_KEY.');
  }
  return apiKey.trim();
}

async function performRequest(body, { signal }) {
  const apiKey = ensureApiKey();
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const errorPayload = await response.text().catch(() => '');
    const error = new Error(`Groq respondió con status ${response.status}.`);
    error.status = response.status;
    error.body = errorPayload;
    throw error;
  }

  return response.json();
}

// FIX: Función principal que encapsula el acceso a Groq y mantiene memoria corta por chat.
export async function askLLM(userText, { systemPrompt, chatId }) {
  const cleanedUserText = sanitizeContent(userText);
  if (!cleanedUserText) {
    throw new Error('El texto del usuario llegó vacío tras la sanitización.');
  }

  const history = getHistory(chatId);
  const sanitizedSystemPrompt = sanitizeContent(systemPrompt)
    || 'Eres un asistente útil, amable y preciso. Responde en español.';
  const messages = [
    { role: 'system', content: sanitizedSystemPrompt },
    ...history,
    { role: 'user', content: cleanedUserText }
  ];

  const body = {
    model: MODEL,
    messages,
    temperature: 0.6,
    top_p: 0.9
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const payload = await performRequest(body, { signal: controller.signal });
      const assistantMessage = sanitizeContent(payload?.choices?.[0]?.message?.content);
      if (!assistantMessage) {
        throw new Error('La respuesta de Groq llegó vacía.');
      }

      const updatedHistory = [
        ...history,
        { role: 'user', content: cleanedUserText },
        { role: 'assistant', content: assistantMessage }
      ];
      storeHistory(chatId, updatedHistory);
      return assistantMessage;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) {
        throw error;
      }
      await sleep(750 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('No se pudo obtener respuesta del modelo tras reintentos.');
}
