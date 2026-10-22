import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { describeDetection, detectStatement } from '../src/parser/detect.js';
import { parseStatementFile } from '../src/parser/index.js';
import { ACC_A, cartola } from './helpers.js';

// Archivos armados con la misma estructura que entregan los bancos, con datos ficticios.

async function xlsx(sheets: Array<{ name: string; rows: unknown[][] }>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    s.rows.forEach((r) => ws.addRow(r));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function xls(name: string, rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }) as Buffer;
}

const CLIENTE = ['Nombre', '', 'RUT', 'Fecha Hora'];
const PERSONA = ['CLIENTE DE PRUEBA', '', '11.111.111-1', '19/10/2026 15:19'];

describe('detectStatement', () => {
  it('Banco de Chile .txt: cuenta corriente y línea de crédito', async () => {
    const cc = await detectStatement(Buffer.from(cartola(ACC_A, '2026-10-12', 0, [{ date: '2026-10-12', amount: 10, type: 'C', desc: 'Pago: Botilleria El Sol' }]), 'latin1'));
    expect(cc).toMatchObject({ format: 'bancochile-cc-txt', bank: 'Banco de Chile', product: 'cuenta_corriente', accountNumber: ACC_A, supported: true });

    const linea = await detectStatement(
      Buffer.from(cartola('12345678910', '2026-10-12', -500, [{ date: '2026-10-12', amount: 500, type: 'C', desc: 'Transferencia Desde Linea De Credito' }]), 'latin1'),
    );
    expect(linea).toMatchObject({ format: 'bancochile-linea-txt', product: 'linea_credito', supported: true });
  });

  it('BancoEstado empresa (la que ya se importa) con su número de cuenta', async () => {
    const d = await detectStatement(
      await xlsx([
        { name: 'Resumen', rows: [['Cuenta Corriente', '', '', '', '99900011122', 'EMPRESA DE PRUEBA SPA']] },
        { name: 'Registros', rows: [['Fecha', 'Sucursal', 'N° Operación', 'Descripción', 'Cargo', 'Abono', 'Saldo']] },
      ]),
    );
    expect(d).toMatchObject({ format: 'bancoestado-empresa', bank: 'BancoEstado', accountNumber: '99900011122', supported: true });
  });

  it('BancoEstado persona: cartola histórica, últimos movimientos y línea de crédito', async () => {
    const cartolaHist = await detectStatement(
      await xlsx([{ name: 'Cartola N° 000002', rows: [['CARTOLA CUENTA CORRIENTE'], ['N° 99900011122'], ['Cliente'], CLIENTE, PERSONA, ['Cartola Seleccionada', '', '000002 02/09/2025']] }]),
    );
    expect(cartolaHist).toMatchObject({ format: 'bancoestado-persona-cartola', product: 'cuenta_corriente', accountNumber: '99900011122', supported: false });

    const ultimos = await detectStatement(
      await xlsx([{ name: 'Últimos Movimientos 99900011122', rows: [['Últimos Movimientos Cuenta Corriente'], ['Cliente'], CLIENTE, PERSONA] }]),
    );
    expect(ultimos).toMatchObject({ format: 'bancoestado-persona-ultimos-cc', accountNumber: '99900011122' });

    const linea = await detectStatement(
      await xlsx([
        {
          name: 'Últimos Movimientos 99900011133',
          rows: [['Últimos Movimientos Línea de Crédito'], ['Cliente'], CLIENTE, PERSONA, ['Saldo'], ['Cuenta Corriente Asociada', '', '', '99900011122', 'Fecha Vencimiento', '', '31/05/2027']],
        },
      ]),
    );
    expect(linea).toMatchObject({ format: 'bancoestado-persona-linea', product: 'linea_credito', accountNumber: '99900011133', linkedAccount: '99900011122' });
  });

  it('BancoEstado tarjeta: movimientos por facturar con los últimos 4 dígitos', async () => {
    const d = await detectStatement(
      await xlsx([
        {
          name: 'movimientos',
          rows: [['Últimos Movimientos Nacionales\nTARJETA PRUEBA VISA N° **** 1234'], ['Datos del cliente'], CLIENTE, PERSONA, ['Movimientos por facturar'], ['Fecha', 'Descripción', 'Ciudad', 'Monto ($)'], ['28/09/2026', 'SUPERMERCADO EJEMPLO', 'SANTIAGO', -1000]],
        },
      ]),
    );
    expect(d).toMatchObject({ format: 'bancoestado-tarjeta-por-facturar', product: 'tarjeta_credito', card: { name: 'TARJETA PRUEBA VISA', last4: '1234' } });
  });

  it('Banco Falabella: tarjeta CMR facturada y no facturada', async () => {
    const header = ['FECHA', 'DESCRIPCION', 'TITULAR/ADICIONAL', 'MONTO', 'CUOTAS PENDIENTES', 'VALOR CUOTA'];
    const row = [new Date(Date.UTC(2026, 8, 24)), 'COMPRA TIENDA EJEMPLO', 'Titular', 1000, 0, 1000];
    const facturados = await detectStatement(await xlsx([{ name: 'Movimientos Facturados', rows: [header, row] }]));
    expect(facturados).toMatchObject({ format: 'falabella-cmr', bank: 'Banco Falabella', variant: 'movimientos facturados', accountNumber: null });
    const ultimos = await detectStatement(await xlsx([{ name: 'Ultimos Movimientos', rows: [header, row] }]));
    expect(ultimos).toMatchObject({ format: 'falabella-cmr', variant: 'movimientos no facturados' });
  });

  it('Banco Falabella .xls: cuenta corriente y línea de crédito (sin número de cuenta)', async () => {
    const cc = await detectStatement(
      xls('Page 1', [
        ['Fecha', 'Descripcion', 'Cargo', 'Abono', 'Saldo'],
        ['01-10-2026', 'Transf para Pago Tarjeta CMR', '$ 1.000', '', '-$ 1.000'],
      ]),
    );
    expect(cc).toMatchObject({ format: 'falabella-cc-xls', bank: 'Banco Falabella', product: 'cuenta_corriente', accountNumber: null });
    expect(cc!.evidence).toContain('pagos a la tarjeta CMR desde la cuenta');

    const linea = await detectStatement(
      xls('Page 1', [
        ['Fecha', 'Descripcion', 'Cargos', 'Abonos', 'Monto utilizado', 'Tasa diaria', 'Intereses'],
        ['16-10-2026', 'TRASPASO PARA CUBRIR SOBREGIRO', '$ 1.000', '', '$ 1.000', '0,11 %', '$ 1'],
      ]),
    );
    expect(linea).toMatchObject({ format: 'falabella-linea-xls', product: 'linea_credito' });
  });

  it('Banco de Chile .xls antiguo, con su número de cuenta', async () => {
    const d = await detectStatement(
      xls('Hoja1', [
        ['Nombre Empresa:', 'EMPRESA DE PRUEBA SPA'],
        ['Cuenta N°:', '00-123-45678-01'],
        ['Fecha', 'Descripción', 'Canal o Sucursal', 'Nro. Docto.', 'Cargos (CLP)', 'Abonos (CLP)', 'Saldo (CLP)'],
      ]),
    );
    expect(d).toMatchObject({ format: 'bancochile-xls', bank: 'Banco de Chile', accountNumber: '001234567801' });
  });

  it('no reconoce planillas que no son cartolas ni un .xlsx con columnas genéricas', async () => {
    expect(await detectStatement(await xlsx([{ name: 'Hoja1', rows: [['Producto', 'Precio'], ['Avena', 1000]] }]))).toBeNull();
    // Mismas columnas que la cuenta Falabella, pero en .xlsx: no basta para decir que es de Falabella.
    expect(await detectStatement(await xlsx([{ name: 'Page 1', rows: [['Fecha', 'Descripcion', 'Cargo', 'Abono', 'Saldo']] }]))).toBeNull();
    expect(await detectStatement(Buffer.from('hola, esto no es una cartola\n'))).toBeNull();
  });
});

describe('parseStatementFile con formatos reconocidos que aún no se importan', () => {
  it('dice qué reconoció en vez de un error genérico', async () => {
    const file = xls('Page 1', [['Fecha', 'Descripcion', 'Cargo', 'Abono', 'Saldo']]);
    await expect(parseStatementFile(file)).rejects.toThrow(/Reconocí el archivo: Banco Falabella · Cuenta corriente .*Todavía no se puede importar/);
  });

  it('un Excel desconocido da un mensaje que no culpa a BancoEstado', async () => {
    await expect(parseStatementFile(await xlsx([{ name: 'Hoja1', rows: [['Producto', 'Precio']] }]))).rejects.toThrow(/No reconozco este Excel/);
  });

  it('describe la detección en una línea', async () => {
    const d = await detectStatement(
      await xlsx([{ name: 'movimientos', rows: [['Últimos Movimientos Nacionales TARJETA PRUEBA N° **** 1234'], ['Fecha', 'Descripción', 'Ciudad', 'Monto ($)']] }]),
    );
    expect(describeDetection(d!)).toBe('BancoEstado · Tarjeta de crédito TARJETA PRUEBA **** 1234 (movimientos nacionales por facturar)');
  });
});
