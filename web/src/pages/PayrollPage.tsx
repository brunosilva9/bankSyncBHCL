import { useMemo, useState } from 'react';
import { api, qs, type Movement } from '../api';
import { CategorySelect } from '../components/CategorySelect';
import { LabelInput } from '../components/LabelInput';
import { RangePicker } from '../components/RangePicker';
import { useFetch, useShared } from '../data';
import { clp, presetRange, shortDate, type DateRange } from '../format';
import { buildBatches, summarizeWorkers, type PayrollBatch } from '../payroll';
import { navigate } from '../router';

type View = 'nominas' | 'trabajadores';

export function PayrollPage({ params }: { params: Record<string, string> }) {
  const { accounts, reload: reloadShared } = useShared();
  const range: DateRange = params.from && params.to ? { from: params.from, to: params.to } : presetRange('month');
  const accountId = params.accountId ?? '';
  const view: View = params.view === 'trabajadores' ? 'trabajadores' : 'nominas';
  const setFilter = (patch: Record<string, string | undefined>) => navigate('/nominas', { ...range, accountId, view, ...patch }, true);

  const { data, error, loading, refresh, setData } = useFetch<Movement[]>(
    `/api/movements${qs({ ...range, accountId, kind: 'payroll', limit: 5000 })}`,
  );
  const batches = useMemo(() => buildBatches(data ?? []), [data]);
  const workers = useMemo(() => summarizeWorkers(batches), [batches]);
  const total = batches.reduce((s, b) => s + b.total, 0);
  const payments = batches.reduce((s, b) => s + b.items.length, 0);

  /** Pone nombre a un RUT y lo refleja en todos los pagos cargados. */
  const savePayee = async (rut: string, name: string) => {
    await api.put(`/api/payees/${encodeURIComponent(rut)}`, { name });
    setData((prev) => (prev ?? []).map((m) => (m.counterparty === rut ? { ...m, payee_name: name || null } : m)));
  };

  const editBatch = async (b: PayrollBatch, edit: { categoryId?: number | null | 'auto'; label?: string | null }) => {
    await api.post('/api/movements/bulk', { ids: b.items.map((m) => m.id), ...edit });
    if (edit.label) reloadShared();
    refresh();
  };

  /** Marca (o desmarca) un pago como el último de su nómina; los de abajo quedan en otra nómina. */
  const splitAfter = async (m: Movement, split: boolean) => {
    await api.post(`/api/movements/${m.id}/payroll-split`, { split });
    refresh();
  };

  return (
    <div className="page">
      <div className="toolbar">
        <RangePicker value={range} onChange={(r) => setFilter({ ...r })} />
        <select value={accountId} onChange={(e) => setFilter({ accountId: e.target.value || undefined })}>
          <option value="">Todas las cuentas</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <h1>Nóminas (Pago Fácil)</h1>
      {error && <p className="error">{error}</p>}

      <section className="card summary-grid">
        <Figure label="Total pagado" value={clp(total)} />
        <Figure label="Nóminas" value={String(batches.length)} />
        <Figure label="Pagos" value={String(payments)} />
        <Figure label="Trabajadores" value={String(workers.length)} />
      </section>

      <div className="tabs">
        <button className={view === 'nominas' ? 'chip active' : 'chip'} onClick={() => setFilter({ view: 'nominas' })}>
          Por nómina
        </button>
        <button className={view === 'trabajadores' ? 'chip active' : 'chip'} onClick={() => setFilter({ view: 'trabajadores' })}>
          Por trabajador
        </button>
        {loading && <span className="muted"> cargando…</span>}
      </div>

      {!loading && batches.length === 0 && <p className="muted">No hay pagos de Pago Fácil en este período.</p>}
      {view === 'nominas' ? (
        <BatchesTable batches={batches} onEdit={editBatch} onSavePayee={savePayee} onSplit={splitAfter} />
      ) : (
        <WorkersTable workers={workers} onSavePayee={savePayee} />
      )}
      <p className="muted small">
        Cada nómina es un bloque de pagos Pago Fácil seguidos en la cartola. Dos nóminas cargadas una tras otra, sin otro movimiento entre
        medio, aparecen como una sola: ábrela y usa <strong>✂ Cortar aquí</strong> en la última persona de la primera nómina; las de abajo
        pasan a otra. Si hay más de dos, se corta de nuevo.
      </p>
    </div>
  );
}

function BatchesTable(props: {
  batches: PayrollBatch[];
  onEdit: (b: PayrollBatch, edit: { categoryId?: number | null | 'auto'; label?: string | null }) => void;
  onSavePayee: (rut: string, name: string) => void;
  onSplit: (m: Movement, split: boolean) => Promise<void>;
}) {
  // Las nóminas abiertas se recuerdan por su primer pago: al cortar o unir cambia el n° de nómina, no el primer pago.
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (key: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="table-wrap">
      <table className="movements">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Cuenta</th>
            <th>Nómina</th>
            <th className="num">Pagos</th>
            <th className="num">Total</th>
            <th>Categoría</th>
            <th>Comentario</th>
          </tr>
        </thead>
        <tbody>
          {props.batches.map((b) => {
            const categories = new Set(b.items.map((m) => m.category_id));
            const labels = new Set(b.items.map((m) => m.label ?? ''));
            const isOpen = open.has(b.items[0].id);
            return [
              <tr key={b.key} className="batch">
                <td className="nowrap">{shortDate(b.date, true)}</td>
                <td className="nowrap small">{b.accountName}</td>
                <td>
                  <button className="link" onClick={() => toggle(b.items[0].id)}>
                    {isOpen ? '▾' : '▸'} {b.batchesInDay > 1 ? `Nómina ${b.batch} de ${b.batchesInDay}` : 'Nómina'}
                  </button>
                </td>
                <td className="num">{b.items.length}</td>
                <td className="num">
                  <strong>{clp(b.total)}</strong>
                </td>
                <td>
                  <CategorySelect
                    value={categories.size === 1 ? b.items[0].category_id : null}
                    placeholder={categories.size > 1 ? '(varias)' : undefined}
                    onChange={(categoryId) => props.onEdit(b, { categoryId })}
                  />
                </td>
                <td>
                  <LabelInput
                    value={labels.size === 1 ? (b.items[0].label ?? '') : ''}
                    placeholder={labels.size > 1 ? '(varias)' : ''}
                    onCommit={(label) => props.onEdit(b, { label })}
                  />
                </td>
              </tr>,
              ...(isOpen
                ? b.items.map((m, i) => (
                    <tr key={m.id} className="nested">
                      <td className="nowrap">
                        {i < b.items.length - 1 ? (
                          <button
                            className="link small"
                            title="Esta persona es la última de la nómina: las de abajo pasan a otra nómina"
                            onClick={() => props.onSplit(m, true).then(() => setOpen((prev) => new Set(prev).add(b.items[i + 1].id)))}
                          >
                            ✂ Cortar aquí
                          </button>
                        ) : (
                          m.payroll_split_after === 1 && (
                            <button className="link small" title="Vuelve a juntar esta nómina con la que sigue abajo" onClick={() => props.onSplit(m, false)}>
                              Unir con la de abajo
                            </button>
                          )
                        )}
                      </td>
                      <td className="nowrap small muted">{m.counterparty}</td>
                      <td colSpan={2}>
                        <PayeeName rut={m.counterparty ?? ''} name={m.payee_name} onSave={props.onSavePayee} />
                      </td>
                      <td className="num">{clp(m.amount)}</td>
                      <td colSpan={2} className="small muted">
                        {m.label}
                      </td>
                    </tr>
                  ))
                : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function WorkersTable({ workers, onSavePayee }: { workers: ReturnType<typeof summarizeWorkers>; onSavePayee: (rut: string, name: string) => void }) {
  const [filter, setFilter] = useState('');
  const shown = workers.filter((w) => !filter || w.rut.includes(filter) || w.name?.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <input type="search" placeholder="Buscar RUT o nombre" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>RUT</th>
              <th>Nombre</th>
              <th className="num">Pagos</th>
              <th className="num">Nóminas</th>
              <th className="num">Total</th>
              <th>Último pago</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((w) => (
              <tr key={w.rut}>
                <td className="nowrap">{w.rut}</td>
                <td>
                  <PayeeName rut={w.rut} name={w.name} onSave={onSavePayee} />
                </td>
                <td className="num">{w.count}</td>
                <td className="num">{w.batches}</td>
                <td className="num">
                  <strong>{clp(w.total)}</strong>
                </td>
                <td className="nowrap">{shortDate(w.lastDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Nombre del trabajador, editable en el lugar; se guarda al salir del campo. */
function PayeeName({ rut, name, onSave }: { rut: string; name: string | null; onSave: (rut: string, name: string) => void }) {
  return (
    <input
      key={name ?? ''}
      className="payee-input"
      defaultValue={name ?? ''}
      placeholder="Sin nombre"
      onBlur={(e) => e.target.value.trim() !== (name ?? '') && onSave(rut, e.target.value.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
