import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useTheme } from '../theme';
import { ThemeToggle } from '../components/ThemeToggle';

export function LoginPage({ onLogin }: { onLogin: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const theme = useTheme();
  const logo = theme === 'dark' ? '/icon-dark.svg' : '/icon.svg';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ username: string }>('/api/auth/login', { username, password });
      onLogin(r.username);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <ThemeToggle />
      <div className="login-card">
        <img className="login-logo" src="/icon.svg" alt="" />
        <h1>SyncBanks</h1>
        <p className="login-tagline">
          Vista global de tus cuentas bancarias: importa las cartolas, ordena los movimientos con categorías y
          comentarios, y arma el informe del período listo para PDF.
        </p>
        <form onSubmit={submit}>
          <label>
            Usuario
            <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            Contraseña
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy || !username || !password}>
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}
