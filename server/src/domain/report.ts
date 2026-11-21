import type { DB } from '../db.js';
import { chileDay } from '../time.js';
import { usedDelta } from './creditLine.js';

/**
 * Por qué fecha va cada movimiento. 'real' (por defecto): el día en que pasó o en que ya aparecía en una cartola
 * (ver seen.ts), así lo hecho un viernes en la noche cuenta el viernes aunque el banco lo feche el lunes.
 * 'banco': la fecha contable, la que imprime el banco.
 */
export type DateMode = 'real' | 'banco';

/** El día de un movimiento en SQL, según el modo; `alias` es el de la tabla movements en la consulta. */
export const dayColumn = (dates: DateMode = 'real', alias?: string) => {
  const p = alias ? `${alias}.` : '';
  return dates === 'banco' ? `${p}date` : `COALESCE(${p}real_date, ${p}date)`;
};

export interface ReportParams {
  from: string; // YYYY-MM-DD, inclusive
  to: string; // YYYY-MM-DD, inclusive
  accountIds?: number[];
  dates?: DateMode;
}

interface Row {
  id: number;
  account_id: number;
  /** Día del movimiento en el informe: el real o el del banco, según el modo. */
  day: string;
  date: string;
  seq: number;
  amount: number;
  direction: 'C' | 'A';
  description: string;
  kind: string;
  counterparty: string | null;
  category_id: number | null;
  category_name: string | null;
  category_color: string | null;
  system_key: string | null;
  label: string | null;
  balance_after: number;
  credit_used_after: number | null;
  payroll_batch: number | null;
  payee_name: string | null;
}

export interface AccountSummary {
  accountId: number;
  name: string;
  number: string;
  opening: number | null;
  closing: number | null;
  income: number;
  expenses: number;
  internalIn: number;
  internalOut: number;
  /** Cupo de la línea de crédito; null si la cuenta no tiene línea calibrada. */
  creditLimit: number | null;
  creditAvailableOpening: number | null;
  creditAvailableClosing: number | null;
  /** Giros desde la línea y amortizaciones en el período (no cuentan como ingreso ni gasto). */
  creditDrawn: number;
  creditRepaid: number;
  /** Saldo + línea disponible. */
  availableOpening: number | null;
  availableClosing: number | null;
  /** Primer día con movimientos cargados; antes de eso el saldo inicial no es confiable. */
  coverageFrom: string | null;
  coverageTo: string | null;
  /** Tarjeta de crédito: no tiene saldo (opening/closing null). */
  isCard: boolean;
  /** Tarjeta: cuánto subió la deuda en el período (cargos − abonos); 0 en las cuentas. */
  cardDebtChange: number;
}

interface AccountRow {
  id: number;
  name: string;
  number: string;
  kind: string;
  credit_limit: number | null;
  credit_used_anchor: number | null;
}

type StateRow = { balance_after: number; credit_used_after: number | null; amount: number; direction: 'C' | 'A'; kind: string };

export function buildReport(db: DB, params: ReportParams) {
  const accounts = (
    db.prepare('SELECT id, name, number, kind, credit_limit, credit_used_anchor FROM accounts ORDER BY name').all() as AccountRow[]
  ).filter((a) => !params.accountIds?.length || params.accountIds.includes(a.id));
  const ids = accounts.map((a) => a.id);
  if (ids.length === 0) return emptyReport(params);
  const inIds = `(${ids.map(() => '?').join(',')})`;
  const real = (params.dates ?? 'real') === 'real';
  const DAY = dayColumn(params.dates, 'm');

  const rows = db
    .prepare(
      `SELECT m.id, m.account_id, ${DAY} AS day, m.date, m.seq, m.amount, m.direction, m.description, m.kind, m.counterparty,
              m.category_id, c.name AS category_name, c.color AS category_color, c.system_key, m.label,
              m.balance_after, m.credit_used_after, m.payroll_batch, p.name AS payee_name
       FROM movements m
       LEFT JOIN categories c ON c.id = m.category_id
       LEFT JOIN payees p ON p.rut = m.counterparty AND m.kind = 'payroll'
       WHERE m.account_id IN ${inIds} AND ${DAY} BETWEEN ? AND ?
       ORDER BY ${DAY} DESC, m.date DESC, m.seq ASC`,
    )
    .all(...ids, params.from, params.to) as Row[];

  const cols = 'balance_after, credit_used_after, amount, direction, kind';
  const lastBefore = db.prepare(`SELECT ${cols} FROM movements WHERE account_id = ? AND date < ? ORDER BY date DESC, seq ASC LIMIT 1`);
  const firstFrom = db.prepare(`SELECT ${cols} FROM movements WHERE account_id = ? AND date >= ? ORDER BY date ASC, seq DESC LIMIT 1`);
  const lastUntil = db.prepare(`SELECT ${cols} FROM movements WHERE account_id = ? AND date <= ? ORDER BY date DESC, seq ASC LIMIT 1`);
  const coverage = db.prepare('SELECT MIN(date) AS f, MAX(date) AS t FROM movements WHERE account_id = ?');
  // Por fecha real, los saldos del banco se corrigen con lo que ya pasó pero el banco fechó después: al inicio, lo
  // hecho antes de `from` con fecha desde `from`; al final, lo hecho hasta `to` con fecha posterior. (El banco ya lo
  // descuenta del saldo que informa al descargar la cartola: así cuadran.)
  const shiftedBefore = db.prepare('SELECT amount, direction, kind FROM movements WHERE account_id = ? AND COALESCE(real_date, date) < ? AND date >= ?');
  const shiftedUntil = db.prepare('SELECT amount, direction, kind FROM movements WHERE account_id = ? AND COALESCE(real_date, date) <= ? AND date > ?');
  type Moved = { amount: number; direction: 'C' | 'A'; kind: string };
  const shift = (moved: Moved[]) => ({
    balance: moved.reduce((s, m) => s + (m.direction === 'A' ? m.amount : -m.amount), 0),
    used: moved.reduce((s, m) => s + usedDelta(m), 0),
  });
  const NO_SHIFT = { balance: 0, used: 0 };

  // dailyBalances (daily.ts) calcula estos mismos saldos día por día en una pasada: lo que cambie aquí en cómo se
  // calcula el saldo o el disponible va también allá (test/balances.test.ts compara los dos).

  /** Saldo y uso de la línea justo antes del primer movimiento del día `date`. */
  function stateAtStart(accountId: number, date: string) {
    const before = lastBefore.get(accountId, date) as StateRow | undefined;
    if (before) return { balance: before.balance_after, used: before.credit_used_after };
    const first = firstFrom.get(accountId, date) as StateRow | undefined;
    if (!first) return null;
    return {
      balance: first.balance_after - (first.direction === 'A' ? first.amount : -first.amount),
      used: first.credit_used_after === null ? null : first.credit_used_after - usedDelta(first),
    };
  }

  // En una cuenta con línea calibrada, girar o amortizar es mover plata entre la línea y la cuenta
  // corriente: el disponible no cambia, así que no es ingreso ni gasto (igual que un traspaso interno).
  const creditTracked = new Set(accounts.filter((a) => a.credit_limit !== null && a.credit_used_anchor !== null).map((a) => a.id));
  const isInternal = (r: Row) => r.system_key === 'internal';
  const isCreditMove = (r: Row) => r.kind === 'credit_line' && creditTracked.has(r.account_id);
  const isNeutral = (r: Row) => isInternal(r) || isCreditMove(r);

  const perAccount: AccountSummary[] = accounts.map((a) => {
    // La tarjeta no tiene saldo (sus archivos no traen la deuda): sus compras cuentan como gasto y lo que
    // falta pagar se informa aparte (cardDebtChange), para que el resumen siga cuadrando.
    const isCard = a.kind === 'tarjeta_credito';
    const start = isCard ? null : stateAtStart(a.id, params.from);
    const end = isCard ? undefined : (lastUntil.get(a.id, params.to) as StateRow | undefined);
    const atStart = real && start ? shift(shiftedBefore.all(a.id, params.from, params.from) as Moved[]) : NO_SHIFT;
    const atEnd = real && start ? shift(shiftedUntil.all(a.id, params.to, params.to) as Moved[]) : NO_SHIFT;
    const bankOpening = start?.balance ?? null;
    const bankClosing = end?.balance_after ?? bankOpening;
    const opening = bankOpening === null ? null : bankOpening + atStart.balance;
    const closing = bankClosing === null ? null : bankClosing + atEnd.balance;
    const tracked = creditTracked.has(a.id);
    const avail = (used: number | null | undefined, delta: number) => (tracked && used !== null && used !== undefined ? a.credit_limit! - (used + delta) : null);
    const creditAvailableOpening = avail(start?.used, atStart.used);
    const creditAvailableClosing = avail(end ? end.credit_used_after : start?.used, atEnd.used);

    const cov = coverage.get(a.id) as { f: string | null; t: string | null };
    const mine = rows.filter((r) => r.account_id === a.id);
    const sum = (pred: (r: Row) => boolean) => mine.filter(pred).reduce((s, r) => s + r.amount, 0);
    return {
      accountId: a.id,
      name: a.name,
      number: a.number,
      opening,
      closing,
      income: sum((r) => r.direction === 'A' && !isNeutral(r)),
      expenses: sum((r) => r.direction === 'C' && !isNeutral(r)),
      internalIn: sum((r) => r.direction === 'A' && isInternal(r)),
      internalOut: sum((r) => r.direction === 'C' && isInternal(r)),
      creditLimit: tracked ? a.credit_limit : null,
      creditAvailableOpening,
      creditAvailableClosing,
      creditDrawn: sum((r) => isCreditMove(r) && r.direction === 'A'),
      creditRepaid: sum((r) => isCreditMove(r) && r.direction === 'C'),
      availableOpening: opening === null ? null : opening + (creditAvailableOpening ?? 0),
      availableClosing: closing === null ? null : closing + (creditAvailableClosing ?? 0),
      coverageFrom: cov.f,
      coverageTo: cov.t,
      isCard,
      cardDebtChange: isCard ? sum((r) => r.direction === 'C') - sum((r) => r.direction === 'A') : 0,
    };
  });

  type NumericKey =
    | 'opening'
    | 'closing'
    | 'income'
    | 'expenses'
    | 'internalIn'
    | 'internalOut'
    | 'availableOpening'
    | 'availableClosing'
    | 'creditAvailableOpening'
    | 'creditAvailableClosing'
    | 'cardDebtChange';
  const total = (k: NumericKey) => perAccount.reduce((s, a) => s + (a[k] ?? 0), 0);

  const external = rows.filter((r) => !isNeutral(r));

  const warnings: string[] = [];
  for (const a of perAccount) {
    if (a.coverageFrom && params.from < a.coverageFrom) {
      warnings.push(
        `${a.name}: hay movimientos cargados solo desde el ${a.coverageFrom}${a.isCard ? '.' : '; el saldo inicial corresponde a esa fecha.'}`,
      );
    }
    if (a.coverageTo && params.to > a.coverageTo && a.coverageTo < chileDay()) {
      warnings.push(`${a.name}: la última cartola cargada llega hasta el ${a.coverageTo}.`);
    }
  }

  return {
    params,
    // Lo que realmente trae la información: del primer al último día con movimientos dentro del filtro
    // (ej. filtro hasta el 18/10 pero la última cartola llega al 13/10).
    period: rows.length ? { from: rows[rows.length - 1].day, to: rows[0].day } : { from: params.from, to: params.to },
    accounts: perAccount,
    totals: {
      opening: total('opening'),
      closing: total('closing'),
      income: total('income'),
      expenses: total('expenses'),
      internalNet: total('internalIn') - total('internalOut'),
      hasCredit: creditTracked.size > 0,
      creditAvailableOpening: total('creditAvailableOpening'),
      creditAvailableClosing: total('creditAvailableClosing'),
      availableOpening: total('availableOpening'),
      availableClosing: total('availableClosing'),
      hasCards: perAccount.some((a) => a.isCard),
      // Saldo final = inicial + entró − salió ± traspasos + esto: lo comprado con tarjeta que aún no se paga.
      cardDebtChange: total('cardDebtChange'),
    },
    payroll: payrollBatches(rows, accounts),
    uncategorizedCount: external.filter((r) => r.category_id === null).length,
    warnings,
  };
}

/** Pago Fácil aparece como una línea por trabajador; se agrupan por nómina (bloque contiguo del día). */
function payrollBatches(rows: Row[], accounts: Array<{ id: number; name: string }>) {
  type Batch = {
    accountId: number;
    accountName: string;
    date: string;
    batch: number;
    batchesInDay: number;
    total: number;
    count: number;
    /** Comentarios distintos puestos a los pagos de la nómina, en el orden de la cartola. */
    comments: string[];
  };
  // Una nómina es un bloque del día del banco (payroll_batch). Por fecha real, en un día pueden quedar nóminas de
  // dos fechas del banco (la de la tarde y la que se cargó de noche): se numeran de nuevo en el orden en que se
  // hicieron, como en Nóminas.
  const map = new Map<string, Batch & { bankDate: string; bankBatch: number }>();
  for (const r of rows.filter((r) => r.kind === 'payroll')) {
    const bankBatch = r.payroll_batch ?? 1;
    const k = `${r.account_id}|${r.date}|${bankBatch}`;
    const b = map.get(k) ?? {
      accountId: r.account_id,
      accountName: accounts.find((a) => a.id === r.account_id)!.name,
      date: r.day,
      batch: 0,
      batchesInDay: 0,
      total: 0,
      count: 0,
      comments: [],
      bankDate: r.date,
      bankBatch,
    };
    b.total += r.amount;
    b.count++;
    if (r.label && !b.comments.includes(r.label)) b.comments.push(r.label);
    map.set(k, b);
  }
  const all = [...map.values()];
  const batches: Batch[] = all.map(({ bankDate, bankBatch, ...b }) => {
    const sameDay = all.filter((o) => o.accountId === b.accountId && o.date === b.date).sort((x, y) => x.bankDate.localeCompare(y.bankDate) || x.bankBatch - y.bankBatch);
    return { ...b, batch: sameDay.findIndex((o) => o.bankDate === bankDate && o.bankBatch === bankBatch) + 1, batchesInDay: sameDay.length };
  });
  return batches.sort((a, b) => b.date.localeCompare(a.date) || a.accountName.localeCompare(b.accountName) || a.batch - b.batch);
}

function emptyReport(params: ReportParams) {
  return {
    params,
    period: { from: params.from, to: params.to },
    accounts: [],
    totals: {
      opening: 0,
      closing: 0,
      income: 0,
      expenses: 0,
      internalNet: 0,
      hasCredit: false,
      creditAvailableOpening: 0,
      creditAvailableClosing: 0,
      availableOpening: 0,
      availableClosing: 0,
      hasCards: false,
      cardDebtChange: 0,
    },
    payroll: [],
    uncategorizedCount: 0,
    warnings: [],
  };
}

export type Report = ReturnType<typeof buildReport>;
