import type { DateMode } from '../api';
import { useShared } from '../data';
import { countedTitle, movedBadgeText, movedFrom, type Dated } from '../seen';

/**
 * Un movimiento que el banco fechó después del día en que pasó (ver seen.ts). Por fecha real muestra la fecha del
 * banco ("banco: lun 23"); por la del banco, el día en que ya aparecía ("↶ vie 20"). Con varios movimientos (una
 * nómina), solo si todos son del mismo día.
 */
export function MovedBadge({ items, dates }: { items: Dated[]; dates?: DateMode }) {
  const shared = useShared().dates;
  const mode = dates ?? shared;
  const days = new Set(items.map((m) => `${movedFrom(m)}|${m.date}`));
  const text = days.size === 1 ? movedBadgeText(items[0], mode) : null;
  if (!text) return null;
  return (
    <span className="badge moved" title={countedTitle(items[0], mode)}>
      {text}
    </span>
  );
}
