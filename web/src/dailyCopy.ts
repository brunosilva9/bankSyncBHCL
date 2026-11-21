import type { DateMode, DayAccountDetail, DayMovement } from './api';
import type { ClipboardContent } from './clipboard';
import { clp, clpSigned, shortDate } from './format';
import { groupDayPayroll, payrollComment, payrollTitle } from './payroll';
import { movedFrom, weekdayDay } from './seen';

// El detalle de un día para pegarlo en otra parte. Por cuenta: el saldo inicial con su fecha, los movimientos en
// el orden del banco con el saldo que deja cada uno (cada nómina en una línea, como en Nóminas), y el saldo final
// con su fecha; con varias cuentas, al final el total. Va como texto, para un chat o un correo, y como tabla
// (Fecha, Detalle, Entró, Salió, Saldo), que Excel, Google Sheets o Word pegan en columnas. Las cartolas del día no
// van: son el control de lo cargado, no algo que pasó en la cuenta.
//
// Lo que el banco fechó después del día en que pasó (de noche, en fin de semana o en feriado), según las fechas:
// - Por fecha real, suma el día en que pasó y lleva "fecha del banco: lun 23"; el día del banco lo trae aparte,
//   después del saldo final, porque ya se contó.
// - Por fecha del banco, al revés: suma en su fecha del banco ("apareció el vie 20") y su día real lo trae aparte.

type Line =
  | { kind: 'opening' | 'closing'; balance: number | null }
  | { kind: 'movement'; detail: string; amount: number; balance: number | null }
  | { kind: 'none' }
  | { kind: 'aside-head'; text: string }
  | { kind: 'aside'; detail: string; amount: number; date: string; note: string };

interface Block {
  title: string;
  /** Una tarjeta no tiene saldo: sin líneas de saldo, su fecha va en el título. */
  isCard: boolean;
  lines: Line[];
}

const LATER_HEAD = 'Ya aparecen hoy, pero el banco los fechó después (cuentan en esa fecha):';
const EARLIER_HEAD = 'Con fecha del banco de hoy, pero de un día anterior (ya se contaron ese día):';

const movementsOf = (a: DayAccountDetail) => a.entries.flatMap((e) => (e.type === 'movement' ? [e.movement] : []));

/**
 * La nota de lo que el banco fechó después, si todos los movimientos son del mismo caso: por fecha real, su fecha
 * del banco ("fecha del banco: lun 23"); por la del banco, el día en que apareció ("apareció el vie 20").
 */
const movedNote = (items: DayMovement[], dates: DateMode) => {
  const days = new Set(items.map((m) => `${movedFrom(m)}|${m.date}`));
  const real = movedFrom(items[0]);
  if (days.size !== 1 || !real) return null;
  return dates === 'real' ? `fecha del banco: ${weekdayDay(items[0].date)}` : `apareció el ${weekdayDay(real)}`;
};

/** Como en la línea de tiempo: el trabajador (en una nómina), la glosa del banco, el comentario y si es provisorio. */
const detailOf = (m: DayMovement) => [m.payee_name, m.description, m.label, m.provisional ? 'provisorio' : null].filter(Boolean).join(' · ');

function blockOf(a: DayAccountDetail, dates: DateMode): Block {
  const movements: Line[] = [];
  const aside: Line[] = [];
  let asideKind: 'later' | 'earlier' = 'earlier';
  for (const r of groupDayPayroll(a.entries)) {
    if (r.type === 'hito') continue;
    const items = r.type === 'payroll' ? r.items : [r.movement];
    const apart = r.type === 'payroll' ? r.aside : r.type === 'movement' ? null : r.type;
    const amount = r.type === 'payroll' ? r.net : r.movement.direction === 'A' ? r.movement.amount : -r.movement.amount;
    const detail =
      r.type === 'payroll'
        ? [payrollTitle(r), payrollComment(r), items.some((m) => m.provisional) ? 'provisorio' : null].filter(Boolean).join(' · ')
        : detailOf(r.movement);
    if (apart) {
      // Va con la fecha en que se cuenta: la del banco (por fecha del banco) o la real (por fecha real).
      asideKind = apart;
      const m = items[0];
      const counted = apart === 'later' ? m.date : (m.real_date ?? m.date);
      aside.push({ kind: 'aside', detail, amount, date: counted, note: apart === 'later' ? `fecha del banco: ${shortDate(counted, true)}` : `se contó el ${shortDate(counted, true)}` });
      continue;
    }
    const moved = movedNote(items, dates);
    const balance = a.isCard ? null : r.type === 'payroll' ? r.balanceAfter : r.movement.balance_after;
    movements.push({ kind: 'movement', detail: moved ? `${detail} (${moved})` : detail, amount, balance });
  }
  const head: Line = { kind: 'aside-head', text: asideKind === 'later' ? LATER_HEAD : EARLIER_HEAD };
  const after: Line[] = aside.length ? [head, ...aside] : [];
  if (a.isCard) return { title: a.name, isCard: true, lines: [...movements, ...after] };
  const between: Line[] = movements.length ? movements : [{ kind: 'none' }];
  return { title: a.name, isCard: false, lines: [{ kind: 'opening', balance: a.opening }, ...between, { kind: 'closing', balance: a.closing }, ...after] };
}

/** Las cuentas que van en la copia: una tarjeta sin compras ni pagos ese día no aporta nada; una cuenta sin movimientos, su saldo. */
export const accountsToCopy = (accounts: DayAccountDetail[]) => accounts.filter((a) => movementsOf(a).length > 0 || (!a.isCard && a.closing !== null));

export function dayCopy(day: string, accounts: DayAccountDetail[], dates: DateMode = 'real'): Required<ClipboardContent> {
  const shown = accountsToCopy(accounts);
  const blocks = shown.map((a) => blockOf(a, dates));
  const withBalance = shown.filter((a) => !a.isCard);
  if (withBalance.length > 1) {
    const sum = (pick: (a: DayAccountDetail) => number | null) => withBalance.reduce((s, a) => s + (pick(a) ?? 0), 0);
    blocks.push({
      title: 'Total de las cuentas',
      isCard: false,
      lines: [
        { kind: 'opening', balance: sum((a) => a.opening) },
        { kind: 'closing', balance: sum((a) => a.closing) },
      ],
    });
  }
  return { text: toText(day, blocks), html: toHtml(day, blocks) };
}

function toText(day: string, blocks: Block[]): string {
  const date = shortDate(day, true);
  const line = (l: Line): string => {
    switch (l.kind) {
      case 'opening':
        return `Saldo inicial ${date}: ${clp(l.balance)}`;
      case 'closing':
        return `Saldo final ${date}: ${clp(l.balance)}`;
      case 'none':
        return 'Sin movimientos.';
      case 'movement':
        return `${clpSigned(l.amount)} ${l.detail}${l.balance === null ? '' : ` (saldo ${clp(l.balance)})`}`;
      case 'aside-head':
        return l.text;
      case 'aside':
        return `${clpSigned(l.amount)} ${l.detail} (${l.note})`;
    }
  };
  return blocks.map((b) => [b.isCard ? `${b.title}, ${date}` : b.title, ...b.lines.map(line)].join('\n')).join('\n\n');
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const td = (s: string, num = false) => `<td${num ? ' style="text-align:right"' : ''}>${escapeHtml(s)}</td>`;
const th = (s: string, num = false) => `<th${num ? ' style="text-align:right"' : ''}>${escapeHtml(s)}</th>`;

/**
 * Cada fila con su fecha, sin día de la semana, para que la planilla la lea como fecha. Lo que va aparte lleva la
 * fecha del día en que se cuenta, sin saldo: no mueve el de este día.
 */
function toHtml(day: string, blocks: Block[]): string {
  const date = shortDate(day);
  const row = (l: Line) => {
    const [rowDate, detail, amount, balance]: [string, string, number | null, number | null] =
      l.kind === 'movement'
        ? [date, l.detail, l.amount, l.balance]
        : l.kind === 'none'
          ? [date, 'Sin movimientos', null, null]
          : l.kind === 'aside-head'
            ? ['', l.text, null, null]
            : l.kind === 'aside'
              ? [shortDate(l.date), l.detail, l.amount, null]
              : [date, l.kind === 'opening' ? 'Saldo inicial' : 'Saldo final', null, l.balance];
    const income = amount !== null && amount > 0 ? clp(amount) : '';
    const expense = amount !== null && amount < 0 ? clp(-amount) : '';
    return `<tr>${td(rowDate)}${td(detail)}${td(income, true)}${td(expense, true)}${td(balance === null ? '' : clp(balance), true)}</tr>`;
  };
  const body = blocks
    .map((b, i) => `${i ? '<tr><td colspan="5"></td></tr>' : ''}<tr><th colspan="5" style="text-align:left">${escapeHtml(b.title)}</th></tr>${b.lines.map(row).join('')}`)
    .join('');
  return `<meta charset="utf-8"><table><thead><tr>${th('Fecha')}${th('Detalle')}${th('Entró', true)}${th('Salió', true)}${th('Saldo', true)}</tr></thead><tbody>${body}</tbody></table>`;
}
