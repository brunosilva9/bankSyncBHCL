// Red de seguridad con cartolas reales, para cambiar los lectores sin romper lo que ya funciona.
// Pasa cada archivo de las carpetas indicadas por el lector actual y guarda un resumen por archivo
// (o lo compara con el guardado). La foto queda en data/ (fuera de git): tiene datos reales.
//
//   npm run check:real -- guardar  <carpetas...>   antes de tocar los lectores
//   npm run check:real -- comparar <carpetas...>   después: lo que ya se leía debe dar exactamente lo mismo
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { parseStatementFile } from '../parser/index.js';

const [mode, ...dirs] = process.argv.slice(2);
if (!['guardar', 'comparar'].includes(mode ?? '') || dirs.length === 0) {
  console.error('Uso: npm run check:real -- guardar|comparar <carpetas con cartolas>');
  process.exit(1);
}
const SNAPSHOT = path.join(path.dirname(config.dbPath), 'cartolas-reales-foto.json');
const sha = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

type Entry = { ok: true; summary: Record<string, unknown> } | { ok: false; error: string };
const now: Record<string, Entry> = {};
for (const dir of dirs) {
  for (const f of fs.readdirSync(dir).filter((f) => /\.(txt|xlsx?)$/i.test(f))) {
    const bytes = fs.readFileSync(path.join(dir, f));
    const key = `${sha(bytes)} ${f}`; // el mismo archivo en dos carpetas cuenta una vez
    try {
      const p = await parseStatementFile(bytes);
      now[key] = {
        ok: true,
        summary: {
          bank: p.bank,
          account: p.accountNumber,
          balance: p.balance,
          balanceDate: p.balanceDate,
          from: p.fromDate,
          to: p.toDate,
          statement: p.statement ?? null,
          company: p.company ?? null,
          movements: p.movements.length,
          movementsHash: sha(JSON.stringify(p.movements)),
        },
      };
    } catch (e) {
      now[key] = { ok: false, error: (e as Error).message };
    }
  }
}
const readable = Object.values(now).filter((e) => e.ok).length;

if (mode === 'guardar') {
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, JSON.stringify(now));
  console.log(`Foto guardada en ${SNAPSHOT}: ${Object.keys(now).length} archivos, ${readable} se leen hoy.`);
} else {
  if (!fs.existsSync(SNAPSHOT)) {
    console.error('No hay foto guardada: corre primero "guardar".');
    process.exit(1);
  }
  const before = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as Record<string, Entry>;
  let changed = 0;
  let improved = 0;
  for (const [key, prev] of Object.entries(before)) {
    const cur = now[key];
    if (!cur) continue;
    if (prev.ok && JSON.stringify(prev) !== JSON.stringify(cur)) {
      changed++;
      console.log(`CAMBIÓ ${key.slice(17)}\n  antes: ${JSON.stringify(prev)}\n  ahora: ${JSON.stringify(cur)}`);
    } else if (!prev.ok && cur.ok) {
      improved++;
      console.log(`NUEVO  ${key.slice(17)} ahora se lee`);
    }
  }
  console.log(`\n${changed ? 'ATENCIÓN' : 'OK'}: ${changed} de ${Object.values(before).filter((e) => e.ok).length} archivos que ya se leían cambiaron; ${improved} archivos nuevos se leen.`);
  process.exitCode = changed ? 1 : 0;
}
