import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import type { DB } from '../src/db.js';
import { calibrateFromAvailable } from '../src/domain/creditLine.js';
import { dailyBalances } from '../src/domain/daily.js';
import { importCartola, type SeenOptions } from '../src/domain/importer.js';
import { buildReport, type DateMode } from '../src/domain/report.js';
import { parseCartola } from '../src/parser/cartola.js';
import { chileInstant, daysBetween } from '../src/time.js';
import { ACC_A, ACC_B, cartola, testDb, testStore } from './helpers.js';

// Datos ficticios. Cuenta A: +1.000 el viernes 13; el sábado 14 una transferencia de −200 que el banco fechó el lunes
// 16, y el lunes un pago de −100.
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
// Cuenta B, con una línea de 1.000: +400 el martes 10, un giro de 400 desde la línea el jueves 12 y −500 el martes 17.
const withCredit = cartola(ACC_B, '2026-11-17', 300, [
  { date: '2026-11-17', amount: 500, type: 'C', desc: 'Pago: Proveedor Dos' },
  { date: '2026-11-12', amount: 400, type: 'A', desc: 'Transferencia Desde Linea De Credito' },
  { date: '2026-11-10', amount: 400, type: 'A', desc: 'Traspaso De: Cliente Dos' },
]);

// Otro día que hoy: la hora de subida no sirve de hora de descarga.
const LATER: SeenOptions = { now: Date.UTC(2030, 0, 1) };
const load = (db: DB, text: string, name: string, seen: SeenOptions = LATER) => importCartola(db, parseCartola(text), name, null, seen);
const at = (local: string) => chileInstant(local)!;

// Desde antes del primer movimiento hasta después del último.
const FROM = '2026-11-08';
const TO = '2026-11-19';
const TODAY = '2026-11-20';

describe('saldo al final de cada día', () => {
  let db: DB;
  let a: number;
  let b: number;

  beforeEach(() => {
    db = testDb();
    a = load(db, friday, 'vie.txt').accountId;
    load(db, saturday, 'sab.txt', { fileModified: at('2026-11-14 22:00'), now: at('2026-11-14 22:05') });
    load(db, monday, 'lun.txt');
    b = load(db, withCredit, 'b.txt').accountId;
    db.prepare('UPDATE accounts SET credit_limit = 1000 WHERE id = ?').run(b);
    calibrateFromAvailable(db, b, 600);
    db.prepare("INSERT INTO accounts (number, name, kind) VALUES ('99990000', 'Tarjeta Prueba', 'tarjeta_credito')").run();
  });

  const series = (dates: DateMode, id: number, from = FROM, to = TO, today = TODAY) =>
    dailyBalances(db, { from, to, dates }, today).accounts.find((x) => x.accountId === id)!;

  it.each(['real', 'banco'] as const)('da lo mismo que el informe de cada día, por fecha %s', (dates) => {
    const balances = dailyBalances(db, { from: FROM, to: TO, dates }, TODAY);
    // Las tarjetas no tienen saldo.
    expect(balances.accounts.map((x) => x.accountId)).toEqual(buildReport(db, { from: FROM, to: TO }).accounts.filter((x) => !x.isCard).map((x) => x.accountId));
    for (const account of balances.accounts) {
      const start = buildReport(db, { from: FROM, to: TO, dates }).accounts.find((x) => x.accountId === account.accountId)!;
      expect(account.opening).toEqual({ closing: start.opening, available: start.availableOpening });
      expect(account.days.map((p) => p.day)).toEqual(daysBetween(FROM, TO));
      for (const p of account.days) {
        const day = buildReport(db, { from: p.day, to: p.day, dates }).accounts.find((x) => x.accountId === account.accountId)!;
        expect({ day: p.day, closing: p.closing, available: p.available }).toEqual({ day: p.day, closing: day.closing, available: day.availableClosing });
      }
    }
  });

  it('por fecha real, lo del sábado que el banco fechó el lunes baja el saldo del sábado; por la del banco, el del lunes', () => {
    const closings = (dates: DateMode) =>
      series(dates, a, '2026-11-12', '2026-11-16')
        .days.map((p) => p.closing);
    expect(closings('real')).toEqual([0, 1000, 800, 800, 700]);
    expect(closings('banco')).toEqual([0, 1000, 1000, 1000, 700]);
    expect(series('real', a, '2026-11-12', '2026-11-16').opening).toEqual({ closing: 0, available: 0 });
  });

  it('dice cuántas cartolas se bajaron cada día, la hora de la última si se sabe y cuándo se subió', () => {
    db.prepare("UPDATE imports SET imported_at = '2026-11-16 12:30:00' WHERE filename = 'vie.txt'").run();
    const days = Object.fromEntries(series('real', a).days.map((p) => [p.day, [p.cartolas, p.lastSeenAt, p.lastImportedAt]]));
    expect(days['2026-11-13']).toEqual([1, null, '2026-11-16 12:30:00']);
    expect(days['2026-11-14']).toEqual([1, '2026-11-15T01:00:00.000Z', expect.any(String)]); // 22:00 en Chile
    expect(days['2026-11-15']).toEqual([0, null, null]);
  });

  it('con línea de crédito, el disponible es saldo + lo libre de la línea: girar de la línea no lo cambia', () => {
    const b11 = series('real', b);
    expect(b11.hasCredit).toBe(true);
    const days = Object.fromEntries(b11.days.map((p) => [p.day, [p.closing, p.available]]));
    expect(days['2026-11-11']).toEqual([400, 1400]);
    expect(days['2026-11-12']).toEqual([800, 1400]);
    expect(days['2026-11-17']).toEqual([300, 900]);
    expect(series('real', a).hasCredit).toBe(false);
  });

  it('llega hasta hoy', () => {
    const s = dailyBalances(db, { from: '2026-11-15', to: '2026-11-30' }, '2026-11-18');
    expect(s.to).toBe('2026-11-18');
    expect(s.accounts[0].days.map((p) => p.day)).toEqual(['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18']);
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
    await request(app)
      .post('/api/imports')
      .set(H)
      .set('Cookie', cookie)
      .set('Content-Type', 'application/octet-stream')
      .set('x-filename', 'sab.txt')
      .send(Buffer.from(saturday, 'latin1'))
      .expect(200);
  });

  const get = (q: string) => request(app).get(`/api/balances?${q}`).set('Cookie', cookie);

  it('GET /api/balances: el saldo de cada cuenta al final de cada día, por fecha real o por la del banco', async () => {
    const real = (await get('from=2026-11-12&to=2026-11-14').expect(200)).body;
    expect(real).toMatchObject({ from: '2026-11-12', to: '2026-11-14' });
    expect(real.accounts[0].days.map((p: { closing: number }) => p.closing)).toEqual([0, 1000, 800]);
    const bank = (await get('from=2026-11-12&to=2026-11-14&fecha=banco').expect(200)).body;
    expect(bank.accounts[0].days.map((p: { closing: number }) => p.closing)).toEqual([0, 1000, 1000]);
  });

  it('rechaza un rango al revés o de más de tres años', async () => {
    await get('from=2026-11-14&to=2026-11-12').expect(400);
    await get('from=2020-01-01&to=2026-11-14').expect(400);
  });
});
