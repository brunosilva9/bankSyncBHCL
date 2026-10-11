import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db.js';
import { recategorize } from '../src/domain/categorize.js';
import { importCartola } from '../src/domain/importer.js';
import { buildReport } from '../src/domain/report.js';
import { parseCartola } from '../src/parser/cartola.js';
import { ACC_A, ACC_B, cartola, testDb } from './helpers.js';

describe('buildReport', () => {
  let db: DB;
  let idA: number;
  let idB: number;

  beforeEach(() => {
    db = testDb();
    // Empresa A ("Agricola Uno") le traspasa 1.000 a la empresa B ("Transporte Dos").
    idA = importCartola(
      db,
      parseCartola(
        cartola(ACC_A, '2026-10-12', 2000, [
          { date: '2026-10-12', amount: 1000, type: 'C', desc: 'Traspaso A: Transporte Dos Limitada' },
          { date: '2026-10-12', amount: 400, type: 'C', desc: 'Pago Fácil Bch: 0111111111' },
          { date: '2026-10-12', amount: 600, type: 'C', desc: 'Pago Fácil Bch: 0222222222' },
          { date: '2026-10-10', amount: 3000, type: 'A', desc: 'Traspaso De: Cliente Grande Spa' },
          { date: '2026-10-08', amount: 100, type: 'C', desc: 'Pago: Botilleria El Sol' },
        ]),
      ),
      'a.txt',
      null,
    ).accountId;
    idB = importCartola(
      db,
      parseCartola(
        cartola(ACC_B, '2026-10-12', 700, [
          { date: '2026-10-12', amount: 300, type: 'C', desc: 'Traspaso A: Pedro Gonzalez Rojas' },
          { date: '2026-10-12', amount: 1000, type: 'A', desc: 'Traspaso De: Agricola Uno Spa' },
        ]),
      ),
      'b.txt',
      null,
    ).accountId;
    db.prepare("UPDATE accounts SET name = 'Agricola Uno Spa' WHERE id = ?").run(idA);
    db.prepare("UPDATE accounts SET name = 'Transporte Dos', aliases = 'Transporte Dos Limitada' WHERE id = ?").run(idB);
    recategorize(db);
  });

  it('cuadra saldo inicial + ingresos - gastos = saldo final, sin contar traspasos internos', () => {
    const r = buildReport(db, { from: '2026-10-09', to: '2026-10-12' });
    // A: antes del 09 tenía 100 menos... saldo antes del 10-10 = 2000 + 1000 + 400 + 600 - 3000 = 1000
    // B: saldo antes = 700 + 300 - 1000 = 0
    expect(r.totals.opening).toBe(1000);
    expect(r.totals.income).toBe(3000);
    expect(r.totals.expenses).toBe(400 + 600 + 300);
    expect(r.totals.internalNet).toBe(0);
    expect(r.totals.closing).toBe(2700);
    expect(r.totals.opening + r.totals.income - r.totals.expenses + r.totals.internalNet).toBe(r.totals.closing);
  });

  it('un traspaso desde una cuenta propia no cargada (sin pareja) cuenta como ingreso normal', () => {
    // A recibe 500 "de Transporte Dos", pero desde una cuenta de Transporte Dos que no se carga (otro banco).
    importCartola(
      db,
      parseCartola(cartola(ACC_A, '2026-10-13', 2500, [{ date: '2026-10-13', amount: 500, type: 'A', desc: 'Traspaso De: Transporte Dos Limitada' }])),
      'a2.txt',
      null,
    );
    const r = buildReport(db, { from: '2026-10-13', to: '2026-10-13' });
    expect(r.totals.income).toBe(500);
    expect(r.totals.internalNet).toBe(0);
    expect(r.uncategorizedCount).toBe(1);
  });

  it('agrupa la nómina de Pago Fácil', () => {
    const r = buildReport(db, { from: '2026-10-01', to: '2026-10-31' });
    expect(r.payroll).toEqual([
      { accountId: idA, accountName: 'Agricola Uno Spa', date: '2026-10-12', batch: 1, batchesInDay: 1, total: 1000, count: 2 },
    ]);
    const cats = db.prepare("SELECT DISTINCT c.name FROM movements m JOIN categories c ON c.id = m.category_id WHERE m.kind = 'payroll'").all();
    expect(cats).toEqual([{ name: 'Sueldos y nómina' }]);
  });

  it('aplica reglas de etiqueta por contraparte', () => {
    db.prepare("INSERT INTO rules (match_type, pattern, label) VALUES ('counterparty', 'Pedro Gonzalez Rojas', 'Gastos Pedro')").run();
    recategorize(db);
    expect(db.prepare("SELECT label, label_source FROM movements WHERE counterparty = 'Pedro Gonzalez Rojas'").all()).toEqual([
      { label: 'Gastos Pedro', label_source: 'rule' },
    ]);
  });

  it('separa en nóminas distintas los bloques de Pago Fácil del mismo día con otros movimientos entre medio', () => {
    importCartola(
      db,
      parseCartola(
        cartola(ACC_A, '2026-10-20', 0, [
          { date: '2026-10-20', amount: 30, type: 'C', desc: 'Pago Fácil Bch: 0333333333' },
          { date: '2026-10-20', amount: 20, type: 'C', desc: 'Pago Fácil Bch: 0444444444' },
          { date: '2026-10-20', amount: 5, type: 'C', desc: 'Pago: Botilleria El Sol' },
          { date: '2026-10-20', amount: 10, type: 'C', desc: 'Pago Fácil Bch: 0111111111' },
          { date: '2026-10-20', amount: 40, type: 'C', desc: 'Pago Fácil Bch: 0222222222' },
        ]),
      ),
      'a3.txt',
      null,
    );
    const r = buildReport(db, { from: '2026-10-20', to: '2026-10-20' });
    // La cartola va del más reciente al más antiguo: el bloque de abajo (10 + 40) es la nómina 1.
    expect(r.payroll.map((p) => [p.batch, p.batchesInDay, p.total, p.count])).toEqual([
      [1, 2, 50, 2],
      [2, 2, 50, 2],
    ]);
  });

  it('informa el período que realmente cubren los datos dentro del filtro', () => {
    expect(buildReport(db, { from: '2026-10-09', to: '2026-10-18' }).period).toEqual({ from: '2026-10-10', to: '2026-10-12' });
    expect(buildReport(db, { from: '2026-11-01', to: '2026-11-30' }).period).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('filtra por cuenta', () => {
    const r = buildReport(db, { from: '2026-10-01', to: '2026-10-31', accountIds: [idB] });
    expect(r.accounts.map((a) => a.accountId)).toEqual([idB]);
    expect(r.totals.closing).toBe(700);
    expect(r.totals.internalNet).toBe(1000);
  });
});
