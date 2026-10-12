import { useState } from 'react';
import { initTheme, saveTheme, type Theme } from '../theme';

/** Interruptor de tema claro/oscuro; la preferencia queda guardada. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initTheme);
  const dark = theme === 'dark';

  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    saveTheme(next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      className="theme-switch"
      onClick={toggle}
      aria-label="Cambiar entre tema claro y oscuro"
      title={dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
    >
      <span className="theme-switch-track">
        <span className="icon moon" aria-hidden="true" />
        <span className="icon sun" aria-hidden="true" />
        <span className="theme-switch-knob" />
      </span>
    </button>
  );
}
