// Uso: npm run import -- <usuario> <archivo.txt> [más archivos...]   (a las cuentas de ese usuario)
import fs from 'node:fs';
import path from 'node:path';
import { findUser } from '../auth.js';
import { config } from '../config.js';
import { calibrateFromLineCartola, isCreditLineCartola } from '../domain/creditLine.js';
import { importCard } from '../domain/creditCard.js';
import { importCartola } from '../domain/importer.js';
import { isCard, parseStatementFile } from '../parser/index.js';
import { openStore } from '../store.js';

const [username, ...files] = process.argv.slice(2);
if (!username || files.length === 0) {
  console.error('Uso: npm run import -- <usuario> <archivo.txt> [más archivos...]');
  process.exit(1);
}

const store = openStore(config.dbPath, config.dbKey);
let user;
try {
  user = findUser(store.auth, username);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const db = store.data(user.data_file);
for (const file of files) {
  const parsed = await parseStatementFile(fs.readFileSync(file));
  if (isCard(parsed)) {
    const r = importCard(db, parsed, path.basename(file), user.id);
    const confirmed = r.confirmed ? `, ${r.confirmed} confirmados por el estado de cuenta` : '';
    console.log(`${path.basename(file)} -> ${r.accountName}${r.billed ? ' [facturados]' : ' [por facturar]'}: ${r.inserted} nuevos, ${r.alreadyLoaded} ya cargados${confirmed}`);
    continue;
  }
  if (isCreditLineCartola(parsed)) {
    const c = calibrateFromLineCartola(db, parsed, path.basename(file), user.id);
    console.log(`${path.basename(file)} -> línea de crédito de ${c.accountName}: usado ${c.used}, disponible ${c.available ?? '(falta el cupo)'}`);
    c.warnings.forEach((w) => console.warn(`  ⚠ ${w}`));
    continue;
  }
  // La última modificación del archivo: en uno recién bajado, la hora de la descarga.
  const r = importCartola(db, parsed, path.basename(file), user.id, { fileModified: Math.round(fs.statSync(file).mtimeMs) });
  const kind = r.statement ? (r.statement.kind === 'provisional' ? ' [en línea, provisoria]' : ` [cartola N° ${r.statement.number}]`) : '';
  console.log(`${path.basename(file)} -> ${r.accountName} (${r.accountNumber})${kind}: ${r.inserted} nuevos, ${r.alreadyLoaded} ya cargados, saldo ${r.balance}`);
  if (r.replacedProvisional) console.log(`  reemplazó ${r.replacedProvisional} movimientos provisorios`);
  r.warnings.forEach((w) => console.warn(`  ⚠ ${w}`));
}
