import type { Category, DateMode, Movement } from './api';
import { photoText, type LedgerAccount, type LedgerDay, type LedgerRow } from './balances';
import { clp, shortDate } from './format';
import { movementTitle } from './reportDetail';
import { movedFrom, weekdayDay } from './seen';

// Las fotos de un día del detalle día a día (hoja Saldos), para pegarlas en un chat o un correo. Dos tarjetas, que se
// copian por separado: la del día, con el saldo con que empezó, cada movimiento con su categoría, lo que entró o salió
// y el saldo relativo que deja, y el saldo con que terminó; y la de saldos, con el saldo final de cada cuenta y la
// cartola de la que sale. Se dibuja como SVG (igual que la imagen del gráfico, chartImage.ts) y siempre en colores
// claros. Lo que no cabe en su columna se corta con "…".

export interface DayCardOptions {
  /** De qué cuentas es: "Todas las cuentas" o el nombre de la cuenta. */
  scope: string;
  /** Con varias cuentas, cada movimiento dice de cuál es. */
  multi: boolean;
  categories: Category[];
  dates: DateMode;
}

const NS = 'http://www.w3.org/2000/svg';
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const INK = '#1c2430';
const MUTED = '#677387';
const BORDER = '#e1e5eb';
const POS = '#15803d';
const NEG = '#b91c1c';
const BAND = '#eef4ff';
const WARN = '#fff7e6';

/** Lo que dice una fila, como en la tabla. `neutral`: un traspaso con una cuenta propia, que no suma ni resta. */
interface CardLine {
  account: string;
  detail: string;
  category: { name: string; color: string } | null;
  amount: number;
  balance: number;
  neutral: boolean;
  gap: boolean;
}

const categoryOf = (items: Movement[], categories: Category[]) => {
  if (new Set(items.map((m) => m.category_id)).size > 1) return { name: '(varias)', color: MUTED };
  const c = categories.find((x) => x.id === items[0].category_id);
  return c ? { name: c.name, color: c.color } : null;
};

/** Lo que el banco fechó después: por fecha real, su fecha del banco; por la del banco, cuándo apareció. */
const movedNote = (items: Movement[], dates: DateMode) => {
  const real = movedFrom(items[0]);
  if (!real || new Set(items.map((m) => `${movedFrom(m)}|${m.date}`)).size !== 1) return null;
  return dates === 'real' ? `banco: ${weekdayDay(items[0].date)}` : `↶ ${weekdayDay(real)}`;
};

export function cardLines(day: LedgerDay, o: DayCardOptions): CardLine[] {
  return day.rows.map((r: LedgerRow): CardLine => {
    const base = { account: '', category: null, amount: r.amount, balance: r.balance, neutral: false, gap: false };
    if (r.type === 'gap') return { ...base, detail: 'No cuadra con el día anterior: falta o sobra algún movimiento', gap: true };
    if (r.type === 'internal') return { ...base, detail: 'Traspasos con cuentas propias que no se compensan en el día' };
    const items = r.type === 'movement' ? [r.m] : r.items;
    const title =
      r.type === 'movement'
        ? movementTitle(r.m)
        : `Nómina Pago Fácil · ${r.items.length} pagos${r.batchesInDay > 1 ? ` · nómina ${r.batch} de ${r.batchesInDay}` : ''}`;
    const comments = [...new Set(items.map((m) => m.label).filter(Boolean))];
    const moved = movedNote(items, o.dates);
    return {
      ...base,
      account: items[0].account_name,
      detail: [title, ...comments, items.some((m) => m.provisional) ? 'provisorio' : null, moved].filter(Boolean).join(' · '),
      category: categoryOf(items, o.categories),
      neutral: r.type === 'movement' && r.m.system_key === 'internal',
    };
  });
}

/** Ancho de un texto en pantalla; sin canvas (en los tests) se estima. */
export type Measure = (text: string, size: number, weight?: number) => number;
let canvas: CanvasRenderingContext2D | null | undefined;
const measureText: Measure = (text, size, weight = 400) => {
  if (canvas === undefined) canvas = document.createElement('canvas').getContext('2d');
  if (!canvas) return text.length * size * 0.55;
  canvas.font = `${weight} ${size}px ${FONT}`;
  return canvas.measureText(text).width;
};

/** El texto que cabe en `width`, cortado con "…" si no cabe entero. */
const fit = (text: string, width: number, size: number, measure: Measure, weight?: number) => {
  if (measure(text, size, weight) <= width) return text;
  let cut = text;
  while (cut.length > 1 && measure(`${cut}…`, size, weight) > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
};

type Attrs = Record<string, string | number>;
const PAD = 20;
const ROW = 26;
/** Donde arranca la tabla, bajo el título y el subtítulo. */
const HEAD_TOP = 74;
const LABEL: Attrs = { 'font-size': 11, 'font-weight': 600, fill: MUTED };
const BOLD: Attrs = { 'font-weight': 700 };
const baseline = (top: number) => top + 17;

/** Una tarjeta en blanco con su título, y lo necesario para dibujar filas en ella. */
function card(width: number, height: number, title: string, subtitle: string) {
  const el = (tag: string, attrs: Attrs, content?: string) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const root = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, 'font-family': FONT });
  const add = (...nodes: Element[]) => root.append(...nodes);
  const text = (value: string, at: number, y: number, attrs: Attrs = {}) => el('text', { x: at, y, 'font-size': 13, fill: INK, ...attrs }, value);
  const right = (value: string, at: number, y: number, attrs: Attrs = {}) => text(value, at - 6, y, { 'text-anchor': 'end', ...attrs });
  const rule = (y: number, stroke = BORDER) => el('line', { x1: PAD, x2: width - PAD, y1: y, y2: y, stroke, 'stroke-width': 1 });
  // Los títulos de las columnas van sobre una franja, como en la pantalla.
  const band = () => add(el('rect', { x: PAD, y: HEAD_TOP, width: width - PAD * 2, height: ROW, rx: 6, fill: BAND }));
  add(el('rect', { width, height, rx: 12, fill: '#ffffff', stroke: BORDER }));
  add(text(title, PAD, PAD + 16, { 'font-size': 17, 'font-weight': 600 }));
  add(text(subtitle, PAD, PAD + 36, { 'font-size': 12, fill: MUTED }));
  return { el, add, text, right, rule, band, svg: () => new XMLSerializer().serializeToString(root) };
}

/** El SVG de la tarjeta del día: encabezado, una fila por movimiento y el saldo con que terminó. */
export function dayCardSvg(day: LedgerDay, o: DayCardOptions, measure: Measure = measureText): { svg: string; width: number; height: number } {
  const pad = PAD;
  const row = ROW;
  // La cuenta solo con varias cuentas.
  const cols = { account: o.multi ? 150 : 0, detail: o.multi ? 250 : 300, category: 140, income: 90, expense: 90, balance: 104 };
  const x = {
    account: pad,
    detail: pad + cols.account,
    category: pad + cols.account + cols.detail,
    income: pad + cols.account + cols.detail + cols.category + cols.income,
    expense: pad + cols.account + cols.detail + cols.category + cols.income + cols.expense,
    balance: pad + cols.account + cols.detail + cols.category + cols.income + cols.expense + cols.balance,
  };
  const width = x.balance + pad;
  const lines = cardLines(day, o);
  const headTop = HEAD_TOP;
  const bodyTop = headTop + row;
  const footTop = bodyTop + row * (lines.length + 1);
  const height = footTop + row + pad;

  const { el, add, text, right, rule, band, svg } = card(width, height, shortDate(day.day, true), o.multi ? `${o.scope} · saldo consolidado` : o.scope);
  band();
  const label = LABEL;
  const y0 = baseline(headTop);
  if (o.multi) add(text('CUENTA', x.account + 6, y0, label));
  add(text('DETALLE', x.detail + 6, y0, label), text('CATEGORÍA', x.category + 6, y0, label));
  add(right('ENTRÓ', x.income, y0, label), right('SALIÓ', x.expense, y0, label), right('SALDO RELATIVO', x.balance, y0, label));

  // Primera fila: el saldo inicial; después, cada movimiento con el saldo que deja.
  const rows: Array<CardLine | null> = [null, ...lines];
  rows.forEach((l, i) => {
    const top = bodyTop + row * i;
    const y = baseline(top);
    if (l?.gap) add(el('rect', { x: pad, y: top, width: width - pad * 2, height: row, fill: WARN }));
    if (!l) {
      add(text('Saldo inicial', x.detail + 6, y, { fill: MUTED }), right(clp(day.opening), x.balance, y, { fill: MUTED }));
    } else {
      const ink = l.neutral ? MUTED : INK;
      if (o.multi) add(text(fit(l.account, cols.account - 12, 12, measure), x.account + 6, y, { 'font-size': 12, fill: MUTED }));
      add(text(fit(l.detail, cols.detail - 12, 13, measure), x.detail + 6, y, { fill: ink }));
      if (l.category) {
        add(el('circle', { cx: x.category + 10, cy: top + row / 2, r: 4, fill: l.category.color }));
        add(text(fit(l.category.name, cols.category - 26, 12, measure), x.category + 20, y, { 'font-size': 12, fill: ink }));
      }
      if (l.amount > 0) add(right(clp(l.amount), x.income, y, { fill: l.neutral ? MUTED : POS }));
      if (l.amount < 0) add(right(clp(-l.amount), x.expense, y, { fill: l.neutral ? MUTED : NEG }));
      add(right(clp(l.balance), x.balance, y, { fill: ink }));
    }
    add(rule(top + row));
  });

  // El saldo con que terminó el día: el real.
  const y = baseline(footTop);
  add(rule(footTop, INK));
  add(text(`Saldo al final del día`, x.detail + 6, y, BOLD));
  if (day.income) add(right(clp(day.income), x.income, y, { ...BOLD, fill: POS }));
  if (day.expenses) add(right(clp(day.expenses), x.expense, y, { ...BOLD, fill: NEG }));
  add(right(clp(day.closing), x.balance, y, BOLD));

  return { svg: svg(), width, height };
}

/** Lo que dice de dónde sale el saldo de una cuenta: su cartola del día y, con línea de crédito, cómo se compone. */
export const accountNote = (a: LedgerAccount) => photoText(a) + (a.hasCredit ? ` · saldo ${clp(a.closing)} + línea ${clp(a.available - a.closing)}` : '');

/**
 * El SVG de la tarjeta de saldos del día: el saldo final de cada cuenta con la "foto" de la que sale (su última cartola
 * de ese día) y el total, que es el consolidado con que terminó el día.
 */
export function balancesCardSvg(day: LedgerDay, o: DayCardOptions, measure: Measure = measureText): { svg: string; width: number; height: number } {
  const cols = { account: 190, note: 330, balance: 120 };
  const x = { account: PAD, note: PAD + cols.account, balance: PAD + cols.account + cols.note + cols.balance };
  const width = x.balance + PAD;
  const bodyTop = HEAD_TOP + ROW;
  const footTop = bodyTop + ROW * day.accounts.length;
  const height = footTop + ROW + PAD;

  const { add, text, right, rule, band, svg } = card(width, height, shortDate(day.day, true), `Saldo final por cuenta · ${o.scope}`);
  band();
  const y0 = baseline(HEAD_TOP);
  add(text('CUENTA', x.account + 6, y0, LABEL), text('DE DÓNDE SALE', x.note + 6, y0, LABEL), right('SALDO FINAL', x.balance, y0, LABEL));
  day.accounts.forEach((a, i) => {
    const top = bodyTop + ROW * i;
    const y = baseline(top);
    add(text(fit(a.name, cols.account - 12, 13, measure), x.account + 6, y));
    add(text(fit(accountNote(a), cols.note - 12, 12, measure), x.note + 6, y, { 'font-size': 12, fill: MUTED }));
    add(right(clp(a.available), x.balance, y));
    add(rule(top + ROW));
  });
  const y = baseline(footTop);
  add(rule(footTop, INK));
  add(text(o.multi ? 'Total de las cuentas' : 'Saldo final', x.account + 6, y, BOLD));
  add(right(clp(day.closing), x.balance, y, BOLD));
  return { svg: svg(), width, height };
}
