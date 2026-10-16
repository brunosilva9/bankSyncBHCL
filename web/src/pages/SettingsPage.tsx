import { useEffect, useState } from 'react';
import { api, type Account, type Category, type Payee, type Rule } from '../api';
import { CategorySelect } from '../components/CategorySelect';
import { useFetch, useShared } from '../data';
import { clp, shortDate } from '../format';

export function SettingsPage() {
  return (
    <div className="page settings">
      <h1>Configuración</h1>
      <AccountsSection />
      <CategoriesSection />
      <RulesSection />
      <PayeesSection />
    </div>
  );
}

function useAction() {
  const [error, setError] = useState<string | null>(null);
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
  return { error, run };
}

function AccountsSection() {
  const { accounts } = useShared();
  return (
    <section className="card">
      <h2>Cuentas</h2>
      <p className="muted small">
        En «Aparece como» pon cómo se ve esta empresa en las cartolas de las otras cuentas (un nombre por línea, ej. «Mi Empresa Spa»). Los
        traspasos hacia o desde esos nombres se marcan como <strong>Traspaso interno</strong> y no cuentan como gasto ni ingreso en la vista global.
      </p>
      {accounts.length === 0 && <p className="muted">Las cuentas se crean solas al importar la primera cartola.</p>}
      {accounts.map((a) => (
        <AccountForm key={a.id} account={a} />
      ))}
    </section>
  );
}

/** "8.000.000" o "$8000000" -> 8000000; vacío -> null. */
const parsePesos = (s: string): number | null => {
  const digits = s.replace(/[^\d-]/g, '');
  return digits === '' ? null : Number(digits);
};

const initialForm = (a: Account) => ({
  name: a.name,
  rut: a.rut ?? '',
  aliases: a.aliases,
  creditLimit: a.credit_limit?.toString() ?? '',
  creditAvailableNow: '',
});

function AccountForm({ account }: { account: Account }) {
  const { reload } = useShared();
  const [form, setForm] = useState(() => initialForm(account));
  const [saved, setSaved] = useState(false);
  const { error, run } = useAction();
  useEffect(() => setForm(initialForm(account)), [account]);

  const creditAvailable = account.credit_limit !== null && account.credit_used !== null ? account.credit_limit - account.credit_used : null;

  const save = async () => {
    const body = {
      name: form.name,
      rut: form.rut,
      aliases: form.aliases,
      creditLimit: parsePesos(form.creditLimit),
      creditAvailableNow: parsePesos(form.creditAvailableNow) ?? undefined,
    };
    if (await run(() => api.patch(`/api/accounts/${account.id}`, body))) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      reload();
    }
  };

  return (
    <div className="account-form">
      <div className="muted small">
        {account.bank} · {account.number_formatted} · {account.movement_count} movimientos
        {account.coverage_from && ` · ${shortDate(account.coverage_from)} al ${shortDate(account.coverage_to!)}`} · saldo {clp(account.balance)}
      </div>
      <div className="row">
        <label>
          Nombre
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          RUT
          <input value={form.rut} onChange={(e) => setForm({ ...form, rut: e.target.value })} />
        </label>
        <label className="grow">
          Aparece como
          <textarea rows={2} value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
        </label>
      </div>
      <div className="row">
        <label>
          Cupo línea de crédito
          <input inputMode="numeric" placeholder="Sin línea" value={form.creditLimit} onChange={(e) => setForm({ ...form, creditLimit: e.target.value })} />
        </label>
        {form.creditLimit && (
          <label>
            Disponible de la línea hoy (según el banco)
            <input
              inputMode="numeric"
              placeholder={creditAvailable !== null ? `Calculado: ${clp(creditAvailable)}` : 'Para calibrar'}
              value={form.creditAvailableNow}
              onChange={(e) => setForm({ ...form, creditAvailableNow: e.target.value })}
            />
          </label>
        )}
        <button className="primary" onClick={save}>
          {saved ? 'Guardado ✓' : 'Guardar'}
        </button>
      </div>
      {form.creditLimit && (
        <p className="muted small">
          {creditAvailable !== null
            ? `Línea: usado ${clp(account.credit_used)}, disponible ${clp(creditAvailable)} · disponible real (saldo + línea) ${clp((account.balance ?? 0) + creditAvailable)}. `
            : 'Falta calibrar la línea. '}
          El uso se sigue solo con los giros y amortizaciones de la cuenta corriente. Para recalibrar, escribe el disponible que muestra el banco
          (en la cartola Excel aparece como «Línea de Crédito») o importa la cartola .txt de la línea descargada el mismo día que la de la cuenta
          corriente.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function CategoriesSection() {
  const { categories, reload } = useShared();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#0ea5e9');
  const { error, run } = useAction();

  const add = async () => {
    if (await run(() => api.post('/api/categories', { name, color }))) {
      setName('');
      reload();
    }
  };

  return (
    <section className="card">
      <h2>Categorías</h2>
      <ul className="category-list">
        {categories.map((c) => (
          <CategoryItem key={c.id} category={c} onError={(fn) => run(fn)} />
        ))}
      </ul>
      <div className="row">
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Color" />
        <input placeholder="Nueva categoría" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name && add()} />
        <button onClick={add} disabled={!name.trim()}>
          Agregar
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function CategoryItem({ category, onError }: { category: Category; onError: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const { reload } = useShared();
  const [name, setName] = useState(category.name);
  const save = (patch: Partial<Category>) => onError(() => api.patch(`/api/categories/${category.id}`, { name, color: category.color, ...patch })).then(reload);
  const remove = () => {
    if (confirm(`¿Borrar la categoría «${category.name}»? Los movimientos que la tengan quedarán sin categoría.`)) {
      onError(() => api.del(`/api/categories/${category.id}`)).then(reload);
    }
  };
  return (
    <li>
      <input type="color" value={category.color} onChange={(e) => save({ color: e.target.value })} aria-label="Color" />
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== category.name && save({ name })} />
      {category.system_key ? <small className="muted">automática</small> : <button className="link danger" onClick={remove}>Borrar</button>}
    </li>
  );
}

function RulesSection() {
  const { data: rules, refresh } = useFetch<Rule[]>('/api/rules');
  const { reload } = useShared();
  const [form, setForm] = useState<{ matchType: 'counterparty' | 'contains'; pattern: string; direction: string; categoryId: number | null; label: string }>({
    matchType: 'contains',
    pattern: '',
    direction: '',
    categoryId: null,
    label: '',
  });
  const { error, run } = useAction();

  const add = async () => {
    const ok = await run(() =>
      api.post('/api/rules', {
        ...form,
        direction: form.direction || undefined,
        categoryId: form.categoryId ?? undefined,
        label: form.label || undefined,
      }),
    );
    if (ok) {
      setForm({ ...form, pattern: '', label: '' });
      refresh();
      reload();
    }
  };

  const remove = async (id: number) => {
    await run(() => api.del(`/api/rules/${id}`));
    refresh();
  };

  return (
    <section className="card">
      <h2>Reglas</h2>
      <p className="muted small">
        Se aplican a los movimientos actuales y a los de próximas cartolas, salvo a los que editaste a mano. Las más nuevas tienen prioridad. También
        se crean desde Movimientos al cambiar la categoría o el comentario de uno.
      </p>
      <table>
        <tbody>
          {(rules ?? []).map((r) => (
            <tr key={r.id}>
              <td>
                {r.match_type === 'counterparty' ? 'Contraparte es' : 'Descripción contiene'} <strong>«{r.pattern}»</strong>
                {r.direction && <small className="muted"> ({r.direction === 'C' ? 'solo cargos' : 'solo abonos'})</small>}
              </td>
              <td>→ {[r.category_name, r.label && `«${r.label}»`].filter(Boolean).join(' + ')}</td>
              <td>
                <button className="link danger" onClick={() => remove(r.id)}>
                  Borrar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <select value={form.matchType} onChange={(e) => setForm({ ...form, matchType: e.target.value as 'counterparty' | 'contains' })}>
          <option value="contains">Descripción contiene</option>
          <option value="counterparty">Contraparte es</option>
        </select>
        <input placeholder="Texto, ej. Copec" value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} />
        <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
          <option value="">Cargos y abonos</option>
          <option value="C">Solo cargos</option>
          <option value="A">Solo abonos</option>
        </select>
        <CategorySelect value={form.categoryId} placeholder="Categoría (opcional)" onChange={(v) => setForm({ ...form, categoryId: typeof v === 'number' ? v : null })} />
        <input placeholder="Comentario (opcional)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <button onClick={add} disabled={!form.pattern.trim() || (form.categoryId === null && !form.label.trim())}>
          Agregar regla
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function PayeesSection() {
  const { data: payees, setData } = useFetch<Payee[]>('/api/payees');
  const [filter, setFilter] = useState('');
  const save = async (rut: string, name: string) => {
    await api.put(`/api/payees/${encodeURIComponent(rut)}`, { name });
    setData((prev) => (prev ?? []).map((p) => (p.rut === rut ? { ...p, name: name || null } : p)));
  };
  const shown = (payees ?? []).filter((p) => !filter || p.rut.includes(filter) || p.name?.toLowerCase().includes(filter.toLowerCase()));

  return (
    <section className="card">
      <h2>Trabajadores (Pago Fácil)</h2>
      <p className="muted small">
        La cartola solo trae el RUT de cada pago de nómina. Ponle nombre una vez y se mostrará en todos los movimientos y en los informes.
      </p>
      <input type="search" placeholder="Buscar RUT o nombre" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="table-wrap tall">
        <table>
          <thead>
            <tr>
              <th>RUT</th>
              <th>Nombre</th>
              <th className="num">Pagos</th>
              <th className="num">Total</th>
              <th>Último</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.rut}>
                <td className="nowrap">{p.rut}</td>
                <td>
                  <input defaultValue={p.name ?? ''} placeholder="Sin nombre" onBlur={(e) => e.target.value !== (p.name ?? '') && save(p.rut, e.target.value)} />
                </td>
                <td className="num">{p.count}</td>
                <td className="num">{clp(p.total)}</td>
                <td className="nowrap">{shortDate(p.last_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
