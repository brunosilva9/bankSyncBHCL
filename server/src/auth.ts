import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { DB } from './db.js';
import { newDataFile, type Store } from './store.js';

/** usuario: usa la app con sus cuentas. admin: además crea y gestiona a sus usuarios y puede ver sus cuentas. */
export type Role = 'admin' | 'usuario';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = 'sb_session';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(expected, actual);
}

const USERNAME = /^[a-z0-9._-]{3,40}$/;

/** Crea un usuario con su propia base de datos (vacía hasta que importe cartolas). Devuelve su id. */
export function createUser(db: DB, username: string, password: string, { role = 'usuario', adminId = null }: { role?: Role; adminId?: number | null } = {}): number {
  const name = username.trim().toLowerCase();
  if (!USERNAME.test(name)) throw new Error('El usuario debe tener entre 3 y 40 caracteres: letras sin tilde, números, punto, guion o guion bajo');
  if (password.length < 10) throw new Error('La contraseña debe tener al menos 10 caracteres');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) throw new Error(`Ya existe el usuario "${name}"`);
  const r = db
    .prepare('INSERT INTO users (username, password_hash, role, admin_id, data_file) VALUES (?, ?, ?, ?, ?)')
    .run(name, hashPassword(password), role, adminId, newDataFile());
  return Number(r.lastInsertRowid);
}

/**
 * Pone una contraseña nueva a un usuario existente (la anterior no se puede recuperar: solo se guarda
 * su hash). Cierra sus sesiones abiertas, para que quien tuviera la clave vieja quede fuera.
 */
export function setPassword(db: DB, username: string, password: string) {
  if (password.length < 10) throw new Error('La contraseña debe tener al menos 10 caracteres');
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim().toLowerCase()) as { id: number } | undefined;
  if (!user) throw new Error(`No existe el usuario "${username}"`);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  })();
}

export const listUsers = (db: DB) => db.prepare('SELECT username, role FROM users ORDER BY username').all() as Array<{ username: string; role: Role }>;

/** Datos de un usuario por nombre, para las herramientas de consola. */
export function findUser(db: DB, username: string) {
  const user = db.prepare('SELECT id, username, role, data_file FROM users WHERE username = ?').get(username.trim().toLowerCase()) as
    | { id: number; username: string; role: Role; data_file: string }
    | undefined;
  if (!user) throw new Error(`No existe el usuario "${username}"`);
  return user;
}

/**
 * Le pasa a "to" todas las cuentas de "from" (con movimientos, categorías, reglas, comentarios...), y
 * "from" queda con la base vacía de "to". Solo hacia un usuario sin cuentas, para no esconder datos de
 * nadie. Si "from" administra a "to", queda viendo sus cuentas, así que para él no cambia nada.
 */
export function transferData(store: Store, fromUsername: string, toUsername: string): { accounts: number } {
  const from = findUser(store.auth, fromUsername);
  const to = findUser(store.auth, toUsername);
  if (from.id === to.id) throw new Error('El usuario de origen y el de destino son el mismo');
  const count = (dataFile: string) => (store.data(dataFile).prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
  const existing = count(to.data_file);
  if (existing > 0) throw new Error(`"${to.username}" ya tiene ${existing} cuenta(s): el traspaso es solo hacia un usuario sin cuentas`);
  const managed = (store.auth.prepare('SELECT admin_id FROM users WHERE id = ?').get(to.id) as { admin_id: number | null }).admin_id === from.id;
  store.auth.transaction(() => {
    const setFile = store.auth.prepare('UPDATE users SET data_file = ? WHERE id = ?');
    setFile.run(to.data_file, from.id);
    setFile.run(from.data_file, to.id);
    if (managed) store.auth.prepare('UPDATE users SET view_user_id = ? WHERE id = ?').run(to.id, from.id);
  })();
  return { accounts: count(from.data_file) };
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(db: DB, userId: number, days: number): { token: string; expires: Date } {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + days * 86_400_000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires.toISOString());
  return { token, expires };
}

export function destroySession(db: DB, token: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export interface DataOwner {
  id: number;
  username: string;
  dataFile: string;
}

export interface AuthedRequest extends Request {
  user?: { id: number; username: string; role: Role };
  /** De quién son las cuentas que se ven: el propio usuario o, para un administrador, el usuario que eligió ver. */
  owner?: DataOwner;
}

export function requireAuth(db: DB) {
  // La vista elegida se vuelve a validar en cada pedido: si el usuario se desactiva o deja de ser
  // de este administrador, el administrador vuelve a ver sus propias cuentas.
  const find = db.prepare(
    `SELECT u.id, u.username, u.role, u.data_file, v.id AS view_id, v.username AS view_username, v.data_file AS view_data_file
     FROM sessions s JOIN users u ON u.id = s.user_id
     LEFT JOIN users v ON v.id = u.view_user_id AND v.admin_id = u.id AND v.active = 1 AND u.role = 'admin'
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
  );
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE);
    const row = token
      ? (find.get(sha256(token), new Date().toISOString()) as
          | { id: number; username: string; role: Role; data_file: string; view_id: number | null; view_username: string; view_data_file: string }
          | undefined)
      : undefined;
    if (!row) return res.status(401).json({ error: 'No autenticado' });
    req.user = { id: row.id, username: row.username, role: row.role };
    req.owner =
      row.view_id !== null
        ? { id: row.view_id, username: row.view_username, dataFile: row.view_data_file }
        : { id: row.id, username: row.username, dataFile: row.data_file };
    next();
  };
}

/** Limita intentos de login fallidos por IP (en memoria; suficiente para un solo servidor). */
export function loginLimiter(maxFailures = 10, windowMs = 15 * 60_000) {
  const failures = new Map<string, { count: number; since: number }>();
  return {
    blocked(ip: string) {
      const f = failures.get(ip);
      if (!f) return false;
      if (Date.now() - f.since > windowMs) {
        failures.delete(ip);
        return false;
      }
      return f.count >= maxFailures;
    },
    fail(ip: string) {
      const f = failures.get(ip);
      if (!f || Date.now() - f.since > windowMs) failures.set(ip, { count: 1, since: Date.now() });
      else f.count++;
    },
    reset(ip: string) {
      failures.delete(ip);
    },
  };
}
