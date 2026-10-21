import { describe, expect, it } from 'vitest';
import { createSession, createUser, listUsers, setPassword, verifyPassword } from '../src/auth.js';
import { testDb } from './helpers.js';

const hashOf = (db: ReturnType<typeof testDb>, username: string) =>
  (db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username) as { password_hash: string }).password_hash;

describe('cambio de contraseña', () => {
  it('pone una contraseña nueva, invalida la anterior y cierra las sesiones abiertas', () => {
    const db = testDb();
    createUser(db, 'Secretaria', 'clave-vieja-123');
    const userId = (db.prepare("SELECT id FROM users WHERE username = 'secretaria'").get() as { id: number }).id;
    createSession(db, userId, 1);

    setPassword(db, 'secretaria', 'clave-nueva-456');

    expect(verifyPassword('clave-nueva-456', hashOf(db, 'secretaria'))).toBe(true);
    expect(verifyPassword('clave-vieja-123', hashOf(db, 'secretaria'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId)).toEqual({ n: 0 });
  });

  it('rechaza usuarios inexistentes y contraseñas cortas', () => {
    const db = testDb();
    createUser(db, 'admin', 'una-clave-larga');
    expect(() => setPassword(db, 'nadie', 'una-clave-larga')).toThrow(/No existe/);
    expect(() => setPassword(db, 'admin', 'corta')).toThrow(/10 caracteres/);
  });

  it('lista los usuarios', () => {
    const db = testDb();
    createUser(db, 'zeta', 'una-clave-larga');
    createUser(db, 'alfa', 'una-clave-larga');
    expect(listUsers(db)).toEqual(['alfa', 'zeta']);
  });
});
