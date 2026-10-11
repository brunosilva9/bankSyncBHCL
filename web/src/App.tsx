import { useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api';
import { DataProvider } from './data';
import { ImportPage } from './pages/ImportPage';
import { LoginPage } from './pages/LoginPage';
import { MovementsPage } from './pages/MovementsPage';
import { PayrollPage } from './pages/PayrollPage';
import { ReportPage } from './pages/ReportPage';
import { SettingsPage } from './pages/SettingsPage';
import { href, useRoute } from './router';

const NAV = [
  { path: '/informe', label: 'Informe' },
  { path: '/movimientos', label: 'Movimientos' },
  { path: '/nominas', label: 'Nóminas' },
  { path: '/importar', label: 'Importar cartolas' },
  { path: '/configuracion', label: 'Configuración' },
];

export function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const route = useRoute();

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api
      .get<{ username: string }>('/api/auth/me')
      .then((r) => setUser(r.username))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return null;
  if (user === null) return <LoginPage onLogin={setUser} />;

  const logout = async () => {
    await api.post('/api/auth/logout');
    setUser(null);
  };

  return (
    <DataProvider>
      <header className="topbar no-print">
        <strong className="brand">SyncBanks</strong>
        <nav>
          {NAV.map((n) => (
            <a key={n.path} href={href(n.path)} className={route.path === n.path ? 'active' : ''}>
              {n.label}
            </a>
          ))}
        </nav>
        <span className="user">
          {user} · <button className="link" onClick={logout}>Salir</button>
        </span>
      </header>
      <main>
        {route.path === '/movimientos' && <MovementsPage params={route.params} />}
        {route.path === '/nominas' && <PayrollPage params={route.params} />}
        {route.path === '/importar' && <ImportPage />}
        {route.path === '/configuracion' && <SettingsPage />}
        {!['/movimientos', '/nominas', '/importar', '/configuracion'].includes(route.path) && <ReportPage params={route.params} />}
      </main>
    </DataProvider>
  );
}
