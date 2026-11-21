import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { shortDate } from '../format';
import type { Placeable } from '../seen';
import { RealDateSelect } from './RealDateSelect';

// Datos ficticios: un pago con fecha del lunes 16 que pudo pasar el sábado 14, el domingo 15 o el lunes.
const monday: Placeable = {
  date: '2026-11-16',
  real_date: '2026-11-16',
  real_date_source: 'banco',
  first_seen_day: '2026-11-16',
  first_seen_at: '2026-11-16T10:00:00.000Z',
  real_date_window: { min: '2026-11-14', max: '2026-11-16', before: { day: '2026-11-14', at: '2026-11-14T13:00:00.000Z' } },
};

describe('RealDateSelect', () => {
  it('ofrece los días en que pudo pasar, con el día de la semana, y avisa el elegido', () => {
    const onChange = vi.fn();
    render(<RealDateSelect m={monday} onChange={onChange} />);
    const select = screen.getByRole('combobox', { name: 'Fecha real' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['2026-11-14', '2026-11-15', '2026-11-16'].map((d) => shortDate(d, true)));
    expect(select.value).toBe('2026-11-16');
    expect(select.title).toContain('No aparecía en la cartola del');
    fireEvent.change(select, { target: { value: '2026-11-15' } });
    expect(onChange).toHaveBeenCalledWith('2026-11-15');
  });

  it('sin nada que elegir, la fecha como texto', () => {
    render(<RealDateSelect m={{ ...monday, real_date_window: null }} onChange={() => {}} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(shortDate('2026-11-16'))).toBeInTheDocument();
  });
});
