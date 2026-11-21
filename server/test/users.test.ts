import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createUser, hashPassword, transferData } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { importCartola } from '../src/domain/importer.js';
import { parseCartola } from '../src/parser/cartola.js';
import { openStore, type Store } from '../src/store.js';
import { ACC_A, ACC_B, cartola, testStore } from './helpers.js';

const H = { 'x-requested-with': 'syncbanks' };
const KEY = 'clave-de-prueba';
const oneMovement = (account: string) => cartola(account, '2026-10-12', 700, [{ date: '2026-10-12', amount: 300, type: 'C', desc: 'Pago: Botilleria El Sol' }]);

function client(store: Store) {
  const app = createApp(store, { production: false, sessionDays: 1 });
  const login = async (username: string, password: string) => {
    const res = await request(app).post('/api/auth/login').set(H).send({ username, password }).expect(200);
    return res.headers['set-cookie'][0].split(';')[0] as string;
  };
  const upload = (cookie: string, text: string) =>
    request(app).post('/api/imports').set(H).set('Cookie', cookie).set('Content-Type', 'application/octet-stream').send(Buffer.from(text, 'latin1'));
  const accounts = async (cookie: string) => ((await request(app).get('/api/accounts').set('Cookie', cookie).expect(200)).body as Array<{ number: string }>).map((a) => a.number);
  return { app, login, upload, accounts };
}

describe('cuentas por usuario y roles', () => {
  const store = testStore();
  const { app, login, upload, accounts } = client(store);
  let jefe: string;
  let secretariaId: number;

  beforeAll(async () => {
    createUser(store.auth, 'jefe', 'clave-del-jefe-1', { role: 'admin' });
    createUser(store.auth, 'otro-admin', 'clave-del-otro-1', { role: 'admin' });
    jefe = await login('jefe', 'clave-del-jefe-1');
    const res = await request(app).post('/api/admin/users').set(H).set('Cookie', jefe).send({ username: 'Secretaria', password: 'clave-secretaria-1' }).expect(201);
    secretariaId = res.body.id;
  });

  it('cada usuario ve solo sus cuentas', async () => {
    const secretaria = await login('secretaria', 'clave-secretaria-1');
    await upload(secretaria, oneMovement(ACC_A)).expect(200);
    await upload(jefe, oneMovement(ACC_B)).expect(200);
    expect(await accounts(secretaria)).toEqual([ACC_A]);
    expect(await accounts(jefe)).toEqual([ACC_B]);
  });

  it('un usuario no administra a nadie', async () => {
    const secretaria = await login('secretaria', 'clave-secretaria-1');
    await request(app).get('/api/admin/users').set('Cookie', secretaria).expect(403);
    await request(app).put('/api/admin/view').set(H).set('Cookie', secretaria).send({ userId: null }).expect(403);
  });

  it('el administrador ve las cuentas de su usuario tal como las ve él, y vuelve a las suyas', async () => {
    const list = (await request(app).get('/api/admin/users').set('Cookie', jefe).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ id: secretariaId, username: 'secretaria', active: true, accounts: 1 })]);

    await request(app).put('/api/admin/view').set(H).set('Cookie', jefe).send({ userId: secretariaId }).expect(200);
    expect(await accounts(jefe)).toEqual([ACC_A]);
    const me = (await request(app).get('/api/auth/me').set('Cookie', jefe).expect(200)).body;
    expect(me).toMatchObject({ username: 'jefe', role: 'admin', owner: { id: secretariaId, username: 'secretaria' } });

    // Lo que importa o comenta el administrador queda en las cuentas del usuario, firmado por él.
    const imports = (await request(app).get('/api/imports').set('Cookie', jefe).expect(200)).body;
    expect(imports.map((i: { username: string }) => i.username)).toEqual(['secretaria']);

    await request(app).put('/api/admin/view').set(H).set('Cookie', jefe).send({ userId: null }).expect(200);
    expect(await accounts(jefe)).toEqual([ACC_B]);
  });

  it('una pestaña con las cuentas de otro usuario no puede escribir en las que se ven ahora', async () => {
    const me = (await request(app).get('/api/auth/me').set('Cookie', jefe)).body;
    await request(app).post('/api/categories').set(H).set('Cookie', jefe).set('x-syncbanks-owner', String(secretariaId)).send({ name: 'Z' }).expect(409);
    await request(app).post('/api/categories').set(H).set('Cookie', jefe).set('x-syncbanks-owner', String(me.owner.id)).send({ name: 'Z' }).expect(201);
  });

  it('un administrador no ve ni toca los usuarios de otro', async () => {
    const otro = await login('otro-admin', 'clave-del-otro-1');
    expect((await request(app).get('/api/admin/users').set('Cookie', otro)).body).toEqual([]);
    await request(app).put('/api/admin/view').set(H).set('Cookie', otro).send({ userId: secretariaId }).expect(404);
    await request(app).put(`/api/admin/users/${secretariaId}/password`).set(H).set('Cookie', otro).send({ password: 'una-clave-larga' }).expect(404);
    await request(app).put(`/api/admin/users/${secretariaId}/active`).set(H).set('Cookie', otro).send({ active: false }).expect(404);
  });

  it('el administrador cambia la contraseña de su usuario y lo desactiva', async () => {
    const vieja = await login('secretaria', 'clave-secretaria-1');
    await request(app).put(`/api/admin/users/${secretariaId}/password`).set(H).set('Cookie', jefe).send({ password: 'corta' }).expect(400);
    await request(app).put(`/api/admin/users/${secretariaId}/password`).set(H).set('Cookie', jefe).send({ password: 'clave-secretaria-2' }).expect(200);
    await request(app).get('/api/accounts').set('Cookie', vieja).expect(401);
    const nueva = await login('secretaria', 'clave-secretaria-2');

    await request(app).put('/api/admin/view').set(H).set('Cookie', jefe).send({ userId: secretariaId }).expect(200);
    await request(app).put(`/api/admin/users/${secretariaId}/active`).set(H).set('Cookie', jefe).send({ active: false }).expect(200);
    await request(app).get('/api/accounts').set('Cookie', nueva).expect(401);
    await request(app).post('/api/auth/login').set(H).send({ username: 'secretaria', password: 'clave-secretaria-2' }).expect(401);
    // Con su usuario desactivado, el administrador vuelve a ver sus propias cuentas.
    expect(await accounts(jefe)).toEqual([ACC_B]);
    await request(app).put('/api/admin/view').set(H).set('Cookie', jefe).send({ userId: secretariaId }).expect(400);

    await request(app).put(`/api/admin/users/${secretariaId}/active`).set(H).set('Cookie', jefe).send({ active: true }).expect(200);
    await login('secretaria', 'clave-secretaria-2');
  });

  it('valida el nombre de usuario y no repite usuarios', async () => {
    const create = (username: string) => request(app).post('/api/admin/users').set(H).set('Cookie', jefe).send({ username, password: 'una-clave-larga' });
    expect((await create('secretaria').expect(400)).body.error).toMatch(/Ya existe/);
    await create('a b').expect(400);
    await create('jóse').expect(400);
  });
});

describe('importar en las cuentas del usuario equivocado', () => {
  it('avisa al administrador si la cuenta ya está en otra de sus bases, y deja importarla igual', async () => {
    const store = testStore();
    const { app, login, upload, accounts } = client(store);
    const jefeId = createUser(store.auth, 'jefe', 'clave-del-jefe-1', { role: 'admin' });
    const contadoraId = createUser(store.auth, 'contadora', 'clave-contadora-1', { adminId: jefeId });
    createUser(store.auth, 'secretaria', 'clave-secretaria-1', { adminId: jefeId });
    const jefe = await login('jefe', 'clave-del-jefe-1');
    await upload(await login('secretaria', 'clave-secretaria-1'), oneMovement(ACC_A)).expect(200);

    await request(app).put('/api/admin/view').set(H).set('Cookie', jefe).send({ userId: contadoraId }).expect(200);
    const res = await upload(jefe, oneMovement(ACC_A)).expect(409);
    expect(res.body).toMatchObject({ code: 'account-elsewhere' });
    expect(res.body.error).toMatch(/ya está en las cuentas de «secretaria», y estás importando a las de «contadora»/);
    expect(await accounts(jefe)).toEqual([]);

    await upload(jefe, oneMovement(ACC_A)).set('x-import-anyway', '1').expect(200);
    expect(await accounts(jefe)).toEqual([ACC_A]);
    // Ya es de la contadora: las siguientes cartolas de esa cuenta entran sin preguntar.
    await upload(jefe, oneMovement(ACC_A)).expect(200);
  });

  it('a un usuario no le dice qué cuentas tienen los demás', async () => {
    const store = testStore();
    const { login, upload, accounts } = client(store);
    const jefeId = createUser(store.auth, 'jefe', 'clave-del-jefe-1', { role: 'admin' });
    createUser(store.auth, 'secretaria', 'clave-secretaria-1', { adminId: jefeId });
    await upload(await login('jefe', 'clave-del-jefe-1'), oneMovement(ACC_A)).expect(200);
    const secretaria = await login('secretaria', 'clave-secretaria-1');
    await upload(secretaria, oneMovement(ACC_A)).expect(200);
    expect(await accounts(secretaria)).toEqual([ACC_A]);
  });
});

describe('traspaso de cuentas entre usuarios', () => {
  it('pasa todas las cuentas a un usuario sin cuentas, y el administrador queda viéndolas', async () => {
    const store = testStore();
    const { login, upload, accounts } = client(store);
    const jefeId = createUser(store.auth, 'jefe', 'clave-del-jefe-1', { role: 'admin' });
    createUser(store.auth, 'secretaria', 'clave-secretaria-1', { adminId: jefeId });
    const jefe = await login('jefe', 'clave-del-jefe-1');
    await upload(jefe, oneMovement(ACC_A)).expect(200);

    expect(transferData(store, 'jefe', 'secretaria')).toEqual({ accounts: 1 });

    expect(await accounts(await login('secretaria', 'clave-secretaria-1'))).toEqual([ACC_A]);
    expect(await accounts(jefe)).toEqual([ACC_A]); // la está viendo
    const view = store.auth.prepare("SELECT view_user_id FROM users WHERE username = 'jefe'").get() as { view_user_id: number };
    expect(view.view_user_id).not.toBeNull();
  });

  it('no pasa cuentas a quien ya tiene', async () => {
    const store = testStore();
    const { login, upload } = client(store);
    createUser(store.auth, 'uno', 'clave-de-uno-12', { role: 'admin' });
    createUser(store.auth, 'dos', 'clave-de-dos-12', { role: 'admin' });
    await upload(await login('uno', 'clave-de-uno-12'), oneMovement(ACC_A)).expect(200);
    await upload(await login('dos', 'clave-de-dos-12'), oneMovement(ACC_B)).expect(200);
    expect(() => transferData(store, 'uno', 'dos')).toThrow(/ya tiene 1 cuenta/);
    expect(() => transferData(store, 'uno', 'uno')).toThrow(/mismo/);
  });
});

describe('base de antes de las cuentas por usuario', () => {
  it('sus usuarios pasan a administradores y siguen viendo la misma base, sin perder nada', async () => {
    // Base como la de antes: usuarios y sesiones adentro, y report_notes apuntando a users.
    const legacyPath = path.join(os.tmpdir(), `syncbanks-test-${crypto.randomUUID()}`, 'syncbanks.db');
    const old = openDb(legacyPath, KEY);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
      DROP TABLE report_notes;
      CREATE TABLE report_notes (scope TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL, text TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (scope, from_date, to_date));
    `);
    old.prepare('INSERT INTO users (id, username, password_hash) VALUES (7, ?, ?)').run('dueno', hashPassword('clave-del-dueno-1'));
    importCartola(old, parseCartola(oneMovement(ACC_A)), 'cartola.txt', 7);
    old.prepare("INSERT INTO report_notes (scope, from_date, to_date, text, user_id) VALUES ('', '2026-10-01', '2026-10-12', 'Nota de antes', 7)").run();
    old.close();

    const store = openStore(legacyPath, KEY);
    expect(store.auth.prepare('SELECT id, username, role, data_file FROM users').all()).toEqual([{ id: 7, username: 'dueno', role: 'admin', data_file: 'syncbanks.db' }]);

    const { app, login, accounts } = client(store);
    const dueno = await login('dueno', 'clave-del-dueno-1');
    expect(await accounts(dueno)).toEqual([ACC_A]);
    const imports = (await request(app).get('/api/imports').set('Cookie', dueno).expect(200)).body;
    expect(imports[0].username).toBe('dueno');

    const data = store.data('syncbanks.db');
    expect(data.prepare('PRAGMA foreign_key_list(report_notes)').all()).toEqual([]);
    expect(data.prepare('SELECT text, user_id FROM report_notes').all()).toEqual([{ text: 'Nota de antes', user_id: 7 }]);

    // Un usuario nuevo (que no existe en la base vieja) puede comentar el informe en esa base.
    const id = createUser(store.auth, 'secretaria', 'clave-secretaria-1', { adminId: 7 });
    transferData(store, 'dueno', 'secretaria');
    const secretaria = await login('secretaria', 'clave-secretaria-1');
    const saved = await request(app).put('/api/report-note').set(H).set('Cookie', secretaria).send({ from: '2026-10-12', to: '2026-10-12', text: 'Nota nueva' }).expect(200);
    expect(saved.body).toMatchObject({ text: 'Nota nueva', username: 'secretaria' });
    expect(id).toBeGreaterThan(7);

    // Volver a abrir no vuelve a copiar usuarios.
    store.close();
    expect(openStore(legacyPath, KEY).auth.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 2 });
  });
});
