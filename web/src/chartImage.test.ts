import { describe, expect, it } from 'vitest';
import { chartImageSvg } from './chartImage';

const NS = 'http://www.w3.org/2000/svg';

/** Un gráfico como el de BalanceChart, con lo que tiene en pantalla mientras se mira un día. */
const chart = () => {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 600 234');
  const parts: Array<[string, string, string?]> = [
    ['rect', 'weekend'],
    ['rect', 'active-day'],
    ['line', 'grid'],
    ['text', 'tick', '$20 MM'],
    ['path', 'line'],
    ['line', 'crosshair'],
    ['circle', 'mark seen'],
    ['circle', 'mark unseen'],
    ['rect', 'hit'],
  ];
  for (const [tag, className, text] of parts) {
    const el = document.createElementNS(NS, tag);
    el.setAttribute('class', className);
    if (tag === 'circle') el.setAttribute('r', '7');
    if (text) el.textContent = text;
    svg.append(el);
  }
  return svg;
};

describe('la infografía como imagen', () => {
  it('el gráfico bajo su encabezado, en colores claros y sin lo que es solo de la pantalla', () => {
    const { svg, width, height } = chartImageSvg(chart(), {
      title: 'Saldo consolidado día a día',
      subtitle: 'Cuenta <b>Caja & Co</b> · del vie 13/11/2026 al lun 16/11/2026',
      summary: 'Total de las cuentas: disponible de $1.400 a $1.600 (+$200)',
    });
    expect([width, height]).toEqual([640, 82 + 234 + 34]);

    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    // Lo que trae un nombre de cuenta va como texto, no como marcas.
    expect([...doc.querySelectorAll('svg > text')].map((t) => t.textContent)).toEqual([
      'Saldo consolidado día a día',
      'Cuenta <b>Caja & Co</b> · del vie 13/11/2026 al lun 16/11/2026',
      'Total de las cuentas: disponible de $1.400 a $1.600 (+$200)',
      '● con cartola ese día  ○ sin cartola: sale de los movimientos  ·  sábados y domingos, sombreados',
    ]);
    expect(doc.querySelector('.hit, .crosshair, .active-day')).toBeNull();
    expect(doc.querySelector('.line')!.getAttribute('stroke')).toBe('#2563eb');
    expect(doc.querySelector('.tick')!.getAttribute('fill')).toBe('#677387');
    // El punto del día que se estaba mirando vuelve a su tamaño.
    expect([...doc.querySelectorAll('.mark')].map((c) => c.getAttribute('r'))).toEqual(['5.5', '3.5']);
    expect(doc.querySelector('svg > rect')!.getAttribute('fill')).toBe('#ffffff');
  });
});
