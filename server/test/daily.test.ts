import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db.js';
import { buildDays, dayDetail, hitosOf, movementsHash } from '../src/domain/daily.js';
import { importCartola } from '../src/domain/importer.js';
import { parseCartola } from '../src/parser/cartola.js';
import { ACC_A, cartola, testDb } from './helpers.js';

const load = (db: DB, text: string, name: string) => importCartola(db, parseCartola(text), name, null);

// Tres cartolas de la misma cuenta (movimientos del más reciente al más antiguo, como las da el banco):
//   10/11  saldo 1.000: +1.300 el 9 y −300 el 10.
//   12/11  saldo 1.500: trae lo anterior y +500 el 12. Cuadra: el banco dice +500 y los movimientos suman +500.
//   14/11  saldo 2.000: solo trae +200 del 14. Al banco le subió 500 y los movimientos suman 200: faltan 300
//          (un movimiento del 13 que no vino en ninguna cartola).
const c10 = cartola(ACC_A, '2026-11-10', 1000, [
  { date: '2026-11-10', amount: 300, type: 'C', desc: 'Pago: Proveedor Uno' },
  { date: '2026-11-09', amount: 1300, type: 'A', desc: 'Traspaso De: Cliente Uno' },
]);
const c12 = cartola(ACC_A, '2026-11-12', 1500, [
  { date: '2026-11-12', amount: 500, type: 'A', desc: 'Traspaso De: Cliente Dos' },
  { date: '2026-11-10', amount: 300, type: 'C', desc: 'Pago: Proveedor Uno' },
  { date: '2026-11-09', amount: 1300, type: 'A', desc: 'Traspaso De: Cliente Uno' },
]);
const c14 = cartola(ACC_A, '2026-11-14', 2000, [{ date: '2026-11-14', amount: 200, type: 'A', desc: 'Traspaso De: Cliente Tres' }]);

describe('hitos (saldo de cada cartola)', () => {
  let db: DB;
  beforeEach(() => {
    db = testDb();
    load(db, c10, 'c10.txt');
    load(db, c12, 'c12.txt');
    load(db, c14, 'c14.txt');
  });

  it('compara cada cartola con la anterior: lo que cambió el saldo contra lo que suman los movimientos', () => {
    const [h10, h12, h14] = hitosOf(db);
    expect(h10).toMatchObject({ day: '2026-11-10', balance: 1000, previous: null, diff: null });
    expect(h12).toMatchObject({ day: '2026-11-12', bankChange: 500, movementsChange: 500, movementsBetween: 1, diff: 0 });
    expect(h14).toMatchObject({ day: '2026-11-14', bankChange: 500, movementsChange: 200, movementsBetween: 1, diff: 300 });
    expect(h14.previous).toMatchObject({ day: '2026-11-12', balance: 1500 });
  });

  it('el saldo se reconstruye desde la cartola más reciente: las anteriores al hueco quedan corridas', () => {
    expect(hitosOf(db).map((h) => h.check)).toEqual([-300, -300, 0]);
  });

  it('un movimiento que el banco agregó después con fecha anterior descuadra dos tramos al revés, y se marcan juntos', () => {
    const other = testDb();
    load(other, cartola(ACC_A, '2026-11-09', 1300, [{ date: '2026-11-09', amount: 1300, type: 'A', desc: 'Traspaso De: Cliente Uno' }]), 'z.txt');
    load(other, c10, 'a.txt');
    // El 12 aparece un cargo de 200 con fecha del 9: el saldo del 10 no lo incluía.
    load(
      other,
      cartola(ACC_A, '2026-11-12', 1300, [
        { date: '2026-11-12', amount: 500, type: 'A', desc: 'Traspaso De: Cliente Dos' },
        { date: '2026-11-10', amount: 300, type: 'C', desc: 'Pago: Proveedor Uno' },
        { date: '2026-11-09', amount: 200, type: 'C', desc: 'Pago: Cobro Tardio' },
        { date: '2026-11-09', amount: 1300, type: 'A', desc: 'Traspaso De: Cliente Uno' },
      ]),
      'b.txt',
    );
    const [z, a, b] = hitosOf(other);
    expect(a).toMatchObject({ diff: 200, pair: { importId: b.importId, day: '2026-11-12' } });
    expect(b).toMatchObject({ diff: -200, pair: { importId: a.importId, day: '2026-11-10' } });
    expect(z.pair).toBeNull();
    // En el ejemplo de arriba el hueco no se compensa: faltan de verdad 300.
    expect(hitosOf(db).map((h) => h.pair)).toEqual([null, null, null]);
  });

  it('una cartola sin movimientos nuevos cuadra con la anterior y va al principio de su día', () => {
    // Descargada el sábado 15: su último movimiento es del 14.
    load(db, cartola(ACC_A, '2026-11-15', 2000, [{ date: '2026-11-14', amount: 200, type: 'A', desc: 'Traspaso De: Cliente Tres' }]), 'c15.txt');
    const h15 = hitosOf(db).at(-1)!;
    expect(h15).toMatchObject({ day: '2026-11-15', anchor: { date: '2026-11-14' }, diff: 0, movementsBetween: 0 });
    const [account] = dayDetail(db, '2026-11-15').accounts;
    expect(account.entries.map((e) => e.type)).toEqual(['hito']);
    expect(account).toMatchObject({ opening: 2000, closing: 2000 });
  });

  it('una cartola que ya trae un movimiento fechado al día siguiente va al final de su día', () => {
    // Descargada el 16 a última hora: el banco ya fechó al 17 una transferencia hecha esa noche.
    load(
      db,
      cartola(ACC_A, '2026-11-16', 2100, [
        { date: '2026-11-17', amount: 100, type: 'A', desc: 'Traspaso De: Cliente Cuatro' },
        { date: '2026-11-14', amount: 200, type: 'A', desc: 'Traspaso De: Cliente Tres' },
      ]),
      'c16.txt',
    );
    // Por fecha real, la transferencia es del 16: va antes de la cartola y su saldo es el que informó el banco.
    const [account] = dayDetail(db, '2026-11-16').accounts;
    expect(account.entries).toHaveLength(2);
    expect(account.entries[0]).toMatchObject({ type: 'movement', movement: { date: '2026-11-17', real_date: '2026-11-16', real_date_source: 'observada', balance_after: 2100 } });
    expect(account.entries[1]).toMatchObject({ type: 'hito', hito: { day: '2026-11-16', anchor: { date: '2026-11-17', realDate: '2026-11-16' }, diff: 0, balance: 2100 } });
    expect(account).toMatchObject({ opening: 2000, closing: 2100 });

    // Por fecha del banco suma el 17: el 16 la muestra sin sumarla, y la cartola va al final.
    const [bank] = dayDetail(db, '2026-11-16', undefined, 'banco').accounts;
    expect(bank.entries.map((e) => e.type)).toEqual(['later', 'hito']);
    expect(bank).toMatchObject({ opening: 2000, closing: 2000 });
  });
});

describe('día por día', () => {
  let db: DB;
  beforeEach(() => {
    db = testDb();
    load(db, c10, 'c10.txt');
    load(db, c12, 'c12.txt');
    load(db, c14, 'c14.txt');
  });

  it('cada día con su saldo inicial y final, sus movimientos y sus cartolas, del más reciente al más antiguo', () => {
    const days = buildDays(db, { from: '2026-11-09', to: '2026-11-14' }, '2026-11-20');
    expect(days.map((d) => d.day)).toEqual(['2026-11-14', '2026-11-13', '2026-11-12', '2026-11-11', '2026-11-10', '2026-11-09']);
    const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
    expect(byDay['2026-11-14']).toMatchObject({ movements: 1, totals: { opening: 1800, income: 200, closing: 2000 } });
    expect(byDay['2026-11-14'].hitos.map((h) => h.filename)).toEqual(['c14.txt']);
    // Sin movimientos: el saldo sigue igual y no hay cartola.
    expect(byDay['2026-11-13']).toMatchObject({ movements: 0, totals: { opening: 1800, closing: 1800 }, hitos: [] });
    expect(byDay['2026-11-10']).toMatchObject({ movements: 1, totals: { expenses: 300 } });
    expect(byDay['2026-11-10'].accounts[0]).toMatchObject({ movements: 1, opening: 1600, closing: 1300 });
  });

  it('no inventa días futuros sin movimientos', () => {
    expect(buildDays(db, { from: '2026-11-14', to: '2026-11-30' }, '2026-11-16').map((d) => d.day)).toEqual(['2026-11-16', '2026-11-15', '2026-11-14']);
  });

  it('el detalle va en el orden del banco, con la cartola justo después de su último movimiento', () => {
    load(
      db,
      cartola(ACC_A, '2026-11-14', 2050, [
        { date: '2026-11-14', amount: 50, type: 'A', desc: 'Traspaso De: Cliente Cinco' },
        { date: '2026-11-14', amount: 200, type: 'A', desc: 'Traspaso De: Cliente Tres' },
      ]),
      'c14-tarde.txt',
    );
    const [account] = dayDetail(db, '2026-11-14').accounts;
    expect(account.entries.map((e) => (e.type === 'hito' ? `cartola ${e.hito.filename}` : e.movement.description))).toEqual([
      'Traspaso De: Cliente Tres',
      'cartola c14.txt',
      'Traspaso De: Cliente Cinco',
      'cartola c14-tarde.txt',
    ]);
  });

  it('cada pago de nómina trae su n° de nómina, para mostrarlos agrupados como en Nóminas', () => {
    const other = testDb();
    load(
      other,
      cartola(ACC_A, '2026-11-05', 900, [
        { date: '2026-11-05', amount: 30, type: 'C', desc: 'Pago Fácil Bch: 0333333333' },
        { date: '2026-11-05', amount: 20, type: 'C', desc: 'Pago Fácil Bch: 0222222222' },
        { date: '2026-11-05', amount: 50, type: 'C', desc: 'Pago: Proveedor Uno' },
        { date: '2026-11-04', amount: 1000, type: 'A', desc: 'Traspaso De: Cliente Uno' },
      ]),
      'n.txt',
    );
    const [account] = dayDetail(other, '2026-11-05').accounts;
    expect(account.entries.map((e) => (e.type === 'movement' ? e.movement.payroll_batch : 'cartola'))).toEqual([null, 1, 1, 'cartola']);
  });

  it('la huella de un día cambia con lo que informa el banco, no con categorías ni comentarios', () => {
    const before = movementsHash(db, '2026-11-14');
    db.prepare("UPDATE movements SET label = 'Comentario', note = 'Nota' WHERE date = '2026-11-14'").run();
    expect(movementsHash(db, '2026-11-14')).toBe(before);
    load(db, cartola(ACC_A, '2026-11-14', 2050, [{ date: '2026-11-14', amount: 50, type: 'A', desc: 'Traspaso De: Cliente Cinco' }, { date: '2026-11-14', amount: 200, type: 'A', desc: 'Traspaso De: Cliente Tres' }]), 'otra.txt');
    expect(movementsHash(db, '2026-11-14')).not.toBe(before);
  });
});
