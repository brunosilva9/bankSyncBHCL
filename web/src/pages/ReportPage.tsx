import { useEffect, useMemo, type ReactNode } from 'react';
import { qs, type Category, type Movement, type Report } from '../api';
import { RangePicker } from '../components/RangePicker';
import { useFetch, useShared } from '../data';
import { clp, clpSigned, presetRange, shortDate, type DateRange } from '../format';
import { chronological, groupByCategory, movementTitle, periodText, reportFileName, topPayroll } from '../reportDetail';
import { href, navigate } from '../router';

// El informe tiene tres hojas: Resumen (siempre una sola página), Entradas y Gastos.
// En pantalla se ve una a la vez; al imprimir salen las tres, cada una en su página.
const SHEETS = [
  { key: 'resumen', label: 'Resumen' },
  { key: 'entradas', label: 'Entradas' },
  { key: 'gastos', label: 'Gastos' },
] as const;
type SheetKey = (typeof SHEETS)[number]['key'];

type LinkFn = (p: Record<string, string | number | null | undefined>) => string;

export function ReportPage({ params }: { params: Record<string, string> }) {
  const { accounts, categories } = useShared();
  const range: DateRange = params.from && params.to ? { from: params.from, to: params.to } : presetRange('friday');
  const accountId = params.account ?? '';
  const sheet: SheetKey = SHEETS.some((s) => s.key === params.hoja) ? (params.hoja as SheetKey) : 'resumen';

  const setFilters = (patch: Record<string, string | undefined>) => navigate('/informe', { ...range, account: accountId, hoja: sheet, ...patch }, true);

  const { data: report, error, loading } = useFetch<Report>(`/api/report${qs({ ...range, accounts: accountId })}`);
  // Mismo criterio que el informe: sin traspasos internos ni giros/amortizaciones de la línea.
  const detail = { ...range, accountId, excludeInternal: 1, limit: 5000 };
  const income = useFetch<Movement[]>(`/api/movements${qs({ ...detail, direction: 'A' })}`);
  const expenses = useFetch<Movement[]>(`/api/movements${qs({ ...detail, direction: 'C' })}`);

  const movementsLink: LinkFn = (extra) => href('/movimientos', { from: range.from, to: range.to, accountId: accountId || undefined, ...extra });
  const scopeName = accountId ? (accounts.find((a) => String(a.id) === accountId)?.name ?? 'Cuenta') : 'Todas las cuentas';
  // Títulos y nombre del PDF usan lo que realmente traen los datos, no el filtro
  // (ej. filtro hasta el 18/10, pero la última cartola llega al 13/10).
  const period = report?.period ?? range;

  useEffect(() => {
    const previous = document.title;
    document.title = reportFileName(period, scopeName);
    return () => {
      document.title = previous;
    };
  }, [period.from, period.to, scopeName]);

  const header = (n: number, title: string) => (
    <header className="sheet-header">
      <h1>
        {title} {periodText(period)} <small className="muted">· Hoja {n} de 3</small>
      </h1>
      <p className="muted">
        {scopeName}
        <br />
        <small>
          * Fechas contables del banco: lo hecho en fin de semana, feriado o después del horario de corte se registra el día hábil siguiente.
        </small>
      </p>
    </header>
  );

  return (
    <div className="page report">
      <div className="toolbar no-print">
        <RangePicker value={range} onChange={(r) => setFilters({ ...r })} />
        <label>
          Cuenta{' '}
          <select value={accountId} onChange={(e) => setFilters({ account: e.target.value || undefined })}>
            <option value="">Todas</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => window.print()}>Imprimir / PDF (3 hojas)</button>
      </div>
      <div className="tabs no-print">
        {SHEETS.map((s) => (
          <button key={s.key} className={sheet === s.key ? 'chip active' : 'chip'} onClick={() => setFilters({ hoja: s.key })}>
            {s.label}
          </button>
        ))}
      </div>

      {(error || income.error || expenses.error) && <p className="error">{error ?? income.error ?? expenses.error}</p>}
      {!report && loading && <p className="muted">Cargando…</p>}
      {report && report.accounts.length === 0 && (
        <p className="card">
          Aún no hay cartolas cargadas. <a href={href('/importar')}>Importar cartolas</a>
        </p>
      )}
      {report && report.accounts.length > 0 && (period.from !== range.from || period.to !== range.to) && (
        <p className="info no-print">
          El filtro va del {shortDate(range.from, true)} al {shortDate(range.to, true)}, pero hay movimientos solo {periodText(period)}; el informe y
          el PDF usan ese período.
        </p>
      )}
      {report && report.accounts.length > 0 && (
        <>
          <Sheet active={sheet === 'resumen'}>
            {header(1, 'Resumen')}
            <SummarySheet report={report} movementsLink={movementsLink} />
          </Sheet>
          <Sheet active={sheet === 'entradas'}>
            {header(2, 'Lo que entró')}
            <IncomeSheet movements={income.data} expectedTotal={report.totals.income} />
          </Sheet>
          <Sheet active={sheet === 'gastos'}>
            {header(3, 'En qué se gastó')}
            <ExpensesSheet movements={expenses.data} expectedTotal={report.totals.expenses} categories={categories} />
          </Sheet>
        </>
      )}
    </div>
  );
}

function Sheet({ active, children }: { active: boolean; children: ReactNode }) {
  return <section className={`sheet ${active ? '' : 'inactive'}`}>{children}</section>;
}

// ---------- Hoja 1: Resumen ----------

function SummarySheet({ report, movementsLink }: { report: Report; movementsLink: LinkFn }) {
  const t = report.totals;
  const multiAccount = report.accounts.length > 1;
  const payrollTotal = report.payroll.reduce((s, p) => s + p.total, 0);
  const payrollCount = report.payroll.reduce((s, p) => s + p.count, 0);
  const payroll = topPayroll(report.payroll);

  return (
    <>
      {report.warnings.map((w) => (
        <p key={w} className="warning">
          {w}
        </p>
      ))}

      <section className="flow card">
        <Step
          label={t.hasCredit ? 'Disponible inicial' : 'Saldo inicial'}
          value={clp(t.hasCredit ? t.availableOpening : t.opening)}
          sub={t.hasCredit ? `Saldo ${clp(t.opening)} + línea ${clp(t.creditAvailableOpening)}` : undefined}
        />
        <Step label="Entró" value={`+${clp(t.income)}`} tone="pos" href={movementsLink({ direction: 'A', excludeInternal: 1 })} />
        <Step label="Salió" value={`−${clp(t.expenses)}`} tone="neg" href={movementsLink({ direction: 'C', excludeInternal: 1 })} />
        {t.internalNet !== 0 && (
          <Step
            label="Traspasos con cuentas propias"
            value={clpSigned(t.internalNet)}
            tone={t.internalNet > 0 ? 'pos' : 'neg'}
            href={movementsLink({ categoryKey: 'internal' })}
          />
        )}
        <Step
          label={t.hasCredit ? 'Disponible final' : 'Saldo final'}
          value={clp(t.hasCredit ? t.availableClosing : t.closing)}
          sub={t.hasCredit ? `Saldo ${clp(t.closing)} + línea ${clp(t.creditAvailableClosing)}` : undefined}
          strong
        />
      </section>

      {multiAccount && (
        <section className="card">
          <h2>Por cuenta</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cuenta</th>
                  <th className="num">{t.hasCredit ? 'Disponible inicial' : 'Saldo inicial'}</th>
                  <th className="num">Entró</th>
                  <th className="num">Salió</th>
                  <th className="num">Traspasos internos</th>
                  <th className="num">Saldo final</th>
                  {t.hasCredit && <th className="num">Línea disponible</th>}
                  {t.hasCredit && <th className="num">Disponible final</th>}
                </tr>
              </thead>
              <tbody>
                {report.accounts.map((a) => (
                  <tr key={a.accountId}>
                    <td>{a.name}</td>
                    <td className="num">{clp(t.hasCredit ? a.availableOpening : a.opening)}</td>
                    <td className="num pos">{clp(a.income)}</td>
                    <td className="num neg">{clp(a.expenses)}</td>
                    <td className="num">{clpSigned(a.internalIn - a.internalOut)}</td>
                    <td className={`num ${(a.closing ?? 0) < 0 ? 'neg' : ''}`}>{t.hasCredit ? clp(a.closing) : <strong>{clp(a.closing)}</strong>}</td>
                    {t.hasCredit && <td className="num">{a.creditLimit !== null ? clp(a.creditAvailableClosing) : ''}</td>}
                    {t.hasCredit && (
                      <td className="num">
                        <strong>{clp(a.availableClosing)}</strong>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report.accounts
        .filter((a) => a.creditLimit !== null)
        .map((a) => {
          const used = a.creditLimit! - (a.creditAvailableClosing ?? 0);
          return (
            <section key={a.accountId} className="card credit">
              <h2>Línea de crédito · {a.name}</h2>
              <div className="credit-grid">
                <Figure label="Cupo" value={clp(a.creditLimit)} />
                <Figure label="Usado" value={clp(used)} />
                <Figure label="Disponible en la línea" value={clp(a.creditAvailableClosing)} />
                <Figure label="Saldo cuenta corriente" value={clp(a.closing)} tone={(a.closing ?? 0) < 0 ? 'neg' : undefined} />
                <Figure label="Disponible real" value={clp(a.availableClosing)} />
              </div>
              <meter min={0} max={a.creditLimit!} value={used} />
              <p className="muted small">
                En el período se giraron {clp(a.creditDrawn)} desde la línea y se amortizaron {clp(a.creditRepaid)}; no cuentan como entrada ni
                salida porque solo pasan plata entre la línea y la cuenta corriente.
              </p>
            </section>
          );
        })}

      {report.payroll.length > 0 && (
        <section className="card">
          <h2>Nóminas (Pago Fácil)</h2>
          <table className="compact">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Cuenta</th>
                <th className="num">Pagos</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {payroll.shown.map((p) => (
                <tr key={`${p.accountId}-${p.date}-${p.batch}`}>
                  <td className="nowrap">
                    {shortDate(p.date, true)}
                    {p.batchesInDay > 1 && <small className="muted"> · nómina {p.batch} de {p.batchesInDay}</small>}
                  </td>
                  <td>{p.accountName}</td>
                  <td className="num">{p.count}</td>
                  <td className="num">{clp(p.total)}</td>
                </tr>
              ))}
              {payroll.rest.batches > 0 && (
                <tr className="muted">
                  <td colSpan={2}>Otras {payroll.rest.batches} nóminas más chicas</td>
                  <td className="num">{payroll.rest.count}</td>
                  <td className="num">{clp(payroll.rest.total)}</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>
                  <strong>Total · {report.payroll.length} nóminas</strong>
                  <span className="no-print">
                    {' '}
                    · <a href={href('/nominas', { from: report.params.from, to: report.params.to })}>Ver detalle por trabajador</a>
                  </span>
                </td>
                <td className="num">
                  <strong>{payrollCount}</strong>
                </td>
                <td className="num">
                  <strong>{clp(payrollTotal)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      {report.uncategorizedCount > 0 && (
        <p className="info no-print">
          Hay {report.uncategorizedCount} movimientos sin categoría en este período.{' '}
          <a href={movementsLink({ categoryId: 'none', excludeInternal: 1 })}>Categorizarlos</a>
        </p>
      )}

    </>
  );
}

// ---------- Hoja 2: Entradas ----------

function IncomeSheet({ movements, expectedTotal }: { movements: Movement[] | null; expectedTotal: number }) {
  const rows = useMemo(() => chronological(movements ?? []), [movements]);
  if (!movements) return <p className="muted">Cargando…</p>;
  const total = rows.reduce((s, m) => s + m.amount, 0);
  return (
    <>
      <TotalMismatch total={total} expected={expectedTotal} />
      <table className="detail">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Entró a</th>
            <th>Desde</th>
            <th className="num">Monto</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td className="nowrap">{shortDate(m.date)}</td>
              <td className="nowrap">{m.account_name}</td>
              <td>
                {movementTitle(m)}
                {m.provisional === 1 && <small className="badge">provisorio</small>}
              </td>
              <td className="num">{clp(m.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="grand-total">
            <td colSpan={3}>Total entró · {rows.length} movimientos</td>
            <td className="num">{clp(total)}</td>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

// ---------- Hoja 3: Gastos por categoría ----------

function ExpensesSheet({ movements, expectedTotal, categories }: { movements: Movement[] | null; expectedTotal: number; categories: Category[] }) {
  const groups = useMemo(() => groupByCategory(movements ?? [], categories), [movements, categories]);
  if (!movements) return <p className="muted">Cargando…</p>;
  const total = groups.reduce((s, g) => s + g.total, 0);
  return (
    <>
      <TotalMismatch total={total} expected={expectedTotal} />
      <table className="detail">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Cuenta</th>
            <th>Detalle</th>
            <th>Etiqueta</th>
            <th className="num">Monto</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={String(g.categoryId)} className="category-group">
            <tr className="group-header">
              <th colSpan={4}>
                <span className="dot" style={{ background: g.color ?? 'var(--muted)' }} />
                {g.name} <small className="muted">· {g.count} mov. · {total ? Math.round((g.total / total) * 100) : 0}%</small>
              </th>
              <th className="num">{clp(g.total)}</th>
            </tr>
            {g.rows.map((r) =>
              r.type === 'single' ? (
                <tr key={r.m.id}>
                  <td className="nowrap">{shortDate(r.m.date)}</td>
                  <td className="nowrap small">{r.m.account_name}</td>
                  <td>
                    {movementTitle(r.m)}
                    {r.m.provisional === 1 && <small className="badge">provisorio</small>}
                  </td>
                  <td className="small">{r.m.label}</td>
                  <td className="num">{clp(r.m.amount)}</td>
                </tr>
              ) : (
                <tr key={r.key}>
                  <td className="nowrap">{shortDate(r.items[0].date)}</td>
                  <td className="nowrap small">{r.items[0].account_name}</td>
                  <td>
                    Nómina Pago Fácil · {r.items.length} pagos
                    {r.batchesInDay > 1 && ` · nómina ${r.batch} de ${r.batchesInDay}`}
                  </td>
                  <td className="small">{new Set(r.items.map((m) => m.label ?? '')).size === 1 ? r.items[0].label : ''}</td>
                  <td className="num">{clp(r.items.reduce((s, m) => s + m.amount, 0))}</td>
                </tr>
              ),
            )}
          </tbody>
        ))}
        <tfoot>
          <tr className="grand-total">
            <td colSpan={4}>Total salió · {movements.length} movimientos</td>
            <td className="num">{clp(total)}</td>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

/** Control: el detalle debe sumar lo mismo que el resumen. */
function TotalMismatch({ total, expected }: { total: number; expected: number }) {
  if (total === expected) return null;
  return (
    <p className="warning">
      El detalle suma {clp(total)} pero el resumen dice {clp(expected)}. Puede que haya más de 5.000 movimientos en el período.
    </p>
  );
}

// ---------- Piezas ----------

interface StepProps {
  label: string;
  value: string;
  sub?: string;
  tone?: 'pos' | 'neg';
  strong?: boolean;
  href?: string;
}

function Step({ label, value, sub, tone, strong, href: link }: StepProps) {
  const body = (
    <>
      <span className="step-label">{label}</span>
      <span className={`step-value ${tone ?? ''}`}>{value}</span>
      {sub && <span className="step-sub muted small">{sub}</span>}
    </>
  );
  return <div className={`step ${strong ? 'strong' : ''}`}>{link ? <a href={link}>{body}</a> : body}</div>;
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'neg' }) {
  return (
    <div>
      <span className="muted small">{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}
