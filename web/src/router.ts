import { useEffect, useState } from 'react';

// Ruteo mínimo por hash: "#/movimientos?from=2026-10-01&categoryId=3".
export interface Route {
  path: string;
  params: Record<string, string>;
}

export function parseHash(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  return { path: path || '/informe', params: Object.fromEntries(new URLSearchParams(query)) };
}

export function href(path: string, params: Record<string, string | number | undefined | null> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const q = p.toString();
  return `#${path}${q ? `?${q}` : ''}`;
}

export function navigate(path: string, params: Record<string, string | number | undefined | null> = {}, replace = false) {
  const url = href(path, params);
  if (replace) history.replaceState(null, '', url);
  else location.hash = url;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
