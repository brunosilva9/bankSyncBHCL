// Uso: npm run user:add -- <usuario>   (pide la contraseña por consola, o la lee de SYNCBANKS_PASSWORD)
// Crea un administrador. Los usuarios de cada administrador se crean desde la app, en Usuarios.
import readline from 'node:readline/promises';
import { createUser } from '../auth.js';
import { config } from '../config.js';
import { openStore } from '../store.js';

const username = process.argv[2];
if (!username) {
  console.error('Uso: npm run user:add -- <usuario>');
  process.exit(1);
}

let password = process.env.SYNCBANKS_PASSWORD;
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question(`Contraseña para ${username}: `);
  rl.close();
}

const store = openStore(config.dbPath, config.dbKey);
try {
  createUser(store.auth, username, password, { role: 'admin' });
  console.log(`Administrador "${username}" creado. Sus usuarios se crean desde la app, en Usuarios.`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
