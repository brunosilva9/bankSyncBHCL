import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Account, type Category } from './api';

// Datos de referencia que usan todas las páginas.
interface SharedData {
  accounts: Account[];
  categories: Category[];
  labels: string[];
  reload: () => Promise<void>;
}

/** Un solo <datalist> con los comentarios existentes, compartido por todos los campos de comentario. */
export const LABELS_LIST_ID = 'labels-list';

const Ctx = createContext<SharedData | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [labels, setLabels] = useState<string[]>([]);

  const reload = useCallback(async () => {
    const [a, c, l] = await Promise.all([
      api.get<Account[]>('/api/accounts'),
      api.get<Category[]>('/api/categories'),
      api.get<Array<{ label: string }>>('/api/labels'),
    ]);
    setAccounts(a);
    setCategories(c);
    setLabels(l.map((x) => x.label));
  }, []);

  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);

  return (
    <Ctx.Provider value={{ accounts, categories, labels, reload }}>
      {children}
      <datalist id={LABELS_LIST_ID}>
        {labels.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
    </Ctx.Provider>
  );
}

export function useShared(): SharedData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useShared fuera de DataProvider');
  return v;
}

/** Carga datos de la API y vuelve a cargar cuando cambia la clave. */
export function useFetch<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setLoading(true);
    api
      .get<T>(url)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [url, tick]);

  return { data, error, loading, refresh: () => setTick((t) => t + 1), setData };
}
