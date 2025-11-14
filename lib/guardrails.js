const normalizeInput = txt => (txt ?? "").toString();

export const limitWords = (txt, max = 40) => {
  const original = normalizeInput(txt);
  const matches = [...original.matchAll(/\S+/g)];
  if (matches.length <= max) {
    return original.trim();
  }

  const cutoff = matches[max - 1];
  const endIndex = cutoff.index + cutoff[0].length;
  return original.slice(0, endIndex).trim();
};

export const verticalize = (txt, max = 8) => {
  const original = normalizeInput(txt).replace(/\r\n/g, "\n");
  const hasLineBreaks = original.includes("\n");
  const segments = hasLineBreaks
    ? original.split(/\n+/)
    : original.replace(/\s*[,;]\s*/g, "\n").split("\n");

  const items = segments.map(x => x.trim()).filter(Boolean);
  if (items.length <= max) {
    return items.join("\n");
  }
  return items.slice(0, max).join("\n");
};