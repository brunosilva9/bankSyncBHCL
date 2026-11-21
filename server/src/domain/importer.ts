import type { DB } from '../db.js';
import { displayAccountNumber, type ParsedCartola, type ParsedMovement } from '../parser/cartola.js';
import { dayDiff } from '../parser/creditCard.js';
import { classifyDescription, titleCase } from './classify.js';
import { recategorize } from './categorize.js';
import { recomputeCreditLine } from './creditLine.js';
import { observedOf, realDateOf, seenStatements } from './seen.js';

/** Para saber la hora de la descarga cuando el archivo no la trae (ver observedOf en seen.ts). */
export interface SeenOptions {
  /** Última modificación del archivo (ms): en uno recién bajado, la hora de la descarga. */
  fileModified?: number | null;
  /** Ahora (ms); se puede fijar en los tests. */
  now?: number;
}

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

// Redacciones distintas que el banco usa para el mismo movimiento. Banco de Chile informa el giro
// automático de la línea el mismo día como "Trasp.fondos A Ctacte-l.cred-c.vista" y, en las cartolas
// siguientes, ese mismo giro (misma fecha y monto) como "Transferencia Desde Linea De Credito". Si no se
// tratan como uno solo, el giro se carga dos veces: descuadra el saldo y el uso de la línea.
const SAME_MOVEMENT: Array<[RegExp, string]> = [[/^(trasp\.fondos a ctacte-l\.cred|transferencia desde linea de credito)/i, 'giro de línea de crédito']];
const matchingDescription = (d: string) => SAME_MOVEMENT.find(([re]) => re.test(d))?.[1] ?? d;

const keyOf = (m: { amount: number; direction: string; description: string; doc_number?: string | null; docNumber?: string | null }) =>
  `${m.direction}|${m.amount}|${matchingDescription(m.description)}|${m.doc_number ?? m.docNumber ?? ''}`;

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
export function importCartola(db: DB, parsed: ParsedCartola, filename: string, userId: number | null, seen: SeenOptions = {}): ImportResult {
  const observed = observedOf(parsed.balanceDate, parsed.downloadedAt ?? null, seen.fileModified ?? null, seen.now ?? Date.now());
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
    // N° de operación, fecha). Por ahora se reemplazan por período, y cuándo se vio cada uno y sus ediciones
    // manuales pasan al movimiento que lo reemplaza (ver carryOver).
    const stash = parsed.statement
      ? removeProvisional(
          db,
          account.id,
          parsed.statement.kind === 'consolidated'
            ? { from: parsed.statement.fromDate ?? parsed.fromDate, to: parsed.statement.toDate ?? parsed.toDate }
            : null,
        )
      : [];
    const provisional = parsed.statement?.kind === 'provisional' ? 1 : 0;

    const importId = Number(
      db
        .prepare(
          `INSERT INTO imports (account_id, filename, balance_date, balance, from_date, to_date, movements_in_file, inserted, user_id,
                                statement_kind, statement_number, observed_at, observed_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
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
          observed.at,
          observed.source,
        ).lastInsertRowid,
    );

    const selectDay = db.prepare(
      'SELECT id, seq, amount, direction, description, doc_number, kind, counterparty, counterparty_rut FROM movements WHERE account_id = ? AND date = ? ORDER BY seq',
    );
    const insert = db.prepare(
      `INSERT INTO movements (account_id, date, seq, amount, direction, description, doc_number, kind, counterparty, counterparty_rut,
                              balance_after, provisional, import_id, first_seen_day, first_seen_at, real_date, real_date_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const seenAgain = seenStatements(db);
    const setSeq = db.prepare('UPDATE movements SET seq = ? WHERE id = ?');
    const setBalance = db.prepare('UPDATE movements SET balance_after = ? WHERE id = ?');
    // La clasificación (tipo y contraparte) es derivada de la descripción: al reimportar se refresca,
    // así una mejora del clasificador también arregla movimientos ya cargados.
    const setClassification = db.prepare('UPDATE movements SET kind = ?, counterparty = ?, counterparty_rut = ? WHERE id = ?');
    const setDescription = db.prepare('UPDATE movements SET description = ? WHERE id = ?');
    const latestCoveringImport = db.prepare(
      "SELECT MAX(balance_date) AS d FROM imports WHERE account_id = ? AND id != ? AND kind = 'account' AND from_date <= ? AND to_date >= ?",
    );

    let inserted = 0;
    let anchorId: number | null = null;
    const fresh: Fresh[] = [];

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
          // Mismo movimiento con otra redacción (ver SAME_MOVEMENT): queda la de la descarga más reciente.
          if (m.description !== match.description && fromBottom) setDescription.run(m.description, match.id);
          const c = classifyDescription(m.description);
          if (c.kind !== match.kind || c.counterparty !== match.counterparty || (c.counterpartyRut ?? null) !== match.counterparty_rut) {
            setClassification.run(c.kind, c.counterparty, c.counterpartyRut ?? null, match.id);
          }
          seenAgain.seen(match.id, observed.day, observed.at);
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
        const real = realDateOf(date, observed.day);
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
            observed.day,
            observed.at,
            real.day,
            real.source,
          ).lastInsertRowid,
        );
        fresh.push({ id, date, direction: m.direction, amount: m.amount, balance: m.balance ?? null, seq });
        if (m.position === 0) anchorId = id;
        inserted++;
      }
    }

    db.prepare('UPDATE imports SET inserted = ?, anchor_movement_id = ? WHERE id = ?').run(inserted, anchorId, importId);
    if (parsed.statement) provisionalFirst(db, account.id);
    carryOver(db, stash, fresh);

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
      replacedProvisional: stash.length,
      warnings,
    };
  })();
}

/** Movimiento provisorio que una cartola nueva reemplazó: lo que hay que pasarle al que lo reemplaza. */
type Replaced = {
  date: string;
  direction: 'C' | 'A';
  amount: number;
  balance_after: number | null;
  first_seen_day: string | null;
  first_seen_at: string | null;
  real_date: string | null;
  real_date_source: string | null;
  category_id: number | null;
  category_source: string | null;
  label: string | null;
  label_source: string | null;
  note: string | null;
};

/** Movimiento que esta carga agregó. */
type Fresh = { id: number; date: string; direction: 'C' | 'A'; amount: number; balance: number | null; seq: number };

/** Borra movimientos provisorios (todos, o los de un período) y devuelve lo que traían. */
function removeProvisional(db: DB, accountId: number, range: { from: string | null; to: string | null } | null): Replaced[] {
  const where = range ? 'AND date >= ? AND date <= ?' : '';
  const args = range ? [accountId, range.from ?? '0000-00-00', range.to ?? '9999-99-99'] : [accountId];
  const replaced = db
    .prepare(
      `SELECT date, direction, amount, balance_after, first_seen_day, first_seen_at, real_date, real_date_source,
              category_id, category_source, label, label_source, note
       FROM movements WHERE account_id = ? AND provisional = 1 ${where}`,
    )
    .all(...args) as Replaced[];
  db.prepare(`DELETE FROM movements WHERE account_id = ? AND provisional = 1 ${where}`).run(...args);
  return replaced;
}

/**
 * Lo provisorio reemplazado le pasa al movimiento que lo reemplaza cuándo se vio por primera vez y las ediciones
 * manuales. Al consolidarlo, el banco puede cambiarle la redacción, el N° de operación y hasta la fecha, así que se
 * busca por pasadas, de la más segura a la más floja: mismo sentido, monto y saldo después (BancoEstado da el
 * saldo de cada fila, que casi no se repite); mismo día, sentido y monto; y mismo sentido y monto a ±3 días, solo
 * si hay un único candidato.
 */
function carryOver(db: DB, stash: Replaced[], fresh: Fresh[]) {
  const used = new Set<number>();
  const free = (s: Replaced) => fresh.filter((f) => !used.has(f.id) && f.direction === s.direction && f.amount === s.amount);
  const passes: Array<(s: Replaced) => Fresh | undefined> = [
    (s) => (s.balance_after === null ? undefined : free(s).filter((f) => f.balance === s.balance_after).sort((a, b) => dayDiff(a.date, s.date) - dayDiff(b.date, s.date))[0]),
    (s) => free(s).filter((f) => f.date === s.date).sort((a, b) => a.seq - b.seq)[0],
    (s) => {
      const near = free(s).filter((f) => dayDiff(f.date, s.date) <= 3);
      return near.length === 1 ? near[0] : undefined;
    },
  ];
  const pairs: Array<[Replaced, Fresh]> = [];
  let pending = stash;
  for (const pass of passes) {
    pending = pending.filter((s) => {
      const f = pass(s);
      if (f) {
        used.add(f.id);
        pairs.push([s, f]);
      }
      return !f;
    });
  }

  const { seen, dated } = seenStatements(db);
  const setCategory = db.prepare("UPDATE movements SET category_id = ?, category_source = 'manual' WHERE id = ?");
  const setLabel = db.prepare("UPDATE movements SET label = ?, label_source = 'manual' WHERE id = ?");
  const setNote = db.prepare('UPDATE movements SET note = ? WHERE id = ?');
  for (const [s, f] of pairs) {
    // Ya estaba en una cartola ese día, y con una fecha que el banco pudo cambiar después.
    if (s.first_seen_day) seen(f.id, s.first_seen_day, s.first_seen_at);
    if (s.real_date) dated(f.id, s.real_date, s.real_date_source ?? 'banco');
    if (s.category_source === 'manual') setCategory.run(s.category_id, f.id);
    if (s.label_source === 'manual') setLabel.run(s.label, f.id);
    if (s.note) setNote.run(s.note, f.id);
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
    .prepare('SELECT id, date, kind, payroll_split_after FROM movements WHERE account_id = ? ORDER BY date ASC, seq DESC')
    .all(accountId) as Array<{ id: number; date: string; kind: string; payroll_split_after: number }>;
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
      // Se recorre de abajo hacia arriba de la cartola: un pago marcado como "último de su nómina"
      // abre una nómina nueva respecto de los que están debajo de él.
      if (!inBlock || r.payroll_split_after) batch++;
      inBlock = true;
      update.run(batch, r.id);
    } else {
      inBlock = false;
      update.run(null, r.id);
    }
  }
}
