import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';

export const ACC_A = '01111111101';
export const ACC_B = '02222222202';

interface LineSpec {
  date: string; // YYYY-MM-DD
  amount: number;
  type: 'C' | 'A';
  desc: string;
}

/** Arma una línea con el mismo formato de ancho fijo que la cartola .txt del banco. */
function line(account: string, date: string, code: string, amount: number, sign: '+' | '-', desc: string, type: string) {
  const d = date.replace(/-/g, '');
  const head = code === '00' ? `${account}${d}${'0'.repeat(18)}` : `${account}${d}${code}0000000        0`;
  return `${head}${String(amount).padStart(21, '0')}${sign}000${desc.padEnd(45).slice(0, 45)}${type}${d}00000`;
}

/** Movimientos del más reciente al más antiguo, como los entrega el banco. */
export function cartola(account: string, balanceDate: string, balance: number, movements: LineSpec[]): string {
  return [
    line(account, balanceDate, '98', 0, '+', 'RETENCIONES + 1 DIA', 'S'),
    line(account, balanceDate, '97', 0, '+', 'RETENCIONES 1 DIA', 'S'),
    line(account, balanceDate, '99', Math.abs(balance), balance < 0 ? '-' : '+', 'SALDO CONTABLE', 'S'),
    ...movements.map((m) => line(account, m.date, '00', m.amount, '+', m.desc, m.type)),
  ].join('\r\n');
}

// SQLCipher no permite cifrar bases en memoria, así que cada test usa un archivo temporal.
export const testDb = () => openDb(path.join(os.tmpdir(), `syncbanks-test-${crypto.randomUUID()}.db`), 'clave-de-prueba');
