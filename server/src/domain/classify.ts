// Interpreta la descripción de un movimiento: qué tipo de operación es y con quién.

export type MovementKind =
  | 'transfer_out'
  | 'transfer_in'
  | 'payroll' // Pago Fácil Bch: pago de nómina, una línea por trabajador
  | 'card_payment' // "Pago: Comercio"
  | 'credit_line'
  | 'loan_payment'
  | 'bank_fee'
  | 'cheque'
  | 'atm'
  | 'other';

export interface Classification {
  kind: MovementKind;
  /** Nombre de la contraparte, comercio o RUT formateado (en nómina). */
  counterparty: string | null;
  /** RUT de la contraparte cuando la descripción lo trae (BancoEstado, Pago Fácil). */
  counterpartyRut?: string | null;
}

export const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase())
    .replace(/\b(Spa|Sa|Ltda|Eirl)\b/g, (w) => w.toUpperCase());

/** "0111111111" -> "11.111.111-1"; "012345678k" -> "12.345.678-K". */
export function formatRut(raw: string): string | null {
  const clean = raw.replace(/[^0-9kK]/g, '').replace(/^0+/, '').toUpperCase();
  if (clean.length < 2) return null;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  if (!/^\d+$/.test(body)) return null;
  return `${body.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${dv}`;
}

const PATTERNS: Array<[RegExp, MovementKind]> = [
  [/^(app-)?traspaso a:\s*(.+)$/i, 'transfer_out'],
  [/^(app-)?traspaso de:\s*(.+)$/i, 'transfer_in'],
];

export function classifyDescription(description: string): Classification {
  const d = description.trim();

  // BancoEstado: "Transferencia otro banco de rut 33333333-3 sociedad ejemplo limitada" / "... a rut 11111111-1"
  const be = d.match(/^transferencia\b.*?\b(de|desde|a)\s+rut\s+([\dkK.]+-?[\dkK])\s*(.*)$/i);
  if (be) {
    const rut = formatRut(be[2]);
    const name = be[3].trim();
    return {
      kind: be[1].toLowerCase() === 'a' ? 'transfer_out' : 'transfer_in',
      counterparty: name ? titleCase(name) : rut,
      counterpartyRut: rut,
    };
  }
  if (/^compra\b/i.test(d)) return { kind: 'card_payment', counterparty: null };

  for (const [re, kind] of PATTERNS) {
    const m = d.match(re);
    if (m) return { kind, counterparty: m[2].trim() };
  }

  const payroll = d.match(/^pago f.cil bch:\s*(\S+)/i);
  if (payroll) {
    const rut = formatRut(payroll[1]);
    return { kind: 'payroll', counterparty: rut ?? payroll[1], counterpartyRut: rut };
  }

  if (/l(i|í)nea de cr(e|é)dito|l\.cred/i.test(d)) {
    if (/^(impuesto|intereses)/i.test(d)) return { kind: 'bank_fee', counterparty: 'Banco de Chile' };
    return { kind: 'credit_line', counterparty: 'Línea de crédito' };
  }
  if (/^(comision|comisión|intereses|impuesto|cargo seguro)/i.test(d)) return { kind: 'bank_fee', counterparty: 'Banco de Chile' };
  if (/^pago de creditos/i.test(d)) return { kind: 'loan_payment', counterparty: 'Banco de Chile' };
  if (/^cheque/i.test(d)) return { kind: 'cheque', counterparty: null };
  if (/^giro cajero/i.test(d)) return { kind: 'atm', counterparty: null };

  const pago = d.match(/^pago:\s*(.+)$/i);
  if (pago) return { kind: 'card_payment', counterparty: pago[1].trim() };

  return { kind: 'other', counterparty: null };
}

export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * La cartola corta la descripción a 45 caracteres, así que la misma persona aparece como
 * "Maria Fernanda Soto Valenzuela" y "Maria Fernanda Soto Valenzue". Dos nombres son la misma
 * contraparte si uno es prefijo del otro (con un mínimo de largo para no confundir nombres cortos).
 */
export function sameCounterparty(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.startsWith(short);
}
