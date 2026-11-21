import type { DailyBalances, DateMode, Movement } from './api';
import { inChile, shortDate } from './format';
import { groupPayroll } from './payroll';
import { chronological } from './reportDetail';
import { dayOf } from './seen';

// Línea de tiempo del informe: el saldo al final de cada día. Entre un punto y el siguiente no se sabe por dónde
// anduvo el saldo (los movimientos no traen hora); los puntos sí son el saldo al cerrar cada día.

/** Un punto: el saldo al final de un día, o al empezar el período (el primero, sin día). */
export interface TimelinePoint {
  day: string | null;
  value: number;
  /** De cuántas cuentas es el punto y cuántas tuvieron cartola descargada ese día. */
  of: number;
  seen: number;
  /** Hora de descarga de la última cartola del día (UTC, ISO), si el punto es de una cuenta y se sabe. */
  lastSeenAt: string | null;
}

export interface Timeline {
  /** null: el total de las cuentas. */
  accountId: number | null;
  name: string;
  points: TimelinePoint[];
}

/**
 * Una línea por cuenta y, con más de una, la del total. Mide el disponible: con línea de crédito es saldo + línea
 * libre, y sin ella es el saldo, como el resumen del informe. Las cuentas sin movimientos cargados no tienen línea.
 */
export function timelines(data: DailyBalances): { total: Timeline | null; accounts: Timeline[] } {
  const withData = data.accounts.filter((a) => a.opening.available !== null);
  const accounts = withData.map(
    (a): Timeline => ({
      accountId: a.accountId,
      name: a.name,
      points: [
        { day: null, value: a.opening.available!, of: 1, seen: 0, lastSeenAt: null },
        ...a.days.map((p) => ({ day: p.day, value: p.available!, of: 1, seen: p.cartolas > 0 ? 1 : 0, lastSeenAt: p.lastSeenAt })),
      ],
    }),
  );
  if (accounts.length < 2) return { total: null, accounts };
  const total: Timeline = {
    accountId: null,
    name: 'Total de las cuentas',
    points: accounts[0].points.map((p, i) => ({
      day: p.day,
      value: accounts.reduce((s, a) => s + a.points[i].value, 0),
      of: accounts.length,
      seen: accounts.reduce((s, a) => s + a.points[i].seen, 0),
      lastSeenAt: null,
    })),
  };
  return { total, accounts };
}

/**
 * Lo que pasó con el saldo en el período: con cuánto empezó y terminó, y el día en que estuvo más bajo si fue entre
 * medio (más bajo que al empezar y que al terminar; si no, ya lo dicen el inicio y el final).
 */
export function timelineSummary(t: Timeline) {
  const [start, ...days] = t.points;
  const end = days.length ? days[days.length - 1] : start;
  const lowest = days.reduce<TimelinePoint | null>((low, p) => (low === null || p.value < low.value ? p : low), null);
  return {
    start: start.value,
    end: end.value,
    change: end.value - start.value,
    lowest: lowest && lowest.value < Math.min(start.value, end.value) ? lowest : null,
  };
}

/**
 * Una fila del detalle día a día: el monto con signo (`amount`, negativo si salió), lo que mueve el saldo (`effect`) y
 * el saldo que deja.
 * - Un traspaso con una cuenta propia ('movement' con system_key 'internal') no suma ni resta: es un abono en una
 *   cuenta y un cargo en otra que se compensan. Su `effect` es 0.
 * - 'internal': lo que los traspasos del día no compensan dentro del mismo día (el otro lado quedó en otro día, o en
 *   una cuenta que no está en el informe). Ese sí mueve el saldo, en una sola línea.
 * - 'gap': lo que los movimientos cargados no explican entre el final del día anterior y el de este.
 */
export type LedgerRow =
  | { type: 'movement'; m: Movement; amount: number; effect: number; balance: number }
  | { type: 'payroll'; key: string; items: Movement[]; batch: number; batchesInDay: number; amount: number; effect: number; balance: number }
  | { type: 'internal'; amount: number; effect: number; balance: number }
  | { type: 'gap'; amount: number; effect: number; balance: number };

/**
 * Una cuenta al final del día, para la tarjeta del día: su saldo y la "foto" de la que sale, la última cartola de ese
 * día. Con línea de crédito cuenta el disponible (saldo + línea libre), como en el consolidado: así suman lo mismo.
 */
export interface LedgerAccount {
  accountId: number;
  name: string;
  closing: number;
  available: number;
  hasCredit: boolean;
  cartolas: number;
  lastSeenAt: string | null;
  lastImportedAt: string | null;
}

/** De qué cartola sale el saldo de una cuenta ese día: cuándo se bajó o, si no se sabe, cuándo se subió. */
export function photoText(a: Pick<LedgerAccount, 'cartolas' | 'lastSeenAt' | 'lastImportedAt'>): string {
  const when = (utc: string) => {
    const { day, time } = inChile(utc);
    return `${shortDate(day, true).slice(0, -5)} ${time}`;
  };
  if (a.cartolas === 0) return 'sin cartola ese día';
  if (a.lastSeenAt) return `cartola del ${when(a.lastSeenAt)}`;
  return a.lastImportedAt ? `cartola sin hora, subida el ${when(a.lastImportedAt)}` : 'cartola sin hora';
}

export interface LedgerDay {
  day: string;
  /** Cada cuenta al final del día: suman el consolidado. */
  accounts: LedgerAccount[];
  /** Consolidado al empezar el día (el final del anterior) y al terminarlo. */
  opening: number;
  closing: number;
  /** Lo que entró y salió ese día, sin los traspasos con cuentas propias (como en el resumen). */
  income: number;
  expenses: number;
  /** Lo que los traspasos con cuentas propias del día no compensan dentro del día (0 si se compensan). */
  internal: number;
  /** Traspasos con cuentas propias del día que no se muestran. */
  hiddenInternal: number;
  rows: LedgerRow[];
}

const isInternal = (m: Movement) => m.system_key === 'internal';

/**
 * El detalle día a día del saldo consolidado (o de la cuenta, si es una): los movimientos de cada día, cada nómina en
 * una línea, con el saldo que deja cada uno. El saldo del final del día es el real y se calcula hacia atrás desde él,
 * como en el Diario: dentro del día el orden entre cuentas no se sabe (el banco no da la hora), así que esos saldos
 * son relativos. Si falta algo, el descuadre queda al principio del día como una fila 'gap'.
 *
 * Los traspasos con cuentas propias no suman ni restan: se ven solo con `showInternal` y lo que no se compensa en el
 * día va en una línea al final. En una cuenta con línea calibrada, girar o amortizar no cambia el disponible: no van
 * (tampoco en Entradas y Gastos). Las tarjetas no tienen saldo: sus compras tampoco.
 */
export function dayLedger(data: DailyBalances, movements: Movement[], dates: DateMode, showInternal = false): LedgerDay[] {
  const { total, accounts } = timelines(data);
  const main = total ?? accounts[0];
  if (!main) return [];
  const ids = new Set(accounts.map((a) => a.accountId));
  const withData = data.accounts.filter((a) => ids.has(a.accountId));
  const tracked = new Set(data.accounts.filter((a) => a.hasCredit).map((a) => a.accountId));
  const effect = (m: Movement) => (tracked.has(m.account_id) && m.kind === 'credit_line' ? 0 : m.direction === 'A' ? m.amount : -m.amount);

  const byDay = new Map<string, Movement[]>();
  for (const m of chronological(
    movements.filter((m) => ids.has(m.account_id) && effect(m) !== 0),
    dates,
  )) {
    const day = dayOf(m, dates);
    byDay.set(day, [...(byDay.get(day) ?? []), m]);
  }

  return main.points.slice(1).map((p, k) => {
    const opening = main.points[k].value;
    const dayMovements = byDay.get(p.day!) ?? [];
    const transfers = dayMovements.filter(isInternal);
    const internal = transfers.reduce((s, m) => s + effect(m), 0);
    const rows: LedgerRow[] = groupPayroll(showInternal ? dayMovements : dayMovements.filter((m) => !isInternal(m)), dates).map((r): LedgerRow => {
      if (r.type === 'single') return { type: 'movement', m: r.m, amount: effect(r.m), effect: isInternal(r.m) ? 0 : effect(r.m), balance: 0 };
      const amount = r.items.reduce((s, m) => s + effect(m), 0);
      return { type: 'payroll', key: r.key, items: r.items, batch: r.batch, batchesInDay: r.batchesInDay, amount, effect: amount, balance: 0 };
    });
    const income = rows.reduce((s, r) => s + Math.max(r.effect, 0), 0);
    const expenses = rows.reduce((s, r) => s + Math.max(-r.effect, 0), 0);
    if (internal !== 0) rows.push({ type: 'internal', amount: internal, effect: internal, balance: 0 });
    let balance = p.value;
    for (const r of [...rows].reverse()) {
      r.balance = balance;
      balance -= r.effect;
    }
    if (balance !== opening) rows.unshift({ type: 'gap', amount: balance - opening, effect: balance - opening, balance });
    const perAccount = withData.map((a): LedgerAccount => {
      const d = a.days[k];
      return {
        accountId: a.accountId,
        name: a.name,
        closing: d.closing!,
        available: d.available!,
        hasCredit: a.hasCredit,
        cartolas: d.cartolas,
        lastSeenAt: d.lastSeenAt,
        lastImportedAt: d.lastImportedAt,
      };
    });
    return { day: p.day!, accounts: perAccount, opening, closing: p.value, income, expenses, internal, hiddenInternal: showInternal ? 0 : transfers.length, rows };
  });
}

/**
 * Escala del eje con números redondos (de a 1, 2 o 5 por una potencia de 10) que cubre de `min` a `max` con unos
 * `count` tramos: el paso se redondea al más cercano, no al siguiente, para que no sobre medio gráfico vacío.
 */
export function niceScale(min: number, max: number, count = 4): { min: number; max: number; ticks: number[] } {
  if (min === max) {
    // Saldo plano: queda al medio.
    const pad = Math.max(Math.abs(min) * 0.05, 1000);
    min -= pad;
    max += pad;
  }
  const rough = (max - min) / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const f = rough / pow;
  const step = Math.max(1, (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * pow);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let i = 0; lo + i * step <= hi + step / 2; i++) ticks.push(Math.round((lo + i * step) * 100) / 100);
  return { min: lo, max: hi, ticks };
}

/**
 * Monto corto para el eje: "$37,5 MM", "$850 mil", "$900". En Chile MM son millones (M$ se lee como miles de pesos,
 * así que no se usa "M").
 */
export function compactClp(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  const fmt = (v: number) => v.toLocaleString('es-CL', { maximumFractionDigits: 2 });
  if (abs >= 1e6) return `${sign}$${fmt(abs / 1e6)} MM`;
  if (abs >= 1e3) return `${sign}$${fmt(abs / 1e3)} mil`;
  return `${sign}$${fmt(abs)}`;
}

/**
 * Qué días llevan su nombre bajo el eje: uno de cada tantos para que no se encimen, contando desde el último (el
 * más reciente siempre va).
 */
export function labeledDays(count: number, spanPx: number, labelPx: number): Set<number> {
  const every = Math.max(1, Math.ceil(labelPx / Math.max(spanPx, 1)));
  const shown = new Set<number>();
  for (let i = count - 1; i >= 0; i -= every) shown.add(i);
  return shown;
}

/** Sábado o domingo: Banco de Chile no fecha movimientos esos días (los pasa al lunes). */
export const isWeekend = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 || w === 6;
};
