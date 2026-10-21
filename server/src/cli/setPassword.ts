// Uso: npm run user:password -- <usuario>   (pide la contraseña nueva por consola, o la lee de SYNCBANKS_PASSWORD)
// Sin usuario, muestra los usuarios que existen.
import readline from 'node:readline/promises';
import { listUsers, setPassword } from '../auth.js';
import { config } from '../config.js';
import { openDb } from '../db.js';

const db = openDb(config.dbPath, config.dbKey);
const username = process.argv[2];
if (!username) {
  const users = listUsers(db);
  console.log('Uso: npm run user:password -- <usuario>');
  console.log(users.length ? `Usuarios: ${users.join(', ')}` : 'No hay usuarios. Crea uno con: npm run user:add -- <usuario>');
  process.exit(0);
}

let password = process.env.SYNCBANKS_PASSWORD;
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question(`Contraseña nueva para ${username}: `);
  rl.close();
}

try {
  setPassword(db, username, password);
  console.log(`Contraseña de "${username}" cambiada. Sus sesiones abiertas se cerraron.`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
