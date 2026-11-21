import { describe, expect, it } from 'vitest';
import type { AccountBalances, BalancePoint, DailyBalances, Movement } from './api';
import { compactClp, dayLedger, isWeekend, labeledDays, niceScale, photoText, timelines, timelineSummary, type LedgerRow, type Timeline } from './balances';

// Datos ficticios: del viernes 13 al lunes 16 de noviembre de 2026.
const point = (day: string, available: number | null, cartolas = 0, lastSeenAt: string | null = null): BalancePoint => ({
  day,
  closing: available,
  available,
  cartolas,
  lastSeenAt,
  lastImportedAt: null,
});
const account = (accountId: number, name: string, opening: number | null, days: BalancePoint[]): AccountBalances => ({
  accountId,
  name,
  hasCredit: false,
  opening: { closing: opening, available: opening },
  days,
});
const uno = account(1, 'Cuenta Uno', 0, [
  point('2026-11-13', 1000, 1),
  point('2026-11-14', 800, 1, '2026-11-15T01:00:00.000Z'),
  point('2026-11-15', 800),
  point('2026-11-16', 700, 2),
]);
const dos = account(2, 'Cuenta Dos', 1400, [point('2026-11-13', 1400), point('2026-11-14', 1400), point('2026-11-15', 1400), point('2026-11-16', 900, 1)]);
const vacia = account(3, 'Sin Movimientos', null, ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'].map((d) => point(d, null)));
const data = (accounts: AccountBalances[]): DailyBalances => ({ from: '2026-11-13', to: '2026-11-16', accounts });

describe('líneas de tiempo del saldo', () => {
  it('una por cuenta con movimientos, que parte con el saldo inicial, y la del total', () => {
    const { total, accounts } = timelines(data([uno, dos, vacia]));
    expect(accounts.map((a) => a.name)).toEqual(['Cuenta Uno', 'Cuenta Dos']);
    expect(accounts[0].points.map((p) => [p.day, p.value, p.seen])).toEqual([
      [null, 0, 0],
      ['2026-11-13', 1000, 1],
      ['2026-11-14', 800, 1],
      ['2026-11-15', 800, 0],
      ['2026-11-16', 700, 1],
    ]);
    expect(accounts[0].points[2].lastSeenAt).toBe('2026-11-15T01:00:00.000Z');
    // El total: la suma, y de cuántas cuentas hubo cartola cada día.
    expect(total!.points.map((p) => [p.value, p.seen, p.of])).toEqual([
      [1400, 0, 2],
      [2400, 1, 2],
      [2200, 1, 2],
      [2200, 0, 2],
      [1600, 2, 2],
    ]);
  });

  it('con una sola cuenta no hay total', () => {
    expect(timelines(data([uno, vacia])).total).toBeNull();
  });

  it('el resumen: de cuánto a cuánto, y lo más bajo solo si fue entre medio', () => {
    const line = (values: number[]): Timeline => ({
      accountId: 1,
      name: 'x',
      points: values.map((value, i) => ({ day: i ? `2026-11-1${i}` : null, value, of: 1, seen: 0, lastSeenAt: null })),
    });
    expect(timelineSummary(line([1000, 400, 900]))).toEqual({ start: 1000, end: 900, change: -100, lowest: expect.objectContaining({ day: '2026-11-11', value: 400 }) });
    expect(timelineSummary(line([1000, 800, 700])).lowest).toBeNull(); // terminó en lo más bajo
    expect(timelineSummary(line([500, 800, 700])).lowest).toBeNull(); // nunca bajó del inicio
  });
});

describe('detalle día a día', () => {
  // Datos ficticios. Cuenta Uno: +1.000 el viernes 13; el sábado 14 una transferencia de −200 que el banco fechó el
  // lunes 16; el domingo 15 le pasa 50 a la Cuenta Dos; el lunes 16 un pago de −100. Cuenta Dos, con línea de crédito:
  // el lunes 16 una nómina de dos pagos (−500) y un giro de 400 desde la línea, que no cambia su disponible.
  const mv = (id: number, account: 1 | 2 | 9, date: string, amount: number, direction: 'A' | 'C', description: string, extra: Partial<Movement> = {}): Movement => ({
    id,
    account_id: account,
    account_name: { 1: 'Cuenta Uno', 2: 'Cuenta Dos', 9: 'Tarjeta Prueba' }[account],
    date,
    seq: 0,
    amount,
    direction,
    description,
    doc_number: null,
    kind: 'other',
    counterparty: null,
    payee_name: null,
    category_id: null,
    category_source: null,
    label: null,
    label_source: null,
    note: null,
    balance_after: null,
    provisional: 0,
    payroll_batch: null,
    payroll_split_after: 0,
    installments: null,
    installment_amount: null,
    system_key: null,
    first_seen_day: date,
    first_seen_at: null,
    real_date: date,
    real_date_source: 'banco',
    ...extra,
  });
  const movements = [
    mv(1, 1, '2026-11-13', 1000, 'A', 'Traspaso De: Cliente Uno'),
    mv(2, 1, '2026-11-16', 200, 'C', 'Traspaso A: Proveedor Sabado', { seq: 1, first_seen_day: '2026-11-14', real_date: '2026-11-14', real_date_source: 'observada' }),
    mv(3, 1, '2026-11-15', 50, 'C', 'Traspaso A: Cuenta Dos', { system_key: 'internal' }),
    mv(4, 2, '2026-11-15', 50, 'A', 'Traspaso De: Cuenta Uno', { system_key: 'internal' }),
    mv(5, 1, '2026-11-16', 100, 'C', 'Pago: Proveedor Lunes'),
    mv(6, 2, '2026-11-16', 300, 'C', 'Pago Fácil Bch: 01', { seq: 3, kind: 'payroll', payroll_batch: 1 }),
    mv(7, 2, '2026-11-16', 200, 'C', 'Pago Fácil Bch: 02', { seq: 2, kind: 'payroll', payroll_batch: 1 }),
    mv(8, 2, '2026-11-16', 400, 'A', 'Transferencia Desde Linea De Credito', { seq: 1, kind: 'credit_line' }),
    mv(9, 9, '2026-11-14', 30, 'C', 'Compra Supermercado'),
  ];
  const ledgerData = data([
    account(1, 'Cuenta Uno', 0, [point('2026-11-13', 1000, 1), point('2026-11-14', 800, 1), point('2026-11-15', 750), point('2026-11-16', 650, 1)]),
    { ...account(2, 'Cuenta Dos', 1400, [point('2026-11-13', 1400), point('2026-11-14', 1400), point('2026-11-15', 1450), point('2026-11-16', 950, 1)]), hasCredit: true },
  ]);
  const label = (r: LedgerRow) =>
    ({ gap: 'no cuadra', internal: 'traspasos sin compensar', movement: r.type === 'movement' ? r.m.description : '', payroll: r.type === 'payroll' ? `nómina de ${r.items.length}` : '' })[r.type];
  const rows = (r: LedgerRow) => [label(r), r.amount, r.balance];

  it('cada día con sus movimientos y el saldo consolidado que deja cada uno; termina en el saldo real del día', () => {
    const days = dayLedger(ledgerData, movements, 'real', true);
    // Lo que entró y salió no cuenta los traspasos entre cuentas propias, como en el resumen.
    expect(days.map((d) => [d.day, d.opening, d.income, d.expenses, d.internal, d.closing])).toEqual([
      ['2026-11-13', 1400, 1000, 0, 0, 2400],
      ['2026-11-14', 2400, 0, 200, 0, 2200],
      ['2026-11-15', 2200, 0, 0, 0, 2200],
      ['2026-11-16', 2200, 0, 600, 0, 1600],
    ]);
    expect(days.map((d) => d.rows.map(rows))).toEqual([
      [['Traspaso De: Cliente Uno', 1000, 2400]],
      // Por fecha real, lo del sábado que el banco fechó el lunes va el sábado.
      [['Traspaso A: Proveedor Sabado', -200, 2200]],
      // Un traspaso entre las dos cuentas no suma ni resta: un abono en una y un cargo en la otra se compensan.
      [
        ['Traspaso De: Cuenta Uno', 50, 2200],
        ['Traspaso A: Cuenta Dos', -50, 2200],
      ],
      // La nómina en una línea; el giro de la línea no va (no cambia el disponible), ni la compra con tarjeta.
      [
        ['nómina de 2', -500, 1700],
        ['Pago: Proveedor Lunes', -100, 1600],
      ],
    ]);
  });

  it('cada día trae el saldo final de cada cuenta, que suman el del día, y la cartola de la que sale', () => {
    const days = dayLedger(ledgerData, movements, 'real');
    expect(days[3].accounts.map((a) => [a.name, a.available, a.cartolas])).toEqual([
      ['Cuenta Uno', 650, 1],
      ['Cuenta Dos', 950, 1],
    ]);
    expect(days.every((d) => d.accounts.reduce((s, a) => s + a.available, 0) === d.closing)).toBe(true);
    // La hora de descarga si se sabe (en Chile); si no, cuándo se subió; y si ese día no hubo cartola, eso.
    expect(photoText({ cartolas: 1, lastSeenAt: '2026-11-17T01:00:00.000Z', lastImportedAt: '2026-11-17 01:05:00' })).toBe('cartola del lun 16/11 22:00');
    expect(photoText({ cartolas: 1, lastSeenAt: null, lastImportedAt: '2026-11-18 12:30:00' })).toBe('cartola sin hora, subida el mié 18/11 09:30');
    expect(photoText({ cartolas: 0, lastSeenAt: null, lastImportedAt: null })).toBe('sin cartola ese día');
  });

  it('sin pedirlos, los traspasos con cuentas propias no se muestran', () => {
    const days = dayLedger(ledgerData, movements, 'real');
    expect(days[2]).toMatchObject({ rows: [], hiddenInternal: 2, closing: 2200 });
    expect(days[3].rows.map(rows)).toEqual([
      ['nómina de 2', -500, 1700],
      ['Pago: Proveedor Lunes', -100, 1600],
    ]);
  });

  it('lo que un traspaso no compensa en el día va en una línea: el otro lado quedó en otro día o en otra cuenta', () => {
    // El banco fechó el cargo el domingo 15 y el abono el lunes 16: el consolidado baja un día y sube al siguiente.
    const split = data([
      account(1, 'Cuenta Uno', 1000, [point('2026-11-15', 950), point('2026-11-16', 950)]),
      account(2, 'Cuenta Dos', 0, [point('2026-11-15', 0), point('2026-11-16', 50)]),
    ]);
    const transfers = [movements[2], { ...movements[3], date: '2026-11-16', real_date: '2026-11-16' }];
    expect(dayLedger(split, transfers, 'real').map((d) => d.rows.map(rows))).toEqual([[['traspasos sin compensar', -50, 950]], [['traspasos sin compensar', 50, 1000]]]);
    expect(dayLedger(split, transfers, 'real', true)[0].rows.map(rows)).toEqual([
      ['Traspaso A: Cuenta Dos', -50, 1000],
      ['traspasos sin compensar', -50, 950],
    ]);
  });

  it('por fecha del banco, lo del sábado va el lunes', () => {
    const bank = data([
      account(1, 'Cuenta Uno', 0, [point('2026-11-13', 1000), point('2026-11-14', 1000), point('2026-11-15', 950), point('2026-11-16', 650)]),
    ]);
    const days = dayLedger(bank, movements, 'banco');
    expect(days[1].rows).toEqual([]);
    // Con una sola cuenta, el traspaso a la otra no se compensa: va en su línea, aparte de lo que entró y salió.
    expect(days[2].rows.map(rows)).toEqual([['traspasos sin compensar', -50, 950]]);
    expect(days[2]).toMatchObject({ income: 0, expenses: 0, internal: -50, hiddenInternal: 1, closing: 950 });
    expect(days[3].rows.map(rows)).toEqual([
      ['Traspaso A: Proveedor Sabado', -200, 750],
      ['Pago: Proveedor Lunes', -100, 650],
    ]);
  });

  it('lo que los movimientos no explican queda al principio del día', () => {
    const gap = data([account(1, 'Cuenta Uno', 0, [point('2026-11-13', 1000), point('2026-11-14', 1100)])]);
    const days = dayLedger(gap, [movements[0]], 'real');
    expect(days[1].rows.map(rows)).toEqual([['no cuadra', 100, 1100]]);
    expect(days[1]).toMatchObject({ income: 0, expenses: 0, closing: 1100 });
  });
});

describe('ejes', () => {
  it('marcas en números redondos que cubren todo', () => {
    expect(niceScale(35_200_000, 41_800_000)).toEqual({ min: 34_000_000, max: 42_000_000, ticks: [34e6, 36e6, 38e6, 40e6, 42e6] });
    // De a 5 y no de a 10: de 20 a 45 y no a 50.
    expect(niceScale(22_000_000, 44_800_000).ticks).toEqual([20e6, 25e6, 30e6, 35e6, 40e6, 45e6]);
    expect(niceScale(-1500, 2600).ticks).toEqual([-2000, -1000, 0, 1000, 2000, 3000]);
    // Un gráfico bajo, con menos tramos.
    expect(niceScale(500_000, 2_300_000, 2).ticks).toEqual([0, 1e6, 2e6, 3e6]);
    // Saldo plano: queda al medio.
    const flat = niceScale(5000, 5000);
    expect(flat.min).toBeLessThan(5000);
    expect(flat.max).toBeGreaterThan(5000);
  });

  it('montos cortos: MM son millones', () => {
    expect(compactClp(37_500_000)).toBe('$37,5 MM');
    expect(compactClp(1_250_000)).toBe('$1,25 MM');
    expect(compactClp(850_000)).toBe('$850 mil');
    expect(compactClp(-2_000_000)).toBe('−$2 MM');
    expect(compactClp(900)).toBe('$900');
    expect(compactClp(0)).toBe('$0');
  });

  it('los días con nombre no se enciman y el último siempre va', () => {
    expect([...labeledDays(7, 80, 50)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const every2 = labeledDays(31, 20, 40);
    expect(every2.has(30)).toBe(true);
    expect(every2.has(29)).toBe(false);
    expect(every2.has(28)).toBe(true);
  });

  it('sábado y domingo', () => {
    expect(['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'].map(isWeekend)).toEqual([false, true, true, false]);
  });
});
