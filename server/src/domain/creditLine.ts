import type { DB } from '../db.js';
import { formatAccountNumber, type ParsedCartola } from '../parser/cartola.js';
import { classifyDescription } from './classify.js';

// La línea de crédito es otra cuenta en el banco, pero cada giro y cada amortización aparece también
// en la cuenta corriente ("Transferencia Desde Linea De Credito", "Trasp.fondos A Ctacte-l.cred",
// "Amortizacion A Linea De Credito"). Con un punto de calibración (cuánto estaba usado en un momento)
// el uso se sigue solo desde la cartola de la cuenta corriente, sin necesitar la cartola de la línea.

/** Variación del monto usado de la línea que produce un movimiento de la cuenta corriente. */
export function usedDelta(m: { kind: string; direction: 'C' | 'A'; amount: number }): number {
  if (m.kind !== 'credit_line') return 0;
  return m.direction === 'A' ? m.amount : -m.amount; // abono en cta cte = giro; cargo = amortización
}

/** Calcula el monto usado de la línea después de cada movimiento, a partir del punto de calibración. */
export function recomputeCreditLine(db: DB, accountId: number) {
  const acc = db.prepare('SELECT credit_used_anchor, credit_anchor_movement_id FROM accounts WHERE id = ?').get(accountId) as
    | { credit_used_anchor: number | null; credit_anchor_movement_id: number | null }
    | undefined;
  const clear = () => db.prepare('UPDATE movements SET credit_used_after = NULL WHERE account_id = ?').run(accountId);
  if (!acc || acc.credit_used_anchor === null || acc.credit_anchor_movement_id === null) return clear();

  const rows = db
    .prepare('SELECT id, kind, direction, amount FROM movements WHERE account_id = ? ORDER BY date DESC, seq ASC')
    .all(accountId) as Array<{ id: number; kind: string; direction: 'C' | 'A'; amount: number }>;

  // Uso relativo al movimiento más reciente, recorriendo hacia atrás.
  const relative = new Map<number, number>();
  let rel = 0;
  for (const m of rows) {
    relative.set(m.id, rel);
    rel -= usedDelta(m);
  }
  const anchorRel = relative.get(acc.credit_anchor_movement_id);
  if (anchorRel === undefined) return clear();

  const newest = acc.credit_used_anchor - anchorRel;
  const update = db.prepare('UPDATE movements SET credit_used_after = ? WHERE id = ?');
  for (const m of rows) update.run(newest + relative.get(m.id)!, m.id);
}

/** Uso de la línea calculado justo después de un movimiento (null si no hay calibración). */
function usedAfter(db: DB, movementId: number): number | null {
  const r = db.prepare('SELECT credit_used_after FROM movements WHERE id = ?').get(movementId) as { credit_used_after: number | null } | undefined;
  return r?.credit_used_after ?? null;
}

function setAnchor(db: DB, accountId: number, used: number, movementId: number) {
  db.prepare('UPDATE accounts SET credit_used_anchor = ?, credit_anchor_movement_id = ? WHERE id = ?').run(used, movementId, accountId);
  recomputeCreditLine(db, accountId);
}

/** Calibración manual: "hoy la línea tiene X disponible según el banco". */
export function calibrateFromAvailable(db: DB, accountId: number, available: number) {
  const acc = db.prepare('SELECT credit_limit FROM accounts WHERE id = ?').get(accountId) as { credit_limit: number | null } | undefined;
  if (!acc?.credit_limit) throw new Error('Primero define el cupo de la línea de crédito');
  const newest = db.prepare('SELECT id FROM movements WHERE account_id = ? ORDER BY date DESC, seq ASC LIMIT 1').get(accountId) as
    | { id: number }
    | undefined;
  if (!newest) throw new Error('La cuenta no tiene movimientos cargados');
  setAnchor(db, accountId, acc.credit_limit - available, newest.id);
}

/** Una cartola de línea de crédito solo trae giros y amortizaciones. */
export function isCreditLineCartola(parsed: ParsedCartola): boolean {
  return parsed.movements.length > 0 && parsed.movements.every((m) => classifyDescription(m.description).kind === 'credit_line');
}

export interface CreditLineImportResult {
  type: 'credit_line';
  accountId: number;
  accountName: string;
  lineNumber: string;
  used: number;
  available: number | null;
  previousUsed: number | null;
  warnings: string[];
}

/**
 * Usa la cartola de la línea para calibrar (no se cargan sus movimientos: son los mismos de la cuenta
 * corriente vistos del otro lado). El saldo de la línea incluye el sobregiro de la cuenta corriente en
 * ese momento, así que lo realmente girado es: |saldo línea| − sobregiro.
 */
export function calibrateFromLineCartola(db: DB, parsed: ParsedCartola, filename: string, userId: number | null): CreditLineImportResult {
  const accounts = db.prepare('SELECT id, number, name, credit_limit FROM accounts').all() as Array<{
    id: number;
    number: string;
    name: string;
    credit_limit: number | null;
  }>;
  // La línea y su cuenta corriente comparten la parte central del número (ej. 1-23456789-10 y 0-23456789-09).
  let linked = accounts.filter((a) => a.number.slice(1, 9) === parsed.accountNumber.slice(1, 9));
  if (linked.length !== 1) {
    linked = accounts.filter((a) => db.prepare("SELECT 1 FROM movements WHERE account_id = ? AND kind = 'credit_line' LIMIT 1").get(a.id));
  }
  if (linked.length !== 1) throw new Error('No pude identificar a qué cuenta corriente pertenece esta línea de crédito');
  const account = linked[0];

  const snapshot = db
    .prepare(
      `SELECT balance, anchor_movement_id FROM imports
       WHERE account_id = ? AND kind = 'account' AND balance_date = ? AND anchor_movement_id IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(account.id, parsed.balanceDate) as { balance: number; anchor_movement_id: number } | undefined;
  if (!snapshot) {
    throw new Error(
      `Para calibrar la línea hace falta la cartola de la cuenta corriente de ${account.name} descargada el mismo día (${parsed.balanceDate}). Impórtala primero.`,
    );
  }

  return db.transaction(() => {
    const previousUsed = usedAfter(db, snapshot.anchor_movement_id);
    const overdraft = Math.max(0, -snapshot.balance);
    const used = Math.max(0, -parsed.balance - overdraft);
    setAnchor(db, account.id, used, snapshot.anchor_movement_id);

    db.prepare(
      `INSERT INTO imports (account_id, filename, balance_date, balance, from_date, to_date, movements_in_file, inserted, user_id, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'credit_line')`,
    ).run(account.id, filename, parsed.balanceDate, parsed.balance, parsed.fromDate, parsed.toDate, parsed.movements.length, userId);

    const warnings: string[] = [];
    if (previousUsed !== null && previousUsed !== used) {
      warnings.push(`El uso calculado de la línea era ${previousUsed} y según esta cartola es ${used}; se recalibró.`);
    }
    if (!account.credit_limit) warnings.push('Falta definir el cupo de la línea en Configuración → Cuentas para calcular el disponible.');

    return {
      type: 'credit_line' as const,
      accountId: account.id,
      accountName: account.name,
      lineNumber: formatAccountNumber(parsed.accountNumber),
      used,
      available: account.credit_limit ? account.credit_limit - used : null,
      previousUsed,
      warnings,
    };
  })();
}
