import { describe, expect, it } from 'vitest';
import type { Category, Movement } from './api';
import { chronological, groupByCategory, movementTitle, periodText, reportFileName, topPayroll } from './reportDetail';

const cats = [
  { id: 1, name: 'Sueldos y nómina', color: '#00f' },
  { id: 2, name: 'Combustible', color: '#f00' },
] as Category[];

const mov = (id: number, date: string, seq: number, amount: number, category_id: number | null, extra: Partial<Movement> = {}) =>
  ({ id, date, seq, amount, category_id, kind: 'transfer_out', account_id: 1, account_name: 'Cuenta Uno', description: `Mov ${id}`, counterparty: null, payee_name: null, payroll_batch: null, ...extra }) as Movement;

describe('detalle del informe', () => {
  it('ordena del más antiguo al más reciente (dentro del día, seq 0 es el último)', () => {
    const ordered = chronological([mov(1, '2026-10-13', 0, 1, null), mov(2, '2026-10-09', 0, 1, null), mov(3, '2026-10-13', 1, 1, null)]);
    expect(ordered.map((m) => m.id)).toEqual([2, 3, 1]);
  });

  it('agrupa por categoría con subtotal, de mayor a menor, y junta cada nómina en una fila', () => {
    const groups = groupByCategory(
      [
        mov(1, '2026-10-13', 0, 100, 2),
        mov(2, '2026-10-13', 1, 300, 1, { kind: 'payroll', payroll_batch: 1 }),
        mov(3, '2026-10-13', 2, 200, 1, { kind: 'payroll', payroll_batch: 1 }),
        mov(4, '2026-10-12', 0, 50, null),
      ],
      cats,
    );
    expect(groups.map((g) => [g.name, g.total, g.count, g.rows.length])).toEqual([
      ['Sueldos y nómina', 500, 2, 1],
      ['Combustible', 100, 1, 1],
      ['Sin categoría', 50, 1, 1],
    ]);
  });

  it('muestra el nombre del trabajador, la contraparte o la descripción', () => {
    expect(movementTitle(mov(1, '2026-10-13', 0, 1, null, { payee_name: 'Juan', counterparty: '11.111.111-1' }))).toBe('Juan');
    expect(movementTitle(mov(1, '2026-10-13', 0, 1, null, { counterparty: 'Copec' }))).toBe('Copec');
    expect(movementTitle(mov(1, '2026-10-13', 0, 1, null))).toBe('Mov 1');
  });
});

describe('topPayroll', () => {
  const line = (date: string, total: number, count = 1) => ({ accountId: 1, accountName: 'Cuenta Uno', date, batch: 1, batchesInDay: 1, total, count });

  it('muestra las nóminas más grandes por fecha y suma el resto', () => {
    const r = topPayroll([line('2026-10-13', 500, 20), line('2026-10-09', 10), line('2026-10-06', 300, 12), line('2026-10-05', 20)], 2);
    expect(r.shown.map((p) => p.date)).toEqual(['2026-10-06', '2026-10-13']);
    expect(r.rest).toEqual({ batches: 2, count: 2, total: 30 });
  });
});

describe('título y nombre de archivo del informe', () => {
  it('describe el período real con día de la semana', () => {
    expect(periodText({ from: '2026-10-09', to: '2026-10-13' })).toBe('del vie 09/10/2026 al mar 13/10/2026');
    expect(periodText({ from: '2026-10-13', to: '2026-10-13' })).toBe('del mar 13/10/2026');
  });

  it('arma un nombre de archivo válido', () => {
    expect(reportFileName({ from: '2026-10-09', to: '2026-10-13' }, 'Todas las cuentas')).toBe('Informe 09-10-2026 al 13-10-2026 - Todas las cuentas');
    expect(reportFileName({ from: '2026-10-13', to: '2026-10-13' }, 'Cuenta A/B')).toBe('Informe 13-10-2026 - Cuenta AB');
  });
});
