import { useState, type FormEvent } from 'react';
import { api, viewAs, type ManagedUser, type Me } from '../api';
import { useFetch } from '../data';
import { shortDate } from '../format';

/** Solo para administradores: sus usuarios, y entrar a ver las cuentas de cada uno. */
export function UsersPage({ me }: { me: Me }) {
  const { data: users, error, refresh } = useFetch<ManagedUser[]>('/api/admin/users');
  const viewingOther = me.owner.id !== me.id;

  return (
    <div className="page settings users">
      <h1>Usuarios</h1>
      {viewingOther && (
        <p className="info">
          Estás viendo las cuentas de <strong>{me.owner.username}</strong>: lo que importes o edites queda en sus cuentas.{' '}
          <button className="link" onClick={() => viewAs(me, me.id)}>
            Volver a mis cuentas
          </button>
        </p>
      )}
      <section className="card">
        <h2>Tus usuarios</h2>
        <p className="muted small">
          Cada usuario tiene sus propias cuentas y no ve las de nadie más. Con «Ver sus cuentas» entras a la app tal como la ve él y puedes trabajar en
          ellas; también puedes cambiar de cuentas arriba, junto a tu nombre.
        </p>
        {error && <p className="error">{error}</p>}
        {users?.length === 0 && <p className="muted">Todavía no tienes usuarios: créalos abajo.</p>}
        {!!users?.length && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th className="num">Cuentas</th>
                  <th>Última importación</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow key={u.id} me={me} user={u} onChange={refresh} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <NewUser onCreated={refresh} />
    </div>
  );
}

function UserRow({ me, user, onChange }: { me: Me; user: ManagedUser; onChange: () => void }) {
  // null: formulario de contraseña cerrado.
  const [password, setPassword] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewing = me.owner.id === user.id;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.put(`/api/admin/users/${user.id}/password`, { password }))) {
      setPassword(null);
      setSaved(true);
    }
  };

  const toggleActive = async () => {
    if (user.active && !confirm(`¿Desactivar a «${user.username}»? No podrá entrar hasta que lo actives de nuevo. Sus cuentas no se borran.`)) return;
    if (await run(() => api.put(`/api/admin/users/${user.id}/active`, { active: !user.active }))) {
      // Si estaba viendo sus cuentas, al desactivarlo vuelve a las propias.
      if (viewing && user.active) location.reload();
      else onChange();
    }
  };

  return (
    <>
      <tr className={user.active ? undefined : 'inactive'}>
        <td>
          <strong>{user.username}</strong>
        </td>
        <td className="num">{user.accounts}</td>
        <td className="nowrap">{user.last_import ? shortDate(user.last_import.slice(0, 10)) : '—'}</td>
        <td>{user.active ? 'Activo' : 'Desactivado'}</td>
        <td>
          <div className="user-actions">
            {viewing ? (
              <span className="muted small">Viendo sus cuentas</span>
            ) : (
              <button disabled={!user.active} onClick={() => viewAs(me, user.id)}>
                Ver sus cuentas
              </button>
            )}
            <button
              className="link"
              onClick={() => {
                setPassword(password === null ? '' : null);
                setSaved(false);
                setError(null);
              }}
            >
              Cambiar contraseña
            </button>
            <button className={user.active ? 'link danger' : 'link'} onClick={toggleActive}>
              {user.active ? 'Desactivar' : 'Activar'}
            </button>
          </div>
        </td>
      </tr>
      {(password !== null || saved || error) && (
        <tr className="user-edit">
          <td colSpan={5}>
            {password !== null && (
              <form className="row" onSubmit={savePassword}>
                <label className="grow">
                  Contraseña nueva para {user.username} (mínimo 10 caracteres)
                  <input type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
                </label>
                <button className="primary" disabled={password.length < 10}>
                  Guardar
                </button>
                <button type="button" onClick={() => setPassword(null)}>
                  Cancelar
                </button>
              </form>
            )}
            {saved && <p className="muted small">Contraseña cambiada. Si tenía la app abierta, tendrá que entrar de nuevo.</p>}
            {error && <p className="error">{error}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

function NewUser({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setCreated(null);
    try {
      await api.post('/api/admin/users', { username, password });
      setCreated(username.trim().toLowerCase());
      setUsername('');
      setPassword('');
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="card">
      <h2>Nuevo usuario</h2>
      <p className="muted small">
        Empieza sin cuentas: aparecen cuando él (o tú, viendo sus cuentas) importa su primera cartola. Entra con este usuario y contraseña, y tú puedes
        cambiársela cuando quieras.
      </p>
      <form className="row" onSubmit={submit}>
        <label>
          Usuario
          <input autoComplete="off" placeholder="ej. secretaria" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Contraseña (mínimo 10 caracteres)
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="primary" disabled={!username.trim() || password.length < 10}>
          Crear usuario
        </button>
      </form>
      {created && <p className="muted small">Usuario «{created}» creado.</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
