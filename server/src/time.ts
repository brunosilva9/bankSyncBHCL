// Hora de Chile en un solo lugar. Los instantes se guardan en UTC y los días como YYYY-MM-DD de Chile.
// Las funciones reciben el instante para poder probar el cambio de hora y el tramo de 21:00 a 24:00, cuando
// en UTC ya es el día siguiente: un `toISOString().slice(0, 10)` a esa hora da el día equivocado.
const FORMATO = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Día (YYYY-MM-DD), hora y minuto de Chile de un instante. */
export function chileParts(ms: number): { day: string; hour: number; minute: number } {
  const p = Object.fromEntries(FORMATO.formatToParts(ms).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

/** Día de Chile: a las 23:59 del 13 en Chile ya es el 14 en UTC, pero aquí sigue siendo el 13. */
export const chileDay = (ms: number = Date.now()) => chileParts(ms).day;

/**
 * Instante (ms) de una hora de Chile "YYYY-MM-DD HH:MM", como la de descarga que anota BancoEstado. En Chile es
 * UTC−4, o UTC−3 en horario de verano: se prueba cuál calza. La hora que se repite al volver al horario de
 * invierno da la primera vez; la que no existe al pasar al de verano (00:00 a 00:59) se lee con la hora de
 * invierno, que ya cae en la de verano: las 00:30 son las 01:30.
 */
export function chileInstant(local: string): number | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  for (const offset of [3, 4]) {
    const ms = Date.UTC(y, mo - 1, d, h + offset, mi);
    const p = chileParts(ms);
    if (p.day === `${m[1]}-${m[2]}-${m[3]}` && p.hour === h && p.minute === mi) return ms;
  }
  return Date.UTC(y, mo - 1, d, h + 4, mi);
}

/** Suma días de calendario a un día YYYY-MM-DD (sin zona horaria: un día es un día). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Días de `from` a `to`, ambos incluidos. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}
