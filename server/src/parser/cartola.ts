// Parser de la cartola en formato .txt de Banco de Chile (ancho fijo, 121 caracteres, latin-1).
//
// Posiciones (0-based, fin exclusivo):
//   [0:11]    número de cuenta sin el primer "0" (ej. 01234567809 = 00-123-45678-09)
//   [11:19]   fecha AAAAMMDD
//   [19:21]   código de línea de resumen (97/98 retenciones, 99 saldo contable); "00" en movimientos
//   [19:37]   número de documento (cheques); ceros si no aplica
//   [37:58]   monto en pesos
//   [58]      signo (+/-), relevante para el saldo
//   [62:107]  descripción
//   [107]     tipo: C = cargo, A = abono, S = línea de saldo/retención

export type Direction = 'C' | 'A';

export interface ParsedMovement {
  date: string; // YYYY-MM-DD
  amount: number; // siempre positivo, en CLP
  direction: Direction;
  description: string;
  docNumber: string | null;
  /** Posición dentro del archivo: 0 = el más reciente. */
  position: number;
  /** Saldo después del movimiento, cuando el banco lo entrega (BancoEstado). */
  balance?: number;
}

export type Bank = 'Banco de Chile' | 'BancoEstado';

/**
 * BancoEstado entrega cartolas numeradas y consolidadas (una por semana) y una "cartola en línea"
 * provisoria con lo ocurrido desde la última consolidada, que se reemplaza cuando sale la siguiente.
 */
export interface StatementInfo {
  kind: 'consolidated' | 'provisional';
  number: string | null;
  /** Rango que cubre la cartola según el banco (puede no tener movimientos en todos los días). */
  fromDate: string | null;
  toDate: string | null;
}

export interface ParsedCartola {
  accountNumber: string;
  /** Fecha de las líneas de saldo (día en que se descargó la cartola). */
  balanceDate: string;
  /** Saldo contable al momento de la descarga; incluye todos los movimientos del archivo. */
  balance: number;
  movements: ParsedMovement[];
  fromDate: string | null;
  toDate: string | null;
  bank: Bank;
  statement?: StatementInfo;
  company?: { name: string | null; rut: string | null };
}

export class CartolaParseError extends Error {}

const LINE_LENGTH = 121;

function toIsoDate(yyyymmdd: string, lineNo: number): string {
  if (!/^\d{8}$/.test(yyyymmdd)) throw new CartolaParseError(`Línea ${lineNo}: fecha inválida "${yyyymmdd}"`);
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function cleanDescription(raw: string): string {
  // El banco a veces mete bytes de control (ej. "Protecci\xf3\x93n"); se eliminan.
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Decodifica el archivo tal como lo entrega el banco (ISO-8859-1). No se usa TextDecoder('latin1')
 * porque en realidad aplica windows-1252 y convierte los bytes basura del banco en comillas.
 */
export function decodeCartola(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

export function parseCartola(text: string): ParsedCartola {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new CartolaParseError('El archivo está vacío');

  let accountNumber: string | null = null;
  let balance: number | null = null;
  let balanceDate: string | null = null;
  const movements: ParsedMovement[] = [];

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (line.length < LINE_LENGTH) {
      throw new CartolaParseError(`Línea ${lineNo}: largo ${line.length}, se esperaban ${LINE_LENGTH} caracteres. ¿Es una cartola .txt de Banco de Chile?`);
    }
    const account = line.slice(0, 11);
    if (!/^\d{11}$/.test(account)) throw new CartolaParseError(`Línea ${lineNo}: número de cuenta inválido`);
    if (accountNumber === null) accountNumber = account;
    else if (account !== accountNumber) throw new CartolaParseError(`Línea ${lineNo}: el archivo mezcla cuentas (${accountNumber} y ${account})`);

    const date = toIsoDate(line.slice(11, 19), lineNo);
    const amountRaw = line.slice(37, 58);
    if (!/^\d+$/.test(amountRaw)) throw new CartolaParseError(`Línea ${lineNo}: monto inválido`);
    const amount = Number(amountRaw);
    const sign = line[58];
    const kind = line[107];

    if (kind === 'S') {
      if (line.slice(19, 21) === '99') {
        balance = sign === '-' ? -amount : amount;
        balanceDate = date;
      }
      return;
    }
    if (kind !== 'C' && kind !== 'A') throw new CartolaParseError(`Línea ${lineNo}: tipo de movimiento desconocido "${kind}"`);

    const doc = line.slice(19, 37).replace(/^0+/, '');
    movements.push({
      date,
      amount,
      direction: kind,
      description: cleanDescription(line.slice(62, 107)),
      docNumber: doc === '' ? null : doc,
      position: movements.length,
    });
  });

  if (balance === null || balanceDate === null) throw new CartolaParseError('No se encontró la línea de SALDO CONTABLE');

  const dates = movements.map((m) => m.date).sort();
  return {
    bank: 'Banco de Chile',
    accountNumber: accountNumber!,
    balance,
    balanceDate,
    movements,
    fromDate: dates[0] ?? null,
    toDate: dates[dates.length - 1] ?? null,
  };
}

/** Número de cuenta como lo muestra cada banco. */
export function displayAccountNumber(bank: string, n: string): string {
  return bank === 'Banco de Chile' ? formatAccountNumber(n) : n;
}

/** "01234567809" -> "00-123-45678-09" (como lo muestra Banco de Chile). */
export function formatAccountNumber(n: string): string {
  const full = n.padStart(12, '0');
  return `${full.slice(0, 2)}-${full.slice(2, 5)}-${full.slice(5, 10)}-${full.slice(10)}`;
}
