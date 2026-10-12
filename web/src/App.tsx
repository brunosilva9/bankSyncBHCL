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
import { useTheme } from './theme';
import { ThemeToggle } from './components/ThemeToggle';

const NAV = [
  { path: '/informe', label: 'Informe' },
  { path: '/movimientos', label: 'Movimientos' },
  { path: '/nominas', label: 'Nóminas' },
  { path: '/importar', label: 'Importar cartolas' },
  { path: '/configuracion', label: 'Configuración' },
];

export function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const route = useRoute();
  const theme = useTheme();
  const logo = theme === 'dark' ? '/icon-dark.svg' : '/icon.svg';

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api
      .get<{ username: string }>('/api/auth/me')
      .then((r) => setUser(r.username))
      .catch(() => setUser(null));
  }, []);

  // El menú móvil se cierra al navegar y con Escape o un toque afuera.
  useEffect(() => setMenuOpen(false), [route.path]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.topbar')) setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [menuOpen]);

  if (user === undefined) return null;
  if (user === null) return <LoginPage onLogin={setUser} />;

  const logout = async () => {
    await api.post('/api/auth/logout');
    setUser(null);
  };

  return (
    <DataProvider>
      <header className="topbar no-print">
        <a className="brand" href={href('/informe')} title="Ir al informe">
          <img className="brand-logo" src={logo} alt="" />
          <span>SyncBanks</span>
        </a>
        <button
          type="button"
          className="topbar-menu-btn"
          aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
          aria-expanded={menuOpen}
          aria-controls="topbar-menu"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="bars" aria-hidden="true" />
        </button>
        <div id="topbar-menu" className={menuOpen ? 'topbar-collapse open' : 'topbar-collapse'}>
          <nav>
            {NAV.map((n) => (
              <a key={n.path} href={href(n.path)} className={route.path === n.path ? 'active' : ''}>
                {n.label}
              </a>
            ))}
          </nav>
          <span className="user">
            <span>{user}</span>
            <button className="link" onClick={logout}>Salir</button>
          </span>
        </div>
        <ThemeToggle />
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
