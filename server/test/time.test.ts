import { describe, expect, it } from 'vitest';
import { addDays, chileDay, chileInstant, chileParts, daysBetween } from '../src/time.js';

describe('hora de Chile', () => {
  it('a las 23:59 de Chile sigue siendo el mismo día, aunque en UTC ya es el siguiente', () => {
    expect(chileDay(Date.UTC(2026, 10, 14, 2, 59))).toBe('2026-11-13');
    expect(chileDay(Date.UTC(2026, 10, 14, 3, 0))).toBe('2026-11-14');
  });

  it('el 6-9-2026 se pasa de las 23:59 a la 01:00: las 00:00 no existieron', () => {
    expect(chileParts(Date.UTC(2026, 8, 6, 3, 59))).toEqual({ day: '2026-09-05', hour: 23, minute: 59 });
    expect(chileParts(Date.UTC(2026, 8, 6, 4, 0))).toEqual({ day: '2026-09-06', hour: 1, minute: 0 });
  });

  it('el 3-4-2027 la hora de 23:00 a 23:59 se repite', () => {
    expect(chileParts(Date.UTC(2027, 3, 4, 2, 30))).toEqual({ day: '2027-04-03', hour: 23, minute: 30 });
    expect(chileParts(Date.UTC(2027, 3, 4, 3, 30))).toEqual({ day: '2027-04-03', hour: 23, minute: 30 });
    expect(chileParts(Date.UTC(2027, 3, 4, 4, 0))).toEqual({ day: '2027-04-04', hour: 0, minute: 0 });
  });

  it('una hora de Chile pasa a su instante, también en el cambio de hora', () => {
    const utc = (local: string) => new Date(chileInstant(local)!).toISOString().slice(0, 16);
    expect(utc('2026-07-15 10:00')).toBe('2026-07-15T14:00'); // invierno, UTC−4
    expect(utc('2026-11-13 22:30')).toBe('2026-11-14T01:30'); // verano, UTC−3: en UTC ya es el día siguiente
    expect(utc('2027-04-03 23:30')).toBe('2027-04-04T02:30'); // se repite: la primera vez
    expect(utc('2026-09-06 00:30')).toBe('2026-09-06T04:30'); // no existió: son las 01:30
    expect(chileParts(chileInstant('2026-09-06 00:30')!)).toEqual({ day: '2026-09-06', hour: 1, minute: 30 });
    expect(chileInstant('13/11/2026')).toBeNull();
  });

  it('suma días de calendario y lista los días de un rango', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-11-29', '2026-12-02')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
    expect(daysBetween('2026-12-02', '2026-11-29')).toEqual([]);
  });
});
