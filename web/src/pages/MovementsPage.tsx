import { useMemo, useState } from 'react';
import { api, qs, type Movement } from '../api';
import { CategorySelect } from '../components/CategorySelect';
import { LabelInput } from '../components/LabelInput';
import { RangePicker } from '../components/RangePicker';
import { useFetch, useShared } from '../data';
import { clp, presetRange, shortDate, type DateRange } from '../format';
import { groupPayroll } from '../payroll';
import { navigate } from '../router';

type Edit = { categoryId?: number | null | 'auto'; label?: string | null };

/** Sugerencia que aparece tras editar un movimiento: convertir la edición en regla. */
interface Suggestion {
  movement: Movement;
  edit: Edit;
  matches: number;
}

const counterpartyName = (m: Movement) => m.payee_name ?? m.counterparty;

export function MovementsPage({ params }: { params: Record<string, string> }) {
  const { accounts, categories, reload: reloadShared } = useShared();
  const range: DateRange = params.from && params.to ? { from: params.from, to: params.to } : presetRange('last30');
  const filters = { ...params, ...range };
  const setFilter = (patch: Record<string, string | number | undefined>) => navigate('/movimientos', { ...filters, ...patch }, true);

  const { data, error, loading, refresh, setData } = useFetch<Movement[]>(`/api/movements${qs(filters)}`);
  const [groupBatches, setGroupBatches] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [search, setSearch] = useState(params.q ?? '');

  const movements = data ?? [];
  const rows = useMemo(() => (groupBatches ? groupPayroll(movements) : movements.map((m) => ({ type: 'single' as const, m }))), [movements, groupBatches]);
  const totals = useMemo(
    () => ({
      out: movements.filter((m) => m.direction === 'C').reduce((s, m) => s + m.amount, 0),
      in: movements.filter((m) => m.direction === 'A').reduce((s, m) => s + m.amount, 0),
    }),
    [movements],
  );

  const patchLocal = (ids: number[], edit: Edit) =>
    setData((prev) =>
      (prev ?? []).map((m) =>
        ids.includes(m.id)
          ? {
              ...m,
              ...(edit.categoryId !== undefined && edit.categoryId !== 'auto' ? { category_id: edit.categoryId, category_source: 'manual' as const } : {}),
              ...(edit.label !== undefined ? { label: edit.label, label_source: edit.label ? ('manual' as const) : null } : {}),
            }
          : m,
      ),
    );

  const editOne = async (m: Movement, edit: Edit) => {
    patchLocal([m.id], edit);
    await api.patch(`/api/movements/${m.id}`, edit);
    if (edit.categoryId === 'auto' || edit.label === null) refresh();
    if (edit.label) reloadShared();
    const name = counterpartyName(m);
    if (name && m.kind !== 'payroll' && edit.categoryId !== 'auto' && (edit.categoryId !== undefined || edit.label)) {
      const matches = movements.filter((o) => o.counterparty === m.counterparty).length;
      setSuggestion({ movement: m, edit, matches });
    }
  };

  const editMany = async (ids: number[], edit: Edit) => {
    patchLocal(ids, edit);
    await api.post('/api/movements/bulk', { ids, ...edit });
    if (edit.label) reloadShared();
    refresh();
  };

  const createRule = async (s: Suggestion) => {
    await api.post('/api/rules', {
      matchType: 'counterparty',
      pattern: s.movement.counterparty,
      direction: s.movement.direction,
      categoryId: typeof s.edit.categoryId === 'number' ? s.edit.categoryId : undefined,
      label: s.edit.label ?? undefined,
      // La edición recién hecha a mano pasa a ser parte de la regla.
      overrideManual: true,
      movementIds: [s.movement.id],
    });
    setSuggestion(null);
    refresh();
  };

  const toggleSelect = (ids: number[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });

  return (
    <div className="page">
      <div className="toolbar">
        <RangePicker value={range} onChange={(r) => setFilter({ ...r })} />
      </div>
      <div className="toolbar filters">
        <select value={params.accountId ?? ''} onChange={(e) => setFilter({ accountId: e.target.value || undefined })}>
          <option value="">Todas las cuentas</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select value={params.direction ?? ''} onChange={(e) => setFilter({ direction: e.target.value || undefined })}>
          <option value="">Cargos y abonos</option>
          <option value="C">Solo cargos (salidas)</option>
          <option value="A">Solo abonos (entradas)</option>
        </select>
        <select value={params.categoryId ?? ''} onChange={(e) => setFilter({ categoryId: e.target.value || undefined, categoryKey: undefined })}>
          <option value="">Todas las categorías</option>
          <option value="none">Sin categoría</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ q: search || undefined });
          }}
        >
          <input type="search" placeholder="Buscar nombre, etiqueta…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
        <label className="check">
          <input type="checkbox" checked={params.excludeInternal === '1'} onChange={(e) => setFilter({ excludeInternal: e.target.checked ? 1 : undefined })} />
          Ocultar traspasos internos y de línea
        </label>
        <label className="check">
          <input type="checkbox" checked={groupBatches} onChange={(e) => setGroupBatches(e.target.checked)} />
          Agrupar nómina
        </label>
        {(params.label || params.kind || params.categoryKey) && (
          <button className="chip active" onClick={() => setFilter({ label: undefined, kind: undefined, batch: undefined, categoryKey: undefined })}>
            {params.label
              ? `Etiqueta: ${params.label}`
              : params.kind === 'payroll'
                ? 'Solo nómina'
                : params.kind === 'credit_line'
                  ? 'Solo línea de crédito'
                  : 'Solo traspasos internos'}{' '}
            ✕
          </button>
        )}
      </div>

      <p className="muted summary-line">
        {movements.length} movimientos · Salió <span className="neg">{clp(totals.out)}</span> · Entró <span className="pos">{clp(totals.in)}</span>
        {loading && ' · cargando…'}
      </p>
      {error && <p className="error">{error}</p>}

      {selected.size > 0 && (
        <div className="bulkbar">
          <strong>{selected.size} seleccionados</strong>
          <LabelInput value="" placeholder="Asignar etiqueta…" onCommit={(label) => label && editMany([...selected], { label })} />
          <CategorySelect value={null} placeholder="Asignar categoría…" onChange={(categoryId) => editMany([...selected], { categoryId })} />
          <button onClick={() => setSelected(new Set())}>Quitar selección</button>
        </div>
      )}

      <div className="table-wrap">
        <table className="movements">
          <thead>
            <tr>
              <th />
              <th>Fecha</th>
              <th>Cuenta</th>
              <th>Descripción</th>
              <th className="num">Cargo</th>
              <th className="num">Abono</th>
              <th className="num">Saldo</th>
              <th>Etiqueta</th>
              <th>Categoría</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) =>
              r.type === 'single' ? (
                <MovementRow key={r.m.id} m={r.m} selected={selected.has(r.m.id)} onSelect={(on) => toggleSelect([r.m.id], on)} onEdit={(e) => editOne(r.m, e)} />
              ) : (
                <BatchRows
                  key={r.key}
                  items={r.items}
                  label={r.batchesInDay > 1 ? `nómina ${r.batch} de ${r.batchesInDay}` : null}
                  open={open.has(r.key)}
                  onToggle={() =>
                    setOpen((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.key)) next.delete(r.key);
                      else next.add(r.key);
                      return next;
                    })
                  }
                  selected={selected}
                  onSelect={toggleSelect}
                  onEditAll={(e) => editMany(r.items.map((m) => m.id), e)}
                  onEditOne={editOne}
                />
              ),
            )}
          </tbody>
        </table>
      </div>

      {suggestion && (
        <div className="toast">
          <span>
            ¿Aplicar{' '}
            {typeof suggestion.edit.categoryId === 'number' && <strong>{categories.find((c) => c.id === suggestion.edit.categoryId)?.name}</strong>}
            {typeof suggestion.edit.categoryId === 'number' && suggestion.edit.label && ' y '}
            {suggestion.edit.label && <strong>«{suggestion.edit.label}»</strong>} a todos los {suggestion.movement.direction === 'C' ? 'pagos a' : 'abonos de'}{' '}
            <strong>{counterpartyName(suggestion.movement)}</strong>
            {suggestion.matches > 1 ? ` (${suggestion.matches} en esta vista)` : ''} y a los que lleguen en próximas cartolas?
          </span>
          <button className="primary" onClick={() => createRule(suggestion)}>
            Sí, crear regla
          </button>
          <button onClick={() => setSuggestion(null)}>Solo este</button>
        </div>
      )}
    </div>
  );
}

function Description({ m }: { m: Movement }) {
  const name = counterpartyName(m);
  return (
    <td className="desc">
      {name && m.kind !== 'other' ? (
        <>
          <span>{name}</span>
          <small className="muted">{m.kind === 'payroll' && m.payee_name ? `Pago Fácil · ${m.counterparty}` : m.description}</small>
        </>
      ) : (
        <span>{m.description}</span>
      )}
      {m.note && <small className="note">{m.note}</small>}
      {m.provisional === 1 && (
        <small className="badge" title="De la cartola en línea: se reemplaza al importar la próxima cartola consolidada">
          provisorio
        </small>
      )}
    </td>
  );
}

function MovementRow({ m, selected, onSelect, onEdit, nested }: { m: Movement; selected: boolean; onSelect: (on: boolean) => void; onEdit: (e: Edit) => void; nested?: boolean }) {
  return (
    <tr className={`${m.system_key === 'internal' ? 'internal' : ''} ${nested ? 'nested' : ''}`}>
      <td>
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label="Seleccionar" />
      </td>
      <td className="nowrap">{shortDate(m.date)}</td>
      <td className="nowrap small">{m.account_name}</td>
      <Description m={m} />
      <td className="num neg">{m.direction === 'C' ? clp(m.amount) : ''}</td>
      <td className="num pos">{m.direction === 'A' ? clp(m.amount) : ''}</td>
      <td className="num muted small">{clp(m.balance_after)}</td>
      <td>
        <LabelInput value={m.label ?? ''} fromRule={m.label_source === 'rule'} onCommit={(label) => onEdit({ label })} />
      </td>
      <td>
        <CategorySelect value={m.category_id} source={m.category_source} onChange={(categoryId) => onEdit({ categoryId })} />
      </td>
    </tr>
  );
}

function BatchRows(props: {
  items: Movement[];
  label: string | null;
  open: boolean;
  onToggle: () => void;
  selected: Set<number>;
  onSelect: (ids: number[], on: boolean) => void;
  onEditAll: (e: Edit) => void;
  onEditOne: (m: Movement, e: Edit) => void;
}) {
  const { items, open } = props;
  const first = items[0];
  const total = items.reduce((s, m) => s + m.amount, 0);
  const ids = items.map((m) => m.id);
  const allSelected = ids.every((id) => props.selected.has(id));
  const categoryIds = new Set(items.map((m) => m.category_id));
  const labels = new Set(items.map((m) => m.label ?? ''));
  return (
    <>
      <tr className="batch">
        <td>
          <input type="checkbox" checked={allSelected} onChange={(e) => props.onSelect(ids, e.target.checked)} aria-label="Seleccionar nómina" />
        </td>
        <td className="nowrap">{shortDate(first.date)}</td>
        <td className="nowrap small">{first.account_name}</td>
        <td className="desc">
          <button className="link" onClick={props.onToggle}>
            {open ? '▾' : '▸'} Nómina Pago Fácil · {items.length} pagos{props.label && ` · ${props.label}`}
          </button>
        </td>
        <td className="num neg">{clp(total)}</td>
        <td />
        <td className="num muted small">{clp(first.balance_after)}</td>
        <td>
          <LabelInput value={labels.size === 1 ? (first.label ?? '') : ''} placeholder={labels.size > 1 ? '(varias)' : ''} onCommit={(label) => props.onEditAll({ label })} />
        </td>
        <td>
          <CategorySelect value={categoryIds.size === 1 ? first.category_id : null} placeholder="(varias)" onChange={(categoryId) => props.onEditAll({ categoryId })} />
        </td>
      </tr>
      {open &&
        items.map((m) => (
          <MovementRow key={m.id} m={m} nested selected={props.selected.has(m.id)} onSelect={(on) => props.onSelect([m.id], on)} onEdit={(e) => props.onEditOne(m, e)} />
        ))}
    </>
  );
}
