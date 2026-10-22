// Reconoce qué es un archivo de cartola (banco, producto y variante) solo por su contenido, sin
// importar cómo se llame. Cada formato conocido tiene una "firma": el título, las columnas o el
// nombre de la hoja que lo delatan. Si el archivo trae el número de cuenta (o de tarjeta) también se
// devuelve; varios formatos no lo traen (p. ej. los .xls de Banco Falabella) y la cuenta habrá que
// deducirla de otra forma.
//
// Formatos reconocidos (los marcados con * ya se pueden importar):
//   Banco de Chile   .txt cuenta corriente* y línea de crédito*, .xls antiguo de cuenta corriente
//   BancoEstado      empresa: cartola histórica* y en línea*; persona: cartola histórica y últimos
//                    movimientos de cuenta corriente, línea de crédito; tarjeta: por facturar
//   Banco Falabella  .xls de cuenta corriente y de línea de crédito; tarjeta CMR facturada y por facturar

import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { isCreditLineCartola } from '../domain/creditLine.js';
import { decodeCartola, parseCartola } from './cartola.js';

export type DetectedBank = 'Banco de Chile' | 'BancoEstado' | 'Banco Falabella';
export type Product = 'cuenta_corriente' | 'linea_credito' | 'tarjeta_credito';

export interface Detection {
  /** Identificador del formato, p. ej. "falabella-cc-xls". */
  format: string;
  bank: DetectedBank;
  product: Product;
  /** Qué parte del producto trae: "cartola histórica", "no facturados"... */
  variant: string;
  /** Número de la cuenta (o de la línea) si el archivo lo trae. */
  accountNumber: string | null;
  /** Línea de crédito: la cuenta corriente a la que está asociada. */
  linkedAccount: string | null;
  /** Tarjeta: nombre del producto y últimos 4 dígitos, si vienen. */
  card: { name: string | null; last4: string } | null;
  /** Si ya se puede importar. */
  supported: boolean;
  /** Por qué se reconoció (para mostrar y para depurar). */
  evidence: string[];
}

export const PRODUCT_LABEL: Record<Product, string> = {
  cuenta_corriente: 'Cuenta corriente',
  linea_credito: 'Línea de crédito',
  tarjeta_credito: 'Tarjeta de crédito',
};

/** "Banco Falabella · Tarjeta de crédito CMR (no facturados) **** 1234" */
export function describeDetection(d: Detection): string {
  const card = d.card ? ` ${d.card.name ?? ''}${d.card.last4 ? ` **** ${d.card.last4}` : ''}`.trimEnd() : '';
  const number = d.accountNumber ? ` N° ${d.accountNumber}` : '';
  return `${d.bank} · ${PRODUCT_LABEL[d.product]}${card} (${d.variant})${number}`;
}

export const isXlsx = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b; // un .xlsx es un zip ("PK")
export const isXls = (b: Uint8Array) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0; // OLE2/BIFF

// ---------- Vista uniforme de una planilla (.xlsx o .xls) ----------

interface Sheet {
  name: string;
  /** Texto de cada celda, fila por fila (las filas vacías se conservan para no correr índices). */
  rows: string[][];
}
interface Workbook {
  kind: 'xlsx' | 'xls';
  sheets: Sheet[];
  creator: string | null;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    return '';
  }
  return String(v).trim();
}

async function loadXlsx(bytes: Uint8Array): Promise<Workbook | null> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  } catch {
    return null;
  }
  const sheets = wb.worksheets.map((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const cells: string[] = [];
      // En una celda combinada ExcelJS repite el valor en todas sus celdas: solo cuenta la principal.
      row.eachCell({ includeEmpty: true }, (cell, c) => (cells[c - 1] = cell.isMerged && cell.master !== cell ? '' : cellText(cell.value)));
      rows[n - 1] = Array.from(cells, (c) => c ?? '');
    });
    return { name: ws.name, rows: Array.from(rows, (r) => r ?? []) };
  });
  return { kind: 'xlsx', sheets, creator: wb.creator || null };
}

function loadXls(bytes: Uint8Array): Workbook | null {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, { type: 'buffer', cellDates: false });
  } catch {
    return null;
  }
  const sheets = wb.SheetNames.map((name) => ({
    name,
    rows: (XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' }) as unknown[][]).map((r) => r.map((c) => String(c ?? '').trim())),
  }));
  return { kind: 'xls', sheets, creator: wb.Props?.Author ?? null };
}

// ---------- Ayudas para las firmas ----------

/** Minúsculas, sin tildes ni espacios repetidos: "Últimos  Movimientos" -> "ultimos movimientos". */
export const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const nonEmpty = (cells: string[]) => cells.filter((c) => c.trim() !== '');
const firstText = (s: Sheet) => s.rows.map(nonEmpty).find((r) => r.length > 0)?.[0] ?? '';
/** La fila cuyas celdas no vacías son exactamente estas columnas (en orden, normalizadas). */
const hasHeader = (s: Sheet, columns: string[]) => s.rows.some((r) => nonEmpty(r).map(norm).join('|') === columns.join('|'));
/** Valor que acompaña a una etiqueta en la misma fila: "Cuenta Corriente Asociada | 99900011122" */
function valueAfter(s: Sheet, label: RegExp): string | null {
  for (const r of s.rows) {
    const cells = nonEmpty(r);
    const i = cells.findIndex((c) => label.test(norm(c)));
    if (i >= 0 && cells[i + 1]) return cells[i + 1];
  }
  return null;
}
const digits = (s: string | null | undefined) => {
  const m = (s ?? '').match(/\d[\d-]{5,}\d/);
  return m ? m[0].replace(/-/g, '') : null;
};
const anyCell = (s: Sheet, re: RegExp) => s.rows.some((r) => r.some((c) => re.test(c)));

type Found = Omit<Detection, 'format' | 'linkedAccount' | 'card' | 'supported'> &
  Partial<Pick<Detection, 'linkedAccount' | 'card' | 'supported'>>;
interface Signature {
  format: string;
  detect(wb: Workbook): Found | null;
}

// El orden importa: primero las firmas más específicas.
const SIGNATURES: Signature[] = [
  {
    format: 'bancoestado-empresa',
    detect(wb) {
      const names = wb.sheets.map((s) => s.name);
      if (!names.includes('Resumen') || !(names.includes('Movimientos') || names.includes('Registros'))) return null;
      const resumen = wb.sheets.find((s) => s.name === 'Resumen')!;
      return {
        bank: 'BancoEstado',
        product: 'cuenta_corriente',
        variant: names.includes('Movimientos') ? 'cartola histórica de empresa' : 'cartola en línea de empresa',
        accountNumber: digits(valueAfter(resumen, /cuenta corriente$/)),
        supported: true,
        evidence: ['hojas "Resumen" + "Movimientos"/"Registros"'],
      };
    },
  },
  {
    format: 'bancoestado-persona-cartola',
    detect(wb) {
      const s = wb.sheets.find((s) => norm(firstText(s)) === 'cartola cuenta corriente');
      if (!s || !anyCell(s, /^Cartola Seleccionada$/i)) return null;
      const numberRow = s.rows.map(nonEmpty).find((r) => /^N\S?\s*\d{6,}$/.test(r[0] ?? ''));
      return {
        bank: 'BancoEstado',
        product: 'cuenta_corriente',
        variant: 'cartola histórica de persona',
        accountNumber: digits(numberRow?.[0]),
        evidence: ['título "CARTOLA CUENTA CORRIENTE" + "Cartola Seleccionada"'],
      };
    },
  },
  {
    format: 'bancoestado-persona-ultimos-cc',
    detect(wb) {
      const s = wb.sheets.find((s) => norm(firstText(s)).startsWith('ultimos movimientos cuenta corrien'));
      if (!s) return null;
      return {
        bank: 'BancoEstado',
        product: 'cuenta_corriente',
        variant: 'últimos movimientos de persona',
        accountNumber: digits(s.name),
        evidence: ['título "Últimos Movimientos Cuenta Corriente"', 'número de cuenta en el nombre de la hoja'],
      };
    },
  },
  {
    format: 'bancoestado-persona-linea',
    detect(wb) {
      const s = wb.sheets.find((s) => norm(firstText(s)).startsWith('ultimos movimientos linea de credi'));
      if (!s) return null;
      return {
        bank: 'BancoEstado',
        product: 'linea_credito',
        variant: 'últimos movimientos de persona',
        accountNumber: digits(s.name),
        linkedAccount: digits(valueAfter(s, /^cuenta corriente asociada/)),
        evidence: ['título "Últimos Movimientos Línea de Crédito"', '"Cuenta Corriente Asociada"'],
      };
    },
  },
  {
    format: 'bancoestado-tarjeta-por-facturar',
    detect(wb) {
      const s = wb.sheets.find((s) => norm(firstText(s)).startsWith('ultimos movimientos nacionales'));
      if (!s || !hasHeader(s, ['fecha', 'descripcion', 'ciudad', 'monto ($)'])) return null;
      const title = firstText(s).replace(/\s+/g, ' ');
      const m = title.match(/nacionales\s+(.*?)\s*N\S?\s*\*+\s*(\d{4})/i);
      return {
        bank: 'BancoEstado',
        product: 'tarjeta_credito',
        variant: 'movimientos nacionales por facturar',
        accountNumber: null,
        card: m ? { name: m[1].trim() || null, last4: m[2] } : null,
        evidence: ['título "Últimos Movimientos Nacionales" con la tarjeta', 'columnas Fecha/Descripción/Ciudad/Monto'],
      };
    },
  },
  {
    format: 'falabella-cmr',
    detect(wb) {
      const cols = ['fecha', 'descripcion', 'titular/adicional', 'monto', 'cuotas pendientes', 'valor cuota'];
      const s = wb.sheets.find((s) => hasHeader(s, cols));
      if (!s) return null;
      const billed = norm(s.name).includes('facturad');
      return {
        bank: 'Banco Falabella',
        product: 'tarjeta_credito',
        variant: billed ? 'movimientos facturados' : 'movimientos no facturados',
        accountNumber: null,
        card: { name: 'CMR', last4: '' },
        evidence: ['columnas TITULAR/ADICIONAL + CUOTAS PENDIENTES + VALOR CUOTA', `hoja "${s.name}"`],
      };
    },
  },
  {
    format: 'falabella-linea-xls',
    detect(wb) {
      const s = wb.sheets.find((s) => hasHeader(s, ['fecha', 'descripcion', 'cargos', 'abonos', 'monto utilizado', 'tasa diaria', 'intereses']));
      if (!s) return null;
      return {
        bank: 'Banco Falabella',
        product: 'linea_credito',
        variant: 'movimientos con intereses diarios',
        accountNumber: null,
        evidence: ['columnas Monto utilizado + Tasa diaria + Intereses'],
      };
    },
  },
  {
    format: 'falabella-cc-xls',
    detect(wb) {
      // Las columnas son genéricas: solo se acepta en el .xls sin preámbulo que exporta Banco Falabella.
      if (wb.kind !== 'xls') return null;
      const s = wb.sheets.find((s) => nonEmpty(s.rows[0] ?? []).map(norm).join('|') === 'fecha|descripcion|cargo|abono|saldo');
      if (!s) return null;
      const evidence = ['.xls sin preámbulo con columnas Fecha/Descripcion/Cargo/Abono/Saldo'];
      if (anyCell(s, /pago tarjeta cmr/i)) evidence.push('pagos a la tarjeta CMR desde la cuenta');
      return { bank: 'Banco Falabella', product: 'cuenta_corriente', variant: 'movimientos', accountNumber: null, evidence };
    },
  },
  {
    format: 'bancochile-xls',
    detect(wb) {
      const s = wb.sheets.find((s) => anyCell(s, /^Canal o Sucursal$/i) && anyCell(s, /^Cuenta N\S?:?$/i));
      if (!s) return null;
      return {
        bank: 'Banco de Chile',
        product: 'cuenta_corriente',
        variant: 'cartola Excel antigua',
        accountNumber: digits(valueAfter(s, /^cuenta n\S?:?$/)),
        evidence: ['"Cuenta N°" + columna "Canal o Sucursal"'],
      };
    },
  },
];

function fromWorkbook(wb: Workbook): Detection | null {
  for (const sig of SIGNATURES) {
    const found = sig.detect(wb);
    if (found) return { linkedAccount: null, card: null, supported: false, ...found, format: sig.format };
  }
  return null;
}

/** Texto ancho fijo de Banco de Chile: 121 caracteres por línea, con la cuenta y la fecha al inicio. */
function fromBancoChileTxt(bytes: Uint8Array): Detection | null {
  const text = decodeCartola(bytes);
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  if (first.length !== 121 || !/^\d{19}/.test(first)) return null;
  let line = false;
  try {
    line = isCreditLineCartola(parseCartola(text));
  } catch {
    return null;
  }
  return {
    format: line ? 'bancochile-linea-txt' : 'bancochile-cc-txt',
    bank: 'Banco de Chile',
    product: line ? 'linea_credito' : 'cuenta_corriente',
    variant: 'cartola .txt',
    accountNumber: first.slice(0, 11),
    linkedAccount: null,
    card: null,
    supported: true,
    evidence: ['texto de ancho fijo (121 caracteres) con cuenta y fecha al inicio'],
  };
}

/** Qué es este archivo, o null si no se parece a ninguna cartola conocida. */
export async function detectStatement(bytes: Uint8Array): Promise<Detection | null> {
  if (isXlsx(bytes)) {
    const wb = await loadXlsx(bytes);
    return wb ? fromWorkbook(wb) : null;
  }
  if (isXls(bytes)) {
    const wb = loadXls(bytes);
    return wb ? fromWorkbook(wb) : null;
  }
  return fromBancoChileTxt(bytes);
}
