// Copiar al portapapeles. El texto sirve para un chat o un correo; el HTML, si viene, para que Excel, Google
// Sheets o Word lo peguen como tabla. Con HTTPS o en localhost se usa la API del portapapeles. Sin ella (la app
// abierta por http en la red local) o si el navegador no deja, se copia con execCommand, que sigue andando en
// todos los navegadores mientras sea dentro del clic.

export interface ClipboardContent {
  text: string;
  html?: string;
}

export async function copyToClipboard({ text, html }: ClipboardContent): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (clipboard) {
    try {
      if (html && typeof ClipboardItem !== 'undefined' && clipboard.write) {
        await clipboard.write([
          new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) }),
        ]);
      } else {
        await clipboard.writeText(text);
      }
      return true;
    } catch {
      // Sin permiso (p. ej. la página no tenía el foco): se intenta a la antigua.
    }
  }
  return copyWithCommand(text, html);
}

/**
 * Copia una imagen PNG. Llega como promesa porque Safari pide armar el ClipboardItem dentro del clic, aunque la
 * imagen todavía se esté dibujando. Sin API del portapapeles (la app por http en la red local) no se puede: false.
 */
export async function copyImageToClipboard(png: Promise<Blob>): Promise<boolean> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  } catch {
    return false;
  }
}

/** Descarga un archivo: lo que queda cuando el navegador no deja copiar una imagen. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** El evento copy entrega los dos formatos; el texto queda además seleccionado por si el navegador no lo usa. */
function copyWithCommand(text: string, html?: string): boolean {
  const holder = document.createElement('pre');
  holder.textContent = text;
  holder.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.append(holder);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const range = document.createRange();
  range.selectNodeContents(holder);
  selection?.removeAllRanges();
  selection?.addRange(range);
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    if (html) e.clipboardData.setData('text/html', html);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.removeEventListener('copy', onCopy);
    selection?.removeAllRanges();
    if (previous) selection?.addRange(previous);
    holder.remove();
  }
}
