// Uso: npm run backup [-- carpeta]
// Genera una copia completa y consistente de todas las bases (usuarios.db y la de cada usuario) en una
// carpeta con fecha, cifradas con la misma DB_KEY. No basta con copiar los .db: los cambios recientes
// viven en los -wal hasta que SQLite los consolida. VACUUM INTO incluye todo y se puede hacer con la
// app corriendo.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openStore } from '../store.js';

const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
const base = path.resolve(process.argv[2] ?? path.join(path.dirname(config.dbPath), '..', 'backups'));
const dir = path.join(base, `syncbanks-${stamp}`);

const store = openStore(config.dbPath, config.dbKey);
const files = store.dataFiles();
const copy = (db: ReturnType<typeof store.data>, relative: string) => {
  const out = path.join(dir, relative);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  db.prepare('VACUUM INTO ?').run(out);
  return fs.statSync(out).size;
};

let size = copy(store.auth, 'usuarios.db');
for (const f of files) size += copy(store.data(f), f);
console.log(`Respaldo creado: ${dir} (usuarios.db y ${files.length} base(s) de usuarios, ${Math.round(size / 1024)} KB)`);
console.log('Para restaurarlo: detener la app, copiar el contenido de esa carpeta dentro de data/ (borrando los -wal/-shm) y usar la misma DB_KEY.');
