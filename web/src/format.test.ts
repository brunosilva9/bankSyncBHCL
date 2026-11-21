import { describe, expect, it } from 'vitest';
import { addDaysIso, chileDateTime, clp, clpSigned, inChile, presetRange, shortDate } from './format';

describe('formato de montos', () => {
  it('formatea pesos chilenos sin decimales', () => {
    expect(clp(1234567)).toMatch(/1\.234\.567/);
    expect(clp(null)).toBe('—');
  });
  it('agrega signo explícito', () => {
    expect(clpSigned(500)).toMatch(/^\+/);
    expect(clpSigned(-500)).toMatch(/^−/);
  });
});

describe('fechas', () => {
  it('muestra dd/mm/aaaa', () => {
    expect(shortDate('2026-10-09')).toBe('09/10/2026');
  });

  it('"Desde el viernes" parte el viernes anterior', () => {
    const sunday = new Date(2026, 9, 11); // domingo 11/10/2026
    expect(presetRange('friday', sunday).from).toBe('2026-10-09');
  });

  it('"Desde el viernes" un viernes parte ese mismo día', () => {
    expect(presetRange('friday', new Date(2026, 9, 9)).from).toBe('2026-10-09');
  });

  it('"Hasta" incluye movimientos fechados a futuro (fin de semana o feriado)', () => {
    expect(presetRange('week', new Date(2026, 9, 11)).to).toBe('2026-10-18');
  });

  it('mes pasado cubre el mes completo', () => {
    expect(presetRange('lastMonth', new Date(2026, 9, 11))).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });
});

describe('hora de Chile', () => {
  it('lee instantes UTC en ISO y en el formato de SQLite', () => {
    // 02:00 del 15 en Chile (verano, UTC−3).
    expect(inChile('2026-11-15T05:00:00.000Z')).toEqual({ day: '2026-11-15', time: '02:00' });
    expect(inChile('2026-11-15 05:00:00')).toEqual({ day: '2026-11-15', time: '02:00' });
    // 01:30 UTC del 15 todavía es el 14 en Chile.
    expect(chileDateTime('2026-11-15 01:30:00')).toBe('14/11/2026 22:30');
  });

  it('suma días de calendario', () => {
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });
});
