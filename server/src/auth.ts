import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { DB } from './db.js';

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

export function createUser(db: DB, username: string, password: string) {
  if (password.length < 10) throw new Error('La contraseña debe tener al menos 10 caracteres');
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username.trim().toLowerCase(), hashPassword(password));
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

export interface AuthedRequest extends Request {
  user?: { id: number; username: string };
}

export function requireAuth(db: DB) {
  const find = db.prepare(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  );
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE);
    const user = token ? (find.get(sha256(token), new Date().toISOString()) as AuthedRequest['user']) : undefined;
    if (!user) return res.status(401).json({ error: 'No autenticado' });
    req.user = user;
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
