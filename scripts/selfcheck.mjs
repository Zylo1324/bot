#!/usr/bin/env node
import 'dotenv/config';
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 10_000;

const normalizeBaseUrl = (value = '') => value.replace(/\/$/, '');

const classifyStatus = (status) => {
  if (status === 401) return { type: 'auth', message: 'Token inválido o expirado. Regenera la clave en Groq.' };
  if (status === 403 || status === 429) {
    return { type: 'quota', message: 'Restricción o cuota activa en Groq. Revisa el panel.' };
  }
  if (status >= 500) {
    return { type: 'server', message: 'Error temporal del servicio. Intenta nuevamente en unos minutos.' };
  }
  return { type: 'http', message: `Error HTTP ${status}.` };
};

export async function runSelfCheck({ silent = false } = {}) {
  const log = (...args) => {
    if (!silent) {
      console.log(...args);
    }
  };

  const apiKey = process.env.GROQ_API_KEY;
  const baseUrl = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';

  if (!apiKey || !baseUrl) {
    const missing = [];
    if (!apiKey) missing.push('GROQ_API_KEY');
    if (!baseUrl) missing.push('GROQ_BASE_URL');
    const message = `Faltan variables de entorno: ${missing.join(', ')}.`;
    log(message);
    return { ok: false, type: 'missing_env', message };
  }

  const endpoint = `${normalizeBaseUrl(baseUrl)}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const classification = classifyStatus(response.status);
      const message = classification.message;
      log(message);
      return { ok: false, type: classification.type, status: response.status, message };
    }

    const payload = await response.json().catch(() => ({}));
    const models = Array.isArray(payload.data)
      ? payload.data
          .map((item) => item?.id)
          .filter(Boolean)
          .slice(0, 20)
      : [];

    if (models.length === 0) {
      log('Solicitud exitosa, pero la lista de modelos llegó vacía.');
      return { ok: true, models: [] };
    }

    log('Modelos disponibles:', models.join(', '));
    return { ok: true, models };
  } catch (error) {
    clearTimeout(timeout);
    const code = error?.code || error?.cause?.code;
    if (error?.name === 'AbortError') {
      const message = 'DNS/conectividad. Verifica red o firewall. (timeout)';
      log(message);
      return { ok: false, type: 'network', message };
    }

    const networkHints = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET'];
    if (code && networkHints.includes(code)) {
      const message = 'DNS/conectividad. Verifica red o firewall.';
      log(message);
      return { ok: false, type: 'network', code, message };
    }

    const message = 'Error inesperado al consultar el endpoint de modelos.';
    if (!silent) {
      console.error(message, error);
    }
    return { ok: false, type: 'unknown', message, error };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runSelfCheck();
  if (!result.ok) {
    process.exitCode = 1;
  }
}
