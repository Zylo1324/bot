import process from 'node:process';
import Groq from 'groq-sdk';

const BASE_URL = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const MAX_TURNS = 10;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2;

const chatMemory = new Map(); // chatId -> [{ role, content }]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeContent(value) {
  if (typeof value !== 'string') return '';

  const normalized = value.replace(/\r\n/g, '\n').replace(/\t/g, ' ');
  const lines = normalized
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''));

  const trimmed = lines.join('\n').trim();
  return trimmed.replace(/\n{3,}/g, '\n\n');
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

export function hasChatHistory(chatId) {
  return (chatMemory.get(chatId) || []).length > 0;
}

function ensureApiKey() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Falta la variable de entorno GROQ_API_KEY.');
  }
  return apiKey.trim();
}

let groqClient;

function getGroqClient() {
  if (!groqClient) {
    groqClient = new Groq({
      apiKey: ensureApiKey(),
      baseURL: BASE_URL
    });
  }
  return groqClient;
}

export const groq = new Proxy(
  {},
  {
    get(_target, prop) {
      const client = getGroqClient();
      const value = client[prop];
      if (typeof value === 'function') {
        return value.bind(client);
      }
      return value;
    },
    has(_target, prop) {
      return prop in getGroqClient();
    },
    ownKeys() {
      return Reflect.ownKeys(getGroqClient());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Object.getOwnPropertyDescriptor(getGroqClient(), prop);
      if (!descriptor) return undefined;
      return { ...descriptor, configurable: true };
    }
  }
);

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
  const sanitizedSystemPrompt =
    (typeof systemPrompt === 'string' && systemPrompt.length > 0
      ? systemPrompt
      : '') || 'Eres un asistente útil, amable y preciso. Responde en español.';
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

export async function fastGroq(prompt) {
  const cleanedPrompt = sanitizeContent(prompt);
  if (!cleanedPrompt) {
    throw new Error('El prompt llegó vacío tras la sanitización.');
  }

  const response = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: cleanedPrompt }],
    temperature: 0.85,
    top_p: 0.95,
    max_tokens: 450,
    presence_penalty: 0.3,
    frequency_penalty: 0.4
  });

  const assistantMessage = sanitizeContent(response?.choices?.[0]?.message?.content);
  if (!assistantMessage) {
    throw new Error('La respuesta de Groq llegó vacía.');
  }

  return assistantMessage;
}
