import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setOwner, type ManagedUser, type Me } from '../api';
import { UsersPage } from './UsersPage';

const jefe: Me = { id: 1, username: 'jefe', role: 'admin', owner: { id: 1, username: 'jefe' } };
const secretaria: ManagedUser = { id: 2, username: 'secretaria', active: true, created_at: '2026-10-22 12:00:00', accounts: 3, last_import: '2026-10-21 19:24:56' };

let users: ManagedUser[];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const body = url === '/api/admin/users' && (init?.method ?? 'GET') === 'GET' ? users : { ok: true };
  return { ok: true, status: 200, json: async () => body };
});
const sent = (method: string, url: string) =>
  fetchMock.mock.calls.filter(([u, init]) => u === url && init?.method === method).map(([, init]) => JSON.parse(String(init!.body)));

beforeEach(() => {
  users = [secretaria];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setOwner(null);
});

describe('UsersPage', () => {
  it('lista los usuarios con sus cuentas y deja entrar a verlas', async () => {
    render(<UsersPage me={jefe} />);
    expect(await screen.findByText('secretaria')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ver sus cuentas' })).toBeEnabled();
  });

  it('muestra que está viendo las cuentas del usuario y cómo volver a las suyas', async () => {
    render(<UsersPage me={{ ...jefe, owner: { id: 2, username: 'secretaria' } }} />);
    expect(await screen.findByText('Viendo sus cuentas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Volver a mis cuentas' })).toBeInTheDocument();
  });

  it('crea un usuario', async () => {
    render(<UsersPage me={jefe} />);
    const create = screen.getByRole('button', { name: 'Crear usuario' });
    fireEvent.change(screen.getByLabelText('Usuario'), { target: { value: 'Contador' } });
    fireEvent.change(screen.getByLabelText('Contraseña (mínimo 10 caracteres)'), { target: { value: 'corta' } });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Contraseña (mínimo 10 caracteres)'), { target: { value: 'una-clave-larga' } });
    fireEvent.click(create);

    expect(await screen.findByText('Usuario «contador» creado.')).toBeInTheDocument();
    expect(sent('POST', '/api/admin/users')).toEqual([{ username: 'Contador', password: 'una-clave-larga' }]);
  });

  it('cambia la contraseña de un usuario', async () => {
    render(<UsersPage me={jefe} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cambiar contraseña' }));
    fireEvent.change(screen.getByLabelText(/Contraseña nueva para secretaria/), { target: { value: 'otra-clave-larga' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(sent('PUT', '/api/admin/users/2/password')).toEqual([{ password: 'otra-clave-larga' }]));
    expect(await screen.findByText(/Contraseña cambiada/)).toBeInTheDocument();
  });
});

describe('api', () => {
  it('avisa al servidor de quién son las cuentas que tiene cargadas la página', async () => {
    vi.stubGlobal('fetch', fetchMock);
    setOwner(2);
    await api.get('/api/accounts');
    expect((fetchMock.mock.calls.at(-1)![1]!.headers as Record<string, string>)['x-syncbanks-owner']).toBe('2');
  });
});
