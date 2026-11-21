import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { openDb, type DB } from '../src/db.js';
import { buildDays, dayDetail } from '../src/domain/daily.js';
import { importCartola, type SeenOptions } from '../src/domain/importer.js';
import { buildReport, type DateMode } from '../src/domain/report.js';
import { observedOf, realDateWindows, type Placeable } from '../src/domain/seen.js';
import { parseCartola } from '../src/parser/cartola.js';
import { chileInstant } from '../src/time.js';
import { ACC_A, cartola, testDb, testStore } from './helpers.js';

// Banco de Chile fecha al día hábil siguiente lo que se hace de noche o en fin de semana. Viernes 13, sábado 14 y
// lunes 16 de noviembre de 2026 (datos ficticios):
//   vie 13  +1.000 de un cliente.
//   sáb 14  la cartola ya trae una transferencia de −200 hecha ese día, pero con fecha del lunes 16.
//   lun 16  la misma transferencia y un pago de −100 hecho el lunes.
const friday = cartola(ACC_A, '2026-11-13', 1000, [{ date: '2026-11-13', amount: 1000, type: 'A', desc: 'Traspaso De: Cliente Uno' }]);
const saturday = cartola(ACC_A, '2026-11-14', 800, [
  { date: '2026-11-16', amount: 200, type: 'C', desc: 'Traspaso A: Proveedor Sabado' },
  { date: '2026-11-13', amount: 1000, type: 'A', desc: 'Traspaso De: Cliente Uno' },
]);
const monday = cartola(ACC_A, '2026-11-16', 700, [
  { date: '2026-11-16', amount: 100, type: 'C', desc: 'Pago: Proveedor Lunes' },
  { date: '2026-11-16', amount: 200, type: 'C', desc: 'Traspaso A: Proveedor Sabado' },
  { date: '2026-11-13', amount: 1000, type: 'A', desc: 'Traspaso De: Cliente Uno' },
]);

// Otro día que hoy: la hora de subida no sirve de hora de descarga.
const LATER: SeenOptions = { now: Date.UTC(2030, 0, 1) };
const load = (db: DB, text: string, name: string, seen: SeenOptions = LATER) => importCartola(db, parseCartola(text), name, null, seen);

const real = (db: DB) =>
  db.prepare('SELECT description, date, first_seen_day, real_date, real_date_source FROM movements ORDER BY date, seq DESC').all() as Array<{
    description: string;
    date: string;
    first_seen_day: string | null;
    real_date: string | null;
    real_date_source: string | null;
  }>;

describe('hora de descarga', () => {
  const day = '2026-11-14';
  const at = (local: string) => chileInstant(local)!;

  it('la que anota el banco; si no, la del archivo o la de subida, si son del mismo día', () => {
    expect(observedOf(day, '2026-11-14 10:32', null, at('2026-11-20 09:00'))).toEqual({ day, at: '2026-11-14T13:32:00.000Z', source: 'banco' });
    expect(observedOf(day, null, at('2026-11-14 23:50'), at('2026-11-20 09:00'))).toEqual({ day, at: '2026-11-15T02:50:00.000Z', source: 'archivo' });
    // El archivo se modificó otro día (se copió): no dice cuándo se bajó. Se subió el mismo día: sirve esa hora.
    expect(observedOf(day, null, at('2026-11-18 08:00'), at('2026-11-14 11:00'))).toEqual({ day, at: '2026-11-14T14:00:00.000Z', source: 'subida' });
    expect(observedOf(day, null, null, at('2026-11-20 09:00'))).toEqual({ day, at: null, source: null });
  });

  it('se guarda con la cartola', () => {
    const db = testDb();
    load(db, saturday, 'sab.txt', { fileModified: at('2026-11-14 10:32'), now: at('2026-11-14 10:40') });
    expect(db.prepare('SELECT observed_at, observed_source FROM imports').get()).toEqual({ observed_at: '2026-11-14T13:32:00.000Z', observed_source: 'archivo' });
    expect(db.prepare("SELECT first_seen_at FROM movements WHERE description LIKE '%Sabado'").get()).toEqual({ first_seen_at: '2026-11-14T13:32:00.000Z' });
  });
});

describe('fecha real: el día en que se vio por primera vez', () => {
  let db: DB;
  beforeEach(() => {
    db = testDb();
  });

  it('lo que el banco fechó el lunes y ya estaba el sábado queda del sábado; lo del lunes, del lunes', () => {
    load(db, friday, 'vie.txt');
    load(db, saturday, 'sab.txt');
    load(db, monday, 'lun.txt');
    expect(real(db)).toEqual([
      { description: 'Traspaso De: Cliente Uno', date: '2026-11-13', first_seen_day: '2026-11-13', real_date: '2026-11-13', real_date_source: 'banco' },
      { description: 'Traspaso A: Proveedor Sabado', date: '2026-11-16', first_seen_day: '2026-11-14', real_date: '2026-11-14', real_date_source: 'observada' },
      { description: 'Pago: Proveedor Lunes', date: '2026-11-16', first_seen_day: '2026-11-16', real_date: '2026-11-16', real_date_source: 'banco' },
    ]);
  });

  it('una cartola descargada antes y subida después también cuenta', () => {
    load(db, monday, 'lun.txt');
    expect(real(db).find((m) => m.description.endsWith('Sabado'))).toMatchObject({ real_date: '2026-11-16', real_date_source: 'banco' });
    load(db, saturday, 'sab.txt');
    expect(real(db).find((m) => m.description.endsWith('Sabado'))).toMatchObject({ first_seen_day: '2026-11-14', real_date: '2026-11-14', real_date_source: 'observada' });
  });

  it('se conserva aunque el banco le cambie la redacción', () => {
    load(db, cartola(ACC_A, '2026-11-14', 1500, [{ date: '2026-11-16', amount: 500, type: 'A', desc: 'Trasp.fondos A Ctacte-l.cred-c.vista' }]), 'sab.txt');
    load(db, cartola(ACC_A, '2026-11-16', 1500, [{ date: '2026-11-16', amount: 500, type: 'A', desc: 'Transferencia Desde Linea De Credito' }]), 'lun.txt');
    expect(real(db)).toEqual([
      { description: 'Transferencia Desde Linea De Credito', date: '2026-11-16', first_seen_day: '2026-11-14', real_date: '2026-11-14', real_date_source: 'observada' },
    ]);
  });

  describe('el diario', () => {
    beforeEach(() => {
      load(db, friday, 'vie.txt');
      load(db, saturday, 'sab.txt');
      load(db, monday, 'lun.txt');
    });
    const timeline = (day: string, dates?: DateMode) =>
      dayDetail(db, day, undefined, dates).accounts[0].entries.map((e) =>
        e.type === 'hito' ? `cartola ${e.hito.filename}` : `${e.type} ${e.movement.description} (saldo ${e.movement.balance_after})`,
      );

    it('por fecha real, cuenta la transferencia el sábado: el saldo del sábado es el que informó el banco', () => {
      expect(timeline('2026-11-14')).toEqual(['movement Traspaso A: Proveedor Sabado (saldo 800)', 'cartola sab.txt']);
      // El lunes se ve, sin sumar: ya se contó el sábado.
      expect(timeline('2026-11-16')).toEqual(['earlier Traspaso A: Proveedor Sabado (saldo 800)', 'movement Pago: Proveedor Lunes (saldo 700)', 'cartola lun.txt']);
      expect(dayDetail(db, '2026-11-14').accounts[0]).toMatchObject({ opening: 1000, closing: 800 });
      expect(dayDetail(db, '2026-11-16').accounts[0]).toMatchObject({ opening: 800, closing: 700 });

      const days = Object.fromEntries(buildDays(db, { from: '2026-11-13', to: '2026-11-16' }, '2026-11-20').map((d) => [d.day, d]));
      expect(days['2026-11-14']).toMatchObject({ movements: 1, datedLater: 1, seenBefore: 0, totals: { opening: 1000, expenses: 200, closing: 800 } });
      expect(days['2026-11-15']).toMatchObject({ movements: 0, totals: { opening: 800, closing: 800 } });
      expect(days['2026-11-16']).toMatchObject({ movements: 1, datedLater: 0, seenBefore: 1, totals: { opening: 800, expenses: 100, closing: 700 } });
    });

    it('por fecha del banco, la cuenta el lunes y el sábado la muestra sin sumar', () => {
      expect(timeline('2026-11-14', 'banco')).toEqual(['later Traspaso A: Proveedor Sabado (saldo 800)', 'cartola sab.txt']);
      expect(timeline('2026-11-16', 'banco')).toEqual(['movement Traspaso A: Proveedor Sabado (saldo 800)', 'movement Pago: Proveedor Lunes (saldo 700)', 'cartola lun.txt']);
      expect(dayDetail(db, '2026-11-14', undefined, 'banco').accounts[0]).toMatchObject({ opening: 1000, closing: 1000 });

      const days = Object.fromEntries(buildDays(db, { from: '2026-11-13', to: '2026-11-16', dates: 'banco' }, '2026-11-20').map((d) => [d.day, d]));
      expect(days['2026-11-14']).toMatchObject({ movements: 0, datedLater: 1, seenBefore: 0 });
      expect(days['2026-11-16']).toMatchObject({ movements: 2, datedLater: 0, seenBefore: 1 });
    });

    it('el informe de un rango: por fecha real cuadra igual, con lo del fin de semana en su día', () => {
      const real = buildReport(db, { from: '2026-11-14', to: '2026-11-15' });
      const bank = buildReport(db, { from: '2026-11-14', to: '2026-11-15', dates: 'banco' });
      expect(real.totals).toMatchObject({ opening: 1000, expenses: 200, closing: 800 });
      expect(bank.totals).toMatchObject({ opening: 1000, expenses: 0, closing: 1000 });
      expect(real.period).toEqual({ from: '2026-11-14', to: '2026-11-14' });
      // Lo que cubre los dos fines da lo mismo de las dos formas.
      expect(buildReport(db, { from: '2026-11-13', to: '2026-11-16' }).totals).toMatchObject({ opening: 0, closing: 700, expenses: 300 });
      expect(buildReport(db, { from: '2026-11-13', to: '2026-11-16', dates: 'banco' }).totals).toMatchObject({ opening: 0, closing: 700, expenses: 300 });
    });
  });

  it('una base de antes se completa al abrirla, con lo que dicen las cartolas cargadas', () => {
    const file = path.join(os.tmpdir(), `syncbanks-test-${crypto.randomUUID()}.db`);
    const old = openDb(file, 'clave-de-prueba');
    load(old, friday, 'vie.txt');
    load(old, saturday, 'sab.txt');
    load(old, monday, 'lun.txt');
    old.exec(`UPDATE movements SET first_seen_day = NULL, first_seen_at = NULL, real_date = NULL, real_date_source = NULL;
              UPDATE imports SET observed_at = NULL, observed_source = NULL, imported_at = '2026-11-20 12:00:00';
              UPDATE imports SET imported_at = '2026-11-14 13:40:00' WHERE filename = 'sab.txt';`);
    old.close();

    const db2 = openDb(file, 'clave-de-prueba');
    expect(real(db2).map((m) => [m.real_date, m.real_date_source])).toEqual([
      ['2026-11-13', 'banco'],
      ['2026-11-14', 'observada'],
      ['2026-11-16', 'banco'],
    ]);
    // Subida el mismo día de la descarga: sirve de hora de descarga.
    expect(db2.prepare("SELECT observed_at, observed_source FROM imports WHERE filename = 'sab.txt'").get()).toEqual({
      observed_at: '2026-11-14T13:40:00.000Z',
      observed_source: 'subida',
    });
    expect(db2.prepare("SELECT observed_at FROM imports WHERE filename = 'lun.txt'").get()).toEqual({ observed_at: null });
    db2.close();
  });
});

describe('fecha real a mano: entre qué días pudo pasar', () => {
  // Las mismas cartolas, bajadas el viernes a las 22:00, el sábado a las 10:00 y el lunes a las 07:00.
  const at = (local: string) => chileInstant(local)!;
  const downloaded = (local: string): SeenOptions => ({ fileModified: at(local), now: LATER.now });
  const byDescription = (db: DB) => {
    const rows = db
      .prepare('SELECT account_id, description, date, real_date, real_date_source, first_seen_day, first_seen_at FROM movements')
      .all() as Array<Placeable & { description: string }>;
    const windows = realDateWindows(db, rows);
    return Object.fromEntries(rows.map((r, k) => [r.description, { ...r, window: windows[k] }]));
  };
  let db: DB;
  beforeEach(() => {
    db = testDb();
    load(db, friday, 'vie.txt', downloaded('2026-11-13 22:00'));
    load(db, saturday, 'sab.txt', downloaded('2026-11-14 10:00'));
    load(db, monday, 'lun.txt', downloaded('2026-11-16 07:00'));
  });

  it('lo que apareció el lunes pudo pasar el sábado después de la descarga anterior, el domingo o el lunes', () => {
    expect(byDescription(db)['Pago: Proveedor Lunes'].window).toEqual({
      min: '2026-11-14',
      max: '2026-11-16',
      before: { day: '2026-11-14', at: '2026-11-14T13:00:00.000Z' },
    });
  });

  it('lo que ya estaba el sábado, el viernes después de las 22:00 o el sábado; sin descarga anterior, desde el día hábil anterior', () => {
    const m = byDescription(db);
    expect(m['Traspaso A: Proveedor Sabado'].window).toEqual({
      min: '2026-11-13',
      max: '2026-11-14',
      before: { day: '2026-11-13', at: '2026-11-14T01:00:00.000Z' },
    });
    expect(m['Traspaso De: Cliente Uno'].window).toEqual({ min: '2026-11-12', max: '2026-11-13', before: null });
  });

  it('una fecha manual se mantiene, salvo que una cartola muestre que ya existía antes', () => {
    db.prepare("UPDATE movements SET real_date = '2026-11-15', real_date_source = 'manual' WHERE description = 'Pago: Proveedor Lunes'").run();
    load(db, monday, 'lun-otra-vez.txt', downloaded('2026-11-16 09:00'));
    expect(byDescription(db)['Pago: Proveedor Lunes']).toMatchObject({ real_date: '2026-11-15', real_date_source: 'manual' });

    // Una descarga del sábado a las 20:00, subida después, ya lo traía: no pudo pasar el domingo, y ya no hay qué elegir.
    const saturdayNight = cartola(ACC_A, '2026-11-14', 700, [
      { date: '2026-11-16', amount: 100, type: 'C', desc: 'Pago: Proveedor Lunes' },
      { date: '2026-11-16', amount: 200, type: 'C', desc: 'Traspaso A: Proveedor Sabado' },
      { date: '2026-11-13', amount: 1000, type: 'A', desc: 'Traspaso De: Cliente Uno' },
    ]);
    load(db, saturdayNight, 'sab-noche.txt', downloaded('2026-11-14 20:00'));
    expect(byDescription(db)['Pago: Proveedor Lunes']).toMatchObject({ real_date: '2026-11-14', real_date_source: 'observada', window: null });
  });
});

describe('API', () => {
  const store = testStore();
  const app = createApp(store, { production: false, sessionDays: 1 });
  const H = { 'x-requested-with': 'syncbanks' };
  let cookie: string;

  beforeAll(async () => {
    createUser(store.auth, 'admin', 'una-clave-larga', { role: 'admin' });
    const res = await request(app).post('/api/auth/login').set(H).send({ username: 'admin', password: 'una-clave-larga' });
    cookie = res.headers['set-cookie'][0].split(';')[0];
  });

  const upload = (text: string, name: string, modified?: number) => {
    const r = request(app).post('/api/imports').set(H).set('Cookie', cookie).set('Content-Type', 'application/octet-stream').set('x-filename', name);
    return (modified === undefined ? r : r.set('x-file-modified', String(modified))).send(Buffer.from(text, 'latin1')).expect(200);
  };

  it('la hora del archivo que manda el navegador queda como hora de descarga', async () => {
    await upload(saturday, 'sab.txt', chileInstant('2026-11-14 10:32')!);
    const [movement] = (await request(app).get('/api/movements?postdated=1&from=2026-11-01&to=2026-11-30').set('Cookie', cookie).expect(200)).body;
    expect(movement).toMatchObject({ date: '2026-11-16', first_seen_day: '2026-11-14', first_seen_at: '2026-11-14T13:32:00.000Z', real_date: '2026-11-14' });
  });

  it('filtra los que el banco fechó después', async () => {
    await upload(monday, 'lun.txt');
    const all = (await request(app).get('/api/movements?from=2026-11-01&to=2026-11-30').set('Cookie', cookie).expect(200)).body;
    const moved = (await request(app).get('/api/movements?postdated=1&from=2026-11-01&to=2026-11-30').set('Cookie', cookie).expect(200)).body;
    expect(all).toHaveLength(3);
    expect(moved.map((m: { description: string }) => m.description)).toEqual(['Traspaso A: Proveedor Sabado']);
  });
});

describe('fecha real a mano: API', () => {
  const store = testStore();
  const app = createApp(store, { production: false, sessionDays: 1 });
  const H = { 'x-requested-with': 'syncbanks' };
  let cookie: string;
  type Row = { id: number; description: string; real_date: string; real_date_source: string; real_date_window: unknown };
  const find = async (description: string) =>
    ((await request(app).get('/api/movements?from=2026-11-01&to=2026-11-30').set('Cookie', cookie).expect(200)).body as Row[]).find((m) => m.description === description)!;
  const patch = (id: number, body: object) => request(app).patch(`/api/movements/${id}`).set(H).set('Cookie', cookie).send(body);

  beforeAll(async () => {
    createUser(store.auth, 'admin', 'una-clave-larga', { role: 'admin' });
    const res = await request(app).post('/api/auth/login').set(H).send({ username: 'admin', password: 'una-clave-larga' });
    cookie = res.headers['set-cookie'][0].split(';')[0];
    const files: Array<[string, string, string]> = [
      [friday, 'vie.txt', '2026-11-13 22:00'],
      [saturday, 'sab.txt', '2026-11-14 10:00'],
      [monday, 'lun.txt', '2026-11-16 07:00'],
    ];
    for (const [text, name, local] of files) {
      await request(app)
        .post('/api/imports')
        .set(H)
        .set('Cookie', cookie)
        .set('Content-Type', 'application/octet-stream')
        .set('x-filename', name)
        .set('x-file-modified', String(chileInstant(local)))
        .send(Buffer.from(text, 'latin1'))
        .expect(200);
    }
  });

  it('cada movimiento trae entre qué días pudo pasar; se elige uno y queda como fecha real manual', async () => {
    const monday = await find('Pago: Proveedor Lunes');
    expect(monday.real_date_window).toEqual({ min: '2026-11-14', max: '2026-11-16', before: { day: '2026-11-14', at: '2026-11-14T13:00:00.000Z' } });
    await patch(monday.id, { realDate: '2026-11-15' }).expect(200);
    expect(await find('Pago: Proveedor Lunes')).toMatchObject({ real_date: '2026-11-15', real_date_source: 'manual' });
  });

  it('fuera de esos días, no', async () => {
    const monday = await find('Pago: Proveedor Lunes');
    expect((await patch(monday.id, { realDate: '2026-11-13' }).expect(400)).body.error).toBe('La fecha real tiene que ser entre el 14/11 y el 16/11');
    await patch(monday.id, { realDate: 'ayer' }).expect(400);
    expect(await find('Pago: Proveedor Lunes')).toMatchObject({ real_date: '2026-11-15', real_date_source: 'manual' });
  });
});
