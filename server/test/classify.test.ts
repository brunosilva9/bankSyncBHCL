import { describe, expect, it } from 'vitest';
import { classifyDescription, formatRut, sameCounterparty } from '../src/domain/classify.js';

describe('classifyDescription', () => {
  it.each([
    ['Traspaso A: Pedro Gonzalez Rojas', 'transfer_out', 'Pedro Gonzalez Rojas'],
    ['App-traspaso A: Maria Fernanda Soto Valenzue', 'transfer_out', 'Maria Fernanda Soto Valenzue'],
    ['Traspaso De: Agricola Los Robles Spa', 'transfer_in', 'Agricola Los Robles Spa'],
    ['Pago Fácil Bch: 012345678k', 'payroll', '12.345.678-K'],
    ['Pago: Comercial El Faro', 'card_payment', 'Comercial El Faro'],
    ['Transferencia Desde Linea De Credito', 'credit_line', 'Línea de crédito'],
    ['Trasp.fondos A Ctacte-l.cred-c.vista', 'credit_line', 'Línea de crédito'],
    ['Intereses Linea De Credito', 'bank_fee', 'Banco de Chile'],
    ['Comision Servicio Pago Facil', 'bank_fee', 'Banco de Chile'],
    ['Pago De Creditos M/n', 'loan_payment', 'Banco de Chile'],
    ['Cheque Pagado Por Caja', 'cheque', null],
    ['Algo que no conocemos', 'other', null],
  ])('%s', (desc, kind, counterparty) => {
    expect(classifyDescription(desc)).toMatchObject({ kind, counterparty });
  });
});

describe('formatRut', () => {
  it('quita ceros a la izquierda y pone puntos y guion', () => {
    expect(formatRut('0111111111')).toBe('11.111.111-1');
    expect(formatRut('0098765432')).toBe('9.876.543-2');
  });
});

describe('sameCounterparty', () => {
  it('reconoce nombres cortados por el largo de la cartola', () => {
    expect(sameCounterparty('Maria Fernanda Soto Valenzuela', 'Maria Fernanda Soto Valenzue')).toBe(true);
    expect(sameCounterparty('Servicios Forestales Y Transportes XY', 'Servicios Forestales Y Transporte')).toBe(true);
  });
  it('no confunde nombres cortos', () => {
    expect(sameCounterparty('Ana', 'Ana Maria Perez Lagos')).toBe(false);
    expect(sameCounterparty('Juan Rojas', 'Juan Rojas Perez')).toBe(false);
  });
});
