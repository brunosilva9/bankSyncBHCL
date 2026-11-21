import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { closeDay } from '../src/domain/closing.js';
import { ACC_A, cartola, testStore } from './helpers.js';

const store = testStore();
const app = createApp(store, { production: false, sessionDays: 1, closingHour: 2 });
const H = { 'x-requested-with': 'syncbanks' };

describe('API del diario', () => {
  let cookie: string;

  beforeAll(async () => {
    createUser(store.auth, 'admin', 'una-clave-larga', { role: 'admin' });
    const res = await request(app).post('/api/auth/login').set(H).send({ username: 'admin', password: 'una-clave-larga' });
    cookie = res.headers['set-cookie'][0].split(';')[0];
    const text = cartola(ACC_A, '2026-11-12', 1500, [
      { date: '2026-11-12', amount: 500, type: 'A', desc: 'Traspaso De: Cliente Dos' },
      { date: '2026-11-10', amount: 300, type: 'C', desc: 'Pago: Proveedor Uno' },
    ]);
    await request(app)
      .post('/api/imports')
      .set(H)
      .set('Cookie', cookie)
      .set('Content-Type', 'application/octet-stream')
      .set('x-filename', 'cartola.txt')
      .send(Buffer.from(text, 'latin1'))
      .expect(200);
  });

  it('lista los días con saldos, cartolas y cierre', async () => {
    const res = await request(app).get('/api/daily?from=2026-11-10&to=2026-11-12').set('Cookie', cookie).expect(200);
    expect(res.body.closingHour).toBe(2);
    expect(res.body.days.map((d: { day: string }) => d.day)).toEqual(['2026-11-12', '2026-11-11', '2026-11-10']);
    expect(res.body.days[0]).toMatchObject({ movements: 1, totals: { opening: 1000, closing: 1500 }, closing: null });
    expect(res.body.days[0].hitos).toEqual([expect.objectContaining({ balance: 1500, filename: 'cartola.txt' })]);
  });

  it('muestra el detalle de un día y su cierre', async () => {
    const before = await request(app).get('/api/daily/2026-11-12').set('Cookie', cookie).expect(200);
    expect(before.body.closing).toBeNull();
    expect(before.body.accounts[0].entries.map((e: { type: string }) => e.type)).toEqual(['movement', 'hito']);

    closeDay(store.data(store.dataFiles()[0]), '2026-11-12');
    const after = await request(app).get('/api/daily/2026-11-12').set('Cookie', cookie).expect(200);
    expect(after.body.closing).toMatchObject({ day: '2026-11-12', changed: false, snapshot: { report: { totals: { closing: 1500 } } } });
    const list = await request(app).get('/api/daily?from=2026-11-12&to=2026-11-12').set('Cookie', cookie).expect(200);
    expect(list.body.days[0].closing).toMatchObject({ changed: false });
  });

  it('rechaza fechas inválidas y rangos demasiado largos', async () => {
    await request(app).get('/api/daily?from=2026-11-12&to=2026-11-01').set('Cookie', cookie).expect(400);
    await request(app).get('/api/daily?from=2026-01-01&to=2026-12-31').set('Cookie', cookie).expect(400);
    await request(app).get('/api/daily/ayer').set('Cookie', cookie).expect(400);
  });
});
