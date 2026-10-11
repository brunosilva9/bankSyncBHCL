import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db.js';
import { importCartola } from '../src/domain/importer.js';
import { parseCartola } from '../src/parser/cartola.js';
import { ACC_A, cartola, testDb } from './helpers.js';

const load = (db: DB, text: string, name = 'cartola.txt') => importCartola(db, parseCartola(text), name, null);
const all = (db: DB) =>
  db.prepare('SELECT date, seq, amount, direction, description, balance_after FROM movements ORDER BY date DESC, seq').all() as Array<{
    date: string;
    amount: number;
    balance_after: number;
  }>;

describe('importCartola', () => {
  let db: DB;
  beforeEach(() => {
    db = testDb();
  });

  // Saldo final 1.000. Del más reciente al más antiguo:
  //   10-02  -300 (pago)            saldo después: 1000
  //   10-02  -300 (pago, idéntico)  saldo después: 1300
  //   10-01  +1600 (abono)          saldo después: 1600  -> saldo antes de todo: 0
  const first = cartola(ACC_A, '2026-10-02', 1000, [
    { date: '2026-10-02', amount: 300, type: 'C', desc: 'Pago: Botilleria El Sol' },
    { date: '2026-10-02', amount: 300, type: 'C', desc: 'Pago: Botilleria El Sol' },
    { date: '2026-10-01', amount: 1600, type: 'A', desc: 'Traspaso De: Cliente Uno' },
  ]);

  it('reconstruye el saldo de cada movimiento desde el saldo contable', () => {
    load(db, first);
    expect(all(db).map((m) => m.balance_after)).toEqual([1000, 1300, 1600]);
  });

  it('crea la cuenta automáticamente la primera vez', () => {
    const r = load(db, first);
    expect(r.accountNumber).toBe('00-111-11111-01');
    expect(r.inserted).toBe(3);
  });

  it('no duplica al volver a cargar la misma cartola, pero conserva movimientos idénticos legítimos', () => {
    load(db, first);
    const again = load(db, first);
    expect(again.inserted).toBe(0);
    expect(again.alreadyLoaded).toBe(3);
    expect(all(db)).toHaveLength(3);
  });

  it('agrega solo lo nuevo cuando las cartolas se traslapan, y el saldo sigue calzando', () => {
    load(db, first);
    // Cartola siguiente: trae un tercer pago del día 2 (que antes no estaba) y un día nuevo.
    const next = cartola(ACC_A, '2026-10-05', 500, [
      { date: '2026-10-05', amount: 200, type: 'C', desc: 'Traspaso A: Pedro Gonzalez Rojas' },
      { date: '2026-10-02', amount: 300, type: 'C', desc: 'Pago: Botilleria El Sol' },
      { date: '2026-10-02', amount: 300, type: 'C', desc: 'Pago: Botilleria El Sol' },
      { date: '2026-10-02', amount: 300, type: 'C', desc: 'Pago: Botilleria El Sol' },
    ]);
    const r = load(db, next, 'nueva.txt');
    expect(r.inserted).toBe(2);
    expect(r.warnings).toEqual([]);
    expect(all(db).map((m) => m.balance_after)).toEqual([500, 700, 1000, 1300, 1600]);
  });

  it('avisa cuando falta una cartola entre medio (el saldo anterior no calza)', () => {
    load(db, first);
    const afterGap = cartola(ACC_A, '2026-11-20', 5000, [{ date: '2026-11-20', amount: 100, type: 'A', desc: 'Traspaso De: Cliente Dos' }]);
    const r = load(db, afterGap, 'noviembre.txt');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/cartola\.txt/);
  });

  it('asigna categorías automáticas por tipo de movimiento', () => {
    load(db, cartola(ACC_A, '2026-10-02', 0, [{ date: '2026-10-02', amount: 50, type: 'C', desc: 'Pago Fácil Bch: 0111111111' }]));
    const row = db.prepare('SELECT m.counterparty, c.name FROM movements m JOIN categories c ON c.id = m.category_id').get();
    expect(row).toEqual({ counterparty: '11.111.111-1', name: 'Sueldos y nómina' });
  });
});
