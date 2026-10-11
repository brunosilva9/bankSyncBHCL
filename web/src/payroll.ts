import type { Movement } from './api';

export type DisplayRow =
  | { type: 'single'; m: Movement }
  | { type: 'batch'; key: string; items: Movement[]; batch: number; batchesInDay: number };

/** Agrupa las líneas de Pago Fácil de una misma nómina (bloque contiguo del día, ver payroll_batch). */
export function groupPayroll(movements: Movement[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const batches = new Map<string, Movement[]>();
  const perDay = new Map<string, Set<number>>();
  for (const m of movements) {
    if (m.kind !== 'payroll') {
      rows.push({ type: 'single', m });
      continue;
    }
    const batch = m.payroll_batch ?? 1;
    const day = `${m.account_id}|${m.date}`;
    if (!perDay.has(day)) perDay.set(day, new Set());
    perDay.get(day)!.add(batch);
    const key = `${day}|${batch}`;
    if (!batches.has(key)) {
      batches.set(key, []);
      rows.push({ type: 'batch', key, items: batches.get(key)!, batch, batchesInDay: 0 });
    }
    batches.get(key)!.push(m);
  }
  return rows.map((r) => {
    if (r.type !== 'batch') return r;
    if (r.items.length === 1) return { type: 'single', m: r.items[0] };
    return { ...r, batchesInDay: perDay.get(`${r.items[0].account_id}|${r.items[0].date}`)!.size };
  });
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

/** Nóminas (bloques de Pago Fácil) a partir de los movimientos de tipo nómina, de la más reciente a la más antigua. */
export function buildBatches(movements: Movement[]): PayrollBatch[] {
  const map = new Map<string, PayrollBatch>();
  for (const m of movements) {
    if (m.kind !== 'payroll') continue;
    const batch = m.payroll_batch ?? 1;
    const key = `${m.account_id}|${m.date}|${batch}`;
    const b = map.get(key) ?? { key, accountId: m.account_id, accountName: m.account_name, date: m.date, batch, batchesInDay: 0, total: 0, items: [] };
    b.total += m.amount;
    b.items.push(m);
    map.set(key, b);
  }
  const batches = [...map.values()];
  for (const b of batches) b.batchesInDay = batches.filter((o) => o.accountId === b.accountId && o.date === b.date).length;
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
      const w = map.get(rut) ?? { rut, name: m.payee_name, total: 0, count: 0, batches: 0, lastDate: m.date, batchKeys: new Set<string>() };
      w.total += m.amount;
      w.count++;
      w.batchKeys.add(b.key);
      if (m.date > w.lastDate) w.lastDate = m.date;
      map.set(rut, w);
    }
  }
  return [...map.values()]
    .map(({ batchKeys, ...w }) => ({ ...w, batches: batchKeys.size }))
    .sort((a, b) => b.total - a.total);
}
