import { shortDate } from '../format';
import { realDateOptions, realDateTitle, type Placeable } from '../seen';

/**
 * La fecha real de un movimiento, para elegir otro de los días en que pudo pasar: lo hecho de noche, en fin de semana o
 * en feriado que el banco fechó el día hábil siguiente y que se bajó después (ver realDateWindows en
 * server/src/domain/seen.ts). Si no hay qué elegir, la fecha como texto.
 */
export function RealDateSelect({ m, onChange }: { m: Placeable; onChange: (day: string) => void }) {
  const options = realDateOptions(m);
  const current = m.real_date ?? m.date;
  if (options.length < 2) return <>{shortDate(current)}</>;
  return (
    <select className="real-date" value={current} title={realDateTitle(m)} aria-label="Fecha real" onChange={(e) => onChange(e.target.value)}>
      {options.map((day) => (
        <option key={day} value={day}>
          {shortDate(day, true)}
        </option>
      ))}
    </select>
  );
}
