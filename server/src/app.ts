import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import {
  createSession,
  createUser,
  destroySession,
  loginLimiter,
  readCookie,
  requireAuth,
  SESSION_COOKIE,
  setPassword,
  verifyPassword,
  type AuthedRequest,
} from './auth.js';
import type { DB } from './db.js';
import type { Store } from './store.js';
import { recategorize } from './domain/categorize.js';
import { importCard } from './domain/creditCard.js';
import { calibrateFromAvailable, calibrateFromLineCartola, isCreditLineCartola, recomputeCreditLine } from './domain/creditLine.js';
import { checkBalances, importCartola, recomputePayrollBatches } from './domain/importer.js';
import { buildReport, dayColumn, type DateMode } from './domain/report.js';
import { closingStatuses, getClosing, lastClosableDay, verifyClosings } from './domain/closing.js';
import { buildDays, dailyBalances, dayDetail } from './domain/daily.js';
import { CartolaParseError, displayAccountNumber } from './parser/cartola.js';
import { isCard, parseStatementFile } from './parser/index.js';
import { daysBetween } from './time.js';

export interface AppOptions {
  production: boolean;
  sessionDays: number;
  webDist?: string;
  /** Valor de "trust proxy" de Express (ver config.trustProxy). */
  trustProxy?: string;
  /** Hora del cierre diario (config.closingHour); null si el servidor no cierra solo. */
  closingHour?: number | null;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const bad = (msg: string) => new HttpError(400, msg);

function str(v: unknown, field: string, { optional = false, max = 200 } = {}): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw bad(`Falta ${field}`);
  }
  if (typeof v !== 'string' || v.length > max) throw bad(`${field} inválido`);
  return v.trim();
}

function intOrNull(v: unknown, field: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw bad(`${field} inválido`);
  return v;
}

/** Ids de cuenta desde "1,2" (query) o [1, 2] (body). */
function parseAccountIds(v: unknown): number[] {
  const parts = Array.isArray(v) ? v : String(v ?? '').split(',');
  return parts.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

const noteScope = (accountIds: number[]) => [...new Set(accountIds)].sort((a, b) => a - b).join(',');

/** ?fecha=banco: por fecha del banco; si no, por fecha real (ver domain/seen.ts y report.ts). */
const datesOf = (v: unknown): DateMode => (v === 'banco' ? 'banco' : 'real');

/** Largo máximo del comentario: unas 4 líneas, para que el resumen siga cabiendo en una página. */
const NOTE_MAX = 500;

/** El diario arma un informe por día: un trimestre a la vez es de sobra. */
const MAX_DAILY_DAYS = 93;

/** La línea de tiempo del informe es un punto por día: tres años ya son más de mil. */
const MAX_BALANCE_DAYS = 1100;

/** Header con el id del dueño de las cuentas que la página tiene cargadas (ver la ruta de datos). */
export const OWNER_HEADER = 'x-syncbanks-owner';

export function createApp(store: Store, opts: AppOptions) {
  const db = store.auth;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy ?? 'loopback');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  // Protección CSRF: además de la cookie SameSite=Strict, toda escritura debe venir con este header,
  // que un formulario de otro sitio no puede enviar.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('x-requested-with') !== 'syncbanks') return res.status(403).json({ error: 'Solicitud rechazada' });
    next();
  });

  // ---------- Autenticación ----------
  const limiter = loginLimiter();
  const findUser = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ? AND active = 1');

  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (limiter.blocked(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const user = findUser.get(username) as { id: number; username: string; password_hash: string } | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      limiter.fail(ip);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    limiter.reset(ip);
    const { token, expires } = createSession(db, user.id, opts.sessionDays);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: opts.production, expires, path: '/' });
    res.json({ username: user.username });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) destroySession(db, token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use(requireAuth(db));
  app.use('/api', api);

  api.get('/auth/me', (req: AuthedRequest, res) => {
    const { user, owner } = req as Required<AuthedRequest>;
    res.json({ id: user.id, username: user.username, role: user.role, owner: { id: owner.id, username: owner.username } });
  });

  api.use('/admin', adminRoutes(store));

  // ---------- Datos del usuario que se está viendo ----------
  // Cada usuario tiene su base; las rutas de datos se arman una vez por base.
  const nameById = db.prepare('SELECT username FROM users WHERE id = ?');
  const usernameOf = (id: number | null) => (id === null ? null : ((nameById.get(id) as { username: string } | undefined)?.username ?? null));
  // Solo para un administrador: sus bases y las de sus usuarios. A un usuario no se le dice qué
  // cuentas tienen los demás.
  const basesOf = db.prepare('SELECT username, data_file FROM users WHERE id = ? OR admin_id = ? ORDER BY id');
  const accountElsewhere = (req: AuthedRequest, number: string) => {
    if (req.user!.role !== 'admin') return null;
    const bases = basesOf.all(req.user!.id, req.user!.id) as Array<{ username: string; data_file: string }>;
    const found = bases.find((b) => b.data_file !== req.owner!.dataFile && store.data(b.data_file).prepare('SELECT 1 FROM accounts WHERE number = ?').get(number));
    return found?.username ?? null;
  };
  const ctx: DataContext = { usernameOf, accountElsewhere, closingHour: opts.closingHour ?? null };
  const routers = new WeakMap<DB, express.Router>();

  api.use((req: AuthedRequest, res, next) => {
    // Un administrador que cambió de vista en otra pestaña: los ids que tiene cargados esta página son
    // de otra base, y una edición caería en el movimiento equivocado.
    const loaded = req.get(OWNER_HEADER);
    if (loaded && Number(loaded) !== req.owner!.id) {
      return res.status(409).json({ error: 'Cambiaste las cuentas que estás viendo en otra pestaña. Recarga la página.', code: 'owner-changed' });
    }
    const data = store.data(req.owner!.dataFile);
    let router = routers.get(data);
    if (!router) routers.set(data, (router = dataRoutes(data, ctx)));
    router(req, res, next);
  });

  // ---------- Frontend compilado (producción) ----------
  if (opts.webDist && fs.existsSync(opts.webDist)) {
    app.use(express.static(opts.webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(opts.webDist!, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  });

  return app;
}

/** Lo que solo hace un administrador, y solo sobre los usuarios que él creó. */
function adminRoutes(store: Store) {
  const db = store.auth;
  const admin = express.Router();
  admin.use((req: AuthedRequest, res, next) => (req.user!.role === 'admin' ? next() : res.status(403).json({ error: 'Solo para administradores' })));

  const findOwn = db.prepare('SELECT id, username, active FROM users WHERE id = ? AND admin_id = ?');
  const ownUser = (id: unknown, adminId: number) => {
    const u = findOwn.get(Number(id), adminId) as { id: number; username: string; active: number } | undefined;
    if (!u) throw new HttpError(404, 'Usuario no encontrado');
    return u;
  };

  admin.get('/users', (req: AuthedRequest, res) => {
    const users = db
      .prepare('SELECT id, username, active, created_at, data_file FROM users WHERE admin_id = ? ORDER BY username')
      .all(req.user!.id) as Array<{ id: number; username: string; active: number; created_at: string; data_file: string }>;
    res.json(
      users.map(({ data_file, ...u }) => ({
        ...u,
        active: u.active === 1,
        ...(store
          .data(data_file)
          .prepare('SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT MAX(imported_at) FROM imports) AS last_import')
          .get() as { accounts: number; last_import: string | null }),
      })),
    );
  });

  admin.post('/users', (req: AuthedRequest, res) => {
    const username = str(req.body?.username, 'usuario', { max: 40 })!;
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    try {
      res.status(201).json({ id: createUser(db, username, password, { role: 'usuario', adminId: req.user!.id }) });
    } catch (e) {
      throw bad((e as Error).message);
    }
  });

  admin.put('/users/:id/password', (req: AuthedRequest, res) => {
    const u = ownUser(req.params.id, req.user!.id);
    try {
      setPassword(db, u.username, typeof req.body?.password === 'string' ? req.body.password : '');
    } catch (e) {
      throw bad((e as Error).message);
    }
    res.json({ ok: true });
  });

  // Desactivar no borra nada: el usuario no puede entrar y sus sesiones se cierran.
  admin.put('/users/:id/active', (req: AuthedRequest, res) => {
    const u = ownUser(req.params.id, req.user!.id);
    if (typeof req.body?.active !== 'boolean') throw bad('active inválido');
    db.transaction(() => {
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, u.id);
      if (!req.body.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    })();
    res.json({ ok: true });
  });

  // Ver (y trabajar en) las cuentas de uno de sus usuarios, tal como las ve él; userId null vuelve a las propias.
  admin.put('/view', (req: AuthedRequest, res) => {
    const userId = req.body?.userId === null ? null : intOrNull(req.body?.userId, 'usuario');
    if (userId !== null && !ownUser(userId, req.user!.id).active) throw bad('Ese usuario está desactivado');
    db.prepare('UPDATE users SET view_user_id = ? WHERE id = ?').run(userId, req.user!.id);
    res.json({ ok: true });
  });

  return admin;
}

/** Lo que las rutas de datos necesitan saber de fuera de la base del usuario. */
interface DataContext {
  usernameOf: (id: number | null) => string | null;
  /** Administrador: usuario (o él mismo) que ya tiene esta cuenta en otra base; null si nadie. */
  accountElsewhere: (req: AuthedRequest, number: string) => string | null;
  closingHour: number | null;
}

/** Header para importar igual una cuenta que el administrador ya tiene en las cuentas de otro usuario. */
export const IMPORT_ANYWAY_HEADER = 'x-import-anyway';

/**
 * Header con la última modificación del archivo según el navegador (File.lastModified, ms): en un archivo recién
 * bajado es la hora de la descarga, que la cartola de Banco de Chile no trae.
 */
export const FILE_MODIFIED_HEADER = 'x-file-modified';
const fileModifiedOf = (v: string | undefined) => {
  const ms = Number(v);
  return Number.isSafeInteger(ms) && ms > Date.UTC(2000, 0, 1) ? ms : null;
};

/** Rutas con los datos de un usuario: db es su base. */
function dataRoutes(db: DB, { usernameOf, accountElsewhere, closingHour }: DataContext) {
  const api = express.Router();

  // ---------- Cuentas ----------
  api.get('/accounts', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT a.id, a.number, a.bank, a.name, a.kind, a.rut, a.aliases, a.credit_limit,
                COUNT(m.id) AS movement_count, MIN(m.date) AS coverage_from, MAX(m.date) AS coverage_to,
                (SELECT balance_after FROM movements WHERE account_id = a.id ORDER BY date DESC, seq ASC LIMIT 1) AS balance,
                (SELECT credit_used_after FROM movements WHERE account_id = a.id ORDER BY date DESC, seq ASC LIMIT 1) AS credit_used
         FROM accounts a LEFT JOIN movements m ON m.account_id = a.id
         GROUP BY a.id ORDER BY a.name`,
      )
      .all() as Array<{ number: string; bank: string }>;
    res.json(rows.map((r) => ({ ...r, number_formatted: displayAccountNumber(r.bank, r.number) })));
  });

  api.patch('/accounts/:id', (req, res) => {
    const id = Number(req.params.id);
    const name = str(req.body.name, 'nombre');
    const rut = str(req.body.rut, 'RUT', { optional: true, max: 20 }) ?? null;
    const aliases = str(req.body.aliases, 'alias', { optional: true, max: 2000 }) ?? '';
    const creditLimit = req.body.creditLimit === undefined ? undefined : intOrNull(req.body.creditLimit, 'cupo');
    db.transaction(() => {
      const r = db.prepare('UPDATE accounts SET name = ?, rut = ?, aliases = ? WHERE id = ?').run(name, rut, aliases, id);
      if (!r.changes) throw new HttpError(404, 'Cuenta no encontrada');
      if (creditLimit !== undefined) {
        db.prepare('UPDATE accounts SET credit_limit = ? WHERE id = ?').run(creditLimit, id);
        if (creditLimit === null) db.prepare('UPDATE accounts SET credit_used_anchor = NULL, credit_anchor_movement_id = NULL WHERE id = ?').run(id);
      }
      if (req.body.creditAvailableNow !== undefined && req.body.creditAvailableNow !== null) {
        const available = intOrNull(req.body.creditAvailableNow, 'disponible de la línea')!;
        try {
          calibrateFromAvailable(db, id, available);
        } catch (e) {
          throw bad((e as Error).message);
        }
      }
      recomputeCreditLine(db, id);
    })();
    recategorize(db);
    res.json({ ok: true });
  });

  // Borra la cuenta con sus movimientos e importaciones (p. ej. cartolas importadas al usuario equivocado).
  // Categorías, reglas y nombres de trabajadores son del usuario, no de la cuenta, y se quedan.
  api.delete('/accounts/:id', (req, res) => {
    const id = Number(req.params.id);
    const movements = db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) throw new HttpError(404, 'Cuenta no encontrada');
      const n = db.prepare('DELETE FROM movements WHERE account_id = ?').run(id).changes;
      db.prepare('DELETE FROM imports WHERE account_id = ?').run(id);
      // Comentarios del informe filtrado por esta cuenta: SQLite puede reusar su id en una cuenta nueva.
      db.prepare("DELETE FROM report_notes WHERE ',' || scope || ',' LIKE ?").run(`%,${id},%`);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      return n;
    })();
    // Los traspasos internos con esta cuenta dejan de tener pareja.
    recategorize(db);
    res.json({ ok: true, movements });
  });

  // ---------- Categorías ----------
  api.get('/categories', (_req, res) => {
    res.json(db.prepare('SELECT * FROM categories ORDER BY sort, name').all());
  });

  api.post('/categories', (req, res) => {
    const name = str(req.body.name, 'nombre', { max: 60 });
    const color = str(req.body.color, 'color', { optional: true, max: 20 }) ?? '#64748b';
    const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories').get() as { s: number }).s;
    try {
      const id = db.prepare('INSERT INTO categories (name, color, sort) VALUES (?, ?, ?)').run(name, color, sort).lastInsertRowid;
      res.status(201).json({ id: Number(id) });
    } catch {
      throw bad('Ya existe una categoría con ese nombre');
    }
  });

  api.patch('/categories/:id', (req, res) => {
    const name = str(req.body.name, 'nombre', { max: 60 });
    const color = str(req.body.color, 'color', { max: 20 });
    db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(name, color, Number(req.params.id));
    res.json({ ok: true });
  });

  api.delete('/categories/:id', (req, res) => {
    const cat = db.prepare('SELECT system_key FROM categories WHERE id = ?').get(Number(req.params.id)) as { system_key: string | null } | undefined;
    if (!cat) throw new HttpError(404, 'Categoría no encontrada');
    if (cat.system_key) throw bad('Esta categoría la usa el sistema y no se puede borrar');
    db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
    db.prepare("UPDATE movements SET category_source = NULL WHERE category_id IS NULL AND category_source = 'manual'").run();
    recategorize(db);
    res.json({ ok: true });
  });

  // ---------- Movimientos ----------
  api.get('/movements', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (clause: string, ...values: unknown[]) => {
      where.push(clause);
      args.push(...values);
    };
    const DAY = dayColumn(datesOf(q.fecha), 'm');
    if (q.from && DATE.test(q.from)) add(`${DAY} >= ?`, q.from);
    if (q.to && DATE.test(q.to)) add(`${DAY} <= ?`, q.to);
    if (q.accountId) add('m.account_id = ?', Number(q.accountId));
    if (q.direction === 'C' || q.direction === 'A') add('m.direction = ?', q.direction);
    if (q.kind) add('m.kind = ?', q.kind);
    if (q.batch) add('m.payroll_batch = ?', Number(q.batch));
    if (q.categoryId === 'none') add('m.category_id IS NULL');
    else if (q.categoryId) add('m.category_id = ?', Number(q.categoryId));
    if (q.label) add('m.label = ? COLLATE NOCASE', q.label);
    if (q.categoryKey) add('c.system_key = ?', q.categoryKey);
    // Los que el banco fechó después de su fecha real (de noche, en fin de semana o feriado; ver domain/seen.ts).
    if (q.postdated === '1') add('m.real_date < m.date');
    // Traspasos internos y, en cuentas con línea calibrada, los giros y amortizaciones de la línea.
    if (q.excludeInternal === '1') {
      add("(c.system_key IS NULL OR c.system_key != 'internal')");
      add("NOT (m.kind = 'credit_line' AND a.credit_limit IS NOT NULL AND a.credit_used_anchor IS NOT NULL)");
    }
    if (q.q) {
      const like = `%${q.q}%`;
      add('(m.description LIKE ? OR m.label LIKE ? OR m.note LIKE ? OR p.name LIKE ? OR m.counterparty LIKE ?)', like, like, like, like, like);
    }
    const limit = Math.min(Number(q.limit ?? 2000), 5000);
    const sql = `
      SELECT m.id, m.account_id, a.name AS account_name, m.date, m.seq, m.amount, m.direction, m.description, m.doc_number,
             m.kind, m.counterparty, p.name AS payee_name, m.category_id, m.category_source, m.label, m.label_source,
             m.note, m.balance_after, m.provisional, m.payroll_batch, m.payroll_split_after, m.installments, m.installment_amount,
             m.first_seen_day, m.first_seen_at, m.real_date, m.real_date_source, c.system_key
      FROM movements m
      JOIN accounts a ON a.id = m.account_id
      LEFT JOIN categories c ON c.id = m.category_id
      LEFT JOIN payees p ON p.rut = m.counterparty AND m.kind = 'payroll'
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${DAY} DESC, a.name, m.date DESC, m.seq ASC
      LIMIT ?`;
    res.json(db.prepare(sql).all(...args, limit));
  });

  function applyEdit(id: number, body: Record<string, unknown>) {
    if ('categoryId' in body) {
      if (body.categoryId === 'auto') {
        db.prepare('UPDATE movements SET category_source = NULL WHERE id = ?').run(id);
      } else {
        db.prepare("UPDATE movements SET category_id = ?, category_source = 'manual' WHERE id = ?").run(intOrNull(body.categoryId, 'categoría'), id);
      }
    }
    if ('label' in body) {
      const label = str(body.label, 'comentario', { optional: true, max: 80 }) ?? null;
      db.prepare('UPDATE movements SET label = ?, label_source = ? WHERE id = ?').run(label, label ? 'manual' : null, id);
    }
    if ('note' in body) {
      const note = str(body.note, 'nota', { optional: true, max: 500 }) ?? null;
      db.prepare('UPDATE movements SET note = ? WHERE id = ?').run(note, id);
    }
  }

  api.patch('/movements/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM movements WHERE id = ?').get(id)) throw new HttpError(404, 'Movimiento no encontrado');
    db.transaction(() => applyEdit(id, req.body))();
    // Volver a "automático" o borrar un comentario manual deja que las reglas vuelvan a actuar.
    recategorize(db);
    res.json({ ok: true });
  });

  // Separar nóminas: la cartola no dice dónde termina una nómina y empieza otra si se cargaron seguidas.
  // El usuario marca el último pago de una nómina y los de abajo pasan a la siguiente.
  api.post('/movements/:id/payroll-split', (req, res) => {
    const id = Number(req.params.id);
    if (typeof req.body.split !== 'boolean') throw bad('split inválido');
    const m = db.prepare('SELECT account_id, kind FROM movements WHERE id = ?').get(id) as { account_id: number; kind: string } | undefined;
    if (!m) throw new HttpError(404, 'Movimiento no encontrado');
    if (m.kind !== 'payroll') throw bad('Solo se pueden separar pagos de nómina (Pago Fácil)');
    db.transaction(() => {
      db.prepare('UPDATE movements SET payroll_split_after = ? WHERE id = ?').run(req.body.split ? 1 : 0, id);
      recomputePayrollBatches(db, m.account_id);
    })();
    res.json({ ok: true });
  });

  api.post('/movements/bulk', (req, res) => {
    const ids = req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 5000 || !ids.every(Number.isInteger)) throw bad('ids inválidos');
    const { ids: _ids, ...edit } = req.body;
    db.transaction(() => ids.forEach((id: number) => applyEdit(id, edit)))();
    recategorize(db);
    res.json({ ok: true, updated: ids.length });
  });

  api.get('/labels', (_req, res) => {
    const rows = db.prepare('SELECT label, COUNT(*) AS n FROM movements WHERE label IS NOT NULL GROUP BY label COLLATE NOCASE ORDER BY n DESC').all();
    res.json(rows);
  });

  // ---------- Reglas ----------
  api.get('/rules', (_req, res) => {
    res.json(db.prepare('SELECT r.*, c.name AS category_name FROM rules r LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.id DESC').all());
  });

  api.post('/rules', (req, res) => {
    const matchType = req.body.matchType;
    if (matchType !== 'counterparty' && matchType !== 'contains') throw bad('Tipo de regla inválido');
    const pattern = str(req.body.pattern, 'texto', { max: 100 })!;
    const direction = req.body.direction === 'C' || req.body.direction === 'A' ? req.body.direction : null;
    const categoryId = req.body.categoryId === undefined ? null : intOrNull(req.body.categoryId, 'categoría');
    const label = str(req.body.label, 'comentario', { optional: true, max: 80 }) ?? null;
    if (categoryId === null && label === null) throw bad('La regla debe asignar una categoría o un comentario');

    db.transaction(() => {
      db.prepare('INSERT INTO rules (match_type, pattern, direction, category_id, label) VALUES (?, ?, ?, ?, ?)').run(
        matchType,
        pattern,
        direction,
        categoryId,
        label,
      );
      // Si se pide, la regla también reemplaza ediciones manuales previas de los movimientos que calzan.
      if (req.body.overrideManual === true && Array.isArray(req.body.movementIds)) {
        const reset = db.prepare('UPDATE movements SET category_source = CASE WHEN ? THEN NULL ELSE category_source END, label_source = CASE WHEN ? THEN NULL ELSE label_source END WHERE id = ?');
        for (const id of req.body.movementIds) if (Number.isInteger(id)) reset.run(categoryId !== null ? 1 : 0, label !== null ? 1 : 0, id);
      }
    })();
    recategorize(db);
    res.status(201).json({ ok: true });
  });

  api.delete('/rules/:id', (req, res) => {
    db.prepare('DELETE FROM rules WHERE id = ?').run(Number(req.params.id));
    recategorize(db);
    res.json({ ok: true });
  });

  // ---------- Nombres de trabajadores (Pago Fácil) ----------
  api.get('/payees', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT m.counterparty AS rut, p.name, COUNT(*) AS count, SUM(m.amount) AS total, MAX(m.date) AS last_date
         FROM movements m LEFT JOIN payees p ON p.rut = m.counterparty
         WHERE m.kind = 'payroll' AND m.counterparty IS NOT NULL
         GROUP BY m.counterparty ORDER BY last_date DESC, total DESC`,
      )
      .all();
    res.json(rows);
  });

  api.put('/payees/:rut', (req, res) => {
    const rut = String(req.params.rut);
    const name = str(req.body.name, 'nombre', { optional: true, max: 100 });
    if (name) db.prepare('INSERT INTO payees (rut, name) VALUES (?, ?) ON CONFLICT(rut) DO UPDATE SET name = excluded.name').run(rut, name);
    else db.prepare('DELETE FROM payees WHERE rut = ?').run(rut);
    res.json({ ok: true });
  });

  // ---------- Importación ----------
  api.post('/imports', express.raw({ type: 'application/octet-stream', limit: '5mb' }), async (req: AuthedRequest, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw bad('Archivo vacío');
    const filename = decodeURIComponent(req.get('x-filename') ?? 'cartola.txt').slice(0, 200);
    let parsed;
    try {
      parsed = await parseStatementFile(req.body);
    } catch (e) {
      if (e instanceof CartolaParseError) throw bad(`${filename}: ${e.message}`);
      throw e;
    }
    // Tarjetas: sin número de cuenta real que comparar con otros usuarios ("CMR" lo tiene cualquiera).
    if (isCard(parsed)) {
      try {
        return res.json(importCard(db, parsed, filename, req.user!.id));
      } catch (e) {
        throw bad(`${filename}: ${(e as Error).message}`);
      }
    }
    if (isCreditLineCartola(parsed)) {
      try {
        return res.json(calibrateFromLineCartola(db, parsed, filename, req.user!.id));
      } catch (e) {
        throw bad(`${filename}: ${(e as Error).message}`);
      }
    }
    // Un administrador que ve las cuentas de varios usuarios puede importar en las del usuario equivocado.
    // Si la cuenta es nueva aquí pero ya está en otra de sus bases, se pregunta antes de crearla.
    const isNew = !db.prepare('SELECT 1 FROM accounts WHERE number = ?').get(parsed.accountNumber);
    const other = isNew && req.get(IMPORT_ANYWAY_HEADER) !== '1' ? accountElsewhere(req, parsed.accountNumber) : null;
    if (other) {
      const here = req.owner!.id === req.user!.id ? 'las tuyas' : `las de «${req.owner!.username}»`;
      const there = other === req.user!.username ? 'tus cuentas' : `las cuentas de «${other}»`;
      return res.status(409).json({
        code: 'account-elsewhere',
        error: `${filename}: la cuenta ${displayAccountNumber(parsed.bank, parsed.accountNumber)} de ${parsed.bank} ya está en ${there}, y estás importando a ${here}.`,
      });
    }
    res.json(importCartola(db, parsed, filename, req.user!.id, { fileModified: fileModifiedOf(req.get(FILE_MODIFIED_HEADER)) }));
  });

  api.get('/imports', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT i.id, i.kind, i.statement_kind, i.statement_number, i.filename, i.imported_at, i.balance_date, i.balance, i.from_date, i.to_date, i.movements_in_file, i.inserted,
                a.name AS account_name, i.user_id
         FROM imports i JOIN accounts a ON a.id = i.account_id
         ORDER BY i.id DESC LIMIT 100`,
      )
      .all() as Array<{ user_id: number | null }>;
    res.json(rows.map(({ user_id, ...r }) => ({ ...r, username: usernameOf(user_id) })));
  });

  // ---------- Informe ----------
  api.get('/report', (req, res) => {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw bad('Rango de fechas inválido');
    const accountIds = parseAccountIds(req.query.accounts);
    const report = buildReport(db, { from, to, accountIds, dates: datesOf(req.query.fecha) });
    res.json({ ...report, note: getNote(noteScope(accountIds), report.period.from, report.period.to) });
  });

  // Línea de tiempo del informe: el saldo de cada cuenta al final de cada día.
  api.get('/balances', (req, res) => {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw bad('Rango de fechas inválido');
    if (daysBetween(from, to).length > MAX_BALANCE_DAYS) throw bad(`La línea de tiempo muestra hasta ${MAX_BALANCE_DAYS} días`);
    res.json(dailyBalances(db, { from, to, accountIds: parseAccountIds(req.query.accounts), dates: datesOf(req.query.fecha) }));
  });

  // Comentario del informe: se guarda para el período real que muestra el informe (report.period).
  api.put('/report-note', (req: AuthedRequest, res) => {
    const from = String(req.body.from ?? '');
    const to = String(req.body.to ?? '');
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw bad('Rango de fechas inválido');
    const scope = noteScope(parseAccountIds(req.body.accounts));
    const text = str(req.body.text, 'comentario', { optional: true, max: NOTE_MAX });
    if (text) {
      db.prepare(
        `INSERT INTO report_notes (scope, from_date, to_date, text, user_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope, from_date, to_date) DO UPDATE SET text = excluded.text, user_id = excluded.user_id, updated_at = datetime('now')`,
      ).run(scope, from, to, text, req.user!.id);
    } else {
      db.prepare('DELETE FROM report_notes WHERE scope = ? AND from_date = ? AND to_date = ?').run(scope, from, to);
    }
    res.json(getNote(scope, from, to));
  });

  const getNote = (scope: string, from: string, to: string) => {
    const note = db
      .prepare('SELECT text, updated_at, user_id FROM report_notes WHERE scope = ? AND from_date = ? AND to_date = ?')
      .get(scope, from, to) as { text: string; updated_at: string; user_id: number | null } | undefined;
    return note ? { text: note.text, updated_at: note.updated_at, username: usernameOf(note.user_id) } : null;
  };

  // ---------- Diario: saldos, movimientos y cartolas día por día, con el cierre de cada día ----------
  api.get('/daily', (req, res) => {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw bad('Rango de fechas inválido');
    if (daysBetween(from, to).length > MAX_DAILY_DAYS) throw bad(`El diario muestra hasta ${MAX_DAILY_DAYS} días`);
    const accountIds = parseAccountIds(req.query.accounts);
    const dates = datesOf(req.query.fecha);
    const closings = closingStatuses(db, from, to, accountIds, dates);
    res.json({
      closingHour,
      // Desde qué día un día sin cierre está atrasado (antes de eso, es que aún no es la hora).
      lastClosable: closingHour === null ? null : lastClosableDay(Date.now(), closingHour),
      days: buildDays(db, { from, to, accountIds, dates }).map((d) => ({ ...d, closing: closings.get(d.day) ?? null })),
    });
  });

  api.get('/daily/:day', (req, res) => {
    const day = String(req.params.day);
    if (!DATE.test(day)) throw bad('Fecha inválida');
    const accountIds = parseAccountIds(req.query.accounts);
    const dates = datesOf(req.query.fecha);
    res.json({ ...dayDetail(db, day, accountIds, dates), closing: getClosing(db, day, accountIds, dates) });
  });

  api.get('/integrity', (_req, res) => res.json({ warnings: [...checkBalances(db), ...verifyClosings(db)] }));

  api.use((_req, res) => res.status(404).json({ error: 'No encontrado' }));

  return api;
}
