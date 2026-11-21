import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { testStore } from './helpers.js';

const H = { 'x-requested-with': 'syncbanks' };

describe('detrás de un proxy (Caddy en producción)', () => {
  const store = testStore();
  createUser(store.auth, 'jefe', 'clave-del-jefe-1', { role: 'admin' });
  // Supertest se conecta desde 127.0.0.1, como el proxy en la misma máquina.
  const app = createApp(store, { production: false, sessionDays: 1, trustProxy: 'loopback' });
  const fail = (ip: string) => request(app).post('/api/auth/login').set(H).set('X-Forwarded-For', ip).send({ username: 'jefe', password: 'no-es-la-clave' });

  it('cuenta los intentos fallidos por la IP real de cada persona, no por la del proxy', async () => {
    for (let i = 0; i < 10; i++) await fail('203.0.113.7').expect(401);
    expect((await fail('203.0.113.7').expect(429)).body.error).toMatch(/Espera 15 minutos/);
    // Otra persona detrás del mismo proxy puede seguir entrando.
    await fail('198.51.100.9').expect(401);
    await request(app).post('/api/auth/login').set(H).set('X-Forwarded-For', '198.51.100.9').send({ username: 'jefe', password: 'clave-del-jefe-1' }).expect(200);
  });
});
