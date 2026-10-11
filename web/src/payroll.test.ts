import { describe, expect, it } from 'vitest';
import type { Movement } from './api';
import { buildBatches, groupPayroll, summarizeWorkers } from './payroll';

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
