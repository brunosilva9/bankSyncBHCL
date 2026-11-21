import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db.js';
import { closeDay, closePending, closingStatuses, getClosing, lastClosableDay, pendingDays, verifyClosings } from '../src/domain/closing.js';
import { importCartola } from '../src/domain/importer.js';
import { parseCartola } from '../src/parser/cartola.js';
import { ACC_A, ACC_B, cartola, testDb } from './helpers.js';

const load = (db: DB, text: string, name = 'cartola.txt') => importCartola(db, parseCartola(text), name, null);
/** Instante a una hora de Chile en noviembre de 2026 (horario de verano, UTC−3). */
const chile = (day: string, hour: number, minute = 0) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-03:00`);

const c12 = cartola(ACC_A, '2026-11-12', 1500, [
  { date: '2026-11-12', amount: 500, type: 'A', desc: 'Traspaso De: Cliente Dos' },
  { date: '2026-11-10', amount: 300, type: 'C', desc: 'Pago: Proveedor Uno' },
]);

describe('cuándo se cierra un día', () => {
  it('el día D se cierra desde las 02:00 de Chile del día siguiente', () => {
    expect(lastClosableDay(chile('2026-11-20', 1, 59), 2)).toBe('2026-11-18');
    expect(lastClosableDay(chile('2026-11-20', 2, 0), 2)).toBe('2026-11-19');
    // 22:00 del 19 en Chile ya es el 20 en UTC: todavía no se cierra el 19.
    expect(lastClosableDay(chile('2026-11-19', 22, 0), 2)).toBe('2026-11-18');
  });

  it('sin cuentas no hay nada que cerrar', () => {
    expect(pendingDays(testDb(), chile('2026-11-20', 3), 2)).toEqual([]);
  });

  it('la primera vez cierra solo el último día; después, lo que falte si el servidor estuvo apagado', () => {
    const db = testDb();
    load(db, c12);
    expect(pendingDays(db, chile('2026-11-20', 3), 2)).toEqual(['2026-11-19']);
    expect(closePending(db, chile('2026-11-20', 3), 2)).toEqual(['2026-11-19']);
    expect(pendingDays(db, chile('2026-11-20', 23), 2)).toEqual([]);
    expect(pendingDays(db, chile('2026-11-21', 2, 5), 2)).toEqual(['2026-11-20']);
    // Apagado del 21 al 24: al volver cierra los tres días.
    expect(closePending(db, chile('2026-11-24', 9), 2)).toEqual(['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23']);
  });

  it('se pone al día hasta 31 días hacia atrás, no más', () => {
    const db = testDb();
    load(db, c12);
    closeDay(db, '2026-09-01', chile('2026-09-02', 2));
    const pending = pendingDays(db, chile('2026-11-20', 3), 2);
    expect(pending).toHaveLength(31);
    expect(pending[0]).toBe('2026-10-20');
    expect(pending.at(-1)).toBe('2026-11-19');
  });
});

describe('el cierre de un día', () => {
  let db: DB;
  beforeEach(() => {
    db = testDb();
    load(db, c12);
  });

  it('congela el informe del día, sus movimientos y cartolas, y hasta dónde llegaban los datos', () => {
    expect(closeDay(db, '2026-11-12', chile('2026-11-13', 2))).toBe(true);
    const closing = getClosing(db, '2026-11-12')!;
    expect(closing).toMatchObject({ day: '2026-11-12', closedAt: '2026-11-13T05:00:00.000Z', changed: false });
    expect(closing.snapshot.report.totals).toMatchObject({ opening: 1000, income: 500, closing: 1500 });
    const [account] = closing.snapshot.detail.accounts;
    expect(account.entries.map((e) => e.type)).toEqual(['movement', 'hito']);
    expect(closing.snapshot.coverage).toEqual([expect.objectContaining({ lastMovement: '2026-11-12', lastCartola: '2026-11-12' })]);
  });

  it('no se cierra dos veces el mismo día', () => {
    expect(closeDay(db, '2026-11-12')).toBe(true);
    expect(closeDay(db, '2026-11-12')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM closings').get()).toEqual({ n: 1 });
  });

  it('si después llega algo que cambia el día, el cierre queda igual y se nota que cambió', () => {
    closeDay(db, '2026-11-12', chile('2026-11-13', 2));
    load(
      db,
      cartola(ACC_A, '2026-11-13', 1550, [
        { date: '2026-11-12', amount: 50, type: 'A', desc: 'Traspaso De: Cliente Tarde' },
        { date: '2026-11-12', amount: 500, type: 'A', desc: 'Traspaso De: Cliente Dos' },
        { date: '2026-11-10', amount: 300, type: 'C', desc: 'Pago: Proveedor Uno' },
      ]),
      'tarde.txt',
    );
    const closing = getClosing(db, '2026-11-12')!;
    expect(closing.changed).toBe(true);
    expect(closing.snapshot.report.totals.income).toBe(500);
    expect(closingStatuses(db, '2026-11-01', '2026-11-30').get('2026-11-12')).toMatchObject({ changed: true });
  });

  it('por cuenta, solo cuenta lo que cambió en esa cuenta', () => {
    load(db, cartola(ACC_B, '2026-11-12', 100, [{ date: '2026-11-12', amount: 100, type: 'A', desc: 'Traspaso De: Cliente B' }]), 'b.txt');
    closeDay(db, '2026-11-12');
    load(db, cartola(ACC_B, '2026-11-13', 150, [{ date: '2026-11-12', amount: 50, type: 'A', desc: 'Traspaso De: Otro B' }, { date: '2026-11-12', amount: 100, type: 'A', desc: 'Traspaso De: Cliente B' }]), 'b2.txt');
    const ids = (db.prepare('SELECT id FROM accounts ORDER BY number').all() as Array<{ id: number }>).map((a) => a.id);
    expect(getClosing(db, '2026-11-12', [ids[0]])!.changed).toBe(false);
    expect(getClosing(db, '2026-11-12', [ids[1]])!.changed).toBe(true);
    expect(getClosing(db, '2026-11-12')!.changed).toBe(true);
  });

  it('cierra por fecha real y guarda también la foto por fecha del banco; uno de antes se muestra por la del banco', () => {
    // La noche del 12, una transferencia que el banco ya fecha el 13.
    load(
      db,
      cartola(ACC_A, '2026-11-12', 1400, [
        { date: '2026-11-13', amount: 100, type: 'C', desc: 'Traspaso A: Proveedor Noche' },
        { date: '2026-11-12', amount: 500, type: 'A', desc: 'Traspaso De: Cliente Dos' },
        { date: '2026-11-10', amount: 300, type: 'C', desc: 'Pago: Proveedor Uno' },
      ]),
      'noche.txt',
    );
    closeDay(db, '2026-11-12', chile('2026-11-13', 2));
    const real = getClosing(db, '2026-11-12')!;
    expect(real.snapshot).toMatchObject({ dates: 'real', report: { totals: { opening: 1000, income: 500, expenses: 100, closing: 1400 } } });
    const bank = getClosing(db, '2026-11-12', undefined, 'banco')!;
    expect(bank.snapshot).toMatchObject({ dates: 'banco', report: { totals: { income: 500, expenses: 0, closing: 1500 } } });
    expect([real.changed, bank.changed]).toEqual([false, false]);

    // Un cierre de antes de la fecha real no trae la foto por fecha real: se muestra el que hay y se compara su huella.
    db.prepare("UPDATE closings SET report = json_remove(report, '$.dates', '$.bank', '$.realHash')").run();
    expect(getClosing(db, '2026-11-12')).toMatchObject({ changed: false, snapshot: { dates: 'banco' } });
  });

  it('cada cierre apunta al anterior, y alterar uno rompe la cadena', () => {
    closeDay(db, '2026-11-11');
    closeDay(db, '2026-11-12');
    const rows = db.prepare('SELECT prev_hash, hash FROM closings ORDER BY id').all() as Array<{ prev_hash: string | null; hash: string }>;
    expect(rows[0].prev_hash).toBeNull();
    expect(rows[1].prev_hash).toBe(rows[0].hash);
    expect(verifyClosings(db)).toEqual([]);

    db.prepare("UPDATE closings SET report = replace(report, '1500', '9999') WHERE day = '2026-11-12'").run();
    expect(verifyClosings(db)).toEqual(['El cierre del 2026-11-12 se modificó después de cerrarse.']);
  });
});
