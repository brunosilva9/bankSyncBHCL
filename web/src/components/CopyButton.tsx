import { useEffect, useRef, useState } from 'react';
import { copyToClipboard, type ClipboardContent } from '../clipboard';

type State = 'idle' | 'done' | 'failed';

/** Copia al portapapeles lo que arma `content` en el momento del clic, y avisa en el mismo botón si se pudo. */
export function CopyButton({ content, label = 'Copiar', title }: { content: () => ClipboardContent; label?: string; title?: string }) {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await copyToClipboard(content());
    setState(ok ? 'done' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2500);
  };

  return (
    <button
      type="button"
      className="link no-print"
      onClick={copy}
      title={state === 'failed' ? 'El navegador no dejó copiar. Selecciona el texto y cópialo a mano.' : title}
      aria-live="polite"
    >
      {state === 'done' ? 'Copiado ✓' : state === 'failed' ? 'No se pudo copiar' : label}
    </button>
  );
}
