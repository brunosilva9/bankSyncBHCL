import type { DB } from '../db.js';
import { normalizeName, sameCounterparty, type MovementKind } from './classify.js';

export interface Rule {
  id: number;
  match_type: 'counterparty' | 'contains';
  pattern: string;
  direction: 'C' | 'A' | null;
  category_id: number | null;
  label: string | null;
}

interface MovementForRules {
  id: number;
  account_id: number;
  direction: 'C' | 'A';
  description: string;
  kind: MovementKind;
  counterparty: string | null;
  category_source: string | null;
  label_source: string | null;
}

const KIND_TO_SYSTEM_KEY: Partial<Record<MovementKind, string>> = {
  payroll: 'payroll',
  bank_fee: 'bank_fee',
  credit_line: 'credit_line',
  loan_payment: 'loan',
};

export function ruleMatches(rule: Rule, m: Pick<MovementForRules, 'direction' | 'description' | 'counterparty'>): boolean {
  if (rule.direction && rule.direction !== m.direction) return false;
  if (rule.match_type === 'counterparty') return m.counterparty !== null && sameCounterparty(rule.pattern, m.counterparty);
  return normalizeName(m.description).includes(normalizeName(rule.pattern));
}

interface OwnAccount {
  id: number;
  names: string[];
  rutKey: string | null;
}

const rutKey = (rut: string | null | undefined) => (rut ? rut.replace(/[^0-9kK]/g, '').replace(/^0+/, '').toUpperCase() : null);

/**
 * Cómo aparece cada cuenta propia en las cartolas de las otras: su nombre, sus alias y su RUT.
 * Las cuentas de una misma empresa (mismo RUT, ej. en dos bancos) comparten nombres y alias.
 */
function loadOwnAccounts(db: DB): OwnAccount[] {
  const rows = db.prepare('SELECT id, name, rut, aliases FROM accounts').all() as Array<{ id: number; name: string; rut: string | null; aliases: string }>;
  const namesOf = (a: (typeof rows)[number]) => [a.name, ...a.aliases.split('\n')].map((s) => s.trim()).filter(Boolean);
  return rows.map((a) => {
    const key = rutKey(a.rut);
    const sameCompany = key ? rows.filter((o) => rutKey(o.rut) === key) : [a];
    return { id: a.id, names: sameCompany.flatMap(namesOf), rutKey: key };
  });
}

type Transfer = { id: number; account_id: number; date: string; amount: number; direction: 'C' | 'A'; counterparty: string | null; counterparty_rut: string | null };

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * Traspasos entre cuentas propias cargadas: un cargo en una cuenta y un abono en la otra por el mismo
 * monto. Normalmente cada lado nombra a la otra empresa (por contraparte o RUT) y se exige que se
 * referencien mutuamente. Pero un envío por la banca en línea de BancoEstado no trae contraparte
 * ("TRANSFERENCIA FONDOS INTERNET"): si es genérico, basta que el otro lado nombre a la empresa de la
 * cuenta que lo emitió. Entre bancos distintos el abono puede llegar uno o dos días después, así que
 * se acepta hasta 3 días de diferencia (prefiriendo el mismo día). Un traspaso desde una cuenta propia
 * que no se carga no tiene pareja y cuenta como ingreso o gasto normal; se identifica con un comentario.
 */
function findInternalPairs(db: DB, own: OwnAccount[]): Set<number> {
  const transfers = db
    .prepare(
      `SELECT id, account_id, date, amount, direction, counterparty, counterparty_rut FROM movements
       WHERE kind IN ('transfer_in', 'transfer_out') ORDER BY date, seq`,
    )
    .all() as Transfer[];

  /** Cuentas propias a las que apunta un traspaso por su contraparte (nombre o RUT). Vacío si es genérico. */
  const pointsTo = (t: Transfer) => {
    const generic = !t.counterparty && !t.counterparty_rut;
    if (generic) return { others: new Set<number>(), generic };
    const tRut = rutKey(t.counterparty_rut ?? t.counterparty);
    const others = new Set(
      own
        .filter(
          (a) =>
            a.id !== t.account_id &&
            ((a.rutKey !== null && a.rutKey === tRut) || (t.counterparty !== null && a.names.some((n) => sameCounterparty(n, t.counterparty!)))),
        )
        .map((a) => a.id),
    );
    return { others, generic };
  };

  const candidates = transfers.map((t) => ({ ...t, ...pointsTo(t) }));

  /** ¿Se referencian? Los dos con nombre deben apuntarse mutuamente; si uno es genérico, basta que el otro lo nombre. */
  const link = (out: (typeof candidates)[number], inn: (typeof candidates)[number]) => {
    if (out.generic && inn.generic) return false;
    if (out.generic) return inn.others.has(out.account_id);
    if (inn.generic) return out.others.has(inn.account_id);
    return out.others.has(inn.account_id) && inn.others.has(out.account_id);
  };

  const paired = new Set<number>();
  for (const out of candidates.filter((c) => c.direction === 'C')) {
    const options = candidates
      .filter((c) => c.direction === 'A' && !paired.has(c.id) && c.amount === out.amount && link(out, c) && daysBetween(c.date, out.date) <= 3)
      .sort((x, y) => daysBetween(x.date, out.date) - daysBetween(y.date, out.date));
    if (options.length) {
      paired.add(out.id);
      paired.add(options[0].id);
    }
  }
  return paired;
}

/**
 * Vuelve a calcular la categoría y el comentario de los movimientos que no fueron editados a mano.
 * Prioridad: traspaso interno > reglas del usuario (la más nueva primero) > categoría automática por tipo.
 * Recorre todas las cuentas, porque cargar una cartola puede convertir en interno un traspaso de otra cuenta.
 */
export function recategorize(db: DB): void {
  const rules = db.prepare('SELECT * FROM rules ORDER BY id DESC').all() as Rule[];
  const internalIds = findInternalPairs(db, loadOwnAccounts(db));
  const systemCats = new Map(
    (db.prepare('SELECT id, system_key FROM categories WHERE system_key IS NOT NULL').all() as Array<{ id: number; system_key: string }>).map(
      (c) => [c.system_key, c.id],
    ),
  );

  const movements = db
    .prepare('SELECT id, account_id, direction, description, kind, counterparty, category_source, label_source FROM movements')
    .all() as MovementForRules[];

  const updateCat = db.prepare('UPDATE movements SET category_id = ?, category_source = ? WHERE id = ?');
  const updateLabel = db.prepare('UPDATE movements SET label = ?, label_source = ? WHERE id = ?');

  db.transaction(() => {
    for (const m of movements) {
      const matching = rules.filter((r) => ruleMatches(r, m));

      // Un traspaso con su pareja en otra cuenta propia es interno aunque se haya categorizado a mano
      // (ej. cuando aún no se cargaba la otra cuenta): si no, la misma plata se cuenta dos veces.
      if (internalIds.has(m.id)) {
        updateCat.run(systemCats.get('internal') ?? null, 'auto', m.id);
      } else if (m.category_source !== 'manual') {
        let category: number | null = null;
        let source: 'auto' | 'rule' | null = null;
        const rule = matching.find((r) => r.category_id !== null);
        if (rule) {
          category = rule.category_id;
          source = 'rule';
        } else {
          const key = KIND_TO_SYSTEM_KEY[m.kind];
          if (key && systemCats.has(key)) {
            category = systemCats.get(key)!;
            source = 'auto';
          }
        }
        updateCat.run(category, source, m.id);
      }

      if (m.label_source !== 'manual') {
        const rule = matching.find((r) => r.label);
        updateLabel.run(rule?.label ?? null, rule ? 'rule' : null, m.id);
      }
    }
  })();
}
