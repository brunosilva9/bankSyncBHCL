import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openAuthDb, openDb, type DB } from './db.js';

/**
 * Bases de la app: una de acceso (usuarios, roles, sesiones) y una por usuario con sus cuentas.
 * Separar los datos por archivo hace que una consulta no pueda mezclar cuentas de dos usuarios, y
 * que pasarle las cuentas a otro usuario sea solo cambiar a qué archivo apunta.
 */
export class Store {
  readonly auth: DB;
  private readonly open = new Map<string, DB>();

  constructor(
    /** Carpeta de datos: ahí van usuarios.db y las bases de cada usuario (en bases/). */
    readonly dir: string,
    private readonly key: string,
  ) {
    this.auth = openAuthDb(path.join(dir, 'usuarios.db'), key);
  }

  /** Base de datos de un usuario (data_file, relativo a la carpeta de datos). Queda abierta. */
  data(dataFile: string): DB {
    const full = this.resolve(dataFile);
    let db = this.open.get(full);
    if (!db) this.open.set(full, (db = openDb(full, this.key)));
    return db;
  }

  /** Bases de usuario, cada una una vez: los usuarios de la base de antes comparten la misma. */
  dataFiles(): string[] {
    return (this.auth.prepare('SELECT DISTINCT data_file FROM users ORDER BY data_file').all() as Array<{ data_file: string }>).map((r) => r.data_file);
  }

  resolve(dataFile: string): string {
    const root = path.resolve(this.dir);
    const full = path.resolve(root, dataFile);
    if (!full.startsWith(root + path.sep)) throw new Error(`Archivo de datos fuera de la carpeta de datos: ${dataFile}`);
    return full;
  }

  close() {
    for (const db of this.open.values()) db.close();
    this.open.clear();
    this.auth.close();
  }
}

/** Archivo para la base de un usuario nuevo. El nombre no dice de quién es. */
export const newDataFile = () => `bases/${crypto.randomUUID()}.db`;

/**
 * Abre las bases. dbPath es la base de siempre (DB_PATH): su carpeta es la carpeta de datos y, si
 * viene de antes de las cuentas por usuario, sus usuarios pasan a usuarios.db como administradores
 * y siguen viendo esa misma base. No se borra ni se mueve nada.
 */
export function openStore(dbPath: string, key: string): Store {
  const store = new Store(path.dirname(dbPath), key);
  const count = (store.auth.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (count === 0 && fs.existsSync(dbPath)) adoptLegacyUsers(store, dbPath);
  return store;
}

function adoptLegacyUsers(store: Store, dbPath: string) {
  const dataFile = path.relative(store.dir, dbPath).split(path.sep).join('/');
  const legacy = store.data(dataFile);
  const hasUsers = legacy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!hasUsers) return;
  const users = legacy.prepare('SELECT id, username, password_hash, created_at FROM users ORDER BY id').all() as Array<{
    id: number;
    username: string;
    password_hash: string;
    created_at: string;
  }>;
  // Se conserva el id: imports y report_notes guardan quién los hizo por id.
  const insert = store.auth.prepare(
    `INSERT INTO users (id, username, password_hash, role, data_file, created_at) VALUES (?, ?, ?, 'admin', ?, ?)`,
  );
  store.auth.transaction(() => users.forEach((u) => insert.run(u.id, u.username, u.password_hash, dataFile, u.created_at)))();
}
