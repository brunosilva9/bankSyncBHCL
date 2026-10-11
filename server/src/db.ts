import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  bank TEXT NOT NULL DEFAULT 'Banco de Chile',
  name TEXT NOT NULL,
  rut TEXT,
  -- Nombres con que esta empresa aparece en las cartolas de las otras cuentas (uno por línea).
  -- Sirven para detectar traspasos internos.
  aliases TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#64748b',
  -- Categorías que el sistema asigna solo: payroll, bank_fee, credit_line, loan, internal.
  system_key TEXT UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  filename TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  balance_date TEXT NOT NULL,
  balance INTEGER NOT NULL,
  from_date TEXT,
  to_date TEXT,
  movements_in_file INTEGER NOT NULL,
  inserted INTEGER NOT NULL,
  -- Movimiento más reciente del archivo: su saldo debe calzar con "balance".
  anchor_movement_id INTEGER,
  user_id INTEGER
);

CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  -- Orden dentro del día tal como viene en la cartola: 0 = el más reciente.
  seq INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('C', 'A')),
  description TEXT NOT NULL,
  doc_number TEXT,
  kind TEXT NOT NULL,
  counterparty TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_source TEXT CHECK (category_source IN ('auto', 'rule', 'manual')),
  label TEXT,
  label_source TEXT CHECK (label_source IN ('rule', 'manual')),
  note TEXT,
  balance_after INTEGER,
  import_id INTEGER REFERENCES imports(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS movements_account_date ON movements(account_id, date, seq);
CREATE INDEX IF NOT EXISTS movements_category ON movements(category_id);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  match_type TEXT NOT NULL CHECK (match_type IN ('counterparty', 'contains')),
  pattern TEXT NOT NULL,
  direction TEXT CHECK (direction IN ('C', 'A')),
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Nombres de los trabajadores que reciben Pago Fácil (la cartola solo trae el RUT).
CREATE TABLE IF NOT EXISTS payees (
  rut TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
`;

const DEFAULT_CATEGORIES: Array<[name: string, color: string, systemKey: string | null]> = [
  ['Sueldos y nómina', '#2563eb', 'payroll'],
  ['Proveedores', '#9333ea', null],
  ['Combustible y transporte', '#ea580c', null],
  ['Oficina', '#0891b2', null],
  ['Pagos varios', '#ca8a04', null],
  ['Retiros y personales', '#db2777', null],
  ['Ventas e ingresos', '#16a34a', null],
  ['Gastos bancarios', '#dc2626', 'bank_fee'],
  ['Línea de crédito', '#7c3aed', 'credit_line'],
  ['Créditos', '#b45309', 'loan'],
  ['Traspaso interno', '#94a3b8', 'internal'],
  ['Otros', '#64748b', null],
];

export function openDb(file: string, key: string): DB {
  if (!key) throw new Error('Falta DB_KEY: la base de datos siempre va cifrada.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key='${key.replace(/'/g, "''")}'`);
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    db.close();
    throw new Error('No se pudo abrir la base de datos: DB_KEY incorrecta o archivo dañado.');
  }
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

/** Columnas agregadas después de la primera versión; se crean si la base es anterior. */
const ADDED_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  // Línea de crédito asociada a la cuenta corriente. El uso se sigue con los giros y amortizaciones
  // que aparecen en la propia cuenta corriente, a partir de un punto de calibración.
  ['accounts', 'credit_limit', 'INTEGER'],
  ['accounts', 'credit_used_anchor', 'INTEGER'],
  ['accounts', 'credit_anchor_movement_id', 'INTEGER'],
  ['movements', 'credit_used_after', 'INTEGER'],
  ['imports', 'kind', "TEXT NOT NULL DEFAULT 'account'"],
  // BancoEstado: cartolas consolidadas numeradas y la "cartola en línea" provisoria.
  ['imports', 'statement_kind', 'TEXT'],
  ['imports', 'statement_number', 'TEXT'],
  ['movements', 'provisional', 'INTEGER NOT NULL DEFAULT 0'],
  ['movements', 'counterparty_rut', 'TEXT'],
  // Pago Fácil: n° de bloque contiguo dentro del día (1 = el más temprano). Cada bloque es una nómina.
  ['movements', 'payroll_batch', 'INTEGER'],
];

function migrate(db: DB) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const exists = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function seed(db: DB) {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n;
  if (count > 0) return;
  const insert = db.prepare('INSERT INTO categories (name, color, system_key, sort) VALUES (?, ?, ?, ?)');
  db.transaction(() => DEFAULT_CATEGORIES.forEach(([name, color, key], i) => insert.run(name, color, key, i)))();
}
