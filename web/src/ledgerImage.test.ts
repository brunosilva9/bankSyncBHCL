import { describe, expect, it } from 'vitest';
import type { Category, Movement } from './api';
import type { LedgerDay } from './balances';
import { clp } from './format';
import { balancesCardSvg, cardLines, dayCardSvg, type DayCardOptions, type Measure } from './ledgerImage';

// Datos ficticios: el lunes 16 de noviembre de 2026, con dos cuentas.
const mv = (id: number, account: 1 | 2, amount: number, direction: 'A' | 'C', description: string, extra: Partial<Movement> = {}): Movement => ({
  id,
  account_id: account,
  account_name: account === 1 ? 'Cuenta Uno' : 'Cuenta Dos',
  date: '2026-11-16',
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
  first_seen_day: '2026-11-16',
  first_seen_at: null,
  real_date: '2026-11-16',
  real_date_source: 'banco',
  ...extra,
});
const categories: Category[] = [
  { id: 11, name: 'Sueldos', color: '#2563eb', system_key: 'payroll', sort: 1 },
  { id: 12, name: 'Traspaso interno', color: '#8a94a6', system_key: 'internal', sort: 2 },
];
const payroll = { kind: 'payroll', payroll_batch: 1, category_id: 11, label: 'Sueldos noviembre' } as const;
const day: LedgerDay = {
  day: '2026-11-16',
  // Suman el saldo final: 650 + 950 = 1.600. La Cuenta Dos tiene línea: cuenta su disponible.
  accounts: [
    { accountId: 1, name: 'Cuenta Uno', closing: 650, available: 650, hasCredit: false, cartolas: 1, lastSeenAt: '2026-11-17T01:00:00.000Z', lastImportedAt: '2026-11-17 01:05:00' },
    { accountId: 2, name: 'Cuenta Dos', closing: -50, available: 950, hasCredit: true, cartolas: 0, lastSeenAt: null, lastImportedAt: null },
  ],
  opening: 2200,
  closing: 1600,
  income: 0,
  expenses: 600,
  internal: 0,
  hiddenInternal: 0,
  rows: [
    { type: 'payroll', key: 'k', items: [mv(4, 2, 300, 'C', 'Pago Fácil Bch: 01', payroll), mv(5, 2, 200, 'C', 'Pago Fácil Bch: 02', payroll)], batch: 1, batchesInDay: 1, amount: -500, effect: -500, balance: 1700 },
    { type: 'movement', m: mv(3, 1, 100, 'C', 'Pago: Proveedor Lunes con un nombre tan largo que no cabe en su columna'), amount: -100, effect: -100, balance: 1600 },
    { type: 'movement', m: mv(7, 1, 50, 'C', 'Traspaso A: Cuenta Dos', { category_id: 12, system_key: 'internal' }), amount: -50, effect: 0, balance: 1600 },
  ],
};
const options: DayCardOptions = { scope: 'Todas las cuentas', multi: true, categories, dates: 'real' };
// Sin canvas en los tests: cada letra mide 4 px.
const measure: Measure = (text) => text.length * 4;

describe('la foto de un día', () => {
  it('encabezado, una fila por movimiento con su categoría y el saldo que deja, y el saldo con que terminó', () => {
    const { svg, width, height } = dayCardSvg(day, options, measure);
    // Encabezado, títulos, saldo inicial y 3 movimientos, y el pie.
    expect([width, height]).toEqual([864, 74 + 26 + 26 * 4 + 26 + 20]);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    const texts = [...doc.querySelectorAll('text')];
    const content = texts.map((t) => t.textContent);
    expect(content.slice(0, 2)).toEqual(['lun 16/11/2026', 'Todas las cuentas · saldo consolidado']);
    expect(content).toEqual(
      expect.arrayContaining([
        'Saldo inicial',
        '$2.200',
        'Cuenta Dos',
        'Nómina Pago Fácil · 2 pagos · Sueldos noviembre',
        'Sueldos',
        '$500',
        '$1.700',
        'Saldo al final del día',
        '$600',
        '$1.600',
      ]),
    );
    // Los saldos por cuenta van en su propia tarjeta.
    expect(content).not.toContain('cartola del lun 16/11 22:00');
    // Lo que no cabe en su columna se corta.
    expect(content.find((t) => t!.startsWith('Pago: Proveedor Lunes'))).toMatch(/…$/);
    // El traspaso con una cuenta propia va atenuado: se ve su monto, pero no suma ni resta.
    expect(texts.find((t) => t.textContent === 'Traspaso A: Cuenta Dos')!.getAttribute('fill')).toBe('#677387');
  });

  it('la tarjeta de saldos: el saldo final de cada cuenta, de qué cartola sale, y el total, que es el del día', () => {
    const { svg, width, height } = balancesCardSvg(day, options, measure);
    expect([width, height]).toEqual([680, 74 + 26 + 26 * 2 + 26 + 20]);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect([...doc.querySelectorAll('text')].map((t) => t.textContent)).toEqual([
      'lun 16/11/2026',
      'Saldo final por cuenta · Todas las cuentas',
      'CUENTA',
      'DE DÓNDE SALE',
      'SALDO FINAL',
      'Cuenta Uno',
      // La hora de descarga, en Chile.
      'cartola del lun 16/11 22:00',
      '$650',
      'Cuenta Dos',
      // Con línea de crédito cuenta el disponible: saldo + lo libre de la línea.
      `sin cartola ese día · saldo ${clp(-50)} + línea ${clp(1000)}`,
      '$950',
      'Total de las cuentas',
      '$1.600',
    ]);
  });

  it('con una sola cuenta, sin columna de cuenta', () => {
    const { svg, width } = dayCardSvg(day, { ...options, scope: 'Cuenta Uno', multi: false }, measure);
    expect(width).toBe(764);
    const content = [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text')].map((t) => t.textContent);
    expect(content).not.toContain('CUENTA');
    expect(content[1]).toBe('Cuenta Uno');
  });

  it('lo que el banco fechó después lleva su fecha del banco, como en la pantalla', () => {
    const moved = mv(2, 1, 200, 'C', 'Traspaso A: Proveedor Sabado', { date: '2026-11-16', real_date: '2026-11-14', real_date_source: 'observada' });
    const saturday: LedgerDay = { ...day, day: '2026-11-14', rows: [{ type: 'movement', m: moved, amount: -200, effect: -200, balance: 2000 }] };
    expect(cardLines(saturday, options)[0].detail).toBe('Traspaso A: Proveedor Sabado · banco: lun 16');
  });
});
