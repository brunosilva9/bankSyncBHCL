const clpFormatter = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });

export const clp = (n: number | null | undefined) => (n === null || n === undefined ? '—' : clpFormatter.format(n));

/** Con signo explícito, para variaciones: "+$1.000" / "−$1.000". */
export const clpSigned = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + clpFormatter.format(Math.abs(n));

/** "2026-10-09" -> "vie 09/10/2026" */
export function shortDate(iso: string, withWeekday = false): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const base = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
  if (!withWeekday) return base;
  return `${date.toLocaleDateString('es-CL', { weekday: 'short' }).replace('.', '')} ${base}`;
}

export const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface DateRange {
  from: string;
  to: string;
}

export type PresetKey = 'friday' | 'week' | 'month' | 'lastMonth' | 'last30';

export const PRESETS: Array<{ key: PresetKey; label: string }> = [
  { key: 'friday', label: 'Desde el viernes' },
  { key: 'week', label: 'Esta semana' },
  { key: 'month', label: 'Este mes' },
  { key: 'lastMonth', label: 'Mes pasado' },
  { key: 'last30', label: 'Últimos 30 días' },
];

/**
 * Rango para cada atajo. "Hasta" incluye una semana a futuro porque el banco fecha al próximo día
 * hábil lo que se hace en fin de semana o feriado (un traspaso del domingo aparece con fecha del martes).
 */
export function presetRange(key: PresetKey, today = new Date()): DateRange {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const ahead = new Date(t);
  ahead.setDate(t.getDate() + 7);
  const to = toIso(ahead);
  switch (key) {
    case 'friday': {
      const back = (t.getDay() - 5 + 7) % 7; // 0 si hoy es viernes
      const f = new Date(t);
      f.setDate(t.getDate() - back);
      return { from: toIso(f), to };
    }
    case 'week': {
      const back = (t.getDay() + 6) % 7; // lunes
      const f = new Date(t);
      f.setDate(t.getDate() - back);
      return { from: toIso(f), to };
    }
    case 'month':
      return { from: toIso(new Date(t.getFullYear(), t.getMonth(), 1)), to };
    case 'lastMonth':
      return {
        from: toIso(new Date(t.getFullYear(), t.getMonth() - 1, 1)),
        to: toIso(new Date(t.getFullYear(), t.getMonth(), 0)),
      };
    case 'last30': {
      const f = new Date(t);
      f.setDate(t.getDate() - 30);
      return { from: toIso(f), to };
    }
  }
}
