const normalizeInput = (txt) => (txt ?? '').toString();

const hasSalesOrPriceContext = (txt = '') => {
  const normalized = txt.toLowerCase();
  const pricePatterns = [
    /\$\s*\d+/, // $ 1500
    /\b\d+[,.]?\d*\s*(usd|mxn|soles|dólares|dolares|pesos)\b/i,
    /\bprecio(?:s)?\b/i,
    /\bpaquete(?:s)?\b/i,
    /\bpromoc(?:ión|ion)\b/i,
    /\binversi(?:ón|on)\b/i,
    /\bcerrar(?:emos)?\b/i,
    /\bcompra(?:r)?\b/i,
    /\bagenda(?:r)?\b/i
  ];

  return pricePatterns.some((pattern) => pattern.test(txt)) ||
    normalized.includes('venta') ||
    normalized.includes('cierre');
};

export const limitWords = (txt, max = 40) => {
  const original = normalizeInput(txt);
  const matches = [...original.matchAll(/\S+/g)];
  if (matches.length <= max || hasSalesOrPriceContext(original)) {
    return original.trim();
  }

  const cutoff = matches[max - 1];
  const endIndex = cutoff.index + cutoff[0].length;
  return original.slice(0, endIndex).trim();
};

export const verticalize = (txt, max = 8) => {
  const original = normalizeInput(txt).replace(/\r\n/g, '\n');
  const hasLineBreaks = original.includes("\n");
  const segments = hasLineBreaks
    ? original.split(/\n+/)
    : original.replace(/\s*[,;]\s*/g, "\n").split("\n");

  const items = segments.map(x => x.trim()).filter(Boolean);
  if (items.length <= max || hasSalesOrPriceContext(original)) {
    return items.join("\n");
  }
  return items.slice(0, max).join("\n");
};