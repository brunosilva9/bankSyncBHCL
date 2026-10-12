// Tema claro/oscuro. Si el usuario no elige uno, se sigue el del sistema operativo.
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'syncbanks-theme';
// Se emite tras cada cambio de tema para que los componentes reactivos se refresquen.
const THEME_EVENT = 'syncbanks-theme';

export function storedTheme(): Theme | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

export function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** Tema con el que arranca la app: el elegido a mano o, si no hay, el del sistema. */
export function initTheme(): Theme {
  const theme = storedTheme() ?? systemTheme();
  applyTheme(theme);
  return theme;
}

export function saveTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

/** Tema activo de forma reactiva; se actualiza al cambiar claro/oscuro. */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(initTheme);
  useEffect(() => {
    const onChange = () => setTheme(currentTheme());
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);
  return theme;
}
