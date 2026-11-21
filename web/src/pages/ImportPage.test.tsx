import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataProvider } from '../data';
import { ImportPage } from './ImportPage';

const imported = {
  type: 'account',
  accountName: 'Cuenta de prueba',
  accountNumber: '00-111-11111-01',
  fromDate: '2026-10-01',
  toDate: '2026-10-12',
  statement: null,
  replacedProvisional: 0,
  inserted: 3,
  alreadyLoaded: 0,
  balance: 700,
  warnings: [],
};

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
  if (url === '/api/imports' && init?.method === 'POST') {
    const anyway = (init.headers as Record<string, string>)['x-import-anyway'] === '1';
    return anyway
      ? reply(200, imported)
      : reply(409, { code: 'account-elsewhere', error: 'cartola.txt: la cuenta 00-111-11111-01 de Banco de Chile ya está en las cuentas de «secretaria»' });
  }
  return reply(200, []);
});
const uploads = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/imports' && init?.method === 'POST');

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('ImportPage', () => {
  it('avisa a qué cuentas importa y deja importar igual una cuenta que es de otro usuario', async () => {
    const { container } = render(
      <DataProvider>
        <ImportPage viewing="contadora" />
      </DataProvider>,
    );
    expect(screen.getByText('contadora', { selector: 'strong' })).toBeInTheDocument();

    const file = new File(['contenido'], 'cartola.txt', { type: 'text/plain' });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } });

    const anyway = await screen.findByRole('button', { name: 'Importar igual en las cuentas de contadora' });
    expect(screen.getByText(/ya está en las cuentas de «secretaria»/)).toBeInTheDocument();
    // No se reintenta solo como una cartola de línea: espera a que el usuario decida.
    expect(uploads()).toHaveLength(1);

    fireEvent.click(anyway);
    expect(await screen.findByText(/movimientos nuevos/)).toBeInTheDocument();
    expect(uploads()).toHaveLength(2);
  });
});
