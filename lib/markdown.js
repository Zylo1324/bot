export function normalizeTitle(title) {
  const raw = typeof title === 'string' ? title : String(title ?? '');
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new TypeError('section requiere un título no vacío.');
  }
  return trimmed;
}

function normalizeItems(items) {
  const list = Array.isArray(items) ? items : [items];
  return list
    .map((item) => {
      if (item == null) return '';
      const raw = typeof item === 'string' ? item : String(item);
      return raw.replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean);
}

export function section(title, items = []) {
  const normalizedTitle = normalizeTitle(title);
  const bullets = normalizeItems(items);
  if (bullets.length === 0) {
    return `*${normalizedTitle}*`;
  }
  const body = bullets.map((item) => `• ${item}`).join('\n');
  return `*${normalizedTitle}*\n${body}`;
}
