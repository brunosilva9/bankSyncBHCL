// La infografía del saldo como imagen: el gráfico con su título, el período y el resumen, para pegarla en un chat o
// un correo. Siempre en colores claros, aunque la app esté en tema oscuro: la imagen se ve igual donde se pegue.

const NS = 'http://www.w3.org/2000/svg';
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const INK = '#1c2430';
const MUTED = '#677387';
const LINE = '#2563eb';
const PAPER = '#ffffff';

/** Cada parte del gráfico (las clases de BalanceChart) con los colores del tema claro: en una imagen no hay CSS. */
const STYLES: Array<[string, Record<string, string>]> = [
  ['.grid', { stroke: '#e1e5eb', 'stroke-width': '1' }],
  ['.zero', { stroke: MUTED, 'stroke-width': '1' }],
  ['.tick', { fill: MUTED, 'font-size': '11px' }],
  ['.weekend', { fill: 'rgba(100,116,139,0.08)' }],
  ['.line', { fill: 'none', stroke: LINE, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }],
  ['.mark.seen', { fill: LINE, stroke: PAPER, 'stroke-width': '2', r: '5.5' }],
  ['.mark.unseen', { fill: PAPER, stroke: LINE, 'stroke-width': '2', r: '3.5' }],
];
/** Lo que es solo de la pantalla: el área del mouse y la marca del día que se está mirando. */
const SCREEN_ONLY = '.hit, .active-day, .crosshair';

export interface ImageText {
  title: string;
  /** Las cuentas y el período. */
  subtitle: string;
  /** De cuánto a cuánto. */
  summary: string;
}

/**
 * Al pie: qué es un punto lleno y uno vacío. Los círculos van del color de la línea; el vacío, un poco más chico,
 * porque la letra lo dibuja más grande que el lleno.
 */
const LEGEND: Array<[string, string, number?]> = [
  ['● ', LINE],
  ['con cartola ese día  ', MUTED],
  ['○ ', LINE, 10],
  ['sin cartola: sale de los movimientos  ·  sábados y domingos, sombreados', MUTED],
];

/** El SVG de la imagen: una copia del gráfico, con el estilo escrito en cada parte, bajo un encabezado. */
export function chartImageSvg(chart: SVGSVGElement, text: ImageText): { svg: string; width: number; height: number } {
  const [, , w, h] = (chart.getAttribute('viewBox') ?? '0 0 640 240').split(/\s+/).map(Number);
  const pad = 20;
  const head = 82;
  const width = w + pad * 2;
  const height = head + h + 34;

  const el = (tag: string, attrs: Record<string, string | number>, content?: string) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (content !== undefined) node.textContent = content;
    return node;
  };
  // El xmlns lo escribe XMLSerializer: ponerlo también como atributo lo duplica y la imagen no se lee.
  const root = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, 'font-family': FONT });
  root.append(
    el('rect', { width, height, fill: PAPER }),
    el('text', { x: pad, y: pad + 14, 'font-size': 16, 'font-weight': 600, fill: INK }, text.title),
    el('text', { x: pad, y: pad + 34, 'font-size': 12, fill: MUTED }, text.subtitle),
    el('text', { x: pad, y: pad + 54, 'font-size': 13, fill: INK }, text.summary),
  );

  const copy = chart.cloneNode(true) as SVGSVGElement;
  copy.querySelectorAll(SCREEN_ONLY).forEach((node) => node.remove());
  for (const [selector, style] of STYLES) {
    copy.querySelectorAll(selector).forEach((node) => Object.entries(style).forEach(([k, v]) => node.setAttribute(k, v)));
  }
  const body = el('g', { transform: `translate(${pad} ${head})` });
  body.append(...Array.from(copy.childNodes));
  root.append(body);

  const legend = el('text', { x: pad, y: head + h + 22, 'font-size': 11 });
  legend.append(...LEGEND.map(([part, fill, size]) => el('tspan', size ? { fill, 'font-size': size } : { fill }, part)));
  root.append(legend);
  return { svg: new XMLSerializer().serializeToString(root), width, height };
}

/** El SVG dibujado en un PNG, al doble de resolución para que se vea nítido en el teléfono. */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('El navegador no deja dibujar la imagen');
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No se pudo armar la imagen'))), 'image/png'));
}
