// Tarjetas de crédito: CMR de Banco Falabella (facturados y no facturados) y BancoEstado (movimientos
// nacionales por facturar). Ninguna planilla trae el saldo ni la deuda: solo movimientos.
//
// Cada compra se registra una vez, completa y en la fecha en que se hizo. Las compras en cuotas vuelven
// a aparecer en cada estado de cuenta mientras se pagan (con su fecha original), así que al importar se
// reconocen como la misma compra (ver sameCardPurchase).
//
// CMR: MONTO es la compra completa y VALOR CUOTA lo que se cobra en este estado de cuenta (negativo en
// pagos y devoluciones; 0 en filas que no son un cargo nuevo, como "ACELERACION CAPITAL X FACTURAR").
// La misma compra cambia de redacción y hasta 2 días de fecha entre "no facturados" y "facturados":
// "COMPRA CUOTAS SIN INTERES FERRETERIA" 19/08 y "COMPRA EN CUOTAS FERRETERIA" 20/08.
//
// BancoEstado: solo trae la cuota ("TIENDA EJEMPLO   10-12 CUOTA", monto de la cuota). El total de la
// compra se calcula como cuota × número de cuotas (incluye los intereses que tenga la cuota).

import { titleCase } from '../domain/classify.js';
import { CartolaParseError, type Direction } from './cartola.js';
import { norm, readWorkbook, type Detection, type Sheet } from './detect.js';

export type CardMovementKind = 'credit_card_purchase' | 'credit_card_payment' | 'credit_card_advance' | 'bank_fee' | 'atm';
export type CardBank = 'Banco Falabella' | 'BancoEstado';

export interface CardMovement {
  date: string; // YYYY-MM-DD
  /** Compra completa, siempre positiva. En BancoEstado, cuota × número de cuotas. */
  amount: number;
  /** C = cargo (compra, comisión); A = abono (pago de la tarjeta, devolución). */
  direction: Direction;
  description: string;
  kind: CardMovementKind;
  counterparty: string | null;
  /** Compra en cuotas: cuántas son (si el banco lo dice) y el valor de cada una. */
  installments: number | null;
  installmentAmount: number | null;
}

export interface ParsedCard {
  type: 'card';
  bank: CardBank;
  /** Identifica la tarjeta entre las cuentas del usuario: "CMR" o "**** 1234". */
  cardNumber: string;
  cardName: string;
  /** true: estado de cuenta ya cerrado (facturados). false: movimientos que aún no se facturan. */
  billed: boolean;
  /** Día de la descarga o, si el archivo no lo trae, el del movimiento más reciente. */
  asOf: string;
  fromDate: string | null;
  toDate: string | null;
  movements: CardMovement[];
}

export const isCard = (p: object): p is ParsedCard => (p as { type?: string }).type === 'card';

/** Tarjeta de crédito de un archivo ya reconocido por detectStatement. */
export async function parseCreditCard(bytes: Uint8Array, d: Detection): Promise<ParsedCard> {
  const wb = await readWorkbook(bytes);
  if (!wb) throw new CartolaParseError('No se pudo leer la planilla de la tarjeta');
  if (d.format === 'falabella-cmr') return parseCmr(wb.sheets, d);
  if (d.format === 'bancoestado-tarjeta-por-facturar') return parseBancoEstadoCard(wb.sheets, d);
  throw new CartolaParseError(`Formato de tarjeta no soportado: ${d.format}`);
}

// ---------- CMR (Banco Falabella) ----------

const CMR_COLUMNS = ['fecha', 'descripcion', 'titular/adicional', 'monto', 'cuotas pendientes', 'valor cuota'];

function parseCmr(sheets: Sheet[], d: Detection): ParsedCard {
  const sheet = sheets.find((s) => headerIndex(s, CMR_COLUMNS) >= 0)!;
  const start = headerIndex(sheet, CMR_COLUMNS) + 1;
  const movements: CardMovement[] = [];
  for (const [i, row] of sheet.rows.slice(start).entries()) {
    const [fecha, desc, holder, monto, , valor] = row.map((c) => (c ?? '').trim());
    if (!fecha && !desc) continue;
    const line = start + i + 1;
    const amount = pesos(monto, line);
    const charged = pesos(valor, line);
    // Aceleración de capital, interés registrado aún no cobrado: informan, pero no son un cargo nuevo.
    if (charged === 0) continue;
    const direction: Direction = charged < 0 ? 'A' : 'C';
    const description = desc.replace(/\s+/g, ' ') + (norm(holder) === 'adicional' ? ' (adicional)' : '');
    const installment = charged > 0 && charged !== Math.abs(amount);
    movements.push({
      date: isoDate(fecha, line),
      amount: Math.abs(amount),
      direction,
      description,
      ...classifyCardRow('Banco Falabella', description, direction),
      installments: null,
      installmentAmount: installment ? charged : null,
    });
  }
  return card('Banco Falabella', 'CMR', 'Tarjeta CMR', d.variant === 'movimientos facturados', null, movements);
}

// ---------- BancoEstado ----------

const BE_COLUMNS = ['fecha', 'descripcion', 'ciudad', 'monto ($)'];

function parseBancoEstadoCard(sheets: Sheet[], d: Detection): ParsedCard {
  const sheet = sheets.find((s) => headerIndex(s, BE_COLUMNS) >= 0)!;
  const start = headerIndex(sheet, BE_COLUMNS) + 1;
  // Fecha y hora de la descarga, en los datos del cliente: "19/10/2026 15:05:22".
  const downloaded = sheet.rows.slice(0, start).flat().find((c) => /^\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}/.test(c ?? ''));
  const movements: CardMovement[] = [];
  for (const [i, row] of sheet.rows.slice(start).entries()) {
    const [fecha, desc, , monto] = row.map((c) => (c ?? '').trim());
    if (!fecha && !desc) continue;
    const line = start + i + 1;
    const value = pesos(monto, line);
    const direction: Direction = value < 0 ? 'C' : 'A';
    // La descripción es de ancho fijo: comercio y al final "COMPRAS" o "2-10 CUOTA" (cuota 2 de 10).
    const cuota = desc.match(/^(.*?)\s*(\d+)-(\d+)\s+CUOTA$/i);
    const merchant = (cuota ? cuota[1] : desc.replace(/COMPRAS$/i, '')).replace(/\s+/g, ' ').trim();
    const installments = cuota ? Number(cuota[3]) : null;
    movements.push({
      date: isoDate(fecha, line),
      amount: Math.abs(value) * (installments ?? 1),
      direction,
      description: merchant,
      ...classifyCardRow('BancoEstado', merchant, direction),
      installments,
      installmentAmount: installments ? Math.abs(value) : null,
    });
  }
  const name = d.card?.name ?? 'Tarjeta';
  const number = `**** ${d.card!.last4}`;
  return card('BancoEstado', number, `${name} ${number}`, false, downloaded ? isoDate(downloaded.slice(0, 10), 0) : null, movements);
}

// ---------- Comunes ----------

function card(bank: CardBank, cardNumber: string, cardName: string, billed: boolean, asOf: string | null, movements: CardMovement[]): ParsedCard {
  if (movements.length === 0) throw new CartolaParseError('La planilla de la tarjeta no trae movimientos');
  const dates = movements.map((m) => m.date).sort();
  return { type: 'card', bank, cardNumber, cardName, billed, asOf: asOf ?? dates[dates.length - 1], fromDate: dates[0], toDate: dates[dates.length - 1], movements };
}

function classifyCardRow(bank: CardBank, description: string, direction: Direction): Pick<CardMovement, 'kind' | 'counterparty'> {
  const d = norm(description);
  if (/^pago\b/.test(d) && direction === 'A') return { kind: 'credit_card_payment', counterparty: bank };
  // Avance: si se transfirió a una cuenta es plata propia que cambia de lugar; en efectivo, como un giro.
  if (/^avance\b/.test(d)) return /transferencia/.test(d) ? { kind: 'credit_card_advance', counterparty: bank } : { kind: 'atm', counterparty: null };
  if (/^(servicio administracion|comision|impuesto|interes|seguro|mantencion|cargo)/.test(d)) return { kind: 'bank_fee', counterparty: bank };
  const merchant = description
    .replace(/\s*\(adicional\)$/i, '')
    .replace(/^(devolucion\s+)?compra(\s+en\s+cuotas|\s+cuotas\s+sin\s+interes|\s+cuotas)?\s+/i, '')
    .trim();
  return { kind: 'credit_card_purchase', counterparty: merchant ? titleCase(merchant) : null };
}

/**
 * Lo que identifica a una compra aunque cambie la redacción: sin "COMPRA EN CUOTAS" / "COMPRA CUOTAS SIN
 * INTERES" / "COMPRA", sin mayúsculas ni signos.
 */
export function merchantKey(description: string): string {
  return norm(description)
    .replace(/\s*\(adicional\)$/, '')
    .replace(/^compra(\s+en\s+cuotas|\s+cuotas\s+sin\s+interes|\s+cuotas)?\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Días máximos entre dos apariciones de la misma compra (CMR la corre hasta 2 días entre archivos). */
export const SAME_PURCHASE_DAYS = 3;

type Comparable = Pick<CardMovement, 'date' | 'amount' | 'direction' | 'description' | 'installments' | 'installmentAmount'>;

/** ¿Es la misma compra? Mismo comercio y sentido, fecha cercana y mismo monto (o misma cuota, con redondeo). */
export function sameCardPurchase(a: Comparable, b: Comparable): boolean {
  if (a.direction !== b.direction || merchantKey(a.description) !== merchantKey(b.description)) return false;
  if (dayDiff(a.date, b.date) > SAME_PURCHASE_DAYS) return false;
  // BancoEstado: el total es calculado y la última cuota suele venir ajustada por redondeo.
  if (a.installments && a.installments === b.installments && a.installmentAmount && b.installmentAmount) {
    return Math.abs(a.installmentAmount - b.installmentAmount) <= Math.max(100, b.installmentAmount * 0.02);
  }
  return a.amount === b.amount;
}

export const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

function headerIndex(s: Sheet, columns: string[]): number {
  return s.rows.findIndex((r) => r.filter((c) => (c ?? '').trim() !== '').map(norm).join('|') === columns.join('|'));
}

/** "-150000", "4990", "$ 1.000" -> número de pesos. */
function pesos(raw: string, line: number): number {
  const clean = raw.replace(/[$\s.]/g, '').replace(',', '.');
  const n = Number(clean);
  if (raw === '' || !Number.isFinite(n)) throw new CartolaParseError(`Fila ${line}: monto inválido "${raw}"`);
  return Math.round(n);
}

/** "2026-09-24" (fecha de Excel) o "04/08/2026" / "04-08-2026" -> "2026-08-04". */
function isoDate(raw: string, line: number): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (!m) throw new CartolaParseError(`Fila ${line}: fecha inválida "${raw}"`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}
