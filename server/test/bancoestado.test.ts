import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db.js';
import { recategorize } from '../src/domain/categorize.js';
import { importCartola } from '../src/domain/importer.js';
import { buildReport } from '../src/domain/report.js';
import { backfillFirstSeen } from '../src/domain/seen.js';
import type { ParsedCartola } from '../src/parser/cartola.js';
import { parseStatementFile as parseAny } from '../src/parser/index.js';
import { ACC_A, cartola, testDb } from './helpers.js';

// Estos archivos son cuentas, no tarjetas.
const parseStatementFile = async (bytes: Uint8Array) => (await parseAny(bytes)) as ParsedCartola;

const BE_ACCOUNT = '99900011122';

type Row = { date: string; op: string; desc: string; out: number; inn: number; balance: number };

/** Arma un Excel con la misma estructura que entrega BancoEstado (datos ficticios). */
async function bancoEstadoXlsx(kind: 'consolidated' | 'provisional', rows: Row[], summary: Record<string, string>, downloaded = '11/10/2026-14:59'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const res = wb.addWorksheet('Resumen');
  res.addRow(['600 600 0033 | soporte@bancoestado.cl']);
  res.addRow([]);
  res.addRow([`Fecha  - Hora       ${downloaded}`]);
  res.addRow(['Nombre Empresa', 'TRANSPORTES XY SPA', 'Ejecutivo', 'EJECUTIVO DE PRUEBA']);
  res.addRow(['Rut Empresa', '22.222.222-2', 'Oficina', 'SANTIAGO']);
  for (const [k, v] of Object.entries(summary)) res.addRow([k, v]);
  if (kind === 'consolidated') {
    const ws = wb.addWorksheet('Movimientos');
    ws.addRow(['Fecha', 'Sucursal', 'N° Cuenta Corriente', 'Alias', 'N° Cartola', 'N° Operación', 'Descripción', 'Cheques / Cargos', 'Depósitos / Abonos', 'Saldo']);
    rows.forEach((r) => ws.addRow([r.date, 'Stgo.principal', BE_ACCOUNT, 'TRANSPORTES XY SPA', '040', r.op, r.desc, r.out, r.inn, r.balance]));
  } else {
    const ws = wb.addWorksheet('Registros');
    ws.addRow(['Fecha', 'Sucursal', 'N° Operación', 'Descripción', 'Cargo', 'Abono', 'Saldo']);
    rows.forEach((r) => ws.addRow([r.date, 'STGO.PRINCIPAL', r.op, r.desc, r.out, r.inn, r.balance]));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const consolidated40 = () =>
  bancoEstadoXlsx(
    'consolidated',
    [
      { date: '13/10/2026', op: '0001077', desc: 'Transferencia otro banco de rut 33333333-3 sociedad cliente grande limitada', out: 0, inn: 3000, balance: 3100 },
      { date: '09/10/2026', op: '7069353', desc: 'Transferencia otro banco a rut 11111111-1', out: 2000, inn: 0, balance: 100 },
      { date: '09/10/2026', op: '0001077', desc: 'Transferencia otro banco de rut 44444444-4 frutos del sur sa', out: 0, inn: 2000, balance: 2100 },
    ],
    { 'N° Cuenta Corriente': BE_ACCOUNT, 'Fecha Inicio': '05/10/2026', 'Fecha Final': '13/10/2026', 'N° Cartola': '040', 'Saldo Inicial': '$100', 'Saldo Final': '$3.100' },
  );

const online = (rows: Row[], balance: number, downloaded?: string) =>
  bancoEstadoXlsx('provisional', rows, { 'Cuenta Corriente': `${BE_ACCOUNT} | TRANSPORTES XY SPA`, Inicial: '$3.100', 'Saldo Contable': `$${balance}` }, downloaded);

const compra = { date: '13/10/2026', op: '6520419', desc: 'COMPRA EN EL COMERCIO', out: 70, inn: 0, balance: 3030 };

describe('BancoEstado', () => {
  let db: DB;
  beforeEach(() => {
    db = testDb();
  });

  it('lee la cartola consolidada: cuenta, número, saldo por fila y contrapartes', async () => {
    const p = await parseStatementFile(await consolidated40());
    expect(p).toMatchObject({ bank: 'BancoEstado', accountNumber: BE_ACCOUNT, balance: 3100, balanceDate: '2026-10-11', downloadedAt: '2026-10-11 14:59' });
    expect(p.statement).toMatchObject({ kind: 'consolidated', number: '040', fromDate: '2026-10-05', toDate: '2026-10-13' });
    expect(p.company).toEqual({ name: 'TRANSPORTES XY SPA', rut: '22.222.222-2' });
    expect(p.movements.map((m) => [m.date, m.direction, m.amount, m.balance])).toEqual([
      ['2026-10-13', 'A', 3000, 3100],
      ['2026-10-09', 'C', 2000, 100],
      ['2026-10-09', 'A', 2000, 2100],
    ]);
  });

  it('crea la cuenta con el nombre y RUT de la empresa, y clasifica las transferencias', async () => {
    const r = importCartola(db, await parseStatementFile(await consolidated40()), 'c40.xlsx', null);
    expect(r).toMatchObject({ accountName: 'Transportes Xy SPA (BancoEstado)', bank: 'BancoEstado', statement: { kind: 'consolidated', number: '040' } });
    const rows = db.prepare('SELECT kind, counterparty, counterparty_rut FROM movements ORDER BY date DESC, seq').all();
    expect(rows).toEqual([
      { kind: 'transfer_in', counterparty: 'Sociedad Cliente Grande Limitada', counterparty_rut: '33.333.333-3' },
      { kind: 'transfer_out', counterparty: '11.111.111-1', counterparty_rut: '11.111.111-1' },
      { kind: 'transfer_in', counterparty: 'Frutos Del Sur SA', counterparty_rut: '44.444.444-4' },
    ]);
  });

  it('la cartola en línea queda provisoria, va después de la consolidada y el saldo final es el suyo', async () => {
    importCartola(db, await parseStatementFile(await consolidated40()), 'c40.xlsx', null);
    importCartola(db, await parseStatementFile(await online([compra], 3030)), 'linea.xlsx', null);
    const day = db.prepare("SELECT description, provisional, balance_after FROM movements WHERE date = '2026-10-13' ORDER BY seq").all();
    expect(day).toEqual([
      { description: 'COMPRA EN EL COMERCIO', provisional: 1, balance_after: 3030 },
      { description: 'Transferencia otro banco de rut 33333333-3 sociedad cliente grande limitada', provisional: 0, balance_after: 3100 },
    ]);
    expect(buildReport(db, { from: '2026-10-01', to: '2026-10-31' }).totals.closing).toBe(3030);
  });

  it('una cartola en línea nueva reemplaza a la anterior completa', async () => {
    importCartola(db, await parseStatementFile(await online([compra], 3030)), 'linea1.xlsx', null);
    const second = { date: '14/10/2026', op: '6520500', desc: 'COMPRA EN EL COMERCIO', out: 30, inn: 0, balance: 3000 };
    const r = importCartola(db, await parseStatementFile(await online([second, compra], 3000)), 'linea2.xlsx', null);
    expect(r.replacedProvisional).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM movements WHERE provisional = 1').get()).toEqual({ n: 2 });
  });

  it('la consolidada reemplaza lo provisorio de su período y conserva las ediciones manuales', async () => {
    importCartola(db, await parseStatementFile(await online([compra], 3030)), 'linea.xlsx', null);
    db.prepare("UPDATE movements SET label = 'Repuestos', label_source = 'manual' WHERE provisional = 1").run();

    const consolidated41 = await bancoEstadoXlsx(
      'consolidated',
      [{ ...compra, desc: 'Compra nacional comercio ejemplo' }],
      { 'N° Cuenta Corriente': BE_ACCOUNT, 'Fecha Inicio': '13/10/2026', 'Fecha Final': '17/10/2026', 'N° Cartola': '041', 'Saldo Final': '$3.030' },
    );
    const r = importCartola(db, await parseStatementFile(consolidated41), 'c41.xlsx', null);
    expect(r.replacedProvisional).toBe(1);
    expect(db.prepare('SELECT description, provisional, label FROM movements').all()).toEqual([
      { description: 'Compra nacional comercio ejemplo', provisional: 0, label: 'Repuestos' },
    ]);
  });

  it('guarda la hora de descarga que anota el banco', async () => {
    importCartola(db, await parseStatementFile(await consolidated40()), 'c40.xlsx', null);
    // 14:59 del 11 de octubre, en horario de verano (UTC−3).
    expect(db.prepare('SELECT observed_at, observed_source FROM imports').get()).toEqual({ observed_at: '2026-10-11T17:59:00.000Z', observed_source: 'banco' });
  });

  describe('fecha real al consolidar', () => {
    // Bajada el domingo 18 a las 10:30: una compra del fin de semana que el banco ya fecha el martes 20.
    const weekend = { date: '20/10/2026', op: '6520419', desc: 'COMPRA EN EL COMERCIO', out: 70, inn: 0, balance: 3030 };
    const sunday = () => online([weekend], 3030, '18/10/2026-10:30');
    // La consolidada la trae con otra redacción, otro N° de operación y un día después.
    const consolidated = () =>
      bancoEstadoXlsx(
        'consolidated',
        [{ ...weekend, date: '21/10/2026', op: '0009999', desc: 'Compra nacional comercio ejemplo' }],
        { 'N° Cuenta Corriente': BE_ACCOUNT, 'Fecha Inicio': '19/10/2026', 'Fecha Final': '23/10/2026', 'N° Cartola': '042', 'Saldo Final': '$3.030' },
        '24/10/2026-09:00',
      );
    const rows = () => db.prepare('SELECT date, description, first_seen_day, real_date, real_date_source, label FROM movements').all();

    it('se conserva la del día en que apareció, con las ediciones manuales', async () => {
      importCartola(db, await parseStatementFile(await sunday()), 'linea.xlsx', null);
      db.prepare("UPDATE movements SET label = 'Repuestos', label_source = 'manual'").run();
      importCartola(db, await parseStatementFile(await consolidated()), 'c42.xlsx', null);
      expect(rows()).toEqual([
        { date: '2026-10-21', description: 'Compra nacional comercio ejemplo', first_seen_day: '2026-10-18', real_date: '2026-10-18', real_date_source: 'observada', label: 'Repuestos' },
      ]);
    });

    it('una cartola en línea nueva tampoco la pierde', async () => {
      importCartola(db, await parseStatementFile(await sunday()), 'linea1.xlsx', null);
      const monday = { date: '20/10/2026', op: '6520500', desc: 'COMPRA EN EL COMERCIO', out: 30, inn: 0, balance: 3000 };
      importCartola(db, await parseStatementFile(await online([monday, weekend], 3000, '19/10/2026-09:00')), 'linea2.xlsx', null);
      expect(db.prepare('SELECT amount, real_date FROM movements ORDER BY amount').all()).toEqual([
        { amount: 30, real_date: '2026-10-19' },
        { amount: 70, real_date: '2026-10-18' },
      ]);
    });

    it('en una base de antes se recupera por el saldo de la cartola en línea ya reemplazada', async () => {
      importCartola(db, await parseStatementFile(await sunday()), 'linea.xlsx', null);
      importCartola(db, await parseStatementFile(await consolidated()), 'c42.xlsx', null);
      db.exec('UPDATE movements SET first_seen_day = NULL, first_seen_at = NULL, real_date = NULL, real_date_source = NULL');
      backfillFirstSeen(db);
      expect(rows()).toEqual([expect.objectContaining({ first_seen_day: '2026-10-18', real_date: '2026-10-18', real_date_source: 'observada' })]);
    });
  });

  it('parea por RUT una transferencia a otra cuenta propia (traspaso interno)', async () => {
    // Cuenta Banco de Chile de la empresa con RUT 11.111.111-1, que recibe los 2.000 desde BancoEstado.
    const bch = importCartola(
      db,
      await parseStatementFile(
        Buffer.from(cartola(ACC_A, '2026-10-11', 2000, [{ date: '2026-10-09', amount: 2000, type: 'A', desc: 'Traspaso De: Transportes Xy SPA' }]), 'latin1'),
      ),
      'bch.txt',
      null,
    );
    db.prepare("UPDATE accounts SET name = 'Agricola Uno', rut = '11.111.111-1' WHERE id = ?").run(bch.accountId);
    importCartola(db, await parseStatementFile(await consolidated40()), 'c40.xlsx', null);
    recategorize(db);
    const internal = db
      .prepare("SELECT m.description FROM movements m JOIN categories c ON c.id = m.category_id WHERE c.system_key = 'internal' ORDER BY m.id")
      .all();
    expect(internal).toEqual([{ description: 'Traspaso De: Transportes Xy SPA' }, { description: 'Transferencia otro banco a rut 11111111-1' }]);
  });

  it('al cargar la otra cuenta, un abono categorizado a mano pasa a interno (conservando el comentario)', async () => {
    const bch = importCartola(
      db,
      await parseStatementFile(
        Buffer.from(cartola(ACC_A, '2026-10-11', 2000, [{ date: '2026-10-09', amount: 2000, type: 'A', desc: 'Traspaso De: Transportes Xy SPA' }]), 'latin1'),
      ),
      'bch.txt',
      null,
    );
    db.prepare("UPDATE accounts SET rut = '11.111.111-1' WHERE id = ?").run(bch.accountId);
    const ventas = (db.prepare("SELECT id FROM categories WHERE name = 'Ventas e ingresos'").get() as { id: number }).id;
    db.prepare("UPDATE movements SET category_id = ?, category_source = 'manual', label = 'Desde BancoEstado', label_source = 'manual'").run(ventas);

    importCartola(db, await parseStatementFile(await consolidated40()), 'c40.xlsx', null);
    const row = db
      .prepare("SELECT c.system_key, m.label FROM movements m JOIN categories c ON c.id = m.category_id WHERE m.account_id = ?")
      .get(bch.accountId);
    expect(row).toEqual({ system_key: 'internal', label: 'Desde BancoEstado' });
  });

  it('parea un envío genérico de BancoEstado con el abono que nombra a la empresa', async () => {
    // El cargo en BancoEstado no trae contraparte; el abono en la otra cuenta sí nombra a la empresa emisora.
    const be = await bancoEstadoXlsx(
      'consolidated',
      [{ date: '13/10/2026', op: '0001080', desc: 'TRANSFERENCIA FONDOS INTERNET', out: 2000, inn: 0, balance: 2000 }],
      { 'N° Cuenta Corriente': BE_ACCOUNT, 'Fecha Inicio': '13/10/2026', 'Fecha Final': '13/10/2026', 'N° Cartola': '041', 'Saldo Inicial': '$4.000', 'Saldo Final': '$2.000' },
    );
    const beId = importCartola(db, await parseStatementFile(be), 'be.xlsx', null).accountId;

    const bd = importCartola(
      db,
      await parseStatementFile(
        Buffer.from(cartola(ACC_A, '2026-10-13', 2000, [{ date: '2026-10-13', amount: 2000, type: 'A', desc: 'Traspaso De: Transportes Xy SPA' }])),
      ),
      'a.txt',
      null,
    );
    db.prepare("UPDATE accounts SET name = 'Agricola Uno Spa' WHERE id = ?").run(bd.accountId);

    recategorize(db);
    const cats = db.prepare('SELECT m.account_id, c.system_key FROM movements m JOIN categories c ON c.id = m.category_id ORDER BY m.account_id').all();
    expect(cats).toEqual([
      { account_id: beId, system_key: 'internal' },
      { account_id: bd.accountId, system_key: 'internal' },
    ]);
  });

  it('al reimportar la misma cartola, refresca la clasificación de lo ya cargado', async () => {
    importCartola(db, await parseStatementFile(await consolidated40()), 'c40.xlsx', null);
    db.prepare("UPDATE movements SET kind = 'other', counterparty = NULL, counterparty_rut = NULL WHERE description LIKE 'Transferencia%'").run();

    importCartola(db, await parseStatementFile(await consolidated40()), 'c40-bis.xlsx', null);
    const kinds = db.prepare("SELECT kind FROM movements WHERE description LIKE 'Transferencia%' ORDER BY description").all();
    expect(kinds).toEqual([{ kind: 'transfer_out' }, { kind: 'transfer_in' }, { kind: 'transfer_in' }]);
  });

  it('rechaza el .xls antiguo de Banco de Chile', async () => {
    await expect(parseStatementFile(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))).rejects.toThrow(/\.txt/);
  });
});
