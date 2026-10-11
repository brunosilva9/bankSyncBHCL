import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db.js';
import { calibrateFromAvailable, calibrateFromLineCartola, isCreditLineCartola } from '../src/domain/creditLine.js';
import { importCartola } from '../src/domain/importer.js';
import { buildReport } from '../src/domain/report.js';
import { parseCartola } from '../src/parser/cartola.js';
import { ACC_A, cartola, testDb } from './helpers.js';

// Cuenta de la línea: comparte la parte central del número con la cuenta corriente ACC_A.
const LINE = '11111111110';

// Cuenta corriente con línea de 8.000. Al descargar: saldo −797 (sobregiro), línea usada 6.802 → disponible 1.198.
const ctacte = cartola(ACC_A, '2026-10-11', -797, [
  { date: '2026-10-13', amount: 245, type: 'A', desc: 'Trasp.fondos A Ctacte-l.cred-c.vista' },
  { date: '2026-10-12', amount: 1000, type: 'C', desc: 'Pago: Proveedor Uno' },
  { date: '2026-10-09', amount: 1427, type: 'C', desc: 'Amortizacion A Linea De Credito' },
  { date: '2026-10-09', amount: 500, type: 'A', desc: 'Traspaso De: Cliente Uno' },
  { date: '2026-10-08', amount: 30, type: 'A', desc: 'Transferencia Desde Linea De Credito' },
]);

// La misma historia vista desde la línea (cargos y abonos invertidos). Su saldo incluye el sobregiro.
const line = cartola(LINE, '2026-10-11', -7599, [
  { date: '2026-10-13', amount: 245, type: 'C', desc: 'Trasp.fondos A Ctacte-l.cred-c.vista' },
  { date: '2026-10-09', amount: 1427, type: 'A', desc: 'Amortizacion A Linea De Credito' },
  { date: '2026-10-08', amount: 30, type: 'C', desc: 'Transferencia Desde Linea De Credito' },
]);

describe('línea de crédito', () => {
  let db: DB;
  let accountId: number;

  beforeEach(() => {
    db = testDb();
    accountId = importCartola(db, parseCartola(ctacte), 'ctacte.txt', null).accountId;
    db.prepare('UPDATE accounts SET credit_limit = 8000 WHERE id = ?').run(accountId);
  });

  it('reconoce la cartola de la línea', () => {
    expect(isCreditLineCartola(parseCartola(line))).toBe(true);
    expect(isCreditLineCartola(parseCartola(ctacte))).toBe(false);
  });

  it('calibra con la cartola de la línea descontando el sobregiro, sin cargar sus movimientos', () => {
    const r = calibrateFromLineCartola(db, parseCartola(line), 'linea.txt', null);
    expect(r).toMatchObject({ accountId, used: 6802, available: 1198 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM movements').get()).toEqual({ n: 5 });
  });

  it('el disponible real es saldo + línea disponible, y los giros y amortizaciones no son ingreso ni gasto', () => {
    calibrateFromLineCartola(db, parseCartola(line), 'linea.txt', null);
    const r = buildReport(db, { from: '2026-10-09', to: '2026-10-13' });
    const t = r.totals;
    expect(t.closing).toBe(-797);
    expect(t.creditAvailableClosing).toBe(1198);
    expect(t.availableClosing).toBe(401); // = 8.000 − 7.599
    expect(t.income).toBe(500);
    expect(t.expenses).toBe(1000);
    expect(t.availableOpening + t.income - t.expenses).toBe(t.availableClosing);
    expect(r.accounts[0]).toMatchObject({ creditDrawn: 245, creditRepaid: 1427 });
  });

  it('sigue el uso de la línea con cartolas posteriores de la cuenta corriente, sin volver a pedir la de la línea', () => {
    calibrateFromLineCartola(db, parseCartola(line), 'linea.txt', null);
    const next = cartola(ACC_A, '2026-10-20', -797 + 2000 - 1000, [
      { date: '2026-10-20', amount: 1000, type: 'C', desc: 'Amortizacion A Linea De Credito' },
      { date: '2026-10-19', amount: 2000, type: 'A', desc: 'Transferencia Desde Linea De Credito' },
      { date: '2026-10-13', amount: 245, type: 'A', desc: 'Trasp.fondos A Ctacte-l.cred-c.vista' },
    ]);
    importCartola(db, parseCartola(next), 'ctacte2.txt', null);
    const r = buildReport(db, { from: '2026-10-14', to: '2026-10-20' });
    expect(r.accounts[0].creditAvailableClosing).toBe(1198 - 2000 + 1000);
    expect(r.totals.availableClosing).toBe(401); // girar y amortizar no cambia el disponible
  });

  it('pide la cartola de la cuenta corriente del mismo día para calibrar', () => {
    const otherDay = line.replace(/20261011/g, '20261015');
    expect(() => calibrateFromLineCartola(db, parseCartola(otherDay), 'linea.txt', null)).toThrow(/mismo día/);
  });

  it('se puede calibrar a mano con el disponible que muestra el banco', () => {
    calibrateFromAvailable(db, accountId, 1198);
    const r = buildReport(db, { from: '2026-10-01', to: '2026-10-31' });
    expect(r.totals.availableClosing).toBe(401);
  });
});
