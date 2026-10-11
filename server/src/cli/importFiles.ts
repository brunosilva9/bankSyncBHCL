// Uso: npm run import -- <archivo.txt> [más archivos...]
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openDb } from '../db.js';
import { calibrateFromLineCartola, isCreditLineCartola } from '../domain/creditLine.js';
import { importCartola } from '../domain/importer.js';
import { parseStatementFile } from '../parser/index.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Uso: npm run import -- <archivo.txt> [más archivos...]');
  process.exit(1);
}

const db = openDb(config.dbPath, config.dbKey);
for (const file of files) {
  const parsed = await parseStatementFile(fs.readFileSync(file));
  if (isCreditLineCartola(parsed)) {
    const c = calibrateFromLineCartola(db, parsed, path.basename(file), null);
    console.log(`${path.basename(file)} -> línea de crédito de ${c.accountName}: usado ${c.used}, disponible ${c.available ?? '(falta el cupo)'}`);
    c.warnings.forEach((w) => console.warn(`  ⚠ ${w}`));
    continue;
  }
  const r = importCartola(db, parsed, path.basename(file), null);
  const kind = r.statement ? (r.statement.kind === 'provisional' ? ' [en línea, provisoria]' : ` [cartola N° ${r.statement.number}]`) : '';
  console.log(`${path.basename(file)} -> ${r.accountName} (${r.accountNumber})${kind}: ${r.inserted} nuevos, ${r.alreadyLoaded} ya cargados, saldo ${r.balance}`);
  if (r.replacedProvisional) console.log(`  reemplazó ${r.replacedProvisional} movimientos provisorios`);
  r.warnings.forEach((w) => console.warn(`  ⚠ ${w}`));
}
