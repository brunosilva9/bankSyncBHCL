import type { Category, Movement } from './api';
import { shortDate } from './format';
import { groupPayroll, type DisplayRow } from './payroll';

/** Con quién fue el movimiento: nombre del trabajador, contraparte o la descripción del banco. */
export const movementTitle = (m: Movement) => m.payee_name ?? m.counterparty ?? m.description;

/** Orden de lectura de un informe: del más antiguo al más reciente (dentro del día, seq 0 es el último). */
export function chronological(movements: Movement[]): Movement[] {
  return [...movements].sort((a, b) => a.date.localeCompare(b.date) || a.account_name.localeCompare(b.account_name) || b.seq - a.seq);
}

export interface CategoryGroup {
  categoryId: number | null;
  name: string;
  color: string | null;
  total: number;
  count: number;
  /** Movimientos en orden cronológico, con cada nómina de Pago Fácil en una sola fila. */
  rows: DisplayRow[];
}

/** Gastos agrupados por categoría, de la que suma más a la que suma menos. */
export function groupByCategory(movements: Movement[], categories: Category[]): CategoryGroup[] {
  const groups = new Map<number | null, Movement[]>();
  for (const m of chronological(movements)) {
    if (!groups.has(m.category_id)) groups.set(m.category_id, []);
    groups.get(m.category_id)!.push(m);
  }
  return [...groups.entries()]
    .map(([categoryId, items]) => {
      const category = categories.find((c) => c.id === categoryId);
      return {
        categoryId,
        name: category?.name ?? 'Sin categoría',
        color: category?.color ?? null,
        total: items.reduce((s, m) => s + m.amount, 0),
        count: items.length,
        rows: groupPayroll(items),
      };
    })
    .sort((a, b) => b.total - a.total);
}

export interface PayrollLine {
  accountId: number;
  accountName: string;
  date: string;
  batch: number;
  batchesInDay: number;
  total: number;
  count: number;
}

/**
 * Para el resumen (que debe caber en una página): las `max` nóminas más grandes, ordenadas por fecha,
 * y el resto sumado en una sola fila.
 */
export function topPayroll(payroll: PayrollLine[], max = 7) {
  const biggest = new Set([...payroll].sort((a, b) => b.total - a.total).slice(0, max));
  const shown = payroll.filter((p) => biggest.has(p)).sort((a, b) => a.date.localeCompare(b.date) || a.batch - b.batch);
  const others = payroll.filter((p) => !biggest.has(p));
  return {
    shown,
    rest: { batches: others.length, count: others.reduce((s, p) => s + p.count, 0), total: others.reduce((s, p) => s + p.total, 0) },
  };
}

/** "del vie 09/10/2026 al mar 13/10/2026" (o "del mar 13/10/2026" si es un solo día). */
export function periodText(period: { from: string; to: string }): string {
  return period.from === period.to ? `del ${shortDate(period.from, true)}` : `del ${shortDate(period.from, true)} al ${shortDate(period.to, true)}`;
}

/** Nombre del PDF al imprimir: lo toma el navegador del título de la página. */
export function reportFileName(period: { from: string; to: string }, scope: string): string {
  const d = (iso: string) => iso.split('-').reverse().join('-');
  const range = period.from === period.to ? d(period.from) : `${d(period.from)} al ${d(period.to)}`;
  return `Informe ${range} - ${scope}`.replace(/[\/:*?"<>|]/g, '');
}
