// Cierre diario. A la hora del cierre (02:00 de Chile, CIERRE_HORA) se congela lo que se sabía del día
// anterior: el informe del día (general y cada cuenta), sus movimientos e hitos, y hasta dónde llegaban las
// cartolas de cada cuenta. Un cierre no se reescribe: si después se carga algo que cambia ese día, se nota
// porque la huella de los movimientos de ahora ya no es la del cierre.
//
// El cierre va por fecha real (lo hecho el viernes en la noche cuenta el viernes, aunque el banco lo feche el
// lunes) y guarda también la foto por fecha del banco. Los cierres anteriores a la fecha real solo tienen esta
// última: se muestran así, avisando.
import crypto from 'node:crypto';
import type { DB } from '../db.js';
import { addDays, chileParts, daysBetween } from '../time.js';
import { dayDetail, movementsHash, realMovementsHash, type DayDetail } from './daily.js';
import { buildReport, type DateMode, type Report } from './report.js';

/** Si el servidor estuvo apagado, al volver se cierran a lo más estos días hacia atrás. */
const MAX_CATCH_UP = 31;

export interface Coverage {
  accountId: number;
  name: string;
  /** Último día con movimientos cargados. */
  lastMovement: string | null;
  /** Día de descarga de la última cartola cargada: si es posterior al día cerrado, ese día estaba completo. */
  lastCartola: string | null;
  /** Huella de los movimientos de la cuenta ese día (fecha del banco), para saber después si cambiaron. */
  hash: string;
  /** Lo mismo por fecha real (ver realMovementsHash); no está en los cierres de antes. */
  realHash?: string;
}

/** Lo que se guarda en closings.report. */
export interface ClosingSnapshot {
  day: string;
  closedAt: string;
  /** Por qué fecha van `report` y `detail`. Los cierres de antes no lo dicen: son por fecha del banco. */
  dates?: DateMode;
  /** El informe del día, igual que /api/report de ese día: totales y cada cuenta por separado. */
  report: Report;
  detail: DayDetail;
  /** La misma foto por fecha del banco (en los cierres por fecha real). */
  bank?: { report: Report; detail: DayDetail };
  /** Huella de todo el día por fecha real (ver realMovementsHash). */
  realHash?: string;
  coverage: Coverage[];
}

/** El cierre como se muestra: la foto por la fecha que se pidió, si la tiene. */
export interface ClosingView {
  day: string;
  closedAt: string;
  /** Por qué fecha está esta foto: puede no ser la pedida, en un cierre de antes de la fecha real. */
  dates: DateMode;
  report: Report;
  detail: DayDetail;
  coverage: Coverage[];
}

export interface ClosingInfo {
  day: string;
  closedAt: string;
  hash: string;
  /** Los movimientos de ese día (de las cuentas pedidas) ya no son los del cierre. */
  changed: boolean;
  snapshot: ClosingView;
}

type ClosingRow = { id: number; day: string; closed_at: string; report: string; movements_hash: string; prev_hash: string | null; hash: string };

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const chainHash = (r: Pick<ClosingRow, 'prev_hash' | 'day' | 'closed_at' | 'movements_hash' | 'report'>) =>
  sha256([r.prev_hash ?? '', r.day, r.closed_at, r.movements_hash, r.report].join('\n'));
const hasAccounts = (db: DB) => db.prepare('SELECT 1 FROM accounts LIMIT 1').get() !== undefined;

/** Último día que ya se puede cerrar: desde la hora del cierre, ayer; antes de esa hora, anteayer. */
export function lastClosableDay(now: number, hour: number): string {
  const { day, hour: h } = chileParts(now);
  return addDays(day, h >= hour ? -1 : -2);
}

/**
 * Días por cerrar. La primera vez, solo el último cerrable: cerrar hoy un día pasado no sería lo que se sabía
 * esa noche. Después, todos los que falten desde el último cierre, por si el servidor estuvo apagado.
 */
export function pendingDays(db: DB, now: number, hour: number): string[] {
  if (!hasAccounts(db)) return [];
  const last = lastClosableDay(now, hour);
  const lastClosed = (db.prepare('SELECT MAX(day) AS d FROM closings').get() as { d: string | null }).d;
  if (!lastClosed) return [last];
  if (lastClosed >= last) return [];
  const oldest = addDays(last, -(MAX_CATCH_UP - 1));
  return daysBetween(addDays(lastClosed, 1) > oldest ? addDays(lastClosed, 1) : oldest, last);
}

/** Cierra un día si no estaba cerrado. false si ya lo estaba o si la base no tiene cuentas. */
export function closeDay(db: DB, day: string, now: number = Date.now()): boolean {
  const close = db.transaction((): boolean => {
    if (db.prepare('SELECT 1 FROM closings WHERE day = ?').get(day) || !hasAccounts(db)) return false;
    const closedAt = new Date(now).toISOString();
    const snapshot: ClosingSnapshot = {
      day,
      closedAt,
      dates: 'real',
      report: buildReport(db, { from: day, to: day, dates: 'real' }),
      detail: dayDetail(db, day, undefined, 'real'),
      bank: { report: buildReport(db, { from: day, to: day, dates: 'banco' }), detail: dayDetail(db, day, undefined, 'banco') },
      realHash: realMovementsHash(db, day),
      coverage: coverage(db, day),
    };
    const prev = db.prepare('SELECT hash FROM closings ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
    const row = { day, closed_at: closedAt, report: JSON.stringify(snapshot), movements_hash: movementsHash(db, day), prev_hash: prev?.hash ?? null };
    db.prepare(
      `INSERT INTO closings (day, closed_at, report, movements_hash, prev_hash, hash, app_version)
       VALUES (@day, @closed_at, @report, @movements_hash, @prev_hash, @hash, @app_version)`,
    ).run({ ...row, hash: chainHash(row), app_version: process.env.npm_package_version ?? null });
    return true;
  });
  // IMMEDIATE: si el servidor y `npm run cierre` cierran a la vez, el segundo espera y ve el cierre del primero.
  return close.immediate();
}

/** Cierra lo pendiente; devuelve los días que cerró. */
export function closePending(db: DB, now: number, hour: number): string[] {
  return pendingDays(db, now, hour).filter((day) => closeDay(db, day, now));
}

function coverage(db: DB, day: string): Coverage[] {
  const accounts = db.prepare('SELECT id, name FROM accounts ORDER BY name').all() as Array<{ id: number; name: string }>;
  const lastMovement = db.prepare('SELECT MAX(date) AS d FROM movements WHERE account_id = ?');
  const lastCartola = db.prepare("SELECT MAX(balance_date) AS d FROM imports WHERE account_id = ? AND kind IN ('account', 'card')");
  return accounts.map((a) => ({
    accountId: a.id,
    name: a.name,
    lastMovement: (lastMovement.get(a.id) as { d: string | null }).d,
    lastCartola: (lastCartola.get(a.id) as { d: string | null }).d,
    hash: movementsHash(db, day, [a.id]),
    realHash: realMovementsHash(db, day, [a.id]),
  }));
}

/**
 * ¿Cambiaron los movimientos del día desde el cierre? Con cuentas, solo los de esas cuentas. Por fecha real, con la
 * huella por fecha real si el cierre la tiene; si no (un cierre de antes), con la del banco.
 */
function changedSince(db: DB, row: ClosingRow, accountIds: number[] | undefined, dates: DateMode): boolean {
  const snap = JSON.parse(row.report) as ClosingSnapshot;
  const real = dates === 'real' && snap.realHash !== undefined;
  const hashOf = (day: string, ids?: number[]) => (real ? realMovementsHash(db, day, ids) : movementsHash(db, day, ids));
  if (!accountIds?.length) return hashOf(row.day) !== (real ? snap.realHash : row.movements_hash);
  // Una cuenta que no existía al cerrar tenía, para ese cierre, cero movimientos ese día.
  const empty = hashOf('0000-00-00');
  return accountIds.some((id) => {
    const c = snap.coverage.find((c) => c.accountId === id);
    return hashOf(row.day, [id]) !== ((real ? c?.realHash : c?.hash) ?? empty);
  });
}

/** La foto del cierre por la fecha pedida; un cierre de antes de la fecha real solo tiene la del banco. */
function viewOf(snap: ClosingSnapshot, dates: DateMode): ClosingView {
  const base = { day: snap.day, closedAt: snap.closedAt, coverage: snap.coverage };
  const made = snap.dates ?? 'banco';
  if (dates === 'banco' && made === 'real' && snap.bank) return { ...base, dates: 'banco', ...snap.bank };
  return { ...base, dates: made, report: snap.report, detail: snap.detail };
}

export function getClosing(db: DB, day: string, accountIds?: number[], dates: DateMode = 'real'): ClosingInfo | null {
  const row = db.prepare('SELECT * FROM closings WHERE day = ?').get(day) as ClosingRow | undefined;
  if (!row) return null;
  const snapshot = viewOf(JSON.parse(row.report) as ClosingSnapshot, dates);
  return { day, closedAt: row.closed_at, hash: row.hash, changed: changedSince(db, row, accountIds, dates), snapshot };
}

/** Estado del cierre de cada día del rango: cuándo se cerró y si cambió después. */
export function closingStatuses(
  db: DB,
  from: string,
  to: string,
  accountIds?: number[],
  dates: DateMode = 'real',
): Map<string, { closedAt: string; changed: boolean }> {
  const rows = db.prepare('SELECT * FROM closings WHERE day BETWEEN ? AND ?').all(from, to) as ClosingRow[];
  return new Map(rows.map((r) => [r.day, { closedAt: r.closed_at, changed: changedSince(db, r, accountIds, dates) }]));
}

/** Revisa la cadena de cierres: cada uno calza con su hash y apunta al anterior. Devuelve los problemas. */
export function verifyClosings(db: DB): string[] {
  const rows = db.prepare('SELECT * FROM closings ORDER BY id').all() as ClosingRow[];
  const problems: string[] = [];
  let prev: string | null = null;
  for (const r of rows) {
    if (r.prev_hash !== prev) problems.push(`El cierre del ${r.day} no sigue al cierre anterior.`);
    if (chainHash(r) !== r.hash) problems.push(`El cierre del ${r.day} se modificó después de cerrarse.`);
    prev = r.hash;
  }
  return problems;
}
