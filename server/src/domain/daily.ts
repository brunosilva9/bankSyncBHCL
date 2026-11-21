// Vista día por día: saldo inicial y final de cada día, sus movimientos y los hitos. Un hito es una cartola
// importada, con el saldo que informó el banco al descargarla. Entre dos hitos de una cuenta, lo que el banco
// dice que cambió el saldo tiene que ser lo que suman los movimientos cargados entre medio; si no, falta o
// sobra algo (p. ej. una cartola que no se cargó).
import crypto from 'node:crypto';
import type { DB } from '../db.js';
import { addDays, chileDay, daysBetween } from '../time.js';
import { usedDelta } from './creditLine.js';
import { buildReport, dayColumn, type AccountSummary, type DateMode, type Report } from './report.js';

export interface Hito {
  importId: number;
  accountId: number;
  accountName: string;
  /** Día de la descarga: la fecha de la línea de saldo (Banco de Chile) o de la hoja Resumen (BancoEstado). */
  day: string;
  /** Cuándo se subió a la app, UTC ("YYYY-MM-DD HH:MM:SS"). */
  importedAt: string;
  /** Hora de la descarga (UTC, ISO), si se sabe, y de dónde salió (ver domain/seen.ts). */
  observedAt: string | null;
  observedSource: 'banco' | 'archivo' | 'subida' | null;
  filename: string;
  /** BancoEstado: cartola consolidada (histórica) o en línea (provisoria). */
  statement: 'consolidated' | 'provisional' | null;
  /** Saldo que informó el banco. */
  balance: number;
  /**
   * Movimiento más reciente del archivo: el saldo del banco es el de justo después de él. null si el archivo no
   * traía movimientos o si eran provisorios que otra cartola ya reemplazó.
   */
  anchor: { id: number; date: string; realDate: string } | null;
  /** Saldo según los movimientos cargados, justo después del ancla. */
  computed: number | null;
  /** Saldo del banco − saldo calculado. En Banco de Chile el saldo se reconstruye desde la cartola más reciente. */
  check: number | null;
  /** Cartola anterior de la misma cuenta, en el orden de sus anclas: con ella se compara. */
  previous: { importId: number; day: string; balance: number } | null;
  /** Desde la cartola anterior: cuánto cambió el saldo según el banco… */
  bankChange: number | null;
  /** …cuánto suman los movimientos cargados entre medio, y cuántos son. */
  movementsChange: number | null;
  movementsBetween: number | null;
  /** Lo que los movimientos no explican: bankChange − movementsChange. 0 = cuadra. */
  diff: number | null;
  /**
   * Otra cartola de la cuenta con la diferencia contraria. Pasa cuando un movimiento quedó en un tramo
   * distinto del que el banco tenía en su saldo, p. ej. uno que el banco agregó después con fecha anterior
   * (tardío): descuadra el tramo de su fecha y el tramo en que apareció. Juntas cuadran: no falta plata.
   */
  pair: { importId: number; day: string } | null;
}

type ImportRow = {
  id: number;
  filename: string;
  imported_at: string;
  observed_at: string | null;
  observed_source: Hito['observedSource'];
  balance_date: string;
  balance: number;
  anchor_movement_id: number | null;
  statement_kind: 'consolidated' | 'provisional' | null;
};

type MovementRow = { id: number; date: string; real_date: string | null; amount: number; direction: 'C' | 'A'; balance_after: number | null };

const effect = (m: { amount: number; direction: 'C' | 'A' }) => (m.direction === 'A' ? m.amount : -m.amount);

/** Hitos de las cuentas (las tarjetas no tienen saldo), por día de descarga y hora de subida. */
export function hitosOf(db: DB, accountIds?: number[]): Hito[] {
  const accounts = (db.prepare("SELECT id, name FROM accounts WHERE kind != 'tarjeta_credito' ORDER BY name").all() as Array<{ id: number; name: string }>).filter(
    (a) => !accountIds?.length || accountIds.includes(a.id),
  );
  const importsOf = db.prepare(
    `SELECT id, filename, imported_at, observed_at, observed_source, balance_date, balance, anchor_movement_id, statement_kind
     FROM imports WHERE account_id = ? AND kind = 'account' ORDER BY id`,
  );
  // Orden cronológico: por fecha y, dentro del día, del más antiguo (seq mayor) al más reciente (seq 0).
  const movementsOf = db.prepare('SELECT id, date, real_date, amount, direction, balance_after FROM movements WHERE account_id = ? ORDER BY date ASC, seq DESC');

  const hitos: Hito[] = [];
  for (const a of accounts) {
    const movements = movementsOf.all(a.id) as MovementRow[];
    const position = new Map(movements.map((m, i) => [m.id, i]));
    // Suma acumulada de los efectos: lo que movieron los movimientos entre dos anclas sale de una resta.
    const running: number[] = [];
    movements.forEach((m, i) => (running[i] = (i > 0 ? running[i - 1] : 0) + effect(m)));

    const rows = (importsOf.all(a.id) as ImportRow[]).map((r) => ({
      r,
      at: r.anchor_movement_id === null ? undefined : position.get(r.anchor_movement_id),
    }));
    // Cada cartola se compara con la anterior según la posición de su ancla, no según cuándo se subió (una
    // consolidada puede subirse después que cartolas más nuevas). Con la misma ancla, va primero la que se
    // descargó antes.
    const anchored = rows
      .filter((x): x is { r: ImportRow; at: number } => x.at !== undefined)
      .sort((x, y) => x.at - y.at || x.r.balance_date.localeCompare(y.r.balance_date) || x.r.id - y.r.id);
    const previousOf = new Map(anchored.map((x, i) => [x.r.id, i > 0 ? anchored[i - 1] : null]));

    const mine = new Map<number, Hito>();
    for (const { r, at } of rows) {
      const anchor = at === undefined ? null : movements[at];
      const prev = previousOf.get(r.id) ?? null;
      const computed = anchor?.balance_after ?? null;
      const bankChange = at !== undefined && prev ? r.balance - prev.r.balance : null;
      const movementsChange = at !== undefined && prev ? running[at] - running[prev.at] : null;
      mine.set(r.id, {
        importId: r.id,
        accountId: a.id,
        accountName: a.name,
        day: r.balance_date,
        importedAt: r.imported_at,
        observedAt: r.observed_at,
        observedSource: r.observed_source,
        filename: r.filename,
        statement: r.statement_kind,
        balance: r.balance,
        anchor: anchor ? { id: anchor.id, date: anchor.date, realDate: anchor.real_date ?? anchor.date } : null,
        computed,
        check: computed === null ? null : r.balance - computed,
        previous: prev ? { importId: prev.r.id, day: prev.r.balance_date, balance: prev.r.balance } : null,
        bankChange,
        movementsChange,
        movementsBetween: at !== undefined && prev ? at - prev.at : null,
        diff: bankChange !== null && movementsChange !== null ? bankChange - movementsChange : null,
        pair: null,
      });
    }

    // Diferencias que se compensan: la primera que no cuadra se junta con la siguiente de monto contrario.
    const chain = anchored.map((x) => mine.get(x.r.id)!);
    chain.forEach((a, i) => {
      if (!a.diff || a.pair) return;
      const b = chain.slice(i + 1).find((x) => x.diff === -a.diff! && !x.pair);
      if (!b) return;
      a.pair = { importId: b.importId, day: b.day };
      b.pair = { importId: a.importId, day: a.day };
    });
    hitos.push(...mine.values());
  }
  // Dentro del día, por hora de descarga (o de subida, si no se sabe).
  const when = (h: Hito) => Date.parse(h.observedAt ?? `${h.importedAt.replace(' ', 'T')}Z`);
  return hitos.sort((x, y) => x.day.localeCompare(y.day) || when(x) - when(y) || x.importId - y.importId);
}

export type DayAccount = AccountSummary & { movements: number };

export interface DaySummary {
  day: string;
  /** Movimientos de ese día: por fecha real o por la del banco, según el modo. */
  movements: number;
  /** Con fecha del banco de este día, pero de un día anterior: ya estaban en la cartola de ese día. */
  seenBefore: number;
  /** De este día, pero el banco los fechó después (ver domain/seen.ts). */
  datedLater: number;
  totals: Report['totals'];
  /** Cada cuenta por separado: saldo inicial y final, entradas, gastos… (lo mismo que el informe de ese día). */
  accounts: DayAccount[];
  /** Cartolas descargadas ese día. */
  hitos: Hito[];
}

/**
 * Un resumen por día, del más reciente al más antiguo. Llega hasta hoy (hora de Chile), salvo que haya
 * movimientos con fecha posterior: por fecha del banco, lo que se hace de noche o en fin de semana queda en el día
 * hábil siguiente.
 */
export function buildDays(db: DB, params: { from: string; to: string; accountIds?: number[]; dates?: DateMode }, today = chileDay()): DaySummary[] {
  const DAY = dayColumn(params.dates);
  const lastMovement = (db.prepare(`SELECT MAX(${DAY}) AS d FROM movements`).get() as { d: string | null }).d;
  const limit = lastMovement && lastMovement > today ? lastMovement : today;
  const to = params.to < limit ? params.to : limit;
  const hitos = hitosOf(db, params.accountIds);
  const countsOf = db.prepare(`SELECT account_id, COUNT(*) AS n FROM movements WHERE ${DAY} = ? GROUP BY account_id`);
  const beforeOf = db.prepare('SELECT account_id, COUNT(*) AS n FROM movements WHERE date = ? AND COALESCE(real_date, date) < date GROUP BY account_id');
  const laterOf = db.prepare('SELECT account_id, COUNT(*) AS n FROM movements WHERE COALESCE(real_date, date) = ? AND date > COALESCE(real_date, date) GROUP BY account_id');
  const byAccount = (rows: unknown) => new Map((rows as Array<{ account_id: number; n: number }>).map((c) => [c.account_id, c.n]));

  return daysBetween(params.from, to)
    .reverse()
    .map((day) => {
      const report = buildReport(db, { from: day, to: day, accountIds: params.accountIds, dates: params.dates });
      const counts = byAccount(countsOf.all(day));
      const before = byAccount(beforeOf.all(day));
      const later = byAccount(laterOf.all(day));
      const accounts = report.accounts.map((a) => ({ ...a, movements: counts.get(a.accountId) ?? 0 }));
      const sum = (m: Map<number, number>) => report.accounts.reduce((s, a) => s + (m.get(a.accountId) ?? 0), 0);
      return {
        day,
        movements: accounts.reduce((s, a) => s + a.movements, 0),
        seenBefore: sum(before),
        datedLater: sum(later),
        totals: report.totals,
        accounts,
        hitos: hitos.filter((h) => h.day === day),
      };
    });
}

/** Una cuenta al final de un día (ver dailyBalances). */
export interface BalancePoint {
  day: string;
  /** Saldo al final del día; null si la cuenta no tiene movimientos cargados. */
  closing: number | null;
  /** Saldo + línea disponible: lo que el informe llama disponible (sin línea calibrada, igual al saldo). */
  available: number | null;
  /** Cartolas descargadas ese día y la hora de descarga de la última (UTC, ISO), si se sabe. */
  cartolas: number;
  lastSeenAt: string | null;
  /** Cuándo se subió a la app la última cartola de ese día (UTC, "YYYY-MM-DD HH:MM:SS"): si no se sabe cuándo se bajó. */
  lastImportedAt: string | null;
}

export interface AccountBalances {
  accountId: number;
  name: string;
  /** Con línea de crédito calibrada: su disponible es saldo + línea. */
  hasCredit: boolean;
  /** Al empezar el primer día: el saldo inicial del informe. */
  opening: { closing: number | null; available: number | null };
  days: BalancePoint[];
}

export interface DailyBalances {
  from: string;
  /** Hasta hoy, como buildDays: después no hay saldo que mostrar. */
  to: string;
  accounts: AccountBalances[];
}

/**
 * El saldo al final de cada día por cuenta (las tarjetas no tienen saldo), para la línea de tiempo del informe. Da lo
 * mismo que buildReport de ese solo día (closing y availableClosing), pero en una pasada: un informe por día
 * recorre todo lo fechado después una vez por día, y un año tardaba segundos. Si cambia cómo calcula el saldo
 * buildReport, cambiarlo aquí también (test/balances.test.ts compara los dos).
 */
export function dailyBalances(db: DB, params: { from: string; to: string; accountIds?: number[]; dates?: DateMode }, today = chileDay()): DailyBalances {
  const real = (params.dates ?? 'real') === 'real';
  const DAY = dayColumn(params.dates);
  const lastMovement = (db.prepare(`SELECT MAX(${DAY}) AS d FROM movements`).get() as { d: string | null }).d;
  const limit = lastMovement && lastMovement > today ? lastMovement : today;
  const to = params.to < limit ? params.to : limit;
  const days = daysBetween(params.from, to);

  const accounts = (
    db.prepare("SELECT id, name, credit_limit, credit_used_anchor FROM accounts WHERE kind != 'tarjeta_credito' ORDER BY name").all() as Array<{
      id: number;
      name: string;
      credit_limit: number | null;
      credit_used_anchor: number | null;
    }>
  ).filter((a) => !params.accountIds?.length || params.accountIds.includes(a.id));

  const seen = new Map<string, { cartolas: number; lastSeenAt: string | null; lastImportedAt: string | null }>();
  for (const h of hitosOf(db, params.accountIds)) {
    const key = `${h.accountId}|${h.day}`;
    const s = seen.get(key) ?? { cartolas: 0, lastSeenAt: null, lastImportedAt: null };
    s.cartolas++;
    if (h.observedAt && (!s.lastSeenAt || h.observedAt > s.lastSeenAt)) s.lastSeenAt = h.observedAt;
    if (!s.lastImportedAt || h.importedAt > s.lastImportedAt) s.lastImportedAt = h.importedAt;
    seen.set(key, s);
  }

  type Row = { date: string; real: string; amount: number; direction: 'C' | 'A'; kind: string; balance_after: number; credit_used_after: number | null };
  // Orden cronológico del banco, como lastUntil en buildReport: por fecha y, dentro del día, de seq mayor a seq 0.
  const movementsOf = db.prepare(
    'SELECT date, COALESCE(real_date, date) AS real, amount, direction, kind, balance_after, credit_used_after FROM movements WHERE account_id = ? ORDER BY date ASC, seq DESC',
  );

  return {
    from: params.from,
    to,
    accounts: accounts.map((a) => {
      const rows = movementsOf.all(a.id) as Row[];
      const tracked = a.credit_limit !== null && a.credit_used_anchor !== null;
      // Por fecha real, lo ya hecho que el banco fechó después (como shiftedUntil en buildReport).
      const moved = real ? rows.filter((m) => m.real < m.date) : [];
      const first = rows[0];
      // Antes del primer movimiento cargado, el saldo es el de justo antes de él (stateAtStart).
      const start = first && {
        balance: first.balance_after - effect(first),
        used: first.credit_used_after === null ? null : first.credit_used_after - usedDelta(first),
      };
      let last = -1; // el último movimiento con fecha del banco hasta el día que se calcula
      const at = (day: string) => {
        if (!start) return { closing: null, available: null };
        while (last + 1 < rows.length && rows[last + 1].date <= day) last++;
        const end = last >= 0 ? rows[last] : null;
        const shifted = moved.filter((m) => m.real <= day && m.date > day);
        const closing = (end ? end.balance_after : start.balance) + shifted.reduce((s, m) => s + effect(m), 0);
        const usedBank = end ? end.credit_used_after : start.used;
        const used = usedBank === null ? null : usedBank + shifted.reduce((s, m) => s + usedDelta(m), 0);
        return { closing, available: closing + (tracked && used !== null ? a.credit_limit! - used : 0) };
      };
      // El saldo al empezar un día es el del final del anterior (lo mismo que opening en buildReport).
      const opening = at(addDays(params.from, -1));
      return {
        accountId: a.id,
        name: a.name,
        hasCredit: tracked,
        opening,
        days: days.map((day) => ({ day, ...at(day), ...(seen.get(`${a.id}|${day}`) ?? { cartolas: 0, lastSeenAt: null, lastImportedAt: null }) })),
      };
    }),
  };
}

export interface DetailMovement {
  id: number;
  /** Fecha contable (la del banco). */
  date: string;
  seq: number;
  amount: number;
  direction: 'C' | 'A';
  description: string;
  kind: string;
  counterparty: string | null;
  payee_name: string | null;
  category_name: string | null;
  category_color: string | null;
  system_key: string | null;
  label: string | null;
  balance_after: number | null;
  provisional: number;
  /** N° de nómina de Pago Fácil dentro del día (importer.ts, recomputePayrollBatches); null si no es nómina. */
  payroll_batch: number | null;
  /** Primera cartola que lo trajo: su día y su hora de descarga, si se sabe. */
  first_seen_day: string | null;
  first_seen_at: string | null;
  /** Fecha real (ver domain/seen.ts): si es anterior a la contable, el banco lo pasó a un día posterior. */
  real_date: string | null;
  real_date_source: 'banco' | 'observada' | 'manual' | null;
}

/**
 * Un movimiento del día, una cartola, o uno que se muestra en el día sin sumar en su saldo:
 * - 'later' (por fecha del banco): ya estaba en una cartola de este día, pero el banco lo fechó después.
 * - 'earlier' (por fecha real): el banco lo fechó este día, pero es de un día anterior y ya se contó ahí.
 */
export type DayEntry =
  | { type: 'movement'; movement: DetailMovement }
  | { type: 'hito'; hito: Hito }
  | { type: 'later'; movement: DetailMovement }
  | { type: 'earlier'; movement: DetailMovement };

export interface DayAccountDetail {
  accountId: number;
  name: string;
  isCard: boolean;
  opening: number | null;
  closing: number | null;
  entries: DayEntry[];
}

export interface DayDetail {
  day: string;
  accounts: DayAccountDetail[];
}

/**
 * Lo que pasó en cada cuenta un día, en el orden en que lo registró el banco (del más antiguo al más
 * reciente), con cada cartola descargada ese día justo después de su último movimiento. Si ese movimiento es
 * de un día anterior (se descargó antes de que hubiera movimientos nuevos), la cartola va al principio; si es
 * de un día posterior, al final.
 *
 * Por fecha real (por defecto), lo hecho ese día que el banco fechó después va al final del día, antes de la
 * cartola que lo trajo, y el saldo después de cada movimiento se calcula en ese orden; lo que el banco fechó ese
 * día pero es de antes va al principio, sin sumar ('earlier'). Por fecha del banco, al revés: lo hecho ese día
 * y fechado después se ve sin sumar ('later').
 */
export function dayDetail(db: DB, day: string, accountIds?: number[], dates: DateMode = 'real'): DayDetail {
  const real = dates === 'real';
  const report = buildReport(db, { from: day, to: day, accountIds, dates });
  const hitos = hitosOf(db, accountIds).filter((h) => h.day === day);
  const select = `
    SELECT m.id, m.date, m.seq, m.amount, m.direction, m.description, m.kind, m.counterparty, p.name AS payee_name,
           c.name AS category_name, c.color AS category_color, c.system_key, m.label, m.balance_after, m.provisional,
           m.payroll_batch, m.first_seen_day, m.first_seen_at, m.real_date, m.real_date_source
    FROM movements m
    LEFT JOIN categories c ON c.id = m.category_id
    LEFT JOIN payees p ON p.rut = m.counterparty AND m.kind = 'payroll'`;
  const REAL = 'COALESCE(m.real_date, m.date)';
  const movementsOf = db.prepare(`${select} WHERE m.account_id = ? AND ${dayColumn(dates, 'm')} = ? ORDER BY m.date, m.seq DESC`);
  // Lo que se muestra sin sumar: por fecha real, lo fechado hoy que es de antes; por la del banco, lo de hoy fechado después.
  const asideOf = db.prepare(
    real
      ? `${select} WHERE m.account_id = ? AND m.date = ? AND ${REAL} < m.date ORDER BY m.seq DESC`
      : `${select} WHERE m.account_id = ? AND ${REAL} = ? AND m.date > ${REAL} ORDER BY m.date, m.seq DESC`,
  );
  const hitoEntry = (hito: Hito): DayEntry => ({ type: 'hito', hito });
  const anchorDay = (h: Hito) => (real ? h.anchor!.realDate : h.anchor!.date);

  return {
    day,
    accounts: report.accounts.map((a) => {
      const mine = hitos.filter((h) => h.accountId === a.accountId);
      const aside = asideOf.all(a.accountId, day) as DetailMovement[];
      const entries: DayEntry[] = mine.filter((h) => !h.anchor || anchorDay(h) < day).map(hitoEntry);
      if (real) entries.push(...aside.map((movement): DayEntry => ({ type: 'earlier', movement })));
      // Por fecha real, el saldo después de cada movimiento se calcula en el orden del día (el del banco va en el
      // orden de su propia fecha). Hacia atrás desde el saldo final, como se reconstruye el saldo de las cartolas:
      // si falta algún movimiento, lo corrido queda al principio del día y el último calza con el saldo final.
      const moves = movementsOf.all(a.accountId, day) as DetailMovement[];
      if (real && a.closing !== null) {
        let balance = a.closing;
        for (const m of [...moves].reverse()) {
          m.balance_after = balance;
          balance -= effect(m);
        }
      }
      for (const movement of moves) {
        entries.push({ type: 'movement', movement });
        entries.push(...mine.filter((h) => h.anchor?.id === movement.id).map(hitoEntry));
      }
      if (!real) entries.push(...aside.map((movement): DayEntry => ({ type: 'later', movement })));
      entries.push(...mine.filter((h) => h.anchor && anchorDay(h) > day).map(hitoEntry));
      return { accountId: a.accountId, name: a.name, isCard: a.isCard, opening: a.opening, closing: a.closing, entries };
    }),
  };
}

/**
 * Huella de un día por fecha real: lo que pasó ese día y lo que el banco fechó ese día, con las dos fechas de cada
 * uno. Cambia si llega, se va o cambia algo de eso (también su fecha real). Va en los cierres hechos por fecha real.
 */
export function realMovementsHash(db: DB, day: string, accountIds?: number[]): string {
  const rows = db
    .prepare(
      `SELECT account_id, date, COALESCE(real_date, date) AS real_date, amount, direction, description, doc_number, balance_after, provisional
       FROM movements WHERE COALESCE(real_date, date) = ? OR date = ?
       ORDER BY account_id, date, direction, amount, description, balance_after`,
    )
    .all(day, day) as Array<{ account_id: number }>;
  const mine = accountIds?.length ? rows.filter((r) => accountIds.includes(r.account_id)) : rows;
  return crypto.createHash('sha256').update(JSON.stringify(mine)).digest('hex');
}

/**
 * Huella de los movimientos de un día (de todas las cuentas o de algunas). Cambia si llega, se va o cambia
 * algo que informa el banco, saldo incluido; no con categorías ni comentarios, que son de quien usa la app.
 */
export function movementsHash(db: DB, day: string, accountIds?: number[]): string {
  const rows = db
    .prepare(
      `SELECT account_id, amount, direction, description, doc_number, balance_after, provisional FROM movements
       WHERE date = ? ORDER BY account_id, direction, amount, description, balance_after`,
    )
    .all(day) as Array<{ account_id: number }>;
  const mine = accountIds?.length ? rows.filter((r) => accountIds.includes(r.account_id)) : rows;
  return crypto.createHash('sha256').update(JSON.stringify(mine)).digest('hex');
}
