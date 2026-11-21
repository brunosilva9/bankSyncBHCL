import { describe, expect, it } from 'vitest';
import type { DayAccountDetail, DayMovement, Hito } from './api';
import { dayCopy } from './dailyCopy';
import { clp, shortDate } from './format';
import { weekdayDay } from './seen';

// Datos ficticios.
const DAY = '2026-11-14';
const date = shortDate(DAY, true);

const movement = (id: number, direction: 'A' | 'C', amount: number, description: string, balance_after: number | null, extra: Partial<DayMovement> = {}): DayMovement => ({
  id,
  seq: 0,
  amount,
  direction,
  description,
  kind: 'other',
  counterparty: null,
  payee_name: null,
  category_name: null,
  category_color: null,
  system_key: null,
  label: null,
  balance_after,
  provisional: 0,
  payroll_batch: null,
  date: DAY,
  first_seen_day: DAY,
  first_seen_at: null,
  real_date: DAY,
  real_date_source: 'banco',
  ...extra,
});
const hito = { importId: 1, accountId: 1, accountName: 'Cuenta Uno', day: DAY, balance: 1950 } as Hito;

const uno: DayAccountDetail = {
  accountId: 1,
  name: 'Cuenta Uno',
  isCard: false,
  opening: 1800,
  closing: 1950,
  entries: [
    { type: 'hito', hito },
    { type: 'movement', movement: movement(1, 'A', 200, 'Traspaso De: Cliente Tres', 2000) },
    { type: 'movement', movement: movement(2, 'C', 50, 'Pago: Proveedor Uno', 1950, { label: 'Arriendo', provisional: 1 }) },
    { type: 'hito', hito },
  ],
};
const dos: DayAccountDetail = { accountId: 2, name: 'Cuenta Dos', isCard: false, opening: 500, closing: 500, entries: [] };
const tarjeta: DayAccountDetail = {
  accountId: 3,
  name: 'Tarjeta Prueba',
  isCard: true,
  opening: null,
  closing: null,
  entries: [{ type: 'movement', movement: movement(3, 'C', 30, 'Compra Supermercado', null) }],
};
const tarjetaSinCompras: DayAccountDetail = { accountId: 4, name: 'Tarjeta Sin Compras', isCard: true, opening: null, closing: null, entries: [] };

/** Las filas de la tabla, cada una como la lista de sus celdas. */
const rowsOf = (html: string) =>
  [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent));

describe('copiar el detalle de un día', () => {
  it('una cuenta: saldo inicial con su fecha, cada movimiento con el saldo que deja y saldo final con su fecha; sin las cartolas', () => {
    const { text, html } = dayCopy(DAY, [uno]);
    expect(text).toBe(
      [
        'Cuenta Uno',
        `Saldo inicial ${date}: ${clp(1800)}`,
        `+${clp(200)} Traspaso De: Cliente Tres (saldo ${clp(2000)})`,
        `−${clp(50)} Pago: Proveedor Uno · Arriendo · provisorio (saldo ${clp(1950)})`,
        `Saldo final ${date}: ${clp(1950)}`,
      ].join('\n'),
    );
    // Para una planilla: cada fila con su fecha y el monto en Entró o Salió, sin signo.
    expect(rowsOf(html)).toEqual([
      ['Fecha', 'Detalle', 'Entró', 'Salió', 'Saldo'],
      ['Cuenta Uno'],
      ['14/11/2026', 'Saldo inicial', '', '', clp(1800)],
      ['14/11/2026', 'Traspaso De: Cliente Tres', clp(200), '', clp(2000)],
      ['14/11/2026', 'Pago: Proveedor Uno · Arriendo · provisorio', '', clp(50), clp(1950)],
      ['14/11/2026', 'Saldo final', '', '', clp(1950)],
    ]);
  });

  it('varias cuentas: cada una por separado y al final el total; una tarjeta va sin saldo y sin compras no va', () => {
    const { text, html } = dayCopy(DAY, [uno, dos, tarjeta, tarjetaSinCompras]);
    const blocks = text.split('\n\n');
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatch(/^Cuenta Uno\n/);
    expect(blocks[1]).toBe(['Cuenta Dos', `Saldo inicial ${date}: ${clp(500)}`, 'Sin movimientos.', `Saldo final ${date}: ${clp(500)}`].join('\n'));
    expect(blocks[2]).toBe([`Tarjeta Prueba, ${date}`, `−${clp(30)} Compra Supermercado`].join('\n'));
    // El total suma solo las cuentas con saldo.
    expect(blocks[3]).toBe(['Total de las cuentas', `Saldo inicial ${date}: ${clp(2300)}`, `Saldo final ${date}: ${clp(2450)}`].join('\n'));
    expect(text).not.toContain('Sin Compras');

    const rows = rowsOf(html);
    expect(rows).toContainEqual(['14/11/2026', 'Compra Supermercado', '', clp(30), '']);
    expect(rows.slice(-3)).toEqual([['Total de las cuentas'], ['14/11/2026', 'Saldo inicial', '', '', clp(2300)], ['14/11/2026', 'Saldo final', '', '', clp(2450)]]);
  });

  it('cada nómina va en una línea, como en Nóminas: cuántos pagos, el total y el saldo después del último', () => {
    const pago = (id: number, amount: number, balance: number, batch = 1) =>
      ({ type: 'movement', movement: movement(id, 'C', amount, `Pago Fácil Bch: 0${id}`, balance, { kind: 'payroll', payroll_batch: batch, label: 'Sueldos' }) }) as const;
    const conNomina: DayAccountDetail = {
      ...dos,
      opening: 1000,
      closing: 550,
      entries: [pago(1, 100, 900), pago(2, 200, 700), { type: 'movement', movement: movement(3, 'C', 50, 'Pago: Proveedor Uno', 650) }, pago(4, 100, 550, 2)],
    };
    const { text, html } = dayCopy(DAY, [conNomina]);
    expect(text.split('\n').slice(2, -1)).toEqual([
      `−${clp(300)} Nómina Pago Fácil · 2 pagos · nómina 1 de 2 · Sueldos (saldo ${clp(700)})`,
      `−${clp(50)} Pago: Proveedor Uno (saldo ${clp(650)})`,
      // Una nómina de un solo pago va como un movimiento más.
      `−${clp(100)} Pago Fácil Bch: 04 · Sueldos (saldo ${clp(550)})`,
    ]);
    expect(rowsOf(html)).toContainEqual(['14/11/2026', 'Nómina Pago Fácil · 2 pagos · nómina 1 de 2 · Sueldos', '', clp(300), clp(700)]);
  });

  // Una transferencia del sábado 14 que el banco fechó el lunes 16.
  const transfer = movement(6, 'C', 200, 'Traspaso A: Proveedor Sabado', 1750, { date: '2026-11-16', real_date: DAY, real_date_source: 'observada' });

  it('por fecha real, cuenta el sábado con su fecha del banco; el lunes va aparte, porque ya se contó', () => {
    const sabado: DayAccountDetail = { ...uno, closing: 1750, entries: [...uno.entries, { type: 'movement', movement: transfer }] };
    expect(dayCopy(DAY, [sabado]).text.split('\n').slice(-2)).toEqual([
      `−${clp(200)} Traspaso A: Proveedor Sabado (fecha del banco: ${weekdayDay('2026-11-16')}) (saldo ${clp(1750)})`,
      `Saldo final ${date}: ${clp(1750)}`,
    ]);

    const lunes: DayAccountDetail = { ...dos, opening: 1750, closing: 1750, entries: [{ type: 'earlier', movement: transfer }] };
    const { text, html } = dayCopy('2026-11-16', [lunes]);
    const head = 'Con fecha del banco de hoy, pero de un día anterior (ya se contaron ese día):';
    expect(text.split('\n').slice(-4)).toEqual([
      'Sin movimientos.',
      `Saldo final ${shortDate('2026-11-16', true)}: ${clp(1750)}`,
      head,
      `−${clp(200)} Traspaso A: Proveedor Sabado (se contó el ${date})`,
    ]);
    // En la planilla, con la fecha en que se contó.
    expect(rowsOf(html).slice(-1)).toEqual([['14/11/2026', 'Traspaso A: Proveedor Sabado', '', clp(200), '']]);
  });

  it('por fecha del banco, al revés: en su día real va aparte, después del saldo final; en su fecha, con el día en que apareció', () => {
    const sabado: DayAccountDetail = { ...uno, entries: [...uno.entries, { type: 'later', movement: transfer }] };
    const { text, html } = dayCopy(DAY, [sabado], 'banco');
    const head = 'Ya aparecen hoy, pero el banco los fechó después (cuentan en esa fecha):';
    expect(text.split('\n').slice(-3)).toEqual([`Saldo final ${date}: ${clp(1950)}`, head, `−${clp(200)} Traspaso A: Proveedor Sabado (fecha del banco: ${shortDate('2026-11-16', true)})`]);
    // En la planilla, con su fecha del banco y sin saldo: suma en el de ese día.
    expect(rowsOf(html).slice(-2)).toEqual([
      ['', head, '', '', ''],
      ['16/11/2026', 'Traspaso A: Proveedor Sabado', '', clp(200), ''],
    ]);

    const lunes: DayAccountDetail = { ...dos, opening: 1950, closing: 1750, entries: [{ type: 'movement', movement: transfer }] };
    expect(dayCopy('2026-11-16', [lunes], 'banco').text).toContain(`−${clp(200)} Traspaso A: Proveedor Sabado (apareció el ${weekdayDay(DAY)}) (saldo ${clp(1750)})`);
  });

  it('el HTML no se rompe con lo que traiga la glosa del banco', () => {
    const raro: DayAccountDetail = { ...dos, entries: [{ type: 'movement', movement: movement(5, 'A', 10, 'Pago <b>Caja & Co</b>', 510) }] };
    const { html } = dayCopy(DAY, [raro]);
    expect(html).not.toContain('<b>');
    expect(rowsOf(html)).toContainEqual(['14/11/2026', 'Pago <b>Caja & Co</b>', clp(10), '', clp(510)]);
  });
});
