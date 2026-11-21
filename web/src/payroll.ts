import type { DateMode, DayEntry, DayMovement, Movement } from './api';
import { dayOf } from './seen';

export type DisplayRow =
  | { type: 'single'; m: Movement }
  | { type: 'batch'; key: string; items: Movement[]; batch: number; batchesInDay: number };

/**
 * Número de cada nómina dentro de su día: una nómina es un bloque del día del banco (payroll_batch), pero por fecha
 * real un día puede tener nóminas de dos fechas del banco (la de la tarde y la que se cargó de noche). Se numeran
 * en el orden en que se hicieron: por fecha del banco y bloque.
 */
function numberBatches(batches: Array<{ key: string; accountId: number; day: string; bankDate: string; bankBatch: number }>) {
  const perDay = new Map<string, typeof batches>();
  for (const b of batches) {
    const k = `${b.accountId}|${b.day}`;
    if (!perDay.has(k)) perDay.set(k, []);
    perDay.get(k)!.push(b);
  }
  const numbers = new Map<string, { batch: number; batchesInDay: number }>();
  for (const list of perDay.values()) {
    list.sort((a, b) => a.bankDate.localeCompare(b.bankDate) || a.bankBatch - b.bankBatch).forEach((b, i) => numbers.set(b.key, { batch: i + 1, batchesInDay: list.length }));
  }
  return numbers;
}

/** Agrupa las líneas de Pago Fácil de una misma nómina (bloque contiguo del día, ver payroll_batch). */
export function groupPayroll(movements: Movement[], dates: DateMode = 'banco'): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const batches = new Map<string, Movement[]>();
  for (const m of movements) {
    if (m.kind !== 'payroll') {
      rows.push({ type: 'single', m });
      continue;
    }
    const key = `${m.account_id}|${m.date}|${m.payroll_batch ?? 1}`;
    if (!batches.has(key)) {
      batches.set(key, []);
      rows.push({ type: 'batch', key, items: batches.get(key)!, batch: 0, batchesInDay: 0 });
    }
    batches.get(key)!.push(m);
  }
  const numbers = numberBatches(
    [...batches].map(([key, [m]]) => ({ key, accountId: m.account_id, day: dayOf(m, dates), bankDate: m.date, bankBatch: m.payroll_batch ?? 1 })),
  );
  return rows.map((r) => {
    if (r.type !== 'batch') return r;
    if (r.items.length === 1) return { type: 'single', m: r.items[0] };
    return { ...r, ...numbers.get(r.key)! };
  });
}

/** Una nómina en el día de una cuenta (Diario). `net` con signo: lo que movió el saldo, negativo si salió. */
export interface DayPayroll {
  type: 'payroll';
  key: string;
  items: DayMovement[];
  batch: number;
  batchesInDay: number;
  net: number;
  /** Saldo después del último pago de la nómina. */
  balanceAfter: number | null;
  /**
   * Se muestra sin sumar en el saldo del día: 'later' (por fecha del banco) ya estaba en una cartola de este día
   * pero el banco la fechó después; 'earlier' (por fecha real) el banco la fechó este día, pero es de antes.
   */
  aside: 'later' | 'earlier' | null;
}

export type DayRow = DayEntry | DayPayroll;

/** Como en Movimientos: "Nómina Pago Fácil · 15 pagos", y "· nómina 2 de 3" si ese día hubo varias. */
export const payrollTitle = (p: Pick<DayPayroll, 'items' | 'batch' | 'batchesInDay'>) =>
  `Nómina Pago Fácil · ${p.items.length} pagos${p.batchesInDay > 1 ? ` · nómina ${p.batch} de ${p.batchesInDay}` : ''}`;

/** El comentario de la nómina, si todos sus pagos tienen el mismo (como en Nóminas). */
export const payrollComment = (p: Pick<DayPayroll, 'items'>) => (new Set(p.items.map((m) => m.label ?? '')).size === 1 ? p.items[0].label : null);

/**
 * El día de una cuenta con cada nómina de Pago Fácil en una sola línea, como en Nóminas y en Movimientos (ver
 * payroll_batch). Si una cartola cae entre dos pagos de la misma nómina, la nómina se muestra en dos partes para
 * que la cartola quede donde corresponde. Una nómina de un solo pago va como un movimiento más. Las nóminas del día
 * se numeran en el orden en que aparecen; las que se muestran sin sumar ('later', 'earlier') se agrupan igual,
 * aparte y sin número.
 */
export function groupDayPayroll(entries: DayEntry[]): DayRow[] {
  const payroll = (e: DayEntry) => (e.type !== 'hito' && e.movement.kind === 'payroll' ? e.movement : null);
  const keyOf = (m: DayMovement) => `${m.date}|${m.payroll_batch ?? 1}`;
  const order = [
    ...new Set(
      entries
        .filter((e) => e.type === 'movement')
        .map(payroll)
        .filter((m): m is DayMovement => m !== null)
        .map(keyOf),
    ),
  ];
  const rows: DayRow[] = [];
  for (const e of entries) {
    const m = payroll(e);
    const aside = e.type === 'later' || e.type === 'earlier' ? e.type : null;
    const last = rows.at(-1);
    const signed = m ? (m.direction === 'A' ? m.amount : -m.amount) : 0;
    if (m && last?.type === 'payroll' && last.aside === aside && keyOf(last.items[0]) === keyOf(m)) {
      last.items.push(m);
      last.net += signed;
      last.balanceAfter = m.balance_after;
    } else if (m) {
      rows.push({
        type: 'payroll',
        key: `${aside ?? 'p'}${m.id}`,
        items: [m],
        batch: aside ? 1 : order.indexOf(keyOf(m)) + 1,
        batchesInDay: aside ? 1 : order.length,
        net: signed,
        balanceAfter: m.balance_after,
        aside,
      });
    } else {
      rows.push(e);
    }
  }
  return rows.map((r) => (r.type === 'payroll' && r.items.length === 1 ? (r.aside ? { type: r.aside, movement: r.items[0] } : { type: 'movement', movement: r.items[0] }) : r));
}

export interface PayrollBatch {
  key: string;
  accountId: number;
  accountName: string;
  date: string;
  batch: number;
  batchesInDay: number;
  total: number;
  items: Movement[];
}

/**
 * Nóminas (bloques de Pago Fácil) a partir de los movimientos de tipo nómina, de la más reciente a la más antigua.
 * `date` es el día en que se muestra (el real o el del banco).
 */
export function buildBatches(movements: Movement[], dates: DateMode = 'banco'): PayrollBatch[] {
  const map = new Map<string, PayrollBatch & { bankDate: string; bankBatch: number }>();
  for (const m of movements) {
    if (m.kind !== 'payroll') continue;
    const bankBatch = m.payroll_batch ?? 1;
    const key = `${m.account_id}|${m.date}|${bankBatch}`;
    const b = map.get(key) ?? {
      key,
      accountId: m.account_id,
      accountName: m.account_name,
      date: dayOf(m, dates),
      batch: 0,
      batchesInDay: 0,
      total: 0,
      items: [],
      bankDate: m.date,
      bankBatch,
    };
    b.total += m.amount;
    b.items.push(m);
    map.set(key, b);
  }
  const numbers = numberBatches([...map.values()].map((b) => ({ key: b.key, accountId: b.accountId, day: b.date, bankDate: b.bankDate, bankBatch: b.bankBatch })));
  const batches: PayrollBatch[] = [...map.values()].map(({ bankDate: _d, bankBatch: _b, ...b }) => ({ ...b, ...numbers.get(b.key)! }));
  return batches.sort((a, b) => b.date.localeCompare(a.date) || a.accountName.localeCompare(b.accountName) || b.batch - a.batch);
}

export interface WorkerSummary {
  rut: string;
  name: string | null;
  total: number;
  count: number;
  batches: number;
  lastDate: string;
}

/** Total pagado a cada trabajador (por RUT) en las nóminas dadas, de mayor a menor. */
export function summarizeWorkers(batches: PayrollBatch[]): WorkerSummary[] {
  const map = new Map<string, WorkerSummary & { batchKeys: Set<string> }>();
  for (const b of batches) {
    for (const m of b.items) {
      const rut = m.counterparty ?? '?';
      const w = map.get(rut) ?? { rut, name: m.payee_name, total: 0, count: 0, batches: 0, lastDate: b.date, batchKeys: new Set<string>() };
      w.total += m.amount;
      w.count++;
      w.batchKeys.add(b.key);
      if (b.date > w.lastDate) w.lastDate = b.date;
      map.set(rut, w);
    }
  }
  return [...map.values()]
    .map(({ batchKeys, ...w }) => ({ ...w, batches: batchKeys.size }))
    .sort((a, b) => b.total - a.total);
}
