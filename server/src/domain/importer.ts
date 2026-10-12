import type { DB } from '../db.js';
import { displayAccountNumber, type ParsedCartola, type ParsedMovement } from '../parser/cartola.js';
import { classifyDescription, titleCase } from './classify.js';
import { recategorize } from './categorize.js';
import { recomputeCreditLine } from './creditLine.js';

export interface ImportResult {
  type: 'account';
  importId: number;
  accountId: number;
  accountNumber: string;
  accountName: string;
  fromDate: string | null;
  toDate: string | null;
  movementsInFile: number;
  inserted: number;
  alreadyLoaded: number;
  balance: number;
  bank: string;
  statement: { kind: 'consolidated' | 'provisional'; number: string | null } | null;
  /** Movimientos provisorios (de una cartola en línea) que esta carga reemplazó. */
  replacedProvisional: number;
  warnings: string[];
}

interface StoredMovement {
  id: number;
  seq: number;
  amount: number;
  direction: 'C' | 'A';
  description: string;
  doc_number: string | null;
  kind: string;
  counterparty: string | null;
  counterparty_rut: string | null;
}

const keyOf = (m: { amount: number; direction: string; description: string; doc_number?: string | null; docNumber?: string | null }) =>
  `${m.direction}|${m.amount}|${m.description}|${m.doc_number ?? m.docNumber ?? ''}`;

function groupByDate(movements: ParsedMovement[]): Map<string, ParsedMovement[]> {
  const days = new Map<string, ParsedMovement[]>();
  for (const m of movements) {
    if (!days.has(m.date)) days.set(m.date, []);
    days.get(m.date)!.push(m);
  }
  return days;
}

/**
 * Carga una cartola. Las cartolas se traslapan (cada descarga trae los últimos ~45 días) y el
 * archivo no trae un ID por movimiento; además hay movimientos idénticos legítimos (dos pagos del
 * mismo monto el mismo día). Por eso se compara día por día como multiconjunto: en cada día se
 * agregan solo los movimientos que exceden lo que ya estaba cargado.
 */
export function importCartola(db: DB, parsed: ParsedCartola, filename: string, userId: number | null): ImportResult {
  return db.transaction(() => {
    let account = db.prepare('SELECT id, name FROM accounts WHERE number = ?').get(parsed.accountNumber) as { id: number; name: string } | undefined;
    if (!account) {
      const company = parsed.company?.name ? titleCase(parsed.company.name) : null;
      const name = company ? `${company} (${parsed.bank})` : `Cuenta ${displayAccountNumber(parsed.bank, parsed.accountNumber)}`;
      const id = Number(
        db
          .prepare('INSERT INTO accounts (number, bank, name, rut) VALUES (?, ?, ?, ?)')
          .run(parsed.accountNumber, parsed.bank, name, parsed.company?.rut ?? null).lastInsertRowid,
      );
      account = { id, name };
    }

    // BancoEstado: la cartola en línea es provisoria. Una nueva cartola en línea reemplaza a la anterior
    // completa, y una consolidada reemplaza lo provisorio de su período.
    // TODO: verificar con la cartola 41 real cómo cambian los movimientos al consolidarse (descripción,
    // N° de operación, fecha). Por ahora se reemplazan por período y las ediciones manuales se traspasan
    // al movimiento consolidado del mismo día, sentido y monto.
    const stash = parsed.statement
      ? removeProvisional(
          db,
          account.id,
          parsed.statement.kind === 'consolidated'
            ? { from: parsed.statement.fromDate ?? parsed.fromDate, to: parsed.statement.toDate ?? parsed.toDate }
            : null,
        )
      : Object.assign([] as Annotation[], { removed: 0 });
    const provisional = parsed.statement?.kind === 'provisional' ? 1 : 0;

    const importId = Number(
      db
        .prepare(
          `INSERT INTO imports (account_id, filename, balance_date, balance, from_date, to_date, movements_in_file, inserted, user_id,
                                statement_kind, statement_number)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          account.id,
          filename,
          parsed.balanceDate,
          parsed.balance,
          parsed.fromDate,
          parsed.toDate,
          parsed.movements.length,
          userId,
          parsed.statement?.kind ?? null,
          parsed.statement?.number ?? null,
        ).lastInsertRowid,
    );

    const selectDay = db.prepare(
      'SELECT id, seq, amount, direction, description, doc_number, kind, counterparty, counterparty_rut FROM movements WHERE account_id = ? AND date = ? ORDER BY seq',
    );
    const insert = db.prepare(
      `INSERT INTO movements (account_id, date, seq, amount, direction, description, doc_number, kind, counterparty, counterparty_rut,
                              balance_after, provisional, import_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const setSeq = db.prepare('UPDATE movements SET seq = ? WHERE id = ?');
    const setBalance = db.prepare('UPDATE movements SET balance_after = ? WHERE id = ?');
    // La clasificación (tipo y contraparte) es derivada de la descripción: al reimportar se refresca,
    // así una mejora del clasificador también arregla movimientos ya cargados.
    const setClassification = db.prepare('UPDATE movements SET kind = ?, counterparty = ?, counterparty_rut = ? WHERE id = ?');
    const latestCoveringImport = db.prepare(
      "SELECT MAX(balance_date) AS d FROM imports WHERE account_id = ? AND id != ? AND kind = 'account' AND from_date <= ? AND to_date >= ?",
    );

    let inserted = 0;
    let anchorId: number | null = null;

    for (const [date, incoming] of groupByDate(parsed.movements)) {
      const existing = selectDay.all(account.id, date) as StoredMovement[];
      // Si el archivo trae el día igual o más completo, su orden manda; si no, se respeta el que ya estaba.
      const fileIsAuthority = incoming.length >= existing.length;

      const pool = new Map<string, StoredMovement[]>();
      for (const e of existing) {
        const k = keyOf(e);
        if (!pool.has(k)) pool.set(k, []);
        pool.get(k)!.push(e);
      }

      // Con movimientos idénticos importa cuáles se emparejan. Un día crece por arriba (movimientos
      // nuevos) y una cartola corta el día más antiguo por abajo. Si lo cargado viene de una descarga
      // anterior a este archivo, lo nuevo está arriba: se empareja de abajo hacia arriba; si no, al revés.
      const lastSnapshot = (latestCoveringImport.get(account.id, importId, date, date) as { d: string | null }).d;
      const fromBottom = lastSnapshot === null || lastSnapshot <= parsed.balanceDate;

      const matchedIds = new Set<number>();
      const toInsert: Array<{ m: ParsedMovement; seq: number }> = [];
      const order = incoming.map((m, i) => ({ m, i }));
      if (fromBottom) order.reverse();
      for (const { m, i } of order) {
        const candidates = pool.get(keyOf(m));
        const match = fromBottom ? candidates?.pop() : candidates?.shift();
        if (match) {
          matchedIds.add(match.id);
          if (fileIsAuthority) setSeq.run(i, match.id);
          if (m.balance !== undefined) setBalance.run(m.balance, match.id);
          const c = classifyDescription(m.description);
          if (c.kind !== match.kind || c.counterparty !== match.counterparty || (c.counterpartyRut ?? null) !== match.counterparty_rut) {
            setClassification.run(c.kind, c.counterparty, c.counterpartyRut ?? null, match.id);
          }
          if (m.position === 0) anchorId = match.id;
        } else {
          toInsert.push({ m, seq: fileIsAuthority ? i : existing.length + toInsert.length });
        }
      }

      if (fileIsAuthority) {
        // Lo que estaba y el archivo no trae queda después (más antiguo) en el día.
        existing.filter((e) => !matchedIds.has(e.id)).forEach((e, j) => setSeq.run(incoming.length + j, e.id));
      }

      for (const { m, seq } of toInsert) {
        const c = classifyDescription(m.description);
        const id = Number(
          insert.run(
            account.id,
            date,
            seq,
            m.amount,
            m.direction,
            m.description,
            m.docNumber,
            c.kind,
            c.counterparty,
            c.counterpartyRut ?? null,
            m.balance ?? null,
            provisional,
            importId,
          ).lastInsertRowid,
        );
        if (m.position === 0) anchorId = id;
        inserted++;
      }
    }

    db.prepare('UPDATE imports SET inserted = ?, anchor_movement_id = ? WHERE id = ?').run(inserted, anchorId, importId);
    if (parsed.statement) provisionalFirst(db, account.id);
    restoreAnnotations(db, account.id, stash);

    recategorize(db);
    const warnings = recomputeBalances(db, account.id);
    recomputeCreditLine(db, account.id);
    recomputePayrollBatches(db, account.id);

    return {
      type: 'account' as const,
      importId,
      accountId: account.id,
      accountNumber: displayAccountNumber(parsed.bank, parsed.accountNumber),
      accountName: account.name,
      fromDate: parsed.fromDate,
      toDate: parsed.toDate,
      movementsInFile: parsed.movements.length,
      inserted,
      alreadyLoaded: parsed.movements.length - inserted,
      balance: parsed.balance,
      bank: parsed.bank,
      statement: parsed.statement ? { kind: parsed.statement.kind, number: parsed.statement.number } : null,
      replacedProvisional: stash.removed,
      warnings,
    };
  })();
}

type Annotation = {
  date: string;
  direction: 'C' | 'A';
  amount: number;
  category_id: number | null;
  category_source: string | null;
  label: string | null;
  label_source: string | null;
  note: string | null;
};

/** Borra movimientos provisorios (todos, o los de un período) guardando sus ediciones manuales. */
function removeProvisional(db: DB, accountId: number, range: { from: string | null; to: string | null } | null) {
  const where = range ? 'AND date >= ? AND date <= ?' : '';
  const args = range ? [accountId, range.from ?? '0000-00-00', range.to ?? '9999-99-99'] : [accountId];
  const annotated = db
    .prepare(
      `SELECT date, direction, amount, category_id, category_source, label, label_source, note FROM movements
       WHERE account_id = ? AND provisional = 1 ${where}
         AND (category_source = 'manual' OR label_source = 'manual' OR note IS NOT NULL)`,
    )
    .all(...args) as Annotation[];
  const removed = db.prepare(`DELETE FROM movements WHERE account_id = ? AND provisional = 1 ${where}`).run(...args).changes;
  return Object.assign(annotated, { removed });
}

/** Traspasa las ediciones manuales al movimiento nuevo del mismo día, sentido y monto. */
function restoreAnnotations(db: DB, accountId: number, stash: Annotation[]) {
  const find = db.prepare(
    `SELECT id FROM movements
     WHERE account_id = ? AND date = ? AND direction = ? AND amount = ?
       AND category_source IS NOT 'manual' AND label_source IS NOT 'manual' AND note IS NULL
     ORDER BY seq LIMIT 1`,
  );
  for (const a of stash) {
    const target = find.get(accountId, a.date, a.direction, a.amount) as { id: number } | undefined;
    if (!target) continue;
    if (a.category_source === 'manual') db.prepare("UPDATE movements SET category_id = ?, category_source = 'manual' WHERE id = ?").run(a.category_id, target.id);
    if (a.label_source === 'manual') db.prepare("UPDATE movements SET label = ?, label_source = 'manual' WHERE id = ?").run(a.label, target.id);
    if (a.note) db.prepare('UPDATE movements SET note = ? WHERE id = ?').run(a.note, target.id);
  }
}

/** Lo provisorio ocurrió después del corte de la última consolidada: dentro del día va primero (más reciente). */
function provisionalFirst(db: DB, accountId: number) {
  const days = db.prepare('SELECT DISTINCT date FROM movements WHERE account_id = ? AND provisional = 1').all(accountId) as Array<{ date: string }>;
  const rows = db.prepare('SELECT id FROM movements WHERE account_id = ? AND date = ? ORDER BY provisional DESC, seq ASC');
  const setSeq = db.prepare('UPDATE movements SET seq = ? WHERE id = ?');
  for (const { date } of days) (rows.all(accountId, date) as Array<{ id: number }>).forEach((r, i) => setSeq.run(i, r.id));
}

const effect = (m: { amount: number; direction: 'C' | 'A' }) => (m.direction === 'A' ? m.amount : -m.amount);

/**
 * La cartola .txt no trae saldo por movimiento, solo el saldo contable al momento de descargarla.
 * Se reconstruye hacia atrás desde la descarga más reciente. Luego se verifica que el saldo de
 * cada descarga anterior calce; si no calza, faltan movimientos (hay un hueco entre cartolas).
 */
export function recomputeBalances(db: DB, accountId: number): string[] {
  // BancoEstado entrega el saldo de cada movimiento: no hay nada que reconstruir.
  const bank = (db.prepare('SELECT bank FROM accounts WHERE id = ?').get(accountId) as { bank: string }).bank;
  if (bank === 'BancoEstado') return checkBalances(db, accountId);

  const latest = db
    .prepare(
      "SELECT balance FROM imports WHERE account_id = ? AND kind = 'account' AND anchor_movement_id IS NOT NULL ORDER BY balance_date DESC, id DESC LIMIT 1",
    )
    .get(accountId) as { balance: number } | undefined;
  if (!latest) return [];

  const rows = db
    .prepare('SELECT id, amount, direction FROM movements WHERE account_id = ? ORDER BY date DESC, seq ASC')
    .all(accountId) as Array<{ id: number; amount: number; direction: 'C' | 'A' }>;

  const update = db.prepare('UPDATE movements SET balance_after = ? WHERE id = ?');
  let balance = latest.balance;
  for (const m of rows) {
    update.run(balance, m.id);
    balance -= effect(m);
  }
  return checkBalances(db, accountId);
}

export function checkBalances(db: DB, accountId?: number): string[] {
  const checks = db
    .prepare(
      `SELECT i.filename, i.balance, i.balance_date, m.balance_after, m.date
       FROM imports i JOIN movements m ON m.id = i.anchor_movement_id
       ${accountId ? 'WHERE i.account_id = ?' : ''}`,
    )
    .all(...(accountId ? [accountId] : [])) as Array<{ filename: string; balance: number; balance_date: string; balance_after: number; date: string }>;

  return checks
    .filter((c) => c.balance !== c.balance_after)
    .map(
      (c) =>
        `El saldo de "${c.filename}" (descargada el ${c.balance_date}) no calza con los movimientos cargados ` +
        `(${c.balance} vs ${c.balance_after}). Probablemente falta una cartola entre esa fecha y la siguiente.`,
    );
}

/**
 * La cartola no trae un identificador de nómina, pero cada nómina de Pago Fácil se procesa de una vez
 * y sus líneas quedan contiguas. Dentro de un día, cada bloque de Pago Fácil sin otros movimientos entre
 * medio se considera una nómina distinta. (Dos nóminas cargadas seguidas, sin nada entre medio, quedan
 * en el mismo bloque.)
 */
export function recomputePayrollBatches(db: DB, accountId: number) {
  const rows = db
    .prepare('SELECT id, date, kind FROM movements WHERE account_id = ? ORDER BY date ASC, seq DESC')
    .all(accountId) as Array<{ id: number; date: string; kind: string }>;
  const update = db.prepare('UPDATE movements SET payroll_batch = ? WHERE id = ?');
  let date = '';
  let batch = 0;
  let inBlock = false;
  for (const r of rows) {
    if (r.date !== date) {
      date = r.date;
      batch = 0;
      inBlock = false;
    }
    if (r.kind === 'payroll') {
      if (!inBlock) batch++;
      inBlock = true;
      update.run(batch, r.id);
    } else {
      inBlock = false;
      update.run(null, r.id);
    }
  }
}
