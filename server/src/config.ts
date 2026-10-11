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
};
