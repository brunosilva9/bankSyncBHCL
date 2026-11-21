import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyImageButton } from './CopyImageButton';

const png = () => Promise.resolve(new Blob(['png'], { type: 'image/png' }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('CopyImageButton', () => {
  it('copia la imagen al portapapeles', async () => {
    const write = vi.fn(async (_items: unknown[]) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(public items: Record<string, unknown>) {}
      },
    );
    render(<CopyImageButton image={png} filename="Saldo.png" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copiar imagen' }));
    expect(await screen.findByRole('button', { name: 'Imagen copiada ✓' })).toBeInTheDocument();
    expect(Object.keys((write.mock.calls[0][0][0] as { items: Record<string, unknown> }).items)).toEqual(['image/png']);
  });

  it('si el navegador no deja copiar imágenes (la app por http), la descarga', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:imagen', revokeObjectURL: () => {} }));
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    render(<CopyImageButton image={png} filename="Saldo del 13-11-2026.png" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copiar imagen' }));
    expect(await screen.findByRole('button', { name: 'Imagen descargada ✓' })).toBeInTheDocument();
    expect(downloads).toEqual(['Saldo del 13-11-2026.png']);
  });

  it('avisa si no se pudo armar la imagen', async () => {
    render(<CopyImageButton image={() => Promise.reject(new Error('sin gráfico'))} filename="Saldo.png" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copiar imagen' }));
    expect(await screen.findByRole('button', { name: 'No se pudo copiar' })).toBeInTheDocument();
  });
});
