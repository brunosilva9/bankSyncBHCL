// Uso: npm run user:transfer -- <de> <a>
// Le pasa a <a> todas las cuentas de <de> (movimientos, categorías, reglas, comentarios...). <a> no debe
// tener cuentas; <de> queda sin cuentas. No se copia ni se borra nada: cambia a qué base apunta cada uno.
import { transferData } from '../auth.js';
import { config } from '../config.js';
import { openStore } from '../store.js';

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error('Uso: npm run user:transfer -- <de> <a>');
  process.exit(1);
}

try {
  const { accounts } = transferData(openStore(config.dbPath, config.dbKey), from, to);
  console.log(`Listo: las ${accounts} cuenta(s) de "${from}" ahora son de "${to}". "${from}" quedó sin cuentas.`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
