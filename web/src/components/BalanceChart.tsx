import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { compactClp, isWeekend, labeledDays, niceScale, type Timeline } from '../balances';
import { clp, clpSigned, shortDate } from '../format';
import { weekdayDay } from '../seen';

const TOP = 10;
const RIGHT = 14;
/** Alto del eje de los días, bajo el gráfico. */
const AXIS = 24;

interface Props {
  timeline: Timeline;
  /** Alto del área con la línea, sin el eje de los días. */
  height: number;
  /**
   * Ancho al imprimir (A4 con márgenes de 12 mm). El SVG se dibuja al ancho que tiene en pantalla, 1:1, y al imprimir
   * se vuelve a dibujar a este: si no, se escalaría entero y el texto quedaría chico.
   */
  printWidth: number;
  /** Lo que el recuadro del día agrega bajo el saldo: el día es `index` (1 = el primero; 0 es el saldo inicial). */
  detail?: (index: number) => ReactNode;
}

/**
 * La línea de tiempo del saldo: un punto al final de cada día. Lleno si ese día se descargó cartola (en el total, de
 * todas las cuentas), vacío si no. Entre dos puntos la línea es recta: no se sabe por dónde anduvo el saldo durante el
 * día. Al pasar el mouse (o con las flechas, con el foco en el gráfico) un recuadro dice el saldo de ese día.
 */
export function BalanceChart({ timeline, height, printWidth, detail }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(printWidth);
  /** Día que se está mirando (1 a n); null: ninguno. */
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => el.clientWidth > 0 && setWidth(Math.round(el.clientWidth));
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    const beforePrint = () => flushSync(() => setWidth(printWidth));
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('beforeprint', beforePrint);
      window.removeEventListener('afterprint', measure);
    };
  }, [printWidth]);

  const { points } = timeline;
  const n = points.length - 1;
  if (n < 1) return null;

  // Un gráfico bajo lleva menos marcas en el eje, para que sus montos no se encimen.
  const scale = niceScale(Math.min(...points.map((p) => p.value)), Math.max(...points.map((p) => p.value)), Math.max(2, Math.round(height / 50)));
  const tickLabels = scale.ticks.map(compactClp);
  const left = Math.max(...tickLabels.map((t) => t.length)) * 6.6 + 12;
  const plotWidth = Math.max(width - left - RIGHT, 40);
  const span = plotWidth / n;
  /** Comienzo de la columna del día k (0 = el primero). */
  const col = (k: number) => left + k * span;
  /** Cada día va al medio de su columna, sobre su nombre; el saldo inicial (0), al comienzo del primero. */
  const x = (i: number) => (i === 0 ? left : left + (i - 0.5) * span);
  const y = (v: number) => TOP + ((scale.max - v) / (scale.max - scale.min)) * height;
  const bottom = TOP + height;

  const short = n > 14;
  const dayName = (day: string) => (short ? shortDate(day).slice(0, 5) : weekdayDay(day));
  const labeled = labeledDays(n, span, short ? 40 : 50);
  const markers = span >= 10;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');

  const onPointer = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    setActive(Math.min(n, Math.max(1, Math.floor((px - left) / span) + 1)));
  };
  const onKey = (e: KeyboardEvent) => {
    const to = { ArrowLeft: (a: number) => a - 1, ArrowRight: (a: number) => a + 1, Home: () => 1, End: () => n }[e.key];
    if (!to) return;
    e.preventDefault();
    setActive((a) => Math.min(n, Math.max(1, to(a ?? n))));
  };

  const first = points[0].value;
  const last = points[n].value;
  const current = active === null ? null : points[active];
  // El recuadro va al lado del punto, hacia donde haya más espacio.
  const tipSide = active !== null && x(active) > width * 0.55 ? { right: width - x(active) + 12 } : { left: (active === null ? 0 : x(active)) + 12 };

  return (
    <div
      ref={wrapRef}
      className="balance-chart"
      role="group"
      tabIndex={0}
      aria-label={`${timeline.name}: saldo al final de cada día, de ${clp(first)} a ${clp(last)}. Con las flechas se recorre día por día; el detalle está en la tabla.`}
      onKeyDown={onKey}
      onFocus={() => setActive((a) => a ?? n)}
      onBlur={() => setActive(null)}
    >
      <svg width="100%" viewBox={`0 0 ${width} ${bottom + AXIS}`} aria-hidden="true">
        {/* Fin de semana: Banco de Chile no fecha esos días, lo pasa al lunes. */}
        {span >= 3 &&
          points.slice(1).map((p, k) =>
            isWeekend(p.day!) ? <rect key={`w${k}`} className="weekend" x={col(k)} y={TOP} width={span} height={height} /> : null,
          )}
        {active !== null && <rect className="active-day" x={col(active - 1)} y={TOP} width={span} height={height} />}
        {scale.ticks.map((t, i) => (
          <g key={t}>
            <line className={t === 0 ? 'zero' : 'grid'} x1={left} x2={left + plotWidth} y1={y(t)} y2={y(t)} />
            <text className="tick" x={left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">
              {tickLabels[i]}
            </text>
          </g>
        ))}
        {points.slice(1).map((p, k) =>
          labeled.has(k) ? (
            <text key={`d${k}`} className="tick" x={x(k + 1)} y={bottom + 16} textAnchor="middle">
              {dayName(p.day!)}
            </text>
          ) : null,
        )}
        <path className="line" d={line} />
        {active !== null && <line className="crosshair" x1={x(active)} x2={x(active)} y1={TOP} y2={bottom} />}
        {points.map((p, i) => {
          if (i === 0 || (!markers && i !== active)) return null;
          // Del mismo tamaño a la vista: el lleno lleva un anillo del color del fondo, el vacío es solo el borde.
          const seen = p.seen === p.of;
          const r = (seen ? 5.5 : 3.5) + (i === active ? 1.5 : 0);
          return <circle key={i} className={seen ? 'mark seen' : 'mark unseen'} cx={x(i)} cy={y(p.value)} r={r} />;
        })}
        <rect
          className="hit"
          x={left}
          y={0}
          width={plotWidth}
          height={bottom + AXIS}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => {
            // Con el foco en el gráfico (flechas) el recuadro se queda.
            if (document.activeElement !== wrapRef.current) setActive(null);
          }}
        />
      </svg>
      {current && active !== null && (
        <div className="chart-tip no-print" role="status" style={{ top: TOP, ...tipSide }}>
          <strong>{clp(current.value)}</strong>
          <span className="muted">al final del {shortDate(current.day!, true)}</span>
          <span>{current.value === points[active - 1].value ? 'Sin cambio en el día' : `${clpSigned(current.value - points[active - 1].value)} en el día`}</span>
          {detail?.(active)}
        </div>
      )}
    </div>
  );
}
