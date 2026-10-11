// Uso: npm run backup [-- carpeta]
// Genera una copia completa y consistente de la base en un solo archivo, cifrada con la misma DB_KEY.
// No basta con copiar syncbanks.db: los cambios recientes viven en syncbanks.db-wal hasta que SQLite
// los consolida. VACUUM INTO incluye todo y se puede hacer con la app corriendo.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openDb } from '../db.js';

const dir = path.resolve(process.argv[2] ?? path.join(path.dirname(config.dbPath), '..', 'backups'));
fs.mkdirSync(dir, { recursive: true });
const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
const out = path.join(dir, `syncbanks-${stamp}.db`);

const db = openDb(config.dbPath, config.dbKey);
db.prepare('VACUUM INTO ?').run(out);
console.log(`Respaldo creado: ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
console.log('Para restaurarlo: detener la app, copiarlo como data/syncbanks.db (borrando los -wal/-shm) y usar la misma DB_KEY.');
