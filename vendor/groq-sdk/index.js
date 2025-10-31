const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

function ensureFetch(customFetch) {
  const resolvedFetch = customFetch || globalThis.fetch;
  if (typeof resolvedFetch !== 'function') {
    throw new Error('Se requiere una implementación de fetch para usar groq-sdk.');
  }
  return resolvedFetch.bind(globalThis);
}

function sanitizeBaseUrl(baseUrl = DEFAULT_BASE_URL) {
  return baseUrl.replace(/\/$/, '');
}

function sanitizeApiKey(apiKey) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('groq-sdk necesita un apiKey válido.');
  }
  return apiKey.trim();
}

async function performJsonRequest(fetchImpl, baseUrl, apiKey, path, body) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorPayload = await response.text().catch(() => '');
    const error = new Error(`Groq API request failed with status ${response.status}.`);
    error.status = response.status;
    error.body = errorPayload;
    throw error;
  }

  return response.json();
}

export default class Groq {
  constructor(options = {}) {
    const { apiKey, baseURL, fetch: customFetch } = options;
    this.apiKey = sanitizeApiKey(apiKey);
    this.baseUrl = sanitizeBaseUrl(baseURL);
    this.fetch = ensureFetch(customFetch);
    this.chat = {
      completions: {
        create: async (payload) =>
          performJsonRequest(this.fetch, this.baseUrl, this.apiKey, '/chat/completions', payload)
      }
    };
  }
}

export { Groq };
