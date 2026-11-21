import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

export const config = {
  port: Number(process.env.PORT ?? 3001),
  production: process.env.NODE_ENV === 'production',
  dbPath: process.env.DB_PATH ?? path.join(root, 'data', 'syncbanks.db'),
  /** Clave de cifrado de la base (SQLCipher). Si se pierde, los datos no se pueden recuperar. */
  dbKey: process.env.DB_KEY ?? '',
  webDist: process.env.WEB_DIST ?? path.join(root, 'web', 'dist'),
  sessionDays: Number(process.env.SESSION_DAYS ?? 7),
  /**
   * De qué proxy creer el X-Forwarded-For para saber la IP real (límite de intentos de login). Por
   * defecto solo uno en la misma máquina; con Docker Compose el proxy (Caddy) llega desde la red interna
   * de Docker: "loopback, uniquelocal". Ver DESPLIEGUE.md.
   */
  trustProxy: process.env.TRUST_PROXY ?? 'loopback',
  /**
   * Hora de Chile (0 a 23) a la que el servidor cierra solo el día anterior (ver domain/closing.ts). Con
   * CIERRE_HORA=no no cierra solo; se puede cerrar a mano con npm run cierre.
   */
  closingHour: parseClosingHour(process.env.CIERRE_HORA),
};

function parseClosingHour(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return 2;
  if (v.trim().toLowerCase() === 'no') return null;
  const hour = Number(v);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`CIERRE_HORA debe ser una hora de 0 a 23, o "no" (es "${v}")`);
  return hour;
}
