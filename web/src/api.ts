// Cliente de la API. Todas las escrituras llevan el header que el servidor exige contra CSRF.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Motivo puntual cuando el servidor lo informa, p. ej. 'account-elsewhere'. */
    public code?: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

// De quién son las cuentas que tiene cargadas esta página. Si un administrador cambia de cuentas en
// otra pestaña, el servidor rechaza los pedidos de esta (409) y la página se recarga con las nuevas.
let owner: number | null = null;
export const setOwner = (id: number | null) => {
  owner = id;
};

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const isRaw = body instanceof ArrayBuffer;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method !== 'GET' ? { 'x-requested-with': 'syncbanks' } : {}),
      ...(body !== undefined && !isRaw ? { 'Content-Type': 'application/json' } : {}),
      ...(owner !== null ? { 'x-syncbanks-owner': String(owner) } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/auth/login')) onUnauthorized();
  if (data.code === 'owner-changed') location.reload();
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Error ${res.status}`, data.code);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, file: ArrayBuffer, filename: string, headers: Record<string, string> = {}) =>
    request<T>('POST', url, file, { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(filename), ...headers }),
};

/** Administrador: pasa a ver las cuentas de uno de sus usuarios (o las suyas) y recarga todo con ellas. */
export async function viewAs(me: Me, userId: number) {
  await api.put('/api/admin/view', { userId: userId === me.id ? null : userId });
  location.reload();
}

export const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---------- Tipos (espejo de lo que devuelve el servidor) ----------

export type Role = 'admin' | 'usuario';

/** Quién entró y de quién son las cuentas que ve (otro usuario si es un administrador mirando las suyas). */
export interface Me {
  id: number;
  username: string;
  role: Role;
  owner: { id: number; username: string };
}

/** Usuario que gestiona un administrador. */
export interface ManagedUser {
  id: number;
  username: string;
  active: boolean;
  created_at: string;
  accounts: number;
  last_import: string | null;
}

export interface Account {
  id: number;
  number: string;
  number_formatted: string;
  bank: string;
  name: string;
  /** Las tarjetas no tienen saldo: sus archivos solo traen movimientos. */
  kind: 'cuenta_corriente' | 'tarjeta_credito';
  rut: string | null;
  aliases: string;
  movement_count: number;
  coverage_from: string | null;
  coverage_to: string | null;
  balance: number | null;
  credit_limit: number | null;
  credit_used: number | null;
}

export interface Category {
  id: number;
  name: string;
  color: string;
  system_key: string | null;
  sort: number;
}

export interface Movement {
  id: number;
  account_id: number;
  account_name: string;
  date: string;
  seq: number;
  amount: number;
  direction: 'C' | 'A';
  description: string;
  doc_number: string | null;
  kind: string;
  counterparty: string | null;
  payee_name: string | null;
  category_id: number | null;
  category_source: 'auto' | 'rule' | 'manual' | null;
  label: string | null;
  label_source: 'rule' | 'manual' | null;
  note: string | null;
  balance_after: number | null;
  provisional: 0 | 1;
  payroll_batch: number | null;
  /** 1 si este pago es el último de su nómina (corte manual). */
  payroll_split_after: number;
  /** Compra en cuotas con tarjeta: cuántas (si el banco lo dice) y el valor de cada una. */
  installments: number | null;
  installment_amount: number | null;
  system_key: string | null;
  /** Primera cartola que lo trajo: su día de Chile y su hora de descarga (UTC), si se sabe. */
  first_seen_day: string | null;
  first_seen_at: string | null;
  /** Fecha real: si es anterior a `date`, el banco lo pasó a un día posterior (ver seen.ts). */
  real_date: string | null;
  real_date_source: RealDateSource | null;
}

/** De dónde sale la fecha real: la del banco, el día en que ya estaba en una cartola, o una corrección a mano. */
export type RealDateSource = 'banco' | 'observada' | 'manual';

/**
 * Por qué fecha se muestra todo: 'real' (por defecto), el día en que pasó o en que ya aparecía en una cartola, así lo
 * hecho un viernes en la noche cuenta el viernes; 'banco', la fecha que le puso el banco.
 */
export type DateMode = 'real' | 'banco';

/** Parámetro de la API para el modo: la fecha real no lo necesita. */
export const fechaParam = (dates: DateMode) => (dates === 'banco' ? 'banco' : undefined);

export interface Rule {
  id: number;
  match_type: 'counterparty' | 'contains';
  pattern: string;
  direction: 'C' | 'A' | null;
  category_id: number | null;
  category_name: string | null;
  label: string | null;
}

export interface Payee {
  rut: string;
  name: string | null;
  count: number;
  total: number;
  last_date: string;
}

export interface ImportResult {
  type: 'account';
  bank: string;
  statement: { kind: 'consolidated' | 'provisional'; number: string | null } | null;
  replacedProvisional: number;
  importId: number;
  accountName: string;
  accountNumber: string;
  fromDate: string | null;
  toDate: string | null;
  movementsInFile: number;
  inserted: number;
  alreadyLoaded: number;
  balance: number;
  warnings: string[];
}

/** Tarjeta de crédito: cada compra entra una vez aunque se repita en varios archivos. */
export interface CardImportResult {
  type: 'card';
  bank: string;
  accountName: string;
  cardNumber: string;
  /** true: estado de cuenta facturado; false: movimientos por facturar. */
  billed: boolean;
  fromDate: string | null;
  toDate: string | null;
  movementsInFile: number;
  inserted: number;
  alreadyLoaded: number;
  /** Compras por facturar que este estado de cuenta confirmó. */
  confirmed: number;
}

/** Cartola de la línea de crédito: no se cargan movimientos, solo calibra el uso de la línea. */
export interface CreditLineImportResult {
  type: 'credit_line';
  accountName: string;
  lineNumber: string;
  used: number;
  available: number | null;
  previousUsed: number | null;
  warnings: string[];
}

export interface ImportRow {
  id: number;
  kind: 'account' | 'credit_line' | 'card';
  statement_kind: 'consolidated' | 'provisional' | null;
  statement_number: string | null;
  filename: string;
  imported_at: string;
  balance_date: string;
  balance: number;
  from_date: string | null;
  to_date: string | null;
  movements_in_file: number;
  inserted: number;
  account_name: string;
  username: string | null;
}

export interface AccountSummary {
  accountId: number;
  name: string;
  number: string;
  opening: number | null;
  closing: number | null;
  income: number;
  expenses: number;
  internalIn: number;
  internalOut: number;
  creditLimit: number | null;
  creditAvailableOpening: number | null;
  creditAvailableClosing: number | null;
  creditDrawn: number;
  creditRepaid: number;
  availableOpening: number | null;
  availableClosing: number | null;
  coverageFrom: string | null;
  coverageTo: string | null;
  /** Tarjeta de crédito: sin saldo (opening/closing null). */
  isCard: boolean;
  /** Tarjeta: cuánto subió la deuda en el período (compras − pagos y devoluciones). */
  cardDebtChange: number;
}

export interface Report {
  params: { from: string; to: string };
  /** Primer y último día con movimientos dentro del filtro. */
  period: { from: string; to: string };
  accounts: AccountSummary[];
  totals: {
    opening: number;
    closing: number;
    income: number;
    expenses: number;
    internalNet: number;
    hasCredit: boolean;
    creditAvailableOpening: number;
    creditAvailableClosing: number;
    availableOpening: number;
    availableClosing: number;
    hasCards: boolean;
    /** Lo comprado con tarjeta que aún no se paga: hace cuadrar saldo inicial y final. */
    cardDebtChange: number;
  };
  payroll: Array<{
    accountId: number;
    accountName: string;
    date: string;
    batch: number;
    batchesInDay: number;
    total: number;
    count: number;
    /** Comentarios distintos de los pagos de la nómina. */
    comments: string[];
  }>;
  uncategorizedCount: number;
  warnings: string[];
  /** Comentario guardado para este período y estas cuentas. */
  note: ReportNote | null;
}

export interface ReportNote {
  text: string;
  updated_at: string;
  username: string | null;
}

/** Igual que en el servidor: unas 4 líneas, para que el resumen siga en una página. */
export const NOTE_MAX = 500;

// ---------- Línea de tiempo del informe (server/src/domain/daily.ts, dailyBalances) ----------

/** Una cuenta al final de un día. */
export interface BalancePoint {
  day: string;
  /** Saldo al final del día; null si la cuenta no tiene movimientos cargados. */
  closing: number | null;
  /** Saldo + línea disponible: lo que el informe llama disponible (sin línea, igual al saldo). */
  available: number | null;
  /** Cartolas descargadas ese día y la hora de descarga de la última (UTC, ISO), si se sabe. */
  cartolas: number;
  lastSeenAt: string | null;
  /** Cuándo se subió a la app la última cartola de ese día (UTC, "YYYY-MM-DD HH:MM:SS"). */
  lastImportedAt: string | null;
}

export interface AccountBalances {
  accountId: number;
  name: string;
  hasCredit: boolean;
  /** Al empezar el primer día: el saldo inicial del informe. */
  opening: { closing: number | null; available: number | null };
  days: BalancePoint[];
}

export interface DailyBalances {
  from: string;
  /** Llega hasta hoy. */
  to: string;
  accounts: AccountBalances[];
}

// ---------- Diario (server/src/domain/daily.ts y closing.ts) ----------

/** Una cartola importada: el saldo que informó el banco y si cuadra con los movimientos cargados. */
export interface Hito {
  importId: number;
  accountId: number;
  accountName: string;
  /** Día de la descarga. */
  day: string;
  /** Cuándo se subió, UTC "YYYY-MM-DD HH:MM:SS". */
  importedAt: string;
  /** Hora de la descarga (UTC, ISO), si se sabe: la anota el banco, es la del archivo o la de subida (mismo día). */
  observedAt: string | null;
  observedSource: 'banco' | 'archivo' | 'subida' | null;
  filename: string;
  statement: 'consolidated' | 'provisional' | null;
  balance: number;
  /** Movimiento más reciente del archivo: el saldo del banco es el de justo después de él. */
  anchor: { id: number; date: string; realDate: string } | null;
  /** Saldo según los movimientos cargados, después del ancla. */
  computed: number | null;
  check: number | null;
  /** Cartola anterior de la misma cuenta, con la que se compara. */
  previous: { importId: number; day: string; balance: number } | null;
  bankChange: number | null;
  movementsChange: number | null;
  movementsBetween: number | null;
  /** Lo que no explican los movimientos entre las dos cartolas; 0 = cuadra. */
  diff: number | null;
  /** Otra cartola con la diferencia contraria: un movimiento quedó en otro tramo (p. ej. tardío); juntas cuadran. */
  pair: { importId: number; day: string } | null;
}

export type DayAccount = AccountSummary & { movements: number };

export interface DayClosingStatus {
  closedAt: string;
  /** Los movimientos de ese día cambiaron después del cierre. */
  changed: boolean;
}

export interface DaySummary {
  day: string;
  movements: number;
  /** De esos, los que ya estaban en una cartola de un día anterior: el banco los pasó a este día. */
  seenBefore: number;
  /** Los que ya estaban en una cartola de este día pero el banco fechó después. */
  datedLater: number;
  totals: Report['totals'];
  accounts: DayAccount[];
  /** Cartolas descargadas ese día. */
  hitos: Hito[];
  closing: DayClosingStatus | null;
}

export interface DailyResponse {
  /** Hora de Chile del cierre automático; null si el servidor no cierra solo. */
  closingHour: number | null;
  /** Último día que ya debería estar cerrado. */
  lastClosable: string | null;
  days: DaySummary[];
}

export interface DayMovement {
  id: number;
  /** Fecha contable (la del banco). */
  date: string;
  seq: number;
  amount: number;
  direction: 'C' | 'A';
  description: string;
  kind: string;
  counterparty: string | null;
  payee_name: string | null;
  category_name: string | null;
  category_color: string | null;
  system_key: string | null;
  label: string | null;
  balance_after: number | null;
  provisional: number;
  /** N° de nómina de Pago Fácil dentro del día; null si no es nómina. */
  payroll_batch: number | null;
  first_seen_day: string | null;
  first_seen_at: string | null;
  real_date: string | null;
  real_date_source: RealDateSource | null;
}

/**
 * Un movimiento del día, una cartola, o uno que se muestra en el día sin sumar en su saldo:
 * - 'later' (por fecha del banco): ya estaba en una cartola de este día, pero el banco lo fechó después.
 * - 'earlier' (por fecha real): el banco lo fechó este día, pero es de un día anterior y ya se contó ahí.
 */
export type DayEntry =
  | { type: 'movement'; movement: DayMovement }
  | { type: 'hito'; hito: Hito }
  | { type: 'later'; movement: DayMovement }
  | { type: 'earlier'; movement: DayMovement };

export interface DayAccountDetail {
  accountId: number;
  name: string;
  isCard: boolean;
  opening: number | null;
  closing: number | null;
  /** En el orden del banco, del más antiguo al más reciente, con cada cartola donde corresponde. */
  entries: DayEntry[];
}

export interface ClosingSnapshot {
  day: string;
  closedAt: string;
  /** Por qué fecha está la foto: un cierre de antes de la fecha real solo la tiene por fecha del banco. */
  dates: DateMode;
  report: Omit<Report, 'note'>;
  detail: { day: string; accounts: DayAccountDetail[] };
  coverage: Array<{ accountId: number; name: string; lastMovement: string | null; lastCartola: string | null }>;
}

export interface DayDetailResponse {
  day: string;
  accounts: DayAccountDetail[];
  closing: (DayClosingStatus & { day: string; hash: string; snapshot: ClosingSnapshot }) | null;
}
