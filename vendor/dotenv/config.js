// FIX: Implementación local mínima de dotenv/config para entornos sin acceso a npm.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const envPath = resolve(process.cwd(), '.env');

if (!existsSync(envPath)) {
  process.emitWarning?.('Archivo .env no encontrado; se continuará con variables del entorno.');
} else {
  try {
    const content = readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const equalsIndex = line.indexOf('=');
      if (equalsIndex === -1) continue;
      const key = line.slice(0, equalsIndex).trim();
      const value = line.slice(equalsIndex + 1).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      process.env[key] = value;
    }
  } catch (error) {
    console.warn('No fue posible cargar el archivo .env:', error);
  }
}
