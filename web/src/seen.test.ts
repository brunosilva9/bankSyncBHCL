import { describe, expect, it } from 'vitest';
import { shortDate } from './format';
import { dayOf, earlierTitle, laterTitle, movedBadgeText, movedFrom, movedTitle, realDateOptions, realDateTitle, weekdayDay, type Placeable } from './seen';

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

describe('fecha real a mano', () => {
  // Datos ficticios: un pago con fecha del lunes 16 que apareció en la cartola del lunes a las 07:00; la descarga anterior
  // fue el sábado a las 10:00. Pudo pasar el sábado (después de esa descarga), el domingo o el lunes.
  const monday: Placeable = {
    date: '2026-11-16',
    real_date: '2026-11-16',
    real_date_source: 'banco',
    first_seen_day: '2026-11-16',
    first_seen_at: '2026-11-16T10:00:00.000Z',
    real_date_window: { min: '2026-11-14', max: '2026-11-16', before: { day: '2026-11-14', at: '2026-11-14T13:00:00.000Z' } },
  };
  const day = (iso: string) => shortDate(iso, true);

  it('se puede elegir cualquier día de la ventana; si la fecha que tiene quedó fuera, también esa', () => {
    expect(realDateOptions(monday)).toEqual(['2026-11-14', '2026-11-15', '2026-11-16']);
    expect(realDateOptions({ ...monday, real_date: '2026-11-13', real_date_source: 'manual' })).toEqual(['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']);
    expect(realDateOptions({ ...monday, real_date_window: null })).toEqual([]);
  });

  it('explica entre qué cartolas quedó: la que todavía no lo traía y la que ya lo traía, con sus horas', () => {
    expect(realDateTitle(monday)).toBe(
      `Fecha real: el día en que pasó. El banco lo fechó el ${mon}. No aparecía en la cartola del ${sat} de las 10:00: pasó después. ` +
        `Ya aparecía en la del ${mon} de las 07:00.`,
    );
    // Sin descarga anterior: el límite es el día hábil anterior. Lo corregido a mano lo dice.
    const friday = { ...monday, date: '2026-11-13', real_date: '2026-11-12', real_date_source: 'manual' as const, first_seen_day: '2026-11-20' };
    expect(realDateTitle({ ...friday, real_date_window: { min: '2026-11-12', max: '2026-11-13', before: null } })).toBe(
      `Fecha real: el día en que pasó. El banco lo fechó el ${day('2026-11-13')}. Lo más temprano es el día hábil anterior: el banco pasa al ` +
        'siguiente lo que se hace de noche, en fin de semana o en feriado. Corregida a mano.',
    );
  });
});
