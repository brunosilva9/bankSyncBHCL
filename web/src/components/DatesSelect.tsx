import { useShared } from '../data';

/**
 * Fechas reales (por defecto) o del banco, para toda la app. Por fecha real, lo hecho de noche, en fin de semana o
 * en feriado cuenta el día en que pasó; por la del banco, el día hábil en que el banco lo contabilizó.
 */
export function DatesSelect() {
  const { dates, setDates } = useShared();
  return (
    <label title="Por fecha real, lo hecho de noche, en fin de semana o en feriado cuenta el día en que pasó, aunque el banco lo feche el día hábil siguiente">
      Fechas{' '}
      <select value={dates} onChange={(e) => setDates(e.target.value === 'banco' ? 'banco' : 'real')}>
        <option value="real">Reales</option>
        <option value="banco">Del banco</option>
      </select>
    </label>
  );
}
