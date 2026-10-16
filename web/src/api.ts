// Cliente de la API. Todas las escrituras llevan el header que el servidor exige contra CSRF.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const isRaw = body instanceof ArrayBuffer;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method !== 'GET' ? { 'x-requested-with': 'syncbanks' } : {}),
      ...(body !== undefined && !isRaw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/auth/login')) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Error ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, file: ArrayBuffer, filename: string) =>
    request<T>('POST', url, file, { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(filename) }),
};

export const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---------- Tipos (espejo de lo que devuelve el servidor) ----------

export interface Account {
  id: number;
  number: string;
  number_formatted: string;
  bank: string;
  name: string;
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
  system_key: string | null;
}

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
  kind: 'account' | 'credit_line';
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
