import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import {
  createSession,
  destroySession,
  loginLimiter,
  readCookie,
  requireAuth,
  SESSION_COOKIE,
  verifyPassword,
  type AuthedRequest,
} from './auth.js';
import type { DB } from './db.js';
import { recategorize } from './domain/categorize.js';
import { calibrateFromAvailable, calibrateFromLineCartola, isCreditLineCartola, recomputeCreditLine } from './domain/creditLine.js';
import { checkBalances, importCartola, recomputePayrollBatches } from './domain/importer.js';
import { buildReport } from './domain/report.js';
import { CartolaParseError, displayAccountNumber } from './parser/cartola.js';
import { parseStatementFile } from './parser/index.js';

export interface AppOptions {
  production: boolean;
  sessionDays: number;
  webDist?: string;
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

/** Largo máximo del comentario: unas 4 líneas, para que el resumen siga cabiendo en una página. */
const NOTE_MAX = 500;

export function createApp(db: DB, opts: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
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
  const findUser = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?');

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

  api.get('/auth/me', (req: AuthedRequest, res) => res.json({ username: req.user!.username }));

  // ---------- Cuentas ----------
  api.get('/accounts', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT a.id, a.number, a.bank, a.name, a.rut, a.aliases, a.credit_limit,
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
    if (q.from && DATE.test(q.from)) add('m.date >= ?', q.from);
    if (q.to && DATE.test(q.to)) add('m.date <= ?', q.to);
    if (q.accountId) add('m.account_id = ?', Number(q.accountId));
    if (q.direction === 'C' || q.direction === 'A') add('m.direction = ?', q.direction);
    if (q.kind) add('m.kind = ?', q.kind);
    if (q.batch) add('m.payroll_batch = ?', Number(q.batch));
    if (q.categoryId === 'none') add('m.category_id IS NULL');
    else if (q.categoryId) add('m.category_id = ?', Number(q.categoryId));
    if (q.label) add('m.label = ? COLLATE NOCASE', q.label);
    if (q.categoryKey) add('c.system_key = ?', q.categoryKey);
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
             m.note, m.balance_after, m.provisional, m.payroll_batch, m.payroll_split_after, c.system_key
      FROM movements m
      JOIN accounts a ON a.id = m.account_id
      LEFT JOIN categories c ON c.id = m.category_id
      LEFT JOIN payees p ON p.rut = m.counterparty AND m.kind = 'payroll'
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY m.date DESC, a.name, m.seq ASC
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
    if (isCreditLineCartola(parsed)) {
      try {
        return res.json(calibrateFromLineCartola(db, parsed, filename, req.user!.id));
      } catch (e) {
        throw bad(`${filename}: ${(e as Error).message}`);
      }
    }
    res.json(importCartola(db, parsed, filename, req.user!.id));
  });

  api.get('/imports', (_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT i.id, i.kind, i.statement_kind, i.statement_number, i.filename, i.imported_at, i.balance_date, i.balance, i.from_date, i.to_date, i.movements_in_file, i.inserted,
                  a.name AS account_name, u.username
           FROM imports i JOIN accounts a ON a.id = i.account_id LEFT JOIN users u ON u.id = i.user_id
           ORDER BY i.id DESC LIMIT 100`,
        )
        .all(),
    );
  });

  // ---------- Informe ----------
  api.get('/report', (req, res) => {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw bad('Rango de fechas inválido');
    const accountIds = parseAccountIds(req.query.accounts);
    const report = buildReport(db, { from, to, accountIds });
    res.json({ ...report, note: getNote(noteScope(accountIds), report.period.from, report.period.to) });
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

  const getNote = (scope: string, from: string, to: string) =>
    db
      .prepare(
        `SELECT n.text, n.updated_at, u.username FROM report_notes n LEFT JOIN users u ON u.id = n.user_id
         WHERE n.scope = ? AND n.from_date = ? AND n.to_date = ?`,
      )
      .get(scope, from, to) ?? null;

  api.get('/integrity', (_req, res) => res.json({ warnings: checkBalances(db) }));

  api.use((_req, res) => res.status(404).json({ error: 'No encontrado' }));

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
