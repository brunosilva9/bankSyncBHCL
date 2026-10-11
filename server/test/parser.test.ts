import { describe, expect, it } from 'vitest';
import { CartolaParseError, decodeCartola, formatAccountNumber, parseCartola } from '../src/parser/cartola.js';
import { ACC_A, cartola } from './helpers.js';

describe('parseCartola', () => {
  const text = cartola(ACC_A, '2026-10-11', -123456, [
    { date: '2026-10-13', amount: 246813, type: 'C', desc: 'Traspaso A: Pedro Gonzalez Rojas' },
    { date: '2026-10-09', amount: 1357913, type: 'A', desc: 'Traspaso De: Frutas Del Sur Spa' },
  ]);

  it('lee cuenta, saldo contable (con signo) y movimientos', () => {
    const p = parseCartola(text);
    expect(p.accountNumber).toBe(ACC_A);
    expect(p.balance).toBe(-123456);
    expect(p.balanceDate).toBe('2026-10-11');
    expect(p.movements).toHaveLength(2);
    expect(p.movements[0]).toMatchObject({ date: '2026-10-13', amount: 246813, direction: 'C', description: 'Traspaso A: Pedro Gonzalez Rojas', position: 0 });
    expect(p.fromDate).toBe('2026-10-09');
    expect(p.toDate).toBe('2026-10-13');
  });

  it('decodifica latin-1 y elimina caracteres de control', () => {
    const raw = cartola(ACC_A, '2026-10-11', 0, [{ date: '2026-10-01', amount: 1, type: 'C', desc: 'Pago Fácil Bch: 0111111111' }]);
    // El byte basura ocupa uno de los 45 caracteres de la descripción, como en la cartola real.
    const withControl = raw.replace('Pago Fácil Bch: 0111111111 ', 'Pago Fá\u0093cil Bch: 0111111111');
    const bytes = Uint8Array.from([...withControl].map((c) => c.charCodeAt(0)));
    expect(parseCartola(decodeCartola(bytes)).movements[0].description).toBe('Pago Fácil Bch: 0111111111');
  });

  it('rechaza archivos que no son cartolas', () => {
    expect(() => parseCartola('hola\nmundo')).toThrow(CartolaParseError);
  });

  it('rechaza archivos que mezclan cuentas', () => {
    const mixed = text + '\r\n' + text.split('\r\n')[3].replace(ACC_A, '09999999999');
    expect(() => parseCartola(mixed)).toThrow(/mezcla cuentas/);
  });

  it('formatea el número de cuenta como el banco', () => {
    expect(formatAccountNumber('01234567809')).toBe('00-123-45678-09');
  });
});
