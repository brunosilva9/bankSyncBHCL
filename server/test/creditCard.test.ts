import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db.js';
import { importCard } from '../src/domain/creditCard.js';
import { importCartola } from '../src/domain/importer.js';
import { buildReport } from '../src/domain/report.js';
import { parseCartola } from '../src/parser/cartola.js';
import { type ParsedCard } from '../src/parser/creditCard.js';
import { isCard, parseStatementFile } from '../src/parser/index.js';
import { ACC_A, cartola, cmrFile as cmr, testDb, xlsxFile as xlsx } from './helpers.js';

// Planillas con la misma estructura que entregan los bancos, con datos ficticios.

type CmrRow = [date: string, description: string, holder: string, amount: number, pending: number, installment: number];

async function card(bytes: Buffer): Promise<ParsedCard> {
  const p = await parseStatementFile(bytes);
  if (!isCard(p)) throw new Error('se esperaba una tarjeta');
  return p;
}

const bancoEstadoCard = (downloaded: string, rows: Array<[string, string, string, number]>) =>
  xlsx('movimientos', [
    ['Últimos Movimientos Nacionales\nTARJETA PRUEBA VISA Nº **** 1234'],
    [],
    ['Datos del cliente'],
    ['Nombre', '', 'RUT', 'Fecha'],
    ['CLIENTE DE PRUEBA', '', '11.111.111-1', downloaded],
    [],
    ['Movimientos por facturar'],
    ['Fecha', 'Descripción', 'Ciudad', 'Monto ($)'],
    ...rows,
  ]);

const movements = (db: DB) =>
  db
    .prepare('SELECT date, direction, amount, description, kind, provisional, installments, installment_amount FROM movements ORDER BY date DESC, amount')
    .all() as Array<{ date: string; direction: string; amount: number; description: string; kind: string; provisional: number }>;

describe('tarjeta CMR (Banco Falabella)', () => {
  // Lo que aún no se factura: una compra nueva en cuotas, una devolución, el pago, un impuesto y una fila
  // informativa (valor cuota 0) que no es un cargo. Más una compra en cuotas de un mes anterior, como
  // la muestra este archivo: otra redacción y un día antes que en el estado de cuenta.
  const unbilled: CmrRow[] = [
    ['2026-10-09', 'ACELERACION CAPITAL X FACTURARTIENDA EJEMPLO', 'Titular', 50000, 2, 0],
    ['2026-10-08', 'COMPRA TIENDA EJEMPLO', 'Titular', 50000, 2, 26000],
    ['2026-10-08', 'IMPUESTO COMPRA CUOTAS TIENDA EJEMPLO', 'Titular', 60, 0, 60],
    ['2026-10-07', 'DEVOLUCION COMPRA TIENDA EJEMPLO', 'Titular', 10000, 0, -10000],
    ['2026-10-07', 'PAGO TARJETA CMR', 'Titular', 300000, 0, -300000],
    ['2026-08-19', 'COMPRA CUOTAS SIN INTERES FERRETERIA PRUEBA', 'Titular', 30000, 1, 10000],
  ];
  // Estado de cuenta: la compra en cuotas de agosto con su redacción y fecha "oficiales", dos compras del
  // mismo día y monto en comercios distintos, una compra de una tarjeta adicional y el cobro de administración.
  const billed: CmrRow[] = [
    ['2026-09-24', 'SERVICIO ADMINISTRACION', 'Titular', 5000, 0, 5000],
    ['2026-08-26', 'COMPRA PANADERIA PRUEBA', 'Adicional', 8500, 0, 8500],
    ['2026-08-20', 'COMPRA EN CUOTAS FERRETERIA PRUEBA', 'Titular', 30000, 1, 10000],
    ['2026-07-24', 'COMPRA EN CUOTAS AEROLINEA UNO', 'Titular', 90000, 1, 30000],
    ['2026-07-24', 'COMPRA EN CUOTAS AEROLINEA DOS', 'Titular', 90000, 0, 30000],
  ];

  it('lee los movimientos: compra completa, sentido, tipo y cuota', async () => {
    const p = await card(await cmr('Ultimos Movimientos', unbilled));
    expect(p).toMatchObject({ bank: 'Banco Falabella', cardNumber: 'CMR', billed: false, fromDate: '2026-08-19', toDate: '2026-10-08' });
    expect(p.movements.map((m) => [m.direction, m.amount, m.kind, m.installmentAmount])).toEqual([
      ['C', 50000, 'credit_card_purchase', 26000],
      ['C', 60, 'bank_fee', null],
      ['A', 10000, 'credit_card_purchase', null],
      ['A', 300000, 'credit_card_payment', null],
      ['C', 30000, 'credit_card_purchase', 10000],
    ]);
    expect(p.movements[0].counterparty).toBe('Tienda Ejemplo');
    const facturado = await card(await cmr('Movimientos Facturados', billed));
    expect(facturado.billed).toBe(true);
    expect(facturado.movements[1].description).toBe('COMPRA PANADERIA PRUEBA (adicional)');
  });

  describe('importar', () => {
    let db: DB;
    beforeEach(() => {
      db = testDb();
    });

    it('cada compra queda una vez aunque reaparezca con otra redacción y fecha; el estado de cuenta la confirma', async () => {
      const first = importCard(db, await card(await cmr('Ultimos Movimientos', unbilled)), 'no-facturados.xlsx', null);
      expect(first).toMatchObject({ type: 'card', accountName: 'Tarjeta CMR (Banco Falabella)', inserted: 5, alreadyLoaded: 0 });

      const statement = importCard(db, await card(await cmr('Movimientos Facturados', billed)), 'facturados.xlsx', null);
      expect(statement).toMatchObject({ inserted: 4, confirmed: 1, alreadyLoaded: 0 });

      const ferreteria = movements(db).filter((m) => m.description.includes('FERRETERIA'));
      expect(ferreteria).toEqual([expect.objectContaining({ date: '2026-08-20', description: 'COMPRA EN CUOTAS FERRETERIA PRUEBA', provisional: 0 })]);
      // El estado de cuenta la pasó del 19 al 20: la fecha real sigue siendo la primera.
      expect(db.prepare("SELECT real_date, real_date_source FROM movements WHERE description LIKE '%FERRETERIA%'").get()).toEqual({
        real_date: '2026-08-19',
        real_date_source: 'banco',
      });
      // Mismo día y monto, pero son dos compras distintas.
      expect(movements(db).filter((m) => m.amount === 90000)).toHaveLength(2);
      // Lo de octubre sigue por facturar.
      expect(movements(db).filter((m) => m.provisional === 1)).toHaveLength(4);

      // Volver a importar no cambia nada.
      expect(importCard(db, await card(await cmr('Movimientos Facturados', billed)), 'facturados.xlsx', null)).toMatchObject({ inserted: 0, confirmed: 0, alreadyLoaded: 5 });
      expect(importCard(db, await card(await cmr('Ultimos Movimientos', unbilled)), 'no-facturados.xlsx', null)).toMatchObject({ inserted: 0, alreadyLoaded: 5 });
      expect(movements(db)).toHaveLength(9);
    });

    it('el pago de la tarjeta es un traspaso interno y las comisiones son gastos bancarios', async () => {
      importCard(db, await card(await cmr('Ultimos Movimientos', unbilled)), 'no-facturados.xlsx', null);
      const cats = db
        .prepare('SELECT m.kind, c.system_key FROM movements m LEFT JOIN categories c ON c.id = m.category_id WHERE m.kind != ?')
        .all('credit_card_purchase');
      expect(cats).toEqual(
        expect.arrayContaining([
          { kind: 'credit_card_payment', system_key: 'internal' },
          { kind: 'bank_fee', system_key: 'bank_fee' },
        ]),
      );
    });
  });
});

describe('tarjeta de BancoEstado', () => {
  const october = () =>
    bancoEstadoCard('19/10/2026 15:05:22', [
      ['04/08/2026', 'AVANCE EN EFECTIVO          2-10 CUOTA', 'SANTIAGO', -40000],
      ['26/01/2026', 'TIENDA EN CUOTAS            10-12 CUOTA', 'SANTIAGO', -50000],
      ['05/10/2026', 'FARMACIA PRUEBA        COMPRAS', 'SANTIAGO', -12345],
      ['01/10/2026', 'PAGO TARJETA', 'SANTIAGO', 100000],
    ]);

  it('lee las cuotas (total = cuota × número de cuotas) y la fecha de descarga', async () => {
    const p = await card(await october());
    expect(p).toMatchObject({ bank: 'BancoEstado', cardNumber: '**** 1234', cardName: 'TARJETA PRUEBA VISA **** 1234', billed: false, asOf: '2026-10-19' });
    expect(p.movements.map((m) => [m.description, m.direction, m.amount, m.kind, m.installments, m.installmentAmount])).toEqual([
      ['AVANCE EN EFECTIVO', 'C', 400000, 'atm', 10, 40000],
      ['TIENDA EN CUOTAS', 'C', 600000, 'credit_card_purchase', 12, 50000],
      ['FARMACIA PRUEBA', 'C', 12345, 'credit_card_purchase', null, null],
      ['PAGO TARJETA', 'A', 100000, 'credit_card_payment', null, null],
    ]);
  });

  it('la cuota del mes siguiente es la misma compra, aunque venga ajustada por redondeo', async () => {
    const db = testDb();
    importCard(db, await card(await october()), 'octubre.xlsx', null);
    const november = await bancoEstadoCard('19/11/2026 10:00:00', [
      ['04/08/2026', 'AVANCE EN EFECTIVO          3-10 CUOTA', 'SANTIAGO', -40000],
      ['26/01/2026', 'TIENDA EN CUOTAS            11-12 CUOTA', 'SANTIAGO', -50004],
      ['02/11/2026', 'FARMACIA PRUEBA        COMPRAS', 'SANTIAGO', -12345],
    ]);
    expect(importCard(db, await card(november), 'noviembre.xlsx', null)).toMatchObject({ inserted: 1, alreadyLoaded: 2 });
    expect(movements(db).filter((m) => m.description === 'FARMACIA PRUEBA')).toHaveLength(2);
  });
});

describe('informe con tarjetas', () => {
  it('las compras con tarjeta son gasto, el pago es traspaso y el resumen cuadra con la deuda nueva', async () => {
    const db = testDb();
    // Cuenta corriente: parte con 1.000 y gasta 300. La tarjeta: compra 500 y recibe un pago de 200 desde
    // una cuenta que no está cargada.
    importCartola(db, parseCartola(cartola(ACC_A, '2026-10-12', 700, [{ date: '2026-10-10', amount: 300, type: 'C', desc: 'Pago: Botilleria El Sol' }])), 'cc.txt', null);
    importCard(
      db,
      await card(
        await cmr('Ultimos Movimientos', [
          ['2026-10-09', 'COMPRA TIENDA EJEMPLO', 'Titular', 500, 0, 500],
          ['2026-10-08', 'PAGO TARJETA CMR', 'Titular', 200, 0, -200],
        ]),
      ),
      'cmr.xlsx',
      null,
    );
    const r = buildReport(db, { from: '2026-10-01', to: '2026-10-31' });
    const cmrAccount = r.accounts.find((a) => a.isCard)!;
    expect(cmrAccount).toMatchObject({ opening: null, closing: null, expenses: 500, internalIn: 200, cardDebtChange: 300 });
    const t = r.totals;
    expect(t).toMatchObject({ opening: 1000, closing: 700, hasCards: true, cardDebtChange: 300 });
    expect(t.opening + t.income - t.expenses + t.internalNet + t.cardDebtChange).toBe(t.closing);
  });
});
