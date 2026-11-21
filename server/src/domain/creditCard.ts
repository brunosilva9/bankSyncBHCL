// Importa movimientos de tarjeta de crédito. La tarjeta es una cuenta más (accounts.kind =
// 'tarjeta_credito') pero sin saldo: los archivos no traen la deuda, solo movimientos.
//
// Los archivos se traslapan mucho: cada estado de cuenta repite las compras en cuotas que se siguen
// pagando, y "no facturados" adelanta lo que saldrá en el próximo. Por eso cada fila se compara con lo
// ya cargado de la tarjeta (sameCardPurchase) y solo se agregan las compras nuevas. Lo que viene de un
// archivo por facturar de CMR queda provisorio; cuando la misma compra llega en un estado de cuenta
// facturado se confirma y toma su redacción y fecha.
import type { DB } from '../db.js';
import { dayDiff, sameCardPurchase, type ParsedCard } from '../parser/creditCard.js';
import { recategorize } from './categorize.js';
import { realDateOf, seenStatements } from './seen.js';

export interface CardImportResult {
  type: 'card';
  bank: string;
  accountName: string;
  cardNumber: string;
  billed: boolean;
  fromDate: string | null;
  toDate: string | null;
  movementsInFile: number;
  inserted: number;
  alreadyLoaded: number;
  /** Compras que estaban por facturar y este estado de cuenta confirmó. */
  confirmed: number;
}

interface Existing {
  id: number;
  date: string;
  amount: number;
  direction: 'C' | 'A';
  description: string;
  installments: number | null;
  installmentAmount: number | null;
  provisional: number;
}

export function importCard(db: DB, card: ParsedCard, filename: string, userId: number | null): CardImportResult {
  const result = db.transaction(() => {
    let account = db.prepare('SELECT id, name, kind FROM accounts WHERE number = ?').get(card.cardNumber) as
      | { id: number; name: string; kind: string }
      | undefined;
    if (account && account.kind !== 'tarjeta_credito') throw new Error(`Ya hay una cuenta "${account.name}" con el número ${card.cardNumber}`);
    if (!account) {
      const name = `${card.cardName} (${card.bank})`;
      const id = Number(
        db.prepare("INSERT INTO accounts (number, bank, name, kind) VALUES (?, ?, ?, 'tarjeta_credito')").run(card.cardNumber, card.bank, name).lastInsertRowid,
      );
      account = { id, name, kind: 'tarjeta_credito' };
    }

    // La tarjeta no tiene saldo: balance queda en 0 y la pantalla lo muestra vacío para kind = 'card'.
    const importId = Number(
      db
        .prepare(
          `INSERT INTO imports (account_id, filename, balance_date, balance, from_date, to_date, movements_in_file, inserted, user_id, kind, statement_kind)
           VALUES (?, ?, ?, 0, ?, ?, ?, 0, ?, 'card', ?)`,
        )
        .run(account.id, filename, card.asOf, card.fromDate, card.toDate, card.movements.length, userId, card.billed ? 'consolidated' : 'provisional')
        .lastInsertRowid,
    );

    const existing = db
      .prepare(
        `SELECT id, date, amount, direction, description, installments, installment_amount AS installmentAmount, provisional
         FROM movements WHERE account_id = ?`,
      )
      .all(account.id) as Existing[];
    const used = new Set<number>();
    // Solo las compras de CMR por facturar se confirman después; BancoEstado no tiene archivo facturado.
    const provisional = !card.billed && card.bank === 'Banco Falabella' ? 1 : 0;
    const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM movements WHERE account_id = ? AND date = ?');
    // Cuándo se vio cada compra (ver domain/seen.ts): el día del archivo, que en CMR es el de su última compra. La
    // fecha real es la de la compra; si el facturado la cambia, queda la primera.
    const insert = db.prepare(
      `INSERT INTO movements (account_id, date, seq, amount, direction, description, kind, counterparty, provisional, import_id, installments, installment_amount,
                              first_seen_day, real_date, real_date_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const confirm = db.prepare(
      'UPDATE movements SET date = ?, description = ?, counterparty = ?, installment_amount = ?, provisional = 0, import_id = ? WHERE id = ?',
    );
    const seenAgain = seenStatements(db);

    let inserted = 0;
    let alreadyLoaded = 0;
    let confirmed = 0;
    for (const m of card.movements) {
      const match = existing
        .filter((e) => !used.has(e.id) && sameCardPurchase(e, m))
        .sort((a, b) => dayDiff(a.date, m.date) - dayDiff(b.date, m.date))[0];
      if (match) {
        used.add(match.id);
        // La misma compra puede venir con otra fecha en otro archivo: la fecha real es la más temprana.
        seenAgain.dated(match.id, m.date);
        seenAgain.seen(match.id, card.asOf, null);
        if (card.billed && match.provisional) {
          confirm.run(m.date, m.description, m.counterparty, m.installmentAmount, importId, match.id);
          confirmed++;
        } else {
          alreadyLoaded++;
        }
        continue;
      }
      const seq = (nextSeq.get(account.id, m.date) as { seq: number }).seq;
      const real = realDateOf(m.date, card.asOf);
      insert.run(
        account.id,
        m.date,
        seq,
        m.amount,
        m.direction,
        m.description,
        m.kind,
        m.counterparty,
        provisional,
        importId,
        m.installments,
        m.installmentAmount,
        card.asOf,
        real.day,
        real.source,
      );
      inserted++;
    }
    db.prepare('UPDATE imports SET inserted = ? WHERE id = ?').run(inserted, importId);

    return {
      type: 'card' as const,
      bank: card.bank,
      accountName: account.name,
      cardNumber: card.cardNumber,
      billed: card.billed,
      fromDate: card.fromDate,
      toDate: card.toDate,
      movementsInFile: card.movements.length,
      inserted,
      alreadyLoaded,
      confirmed,
    };
  })();
  recategorize(db);
  return result;
}
