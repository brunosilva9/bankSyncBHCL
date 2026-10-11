// Cartolas Excel de BancoEstado (cuenta corriente empresa). Hay dos formatos:
//
//  - "Cartola Histórica" (consolidada, numerada): hojas "Resumen" y "Movimientos".
//  - "Cartola en Línea" (provisoria): hojas "Resumen" y "Registros". Trae lo ocurrido desde la
//    última cartola consolidada y se reemplaza cuando sale la siguiente.
//
// En ambas, cada fila trae el saldo después del movimiento y vienen del más reciente al más antiguo.

import ExcelJS from 'exceljs';
import { formatRut } from '../domain/classify.js';
import { CartolaParseError, type ParsedCartola, type ParsedMovement } from './cartola.js';

type Cell = ExcelJS.CellValue;

function cellText(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return cellText(v.result as Cell);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
}

/** Valores no vacíos de una fila, sin las repeticiones que generan las celdas combinadas. */
function rowTexts(row: ExcelJS.Row): string[] {
  const out: string[] = [];
  row.eachCell({ includeEmpty: false }, (cell) => {
    const t = cellText(cell.value);
    if (t && out[out.length - 1] !== t) out.push(t);
  });
  return out;
}

/** "$3.127.291" / 3127291 / "-1.000" -> número entero de pesos. */
function pesos(v: Cell): number {
  if (typeof v === 'number') return Math.round(v);
  const t = cellText(v).replace(/[^\d-]/g, '');
  return t === '' || t === '-' ? 0 : Number(t);
}

/** "11/10/2026" (o "11/10/2026-14:59") -> "2026-10-11". */
function isoDate(text: string): string | null {
  const m = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const normalizeLabel = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export function isXlsx(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK": un .xlsx es un zip
}

export async function parseBancoEstadoXlsx(bytes: Uint8Array): Promise<ParsedCartola> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  } catch {
    throw new CartolaParseError('No se pudo leer el archivo Excel');
  }

  const summary = wb.getWorksheet('Resumen');
  const movementsSheet = wb.getWorksheet('Movimientos') ?? wb.getWorksheet('Registros');
  if (!summary || !movementsSheet) throw new CartolaParseError('No parece una cartola de BancoEstado (faltan las hojas Resumen y Movimientos/Registros)');
  const provisional = movementsSheet.name === 'Registros';

  // Resumen: pares "etiqueta, valor" (y una línea suelta "Fecha - Hora dd/mm/aaaa-hh:mm").
  const fields = new Map<string, string>();
  let downloadedAt: string | null = null;
  let isBancoEstado = false;
  summary.eachRow((row) => {
    const texts = rowTexts(row);
    if (texts.some((t) => /bancoestado/i.test(t))) isBancoEstado = true;
    if (texts.length === 1 && /fecha\s*-\s*hora/i.test(texts[0])) downloadedAt = isoDate(texts[0]);
    for (let i = 0; i + 1 < texts.length; i += 2) fields.set(normalizeLabel(texts[i]), texts[i + 1]);
  });
  if (!isBancoEstado) throw new CartolaParseError('El Excel no es una cartola de BancoEstado');

  const field = (...labels: string[]) => labels.map((l) => fields.get(normalizeLabel(l))).find((v) => v !== undefined) ?? null;

  const accountNumber = (field('N° Cuenta Corriente', 'Cuenta Corriente') ?? '').match(/\d{6,}/)?.[0];
  if (!accountNumber) throw new CartolaParseError('No se encontró el número de cuenta en la hoja Resumen');

  // Movimientos: las columnas se ubican por el encabezado.
  const header = movementsSheet.getRow(1);
  const col = new Map<string, number>();
  header.eachCell((cell, n) => col.set(normalizeLabel(cellText(cell.value)), n));
  const colOf = (...names: string[]) => names.map((n) => col.get(normalizeLabel(n))).find((n) => n !== undefined);
  const cDate = colOf('Fecha');
  const cDesc = colOf('Descripción');
  const cOp = colOf('N° Operación');
  const cOut = colOf('Cheques / Cargos', 'Cargo', 'Cargos');
  const cIn = colOf('Depósitos / Abonos', 'Abono', 'Abonos');
  const cBal = colOf('Saldo');
  if (!cDate || !cDesc || !cOut || !cIn || !cBal) throw new CartolaParseError('Faltan columnas en la hoja de movimientos');

  const movements: ParsedMovement[] = [];
  movementsSheet.eachRow((row, n) => {
    if (n === 1) return;
    const date = isoDate(cellText(row.getCell(cDate).value));
    if (!date) return;
    const out = pesos(row.getCell(cOut).value);
    const inn = pesos(row.getCell(cIn).value);
    if (out === 0 && inn === 0) return;
    const op = cOp ? cellText(row.getCell(cOp).value).replace(/^0+/, '') : '';
    movements.push({
      date,
      amount: out > 0 ? out : inn,
      direction: out > 0 ? 'C' : 'A',
      description: cellText(row.getCell(cDesc).value).replace(/\s+/g, ' '),
      docNumber: op || null,
      position: movements.length,
      balance: pesos(row.getCell(cBal).value),
    });
  });

  // Se espera del más reciente al más antiguo; si viniera al revés, se invierte.
  if (movements.length > 1 && movements[0].date < movements[movements.length - 1].date) {
    movements.reverse();
    movements.forEach((m, i) => (m.position = i));
  }

  const finalBalance = field('Saldo Final', 'Saldo Contable');
  const balance = finalBalance !== null ? pesos(finalBalance) : (movements[0]?.balance ?? null);
  if (balance === null) throw new CartolaParseError('No se encontró el saldo final');

  const dates = movements.map((m) => m.date).sort();
  const companyRut = field('Rut Empresa');
  return {
    bank: 'BancoEstado',
    accountNumber,
    balance,
    balanceDate: downloadedAt ?? dates[dates.length - 1] ?? new Date().toISOString().slice(0, 10),
    movements,
    fromDate: dates[0] ?? null,
    toDate: dates[dates.length - 1] ?? null,
    statement: {
      kind: provisional ? 'provisional' : 'consolidated',
      number: provisional ? null : (field('N° Cartola') ?? null),
      fromDate: isoDate(field('Fecha Inicio') ?? ''),
      toDate: isoDate(field('Fecha Final') ?? ''),
    },
    company: { name: field('Nombre Empresa'), rut: companyRut ? formatRut(companyRut) : null },
  };
}
