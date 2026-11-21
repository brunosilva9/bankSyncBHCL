import { describe, expect, it } from 'vitest';
import { shortDate } from './format';
import { dayOf, earlierTitle, laterTitle, movedBadgeText, movedFrom, movedTitle, weekdayDay } from './seen';

// Datos ficticios: una transferencia del sábado 14 que el banco fechó el lunes 16.
const moved = { date: '2026-11-16', real_date: '2026-11-14', real_date_source: 'observada' as const, first_seen_at: '2026-11-14T13:32:00.000Z' };
const sat = shortDate('2026-11-14', true);
const mon = shortDate('2026-11-16', true);

describe('fecha real', () => {
  it('solo cuenta como fechado después si la fecha real es anterior a la del banco', () => {
    expect(movedFrom(moved)).toBe('2026-11-14');
    expect(movedFrom({ ...moved, real_date: '2026-11-16', real_date_source: 'banco' })).toBeNull();
    expect(movedFrom({ ...moved, real_date: null, real_date_source: null })).toBeNull();
  });

  it('la insignia dice el día de la semana y el número', () => {
    expect(weekdayDay('2026-11-14')).toBe(`${sat.split(' ')[0]} 14`);
  });

  it('explica por qué: la cartola en que ya estaba, con su hora, o que el banco le cambió la fecha', () => {
    expect(movedTitle(moved)).toBe(
      `Ya aparecía en la cartola del ${sat} de las 10:32, pero el banco lo fechó el ${mon}: lo que se hace de noche, en fin de semana o en feriado pasa al día hábil siguiente.`,
    );
    // Sin hora, o con la de otro día, solo el día.
    expect(movedTitle({ ...moved, first_seen_at: null })).toContain(`cartola del ${sat}, pero`);
    expect(movedTitle({ ...moved, first_seen_at: '2026-11-15T13:32:00.000Z' })).toContain(`cartola del ${sat}, pero`);
    expect(movedTitle({ ...moved, real_date_source: 'banco' })).toBe(`El banco primero lo informó con fecha del ${sat} y después lo pasó al ${mon}.`);
    expect(movedTitle({ ...moved, date: '2026-11-14' })).toBe('');
    expect(laterTitle(moved).endsWith(`Por fecha del banco se cuenta el ${mon}.`)).toBe(true);
    expect(earlierTitle(moved).endsWith(`Por fecha real se cuenta el ${sat}.`)).toBe(true);
  });

  it('la insignia dice la otra fecha: por fecha real, la del banco; por la del banco, el día real', () => {
    expect(movedBadgeText(moved, 'real')).toBe(`banco: ${weekdayDay('2026-11-16')}`);
    expect(movedBadgeText(moved, 'banco')).toBe(`↶ ${weekdayDay('2026-11-14')}`);
    expect(movedBadgeText({ ...moved, real_date: '2026-11-16' }, 'real')).toBeNull();
    expect([dayOf(moved, 'real'), dayOf(moved, 'banco')]).toEqual(['2026-11-14', '2026-11-16']);
  });
});
