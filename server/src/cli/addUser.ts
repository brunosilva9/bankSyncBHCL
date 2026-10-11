// Uso: npm run user:add -- <usuario>   (pide la contraseña por consola, o la lee de SYNCBANKS_PASSWORD)
import readline from 'node:readline/promises';
import { createUser } from '../auth.js';
import { config } from '../config.js';
import { openDb } from '../db.js';

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

const db = openDb(config.dbPath, config.dbKey);
try {
  createUser(db, username, password);
  console.log(`Usuario "${username}" creado.`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
