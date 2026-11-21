import { describe, expect, it } from 'vitest';
import type { DayEntry, DayMovement, Hito, Movement } from './api';
import { buildBatches, groupDayPayroll, groupPayroll, payrollComment, payrollTitle, summarizeWorkers, type DayPayroll } from './payroll';

const mov = (id: number, kind: string, payroll_batch: number | null = null, date = '2026-10-13', account_id = 1) =>
  ({ id, kind, date, account_id, payroll_batch }) as Movement;

const ids = (rows: ReturnType<typeof groupPayroll>) => rows.map((r) => (r.type === 'batch' ? r.items.map((m) => m.id) : r.m.id));

describe('groupPayroll', () => {
  it('junta los Pago Fácil de una misma nómina', () => {
    const rows = groupPayroll([mov(1, 'transfer_out'), mov(2, 'payroll', 1), mov(3, 'payroll', 1), mov(4, 'card_payment')]);
    expect(ids(rows)).toEqual([1, [2, 3], 4]);
  });

  it('separa las nóminas distintas del mismo día y las numera', () => {
    const rows = groupPayroll([mov(1, 'payroll', 2), mov(2, 'payroll', 2), mov(3, 'card_payment'), mov(4, 'payroll', 1), mov(5, 'payroll', 1)]);
    expect(ids(rows)).toEqual([[1, 2], 3, [4, 5]]);
    expect(rows.flatMap((r) => (r.type === 'batch' ? [`${r.batch}/${r.batchesInDay}`] : []))).toEqual(['2/2', '1/2']);
  });

  it('separa nóminas de distintas cuentas o días, y un pago suelto no es lote', () => {
    const rows = groupPayroll([mov(1, 'payroll', 1, '2026-10-13', 1), mov(2, 'payroll', 1, '2026-10-13', 2), mov(3, 'payroll', 1, '2026-10-13', 2)]);
    expect(rows.map((r) => r.type)).toEqual(['single', 'batch']);
  });
});

describe('groupDayPayroll (Diario)', () => {
  const entry = (id: number, kind: string, payroll_batch: number | null, extra: Partial<DayMovement> = {}): DayEntry => ({
    type: 'movement',
    movement: { id, seq: 0, amount: 10 * id, direction: 'C', description: `Mov ${id}`, kind, counterparty: null, payee_name: null, category_name: null, category_color: null, system_key: null, label: null, balance_after: 1000 - id, provisional: 0, payroll_batch, date: '2026-10-13', first_seen_day: '2026-10-13', first_seen_at: null, real_date: '2026-10-13', real_date_source: 'banco', ...extra },
  });
  const pay = (id: number, batch: number, extra: Partial<DayMovement> = {}) => entry(id, 'payroll', batch, extra);
  const hito: DayEntry = { type: 'hito', hito: { importId: 1 } as Hito };
  const shape = (rows: ReturnType<typeof groupDayPayroll>) =>
    rows.map((r) => (r.type === 'payroll' ? r.items.map((m) => m.id) : r.type === 'hito' ? 'cartola' : r.movement.id));

  it('cada nómina en una línea, con lo que suma y el saldo después de su último pago', () => {
    const rows = groupDayPayroll([entry(1, 'transfer_out', null), pay(2, 1), pay(3, 1), entry(4, 'card_payment', null)]);
    expect(shape(rows)).toEqual([1, [2, 3], 4]);
    const p = rows[1] as DayPayroll;
    expect(p).toMatchObject({ net: -50, balanceAfter: 997, batch: 1, batchesInDay: 1 });
    expect(payrollTitle(p)).toBe('Nómina Pago Fácil · 2 pagos');
  });

  it('las nóminas del mismo día se numeran como en Nóminas; la de un solo pago va como movimiento', () => {
    const rows = groupDayPayroll([pay(1, 1), pay(2, 1), pay(3, 2), pay(4, 2), entry(5, 'transfer_out', null), pay(6, 3)]);
    expect(shape(rows)).toEqual([[1, 2], [3, 4], 5, 6]);
    expect(rows.flatMap((r) => (r.type === 'payroll' ? [payrollTitle(r)] : []))).toEqual([
      'Nómina Pago Fácil · 2 pagos · nómina 1 de 3',
      'Nómina Pago Fácil · 2 pagos · nómina 2 de 3',
    ]);
  });

  it('una cartola entre dos pagos de la misma nómina queda en su lugar', () => {
    expect(shape(groupDayPayroll([pay(1, 1), pay(2, 1), hito, pay(3, 1), pay(4, 1)]))).toEqual([[1, 2], 'cartola', [3, 4]]);
  });

  it('lo que el banco fechó después se agrupa aparte, sin el n° de nómina de su fecha contable', () => {
    const later = (id: number, batch: number): DayEntry => ({ type: 'later', movement: (pay(id, batch) as { movement: DayMovement }).movement });
    const rows = groupDayPayroll([pay(1, 1), pay(2, 1), later(3, 2), later(4, 2), later(5, 3)]);
    expect(rows.map((r) => (r.type === 'payroll' ? `${r.aside ? 'después' : 'hoy'} ${r.items.map((m) => m.id)}` : `${r.type} ${r.type === 'hito' ? '' : r.movement.id}`))).toEqual([
      'hoy 1,2',
      'después 3,4',
      'later 5',
    ]);
    expect(payrollTitle(rows[1] as DayPayroll)).toBe('Nómina Pago Fácil · 2 pagos');
  });

  it('el comentario de la nómina es el de sus pagos, si todos tienen el mismo', () => {
    const same = groupDayPayroll([pay(1, 1, { label: 'Sueldos' }), pay(2, 1, { label: 'Sueldos' })])[0] as DayPayroll;
    const mixed = groupDayPayroll([pay(1, 1, { label: 'Sueldos' }), pay(2, 1)])[0] as DayPayroll;
    expect([payrollComment(same), payrollComment(mixed)]).toEqual(['Sueldos', null]);
  });
});

describe('buildBatches y summarizeWorkers', () => {
  const pago = (id: number, rut: string, amount: number, batch: number, date = '2026-10-13') =>
    ({ id, kind: 'payroll', date, account_id: 1, account_name: 'Cuenta Uno', payroll_batch: batch, counterparty: rut, payee_name: null, amount }) as Movement;

  const batches = buildBatches([
    pago(1, '11.111.111-1', 100, 2),
    pago(2, '22.222.222-2', 50, 2),
    pago(3, '11.111.111-1', 30, 1),
    pago(4, '11.111.111-1', 20, 1, '2026-10-06'),
  ]);

  it('arma las nóminas con su total, de la más reciente a la más antigua', () => {
    expect(batches.map((b) => [b.date, b.batch, b.batchesInDay, b.total, b.items.length])).toEqual([
      ['2026-10-13', 2, 2, 150, 2],
      ['2026-10-13', 1, 2, 30, 1],
      ['2026-10-06', 1, 1, 20, 1],
    ]);
  });

  it('suma lo pagado a cada trabajador y en cuántas nóminas aparece', () => {
    expect(summarizeWorkers(batches)).toEqual([
      { rut: '11.111.111-1', name: null, total: 150, count: 3, batches: 3, lastDate: '2026-10-13' },
      { rut: '22.222.222-2', name: null, total: 50, count: 1, batches: 1, lastDate: '2026-10-13' },
    ]);
  });
});

describe('nóminas por fecha real', () => {
  const pago = (id: number, date: string, real: string) =>
    ({ id, kind: 'payroll', date, real_date: real, account_id: 1, account_name: 'Cuenta Uno', payroll_batch: 1, counterparty: '11.111.111-1', payee_name: null, amount: 10 }) as Movement;
  // Viernes 20: una nómina en la tarde y otra en la noche, que el banco fechó el lunes 23 (cada una es el bloque 1 de su fecha).
  const list = [pago(1, '2026-11-20', '2026-11-20'), pago(2, '2026-11-20', '2026-11-20'), pago(3, '2026-11-23', '2026-11-20'), pago(4, '2026-11-23', '2026-11-20')];

  it('las dos quedan el viernes y se numeran en el orden en que se hicieron', () => {
    expect(buildBatches(list, 'real').map((b) => [b.date, b.batch, b.batchesInDay, b.items.length])).toEqual([
      ['2026-11-20', 2, 2, 2],
      ['2026-11-20', 1, 2, 2],
    ]);
    expect(groupPayroll(list, 'real').flatMap((r) => (r.type === 'batch' ? [`${r.batch}/${r.batchesInDay}`] : []))).toEqual(['1/2', '2/2']);
    // Por fecha del banco, cada una en su fecha.
    expect(buildBatches(list, 'banco').map((b) => [b.date, b.batch, b.batchesInDay])).toEqual([
      ['2026-11-23', 1, 1],
      ['2026-11-20', 1, 1],
    ]);
  });
});
