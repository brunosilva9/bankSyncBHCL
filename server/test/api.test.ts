import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { ACC_A, cartola, testDb } from './helpers.js';

const db = testDb();
const app = createApp(db, { production: false, sessionDays: 1 });
const H = { 'x-requested-with': 'syncbanks' };

describe('API', () => {
  let cookie: string;

  beforeAll(async () => {
    createUser(db, 'admin', 'una-clave-larga');
    const res = await request(app).post('/api/auth/login').set(H).send({ username: 'admin', password: 'una-clave-larga' });
    cookie = res.headers['set-cookie'][0].split(';')[0];
  });

  it('exige sesión para ver datos', async () => {
    await request(app).get('/api/movements').expect(401);
  });

  it('rechaza contraseña incorrecta', async () => {
    await request(app).post('/api/auth/login').set(H).send({ username: 'admin', password: 'otra' }).expect(401);
  });

  it('rechaza escrituras sin el header anti-CSRF', async () => {
    await request(app).post('/api/categories').set('Cookie', cookie).send({ name: 'X' }).expect(403);
  });

  it('importa una cartola, etiqueta un movimiento y genera el informe', async () => {
    const text = cartola(ACC_A, '2026-10-12', 700, [{ date: '2026-10-12', amount: 300, type: 'C', desc: 'Traspaso A: Pedro Gonzalez Rojas' }]);
    const imp = await request(app)
      .post('/api/imports')
      .set(H)
      .set('Cookie', cookie)
      .set('Content-Type', 'application/octet-stream')
      .set('x-filename', 'cartola.txt')
      .send(Buffer.from(text, 'latin1'))
      .expect(200);
    expect(imp.body.inserted).toBe(1);

    const movs = await request(app).get('/api/movements').set('Cookie', cookie).expect(200);
    await request(app).patch(`/api/movements/${movs.body[0].id}`).set(H).set('Cookie', cookie).send({ label: 'Gastos Pedro' }).expect(200);

    const labeled = await request(app).get('/api/movements?label=Gastos%20Pedro').set('Cookie', cookie).expect(200);
    expect(labeled.body).toHaveLength(1);

    const report = await request(app).get('/api/report?from=2026-10-01&to=2026-10-31').set('Cookie', cookie).expect(200);
    expect(report.body.totals).toMatchObject({ opening: 1000, expenses: 300, closing: 700 });
    expect(report.body.note).toBeNull();
  });

  it('guarda el comentario del informe para su período real y por alcance de cuentas', async () => {
    // El filtro va más allá de los datos (12/10), así que el comentario queda en el período real.
    const report = await request(app).get('/api/report?from=2026-10-01&to=2026-10-31').set('Cookie', cookie).expect(200);
    const { period } = report.body;
    const put = (body: object) => request(app).put('/api/report-note').set(H).set('Cookie', cookie).send({ ...period, ...body });

    const saved = await put({ text: '  Se pagó la nómina de la semana.  ' }).expect(200);
    expect(saved.body).toMatchObject({ text: 'Se pagó la nómina de la semana.', username: 'admin' });

    const again = await request(app).get('/api/report?from=2026-10-10&to=2026-10-20').set('Cookie', cookie).expect(200);
    expect(again.body.note.text).toBe('Se pagó la nómina de la semana.');
    const oneAccount = await request(app).get(`/api/report?from=2026-10-01&to=2026-10-31&accounts=${report.body.accounts[0].accountId}`).set('Cookie', cookie);
    expect(oneAccount.body.note).toBeNull();

    await put({ text: 'x'.repeat(501) }).expect(400);
    await put({ text: '' }).expect(200);
    const cleared = await request(app).get('/api/report?from=2026-10-01&to=2026-10-31').set('Cookie', cookie);
    expect(cleared.body.note).toBeNull();
  });

  it('responde 400 con un archivo que no es cartola', async () => {
    const res = await request(app)
      .post('/api/imports')
      .set(H)
      .set('Cookie', cookie)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('no soy una cartola'))
      .expect(400);
    expect(res.body.error).toMatch(/largo/);
  });
});
