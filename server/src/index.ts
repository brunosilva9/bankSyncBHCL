import { createApp } from './app.js';
import { config } from './config.js';
import { startDailyClosings } from './scheduler.js';
import { openStore } from './store.js';

const store = openStore(config.dbPath, config.dbKey);
const users = (store.auth.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
if (users === 0) console.warn('No hay usuarios. Crea un administrador con: npm run user:add -- <usuario>');

const app = createApp(store, {
  production: config.production,
  sessionDays: config.sessionDays,
  webDist: config.webDist,
  trustProxy: config.trustProxy,
  closingHour: config.closingHour,
});
app.listen(config.port, () => console.log(`SyncBanks escuchando en http://localhost:${config.port}`));

if (config.closingHour !== null) {
  startDailyClosings(store, config.closingHour);
  console.log(`Cierre diario: cada día a las ${String(config.closingHour).padStart(2, '0')}:00 (hora de Chile) se cierra el anterior`);
}
