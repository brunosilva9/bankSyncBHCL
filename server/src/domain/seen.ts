// Cuándo se vio cada movimiento por primera vez y su fecha real. El banco fecha al día hábil siguiente lo que se
// hace de noche, en fin de semana o en feriado: una transferencia del sábado ya aparece el sábado en la cartola,
// pero con fecha del lunes. Lo que no pudo pasar es que se hiciera después de verse, así que la fecha real es la
// más temprana que se conoce: el día de la primera cartola que lo trajo o una fecha anterior que le dio el banco
// (p. ej. antes de consolidarlo). Se conserva aunque después el banco le cambie la redacción, el N° de operación
// o la fecha (ver carryOver en importer.ts).
//
// movements.real_date_source dice de dónde salió: 'banco' (es la fecha que dio el banco), 'observada' (el día en
// que ya estaba en una cartola, anterior a la fecha del banco) o 'manual' (la eligió el usuario en Movimientos, dentro
// de los días en que pudo pasar: ver realDateWindows). Lo automático solo la baja, así que no cambia una fecha
// manual, salvo que una cartola muestre que el movimiento ya existía antes: entonces esa fecha manual no pudo ser.
import type { DB } from '../db.js';
import { addDays, chileDay, chileInstant } from '../time.js';

/** De dónde salió la hora de descarga: el archivo la anota, es la última modificación del archivo o la de subida. */
export type ObservedSource = 'banco' | 'archivo' | 'subida';

export interface Observed {
  /** Día de Chile de la descarga, según el archivo (la línea de saldo de Banco de Chile, la hoja Resumen de BancoEstado). */
  day: string;
  /** Instante de la descarga (UTC, ISO), si se sabe. */
  at: string | null;
  source: ObservedSource | null;
}

/**
 * Cuándo se descargó un archivo, con la mejor hora disponible: la que anota el banco (BancoEstado); la última
 * modificación del archivo, que en uno recién bajado es la de la descarga; o la de subida. Las dos últimas solo
 * sirven si caen el mismo día que dice el archivo: uno copiado o subido días después no dice a qué hora se bajó.
 */
export function observedOf(day: string, downloadedAt: string | null, fileModified: number | null, now: number): Observed {
  const fromBank = downloadedAt ? chileInstant(downloadedAt) : null;
  if (fromBank !== null && chileDay(fromBank) === day) return { day, at: new Date(fromBank).toISOString(), source: 'banco' };
  if (fileModified !== null && chileDay(fileModified) === day) return { day, at: new Date(fileModified).toISOString(), source: 'archivo' };
  if (chileDay(now) === day) return { day, at: new Date(now).toISOString(), source: 'subida' };
  return { day, at: null, source: null };
}

/** Fecha real de un movimiento nuevo: la del banco, o el día en que se vio si es anterior. */
export const realDateOf = (date: string, seenDay: string) => (seenDay < date ? { day: seenDay, source: 'observada' } : { day: date, source: 'banco' });

/** Sentencias para anotar que un movimiento ya existía un día: solo bajan la primera vez y la fecha real. */
export function seenStatements(db: DB) {
  // Un archivo descargado antes puede subirse después. Parámetros: { id, day, at }.
  const firstSeen = db.prepare(`
    UPDATE movements SET first_seen_day = @day, first_seen_at = @at
    WHERE id = @id AND (first_seen_day IS NULL OR first_seen_day > @day
      OR (first_seen_day = @day AND @at IS NOT NULL AND (first_seen_at IS NULL OR first_seen_at > @at)))`);
  // Parámetros: { id, day, source }. Sin fecha real todavía, se compara con la del banco. También baja una fecha
  // manual: si ya existía antes de esa fecha, no pudo pasar ese día.
  const realDate = db.prepare(`
    UPDATE movements SET real_date = @day, real_date_source = @source
    WHERE id = @id AND @day < COALESCE(real_date, date)`);
  return {
    /** Estaba en una cartola descargada ese día (y a esa hora, si se sabe). */
    seen(id: number, day: string, at: string | null) {
      firstSeen.run({ id, day, at });
      realDate.run({ id, day, source: 'observada' });
    },
    /** El banco le dio esa fecha (otra versión del mismo movimiento). */
    dated(id: number, day: string, source: string = 'banco') {
      realDate.run({ id, day, source });
    },
  };
}

/** Sábado o domingo. */
const isWeekend = (day: string) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());

/** Día hábil anterior: para el lunes, el viernes. Los feriados no se conocen, así que cuentan como hábiles. */
export function previousBusinessDay(day: string): string {
  let d = addDays(day, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

/** Lo que hace falta de un movimiento para saber entre qué días pudo pasar. */
export interface Placeable {
  account_id: number;
  date: string;
  real_date: string | null;
  real_date_source: string | null;
  first_seen_day: string | null;
  first_seen_at: string | null;
}

/** Entre qué días pudo pasar un movimiento: los que se pueden elegir como fecha real. */
export interface RealDateWindow {
  min: string;
  max: string;
  /** La última descarga de su cuenta en que todavía no aparecía, si es la que pone el límite de abajo: pasó después. */
  before: { day: string; at: string | null } | null;
}

/**
 * Entre qué días pudo pasar cada movimiento, para corregir su fecha real a mano; null si no hay nada que elegir.
 * - El banco pasa al día hábil siguiente lo que se hace de noche, en fin de semana o en feriado. Lo más temprano es
 *   el día hábil anterior a su fecha: para un martes, el lunes; para un lunes, el viernes.
 * - No aparecía en la descarga anterior de su cuenta, así que pasó después: ese mismo día, más tarde, o después.
 * - Ya aparecía en la primera cartola que lo trajo, así que pasó ese día o antes; y tampoco después de una fecha
 *   anterior que le haya dado el banco.
 * Solo cuentan las descargas que traen todo lo que ya pasó en la cuenta: no una cartola consolidada de BancoEstado,
 * que trae solo su período. Las tarjetas no tienen ventana: su fecha es la de la compra.
 */
export function realDateWindows(db: DB, movements: Placeable[]): Array<RealDateWindow | null> {
  const cards = new Set((db.prepare("SELECT id FROM accounts WHERE kind = 'tarjeta_credito'").all() as Array<{ id: number }>).map((a) => a.id));
  const downloads = new Map<number, Array<{ day: string; at: string | null; from: string | null }>>();
  const rows = db
    .prepare(
      `SELECT account_id, balance_date AS day, observed_at AS at, from_date AS "from" FROM imports
       WHERE kind = 'account' AND COALESCE(statement_kind, '') <> 'consolidated'`,
    )
    .all() as Array<{ account_id: number; day: string; at: string | null; from: string | null }>;
  for (const r of rows) {
    if (!downloads.has(r.account_id)) downloads.set(r.account_id, []);
    downloads.get(r.account_id)!.push(r);
  }

  return movements.map((m) => {
    if (cards.has(m.account_id)) return null;
    const known = m.real_date_source === 'manual' ? m.date : (m.real_date ?? m.date);
    const max = [m.date, m.first_seen_day ?? m.date, known].sort()[0];
    let min = previousBusinessDay(m.date);
    let before: RealDateWindow['before'] = null;
    if (m.first_seen_day) {
      // Las de un día anterior, o del mismo día y de antes, si se sabe la hora de las dos. Una que no cubre su fecha
      // no dice nada: no lo habría traído aunque ya existiera.
      const earlier = (downloads.get(m.account_id) ?? []).filter(
        (d) =>
          (d.from === null || d.from <= m.date) &&
          (d.day < m.first_seen_day! || (d.day === m.first_seen_day && d.at !== null && m.first_seen_at !== null && d.at < m.first_seen_at)),
      );
      const last = earlier.sort((a, b) => a.day.localeCompare(b.day) || (a.at ?? '').localeCompare(b.at ?? '')).at(-1);
      if (last && last.day >= min) {
        min = last.day;
        before = { day: last.day, at: last.at };
      }
    }
    return min < max ? { min, max, before } : null;
  });
}

/**
 * Bases de antes de guardar estos datos: se deducen de las cartolas ya cargadas. Solo completa lo que falta, así
 * que correrlo de nuevo no pisa lo que ya se sabía.
 * - Hora de descarga: no se guardaba. Si la cartola se subió el mismo día, sirve la hora de subida.
 * - Primera vez: la cartola que cargó el movimiento (import_id). En BancoEstado lo provisorio se reemplaza con
 *   cada cartola nueva y import_id es la última; las anteriores se ubican por el saldo de su movimiento más
 *   reciente (BancoEstado da el saldo de cada fila): cada una trae todo lo de su período hasta ese movimiento.
 */
export function backfillFirstSeen(db: DB) {
  const imports = db.prepare('SELECT id, imported_at, balance_date FROM imports').all() as Array<{ id: number; imported_at: string; balance_date: string }>;
  const setObserved = db.prepare("UPDATE imports SET observed_at = ?, observed_source = 'subida' WHERE id = ? AND observed_at IS NULL");
  for (const i of imports) {
    const ms = Date.parse(`${i.imported_at.replace(' ', 'T')}Z`);
    if (!Number.isNaN(ms) && chileDay(ms) === i.balance_date) setObserved.run(new Date(ms).toISOString(), i.id);
  }
  db.exec(`UPDATE movements SET
             first_seen_day = (SELECT balance_date FROM imports i WHERE i.id = movements.import_id),
             first_seen_at = (SELECT observed_at FROM imports i WHERE i.id = movements.import_id)
           WHERE first_seen_day IS NULL`);

  const { seen } = seenStatements(db);
  const accounts = db.prepare("SELECT id FROM accounts WHERE bank = 'BancoEstado' AND kind != 'tarjeta_credito'").all() as Array<{ id: number }>;
  for (const { id } of accounts) {
    const movements = db.prepare('SELECT id, date, balance_after FROM movements WHERE account_id = ? ORDER BY date ASC, seq DESC').all(id) as Array<{
      id: number;
      date: string;
      balance_after: number | null;
    }>;
    const position = new Map(movements.map((m, k) => [m.id, k]));
    const files = db
      .prepare("SELECT balance_date, observed_at, balance, from_date, to_date, anchor_movement_id FROM imports WHERE account_id = ? AND kind = 'account'")
      .all(id) as Array<{ balance_date: string; observed_at: string | null; balance: number; from_date: string | null; to_date: string | null; anchor_movement_id: number | null }>;
    const best = new Map<number, { day: string; at: string | null }>();
    for (const f of files) {
      let end = f.anchor_movement_id === null ? -1 : (position.get(f.anchor_movement_id) ?? -1);
      // SQLite puede reusar el id de un movimiento borrado: el ancla de verdad tiene el saldo de la cartola.
      if (end >= 0 && movements[end].balance_after !== f.balance) end = -1;
      // El ancla de una cartola en línea ya reemplazada se borró con ella: se busca por su saldo, en su fecha o
      // hasta 3 días después (al consolidarlo, el banco puede cambiarle la fecha).
      if (end < 0 && f.to_date) {
        const until = addDays(f.to_date, 3);
        end = movements.findLastIndex((m) => m.date === f.to_date && m.balance_after === f.balance);
        if (end < 0) end = movements.findLastIndex((m) => m.date <= until && (!f.from_date || m.date >= f.from_date) && m.balance_after === f.balance);
      }
      for (let k = 0; k <= end; k++) {
        const m = movements[k];
        const b = best.get(m.id);
        if ((f.from_date && m.date < f.from_date) || (b && (b.day < f.balance_date || (b.day === f.balance_date && (!f.observed_at || (b.at && b.at <= f.observed_at)))))) continue;
        best.set(m.id, { day: f.balance_date, at: f.observed_at });
      }
    }
    for (const [movementId, b] of best) seen(movementId, b.day, b.at);
  }

  db.exec(`UPDATE movements SET
             real_date = CASE WHEN first_seen_day < date THEN first_seen_day ELSE date END,
             real_date_source = CASE WHEN first_seen_day < date THEN 'observada' ELSE 'banco' END
           WHERE real_date IS NULL`);
}
