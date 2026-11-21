import type { DateMode, RealDateSource, RealDateWindow } from './api';
import { addDaysIso, inChile, shortDate } from './format';

// Movimientos que el banco fechó después de su fecha real: lo que se hace de noche, en fin de semana o en feriado
// pasa al día hábil siguiente, aunque ya aparezca en la cartola de ese mismo día. La fecha real es la del día en
// que apareció por primera vez, y se conserva aunque el banco después le cambie el nombre o lo consolide (ver
// server/src/domain/seen.ts).

/** Lo que hace falta de un movimiento (de Movimientos o del Diario). */
export type Dated = { date: string; real_date: string | null; real_date_source: RealDateSource | null; first_seen_at: string | null };

/** Fecha real de un movimiento que el banco fechó después; null si su fecha es la del banco. */
export const movedFrom = (m: Dated) => (m.real_date && m.real_date < m.date ? m.real_date : null);

/** "vie 13": para la insignia, que va junto a la fecha del banco. */
export const weekdayDay = (iso: string) => {
  const [weekday, date] = shortDate(iso, true).split(' ');
  return `${weekday} ${date.slice(0, 2)}`;
};

/** Hora de la descarga de la cartola en que apareció, si se sabe y es de ese día. */
const seenTime = (m: Dated, day: string) => {
  if (!m.first_seen_at) return null;
  const at = inChile(m.first_seen_at);
  return at.day === day ? at.time : null;
};

/** Por qué tiene otra fecha real, para el detalle de la insignia. */
export function movedTitle(m: Dated): string {
  const real = movedFrom(m);
  if (!real) return '';
  const bank = shortDate(m.date, true);
  if (m.real_date_source === 'manual') return `Fecha real corregida a mano: ${shortDate(real, true)}. El banco lo fechó el ${bank}.`;
  if (m.real_date_source === 'banco') return `El banco primero lo informó con fecha del ${shortDate(real, true)} y después lo pasó al ${bank}.`;
  // La hora es la de la descarga o, en lo cargado antes de guardarla, la de subida: en las dos ya aparecía.
  const time = seenTime(m, real);
  return (
    `Ya aparecía en la cartola del ${shortDate(real, true)}${time ? ` de las ${time}` : ''}, pero el banco lo fechó el ${bank}: ` +
    'lo que se hace de noche, en fin de semana o en feriado pasa al día hábil siguiente.'
  );
}

/** El porqué y en qué día se cuenta, según las fechas que se están usando. */
export function countedTitle(m: Dated, dates: DateMode): string {
  const real = movedFrom(m);
  if (!real) return '';
  return `${movedTitle(m)} ${dates === 'real' ? `Por fecha real se cuenta el ${shortDate(real, true)}.` : `Por fecha del banco se cuenta el ${shortDate(m.date, true)}.`}`;
}

/** Por fecha del banco, en su día real: por qué está aquí y por qué no suma. */
export const laterTitle = (m: Dated) => countedTitle(m, 'banco');

/** Por fecha real, en su fecha del banco: por qué está aquí y por qué no suma. */
export const earlierTitle = (m: Dated) => countedTitle(m, 'real');

/** El día en que se muestra y se cuenta un movimiento. */
export const dayOf = (m: { date: string; real_date: string | null }, dates: DateMode) => (dates === 'real' ? (m.real_date ?? m.date) : m.date);

/**
 * La insignia de un movimiento que el banco fechó después: por fecha real, la fecha del banco ("banco: lun 23");
 * por la del banco, el día en que ya aparecía ("↶ vie 20"). null si no hace falta.
 */
export function movedBadgeText(m: Dated, dates: DateMode): string | null {
  const real = movedFrom(m);
  if (!real) return null;
  return dates === 'real' ? `banco: ${weekdayDay(m.date)}` : `↶ ${weekdayDay(real)}`;
}

/** Un movimiento con los días en que pudo pasar (de GET /api/movements). */
export type Placeable = Dated & { first_seen_day: string | null; real_date_window?: RealDateWindow | null };

/** Los días que se pueden elegir como fecha real: los de su ventana y, si quedó fuera, la que tiene. */
export function realDateOptions(m: Placeable): string[] {
  const w = m.real_date_window;
  if (!w) return [];
  const days: string[] = [];
  for (let d = w.min; d <= w.max; d = addDaysIso(d, 1)) days.push(d);
  const current = m.real_date ?? m.date;
  return days.includes(current) ? days : [...days, current].sort();
}

/** Por qué se puede elegir entre esos días, para el detalle del selector. */
export function realDateTitle(m: Placeable): string {
  const w = m.real_date_window;
  if (!w) return '';
  const parts = [`Fecha real: el día en que pasó. El banco lo fechó el ${shortDate(m.date, true)}.`];
  if (w.before) {
    const time = w.before.at ? inChile(w.before.at) : null;
    parts.push(`No aparecía en la cartola del ${shortDate(w.before.day, true)}${time?.day === w.before.day ? ` de las ${time.time}` : ''}: pasó después.`);
  } else {
    parts.push('Lo más temprano es el día hábil anterior: el banco pasa al siguiente lo que se hace de noche, en fin de semana o en feriado.');
  }
  if (m.first_seen_day && m.first_seen_day <= w.max) {
    const time = seenTime(m, m.first_seen_day);
    parts.push(`Ya aparecía en la del ${shortDate(m.first_seen_day, true)}${time ? ` de las ${time}` : ''}.`);
  }
  if (m.real_date_source === 'manual') parts.push('Corregida a mano.');
  return parts.join(' ');
}
