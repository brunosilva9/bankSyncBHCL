import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';

const db = openDb(config.dbPath, config.dbKey);
const users = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
if (users === 0) console.warn('No hay usuarios. Crea uno con: npm run user:add -- <usuario>');

const app = createApp(db, { production: config.production, sessionDays: config.sessionDays, webDist: config.webDist });
app.listen(config.port, () => console.log(`SyncBanks escuchando en http://localhost:${config.port}`));
