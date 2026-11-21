import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setOwner, setUnauthorizedHandler, viewAs, type ManagedUser, type Me } from './api';
import { DataProvider } from './data';
import { DailyPage } from './pages/DailyPage';
import { ImportPage } from './pages/ImportPage';
import { LoginPage } from './pages/LoginPage';
import { MovementsPage } from './pages/MovementsPage';
import { PayrollPage } from './pages/PayrollPage';
import { ReportPage } from './pages/ReportPage';
import { SettingsPage } from './pages/SettingsPage';
import { UsersPage } from './pages/UsersPage';
import { href, useRoute } from './router';
import { useTheme } from './theme';
import { ThemeToggle } from './components/ThemeToggle';

const NAV = [
  { path: '/informe', label: 'Informe' },
  { path: '/diario', label: 'Diario' },
  { path: '/movimientos', label: 'Movimientos' },
  { path: '/nominas', label: 'Nóminas' },
  { path: '/importar', label: 'Importar cartolas' },
  { path: '/configuracion', label: 'Configuración' },
];

const ADMIN_NAV = [...NAV, { path: '/usuarios', label: 'Usuarios' }];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const route = useRoute();
  const theme = useTheme();
  const logo = theme === 'dark' ? '/icon-dark.svg' : '/icon.svg';
  const topbarRef = useRef<HTMLElement>(null);

  const loadMe = useCallback(
    () =>
      api
        .get<Me>('/api/auth/me')
        .then((m) => {
          setOwner(m.owner.id);
          setMe(m);
        })
        .catch(() => setMe(null)),
    [],
  );

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    loadMe();
  }, [loadMe]);

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

  // Alto real de la barra superior (cambia si se parte en dos filas o se abre el menú móvil):
  // las barras fijas de cada página se pegan justo debajo (--topbar-h).
  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const update = () => document.documentElement.style.setProperty('--topbar-h', `${el.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [me]);

  if (me === undefined) return null;
  if (me === null) return <LoginPage onLogin={loadMe} />;

  const logout = async () => {
    await api.post('/api/auth/logout');
    setOwner(null);
    setMe(null);
  };
  const isAdmin = me.role === 'admin';

  return (
    <DataProvider>
      <header ref={topbarRef} className="topbar no-print">
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
            {(isAdmin ? ADMIN_NAV : NAV).map((n) => (
              <a key={n.path} href={href(n.path)} className={route.path === n.path ? 'active' : ''}>
                {n.label}
              </a>
            ))}
          </nav>
          <span className="user">
            {isAdmin && <OwnerSelect me={me} />}
            <span>{me.username}</span>
            <button className="link" onClick={logout}>Salir</button>
          </span>
        </div>
        <ThemeToggle />
      </header>
      <main>
        {route.path === '/diario' && <DailyPage params={route.params} />}
        {route.path === '/movimientos' && <MovementsPage params={route.params} />}
        {route.path === '/nominas' && <PayrollPage params={route.params} />}
        {route.path === '/importar' && <ImportPage viewing={me.owner.id !== me.id ? me.owner.username : null} />}
        {route.path === '/configuracion' && <SettingsPage />}
        {route.path === '/usuarios' && isAdmin && <UsersPage me={me} />}
        {!['/diario', '/movimientos', '/nominas', '/importar', '/configuracion', '/usuarios'].includes(route.path) && <ReportPage params={route.params} />}
      </main>
    </DataProvider>
  );
}

/** Cuentas que ve el administrador: las suyas o las de uno de sus usuarios. Solo aparece si tiene usuarios. */
function OwnerSelect({ me }: { me: Me }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  useEffect(() => {
    api
      .get<ManagedUser[]>('/api/admin/users')
      .then(setUsers)
      .catch(() => {});
  }, []);

  const active = users.filter((u) => u.active);
  if (active.length === 0) return null;
  const viewingOther = me.owner.id !== me.id;
  return (
    <label className={viewingOther ? 'owner-select other' : 'owner-select'} title="Cuentas que estás viendo">
      <span>Cuentas de</span>
      <select value={me.owner.id} onChange={(e) => viewAs(me, Number(e.target.value))}>
        <option value={me.id}>mí</option>
        {active.map((u) => (
          <option key={u.id} value={u.id}>
            {u.username}
          </option>
        ))}
      </select>
    </label>
  );
}
