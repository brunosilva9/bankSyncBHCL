import { useEffect, useRef, useState } from 'react';
import { copyImageToClipboard, downloadBlob } from '../clipboard';

type State = 'idle' | 'copied' | 'downloaded' | 'failed';

const LABELS: Record<Exclude<State, 'idle'>, string> = {
  copied: 'Imagen copiada ✓',
  downloaded: 'Imagen descargada ✓',
  failed: 'No se pudo copiar',
};

/**
 * Copia como imagen lo que arma `image` en el momento del clic. Si el navegador no deja copiar imágenes, la
 * descarga como `filename`. Avisa en el mismo botón.
 */
export function CopyImageButton({ image, filename, label = 'Copiar imagen' }: { image: () => Promise<Blob>; filename: string; label?: string }) {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    const png = image();
    // Si el armado falla, que no quede un rechazo sin atender mientras se intenta copiar.
    png.catch(() => {});
    let next: State = 'copied';
    if (!(await copyImageToClipboard(png))) {
      try {
        downloadBlob(await png, filename);
        next = 'downloaded';
      } catch {
        next = 'failed';
      }
    }
    setState(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2500);
  };

  return (
    <button type="button" className="link no-print" onClick={copy} title="Para pegar el gráfico en un chat o un correo" aria-live="polite">
      {state === 'idle' ? label : LABELS[state]}
    </button>
  );
}
