import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, fechaParam, qs, NOTE_MAX, type Category, type DailyBalances, type Movement, type Report, type ReportNote } from '../api';
import { dayLedger, timelines, timelineSummary, type LedgerDay, type LedgerRow, type Timeline, type TimelinePoint } from '../balances';
import { chartImageSvg, svgToPng } from '../chartImage';
import { BalanceChart } from '../components/BalanceChart';
import { CategorySelect } from '../components/CategorySelect';
import { CopyImageButton } from '../components/CopyImageButton';
import { accountNote, balancesCardSvg, dayCardSvg, type DayCardOptions } from '../ledgerImage';
import { LabelInput } from '../components/LabelInput';
import { DatesSelect } from '../components/DatesSelect';
import { MovedBadge } from '../components/MovedBadge';
import { RangePicker } from '../components/RangePicker';
import { useFetch, useShared } from '../data';
import { clp, clpSigned, inChile, presetRange, shortDate, type DateRange } from '../format';
import { chronological, groupByCategory, movementTitle, periodText, reportFileName, topPayroll } from '../reportDetail';
import { type DisplayRow } from '../payroll';
import { href, navigate } from '../router';
import { dayOf } from '../seen';

// El informe tiene cuatro hojas: Resumen (siempre una sola página), Saldos (el saldo consolidado de cada día),
// Entradas y Gastos. En pantalla se muestran apiladas (las pestañas saltan a cada una); al imprimir sale cada una
// en su página.
const SHEETS = [
  { key: 'resumen', label: 'Resumen' },
  { key: 'saldos', label: 'Saldos' },
  { key: 'entradas', label: 'Entradas' },
  { key: 'gastos', label: 'Gastos' },
] as const;
type SheetKey = (typeof SHEETS)[number]['key'];

/** Movimientos que van pegados a la cabecera de cada categoría al imprimir. */
const HEAD_ROWS = 4;

/** Lo más que entrega la API de movimientos de una vez. */
const MAX_MOVEMENTS = 5000;

type LinkFn = (p: Record<string, string | number | null | undefined>) => string;

/** Edición de categoría o comentario de un movimiento, igual que en Movimientos. */
type Edit = { categoryId?: number | null | 'auto'; label?: string | null };

export function ReportPage({ params }: { params: Record<string, string> }) {
  const { accounts, categories, reload: reloadShared, dates } = useShared();
  const range: DateRange = params.from && params.to ? { from: params.from, to: params.to } : presetRange('friday');
  const accountId = params.account ?? '';
  // Las tres hojas se muestran apiladas; la navegación salta a cada una.
  const [activeSheet, setActiveSheet] = useState<SheetKey>('resumen');
  // En móvil la navegación se pliega tras una flecha flotante para no tapar el contenido.
  const [navOpen, setNavOpen] = useState(false);

  // La barra de filtros es fija: su alto (varía si se parte en varias filas) define dónde queda
  // el título de cada hoja al saltar a ella (scroll-margin-top de .sheet).
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const update = () => document.documentElement.style.setProperty('--report-toolbar-h', `${el.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const setFilters = (patch: Record<string, string | undefined>) => navigate('/informe', { ...range, account: accountId, ...patch }, true);
  const goToSheet = (key: SheetKey) => {
    setNavOpen(false);
    document.getElementById(`hoja-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const fecha = fechaParam(dates);
  const { data: report, error, loading, refresh: refreshReport, setData: setReport } = useFetch<Report>(`/api/report${qs({ ...range, accounts: accountId, fecha })}`);
  // Mismo criterio que el informe: sin traspasos internos ni giros/amortizaciones de la línea.
  const detail = { ...range, accountId, excludeInternal: 1, limit: MAX_MOVEMENTS, fecha };
  const income = useFetch<Movement[]>(`/api/movements${qs({ ...detail, direction: 'A' })}`);
  const expenses = useFetch<Movement[]>(`/api/movements${qs({ ...detail, direction: 'C' })}`);
  // El saldo de cada día, en el período que muestra el informe (se sabe cuando llega el resumen).
  const balances = useFetch<DailyBalances>(
    report ? `/api/balances${qs({ from: report.period.from, to: report.period.to, accounts: accountId, fecha })}` : null,
  );
  // El detalle día a día va con el saldo: lleva todos los movimientos, también los traspasos internos.
  const ledger = useFetch<Movement[]>(`/api/movements${qs({ ...range, accountId, limit: MAX_MOVEMENTS, fecha })}`);

  // Edición desde el informe: se aplica en pantalla al instante y recién se reconsulta
  // el resumen para mantener al día, por ejemplo, el conteo de movimientos sin categoría.
  const saveEdit = async (m: Movement, edit: Edit) => {
    const list = m.direction === 'A' ? income : expenses;
    list.setData((prev) =>
      (prev ?? []).map((x) =>
        x.id === m.id
          ? {
              ...x,
              ...(edit.categoryId !== undefined && edit.categoryId !== 'auto' ? { category_id: edit.categoryId, category_source: 'manual' as const } : {}),
              ...(edit.label !== undefined ? { label: edit.label, label_source: edit.label ? ('manual' as const) : null } : {}),
            }
          : x,
      ),
    );
    await api.patch(`/api/movements/${m.id}`, edit);
    if (edit.label) reloadShared();
    if (edit.categoryId === 'auto' || edit.label === null) list.refresh();
    refreshReport();
    ledger.refresh();
  };

  // Las nóminas solo salen en Gastos; la edición se aplica al lote completo.
  const saveEditAll = async (ids: number[], edit: Edit) => {
    expenses.setData((prev) =>
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
    await api.post('/api/movements/bulk', { ids, ...edit });
    if (edit.label) reloadShared();
    expenses.refresh();
    refreshReport();
    ledger.refresh();
  };

  const movementsLink: LinkFn = (extra) => href('/movimientos', { from: range.from, to: range.to, accountId: accountId || undefined, ...extra });
  const scopeName = accountId ? (accounts.find((a) => String(a.id) === accountId)?.name ?? 'Cuenta') : 'Todas las cuentas';
  // Títulos y nombre del PDF usan lo que realmente traen los datos, no el filtro
  // (ej. filtro hasta el 18/10, pero la última cartola llega al 13/10).
  const period = report?.period ?? range;

  // El comentario se guarda para el período real y el alcance de cuentas que muestra el informe.
  // Se refleja en pantalla con lo que devuelve el servidor (texto ya recortado) sin recargar el informe.
  const saveNote = async (text: string) => {
    const saved = await api.put<ReportNote | null>('/api/report-note', { from: period.from, to: period.to, accounts: accountId || undefined, text });
    setReport((prev) => (prev ? { ...prev, note: saved } : prev));
  };

  useEffect(() => {
    const previous = document.title;
    document.title = reportFileName(period, scopeName);
    return () => {
      document.title = previous;
    };
  }, [period.from, period.to, scopeName]);

  // Resalta en las pestañas la hoja que se está viendo mientras se hace scroll.
  useEffect(() => {
    if (!report) return;
    const sections = SHEETS.map((s) => document.getElementById(`hoja-${s.key}`)).filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const [visible] = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible) setActiveSheet(visible.target.id.replace('hoja-', '') as SheetKey);
      },
      { rootMargin: '-30% 0px -60% 0px' },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, [report]);

  const header = (n: number, title: string) => (
    <header className="sheet-header">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1>
          {title} <span className="muted sheet-period">{periodText(period)}</span>
        </h1>
        <span className="sheet-badge">
          Hoja {n} de {SHEETS.length}
        </span>
      </div>
      <p className="sheet-meta">
        <strong className="sheet-scope">{scopeName}</strong>
        <small className="muted sheet-note">
          {dates === 'real'
            ? '* Fechas reales: lo hecho en fin de semana, feriado o después del horario de corte va en el día en que se hizo, aunque el banco lo registre el día hábil siguiente (se indica la fecha del banco).'
            : '* Fechas contables del banco: lo hecho en fin de semana, feriado o después del horario de corte se registra el día hábil siguiente.'}
        </small>
      </p>
    </header>
  );

  return (
    <div className="page report">
      <div ref={toolbarRef} className="toolbar no-print">
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
        <DatesSelect />
        <button onClick={() => window.print()}>Imprimir / PDF ({SHEETS.length} hojas)</button>
      </div>
      <button
        type="button"
        className="sheet-nav-toggle no-print"
        aria-expanded={navOpen}
        aria-label={navOpen ? 'Ocultar hojas del informe' : 'Navegar entre las hojas del informe'}
        onClick={() => setNavOpen((o) => !o)}
      >
        <span className="chevron" aria-hidden="true" />
      </button>
      <nav className={navOpen ? 'sheet-nav open no-print' : 'sheet-nav no-print'} aria-label="Ir a las hojas del informe">
        {SHEETS.map((s, i) => (
          <button
            key={s.key}
            className={activeSheet === s.key ? 'chip active' : 'chip'}
            aria-current={activeSheet === s.key ? 'true' : undefined}
            onClick={() => goToSheet(s.key)}
          >
            <span className="sheet-nav-idx">{i + 1}</span>
            {s.label}
          </button>
        ))}
      </nav>

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
          <Sheet id="hoja-resumen">
            {header(1, 'Resumen')}
            <SummarySheet report={report} movementsLink={movementsLink} />
            <NoteCard note={report.note} onSave={saveNote} />
          </Sheet>
          <Sheet id="hoja-saldos">
            {header(2, accountId ? 'Saldo día a día' : 'Saldo consolidado día a día')}
            <BalanceSheet
              data={balances.data}
              error={balances.error ?? ledger.error}
              movements={ledger.data}
              hasCredit={report.totals.hasCredit}
              hasCards={report.totals.hasCards}
              expectedClosing={report.totals.hasCredit ? report.totals.availableClosing : report.totals.closing}
              scope={scopeName}
              caption={`${scopeName} · ${periodText(period)}`}
              imageName={`${reportFileName(period, scopeName).replace(/^Informe/, 'Saldo')}.png`}
            />
          </Sheet>
          <Sheet id="hoja-entradas">
            {header(3, 'Lo que entró')}
            <IncomeSheet movements={income.data} expectedTotal={report.totals.income} onEdit={(m, edit) => saveEdit(m, edit)} />
          </Sheet>
          <Sheet id="hoja-gastos">
            {header(4, 'En qué se gastó')}
            <ExpensesSheet
              movements={expenses.data}
              expectedTotal={report.totals.expenses}
              categories={categories}
              onEditOne={(m, edit) => saveEdit(m, edit)}
              onEditAll={(ids, edit) => saveEditAll(ids, edit)}
            />
          </Sheet>
        </>
      )}
    </div>
  );
}

function Sheet({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section id={id} className="sheet">
      {children}
    </section>
  );
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
      {/* Avisos de cobertura de cartolas: son para quien arma el informe, no salen en el PDF. */}
      {report.warnings.map((w) => (
        <p key={w} className="warning no-print">
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
        {t.hasCards && t.cardDebtChange !== 0 && (
          <Step
            label={t.cardDebtChange > 0 ? 'Quedó por pagar en tarjetas' : 'Deuda de tarjetas pagada'}
            value={clpSigned(t.cardDebtChange)}
            sub="Compras con tarjeta menos pagos del período"
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
                  {t.hasCards && <th className="num">Deuda nueva en tarjeta</th>}
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
                    {t.hasCards && <td className="num">{a.isCard ? clpSigned(a.cardDebtChange) : ''}</td>}
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
                <th>Comentario</th>
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
                  <td className="small">{p.comments.join(' · ')}</td>
                  <td className="num">{p.count}</td>
                  <td className="num">{clp(p.total)}</td>
                </tr>
              ))}
              {payroll.rest.batches > 0 && (
                <tr className="muted">
                  <td colSpan={3}>Otras {payroll.rest.batches} nóminas más chicas</td>
                  <td className="num">{payroll.rest.count}</td>
                  <td className="num">{clp(payroll.rest.total)}</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>
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

// ---------- Hoja 2: Saldo consolidado día a día ----------

/** Ancho del gráfico al imprimir: la hoja A4 menos los márgenes y el borde de su tarjeta. */
const PRINT_WIDTH = 660;

/** "mié 18/11" */
const dayMonth = (day: string) => shortDate(day, true).slice(0, -5);

/** Si el detalle día a día muestra los traspasos con cuentas propias (al comienzo, sí): se recuerda en este navegador. */
const SHOW_INTERNAL_KEY = 'syncbanks.traspasos';
const savedShowInternal = () => {
  try {
    return localStorage.getItem(SHOW_INTERNAL_KEY) !== '0';
  } catch {
    return true;
  }
};

/** Qué se sabe del saldo de ese día por las cartolas que se descargaron. */
export function seenText(p: TimelinePoint): string {
  if (p.seen === 0) return 'sin cartola ese día';
  if (p.of > 1) return p.seen === p.of ? 'con cartola de todas las cuentas' : `con cartola de ${p.seen} de ${p.of} cuentas`;
  return p.lastSeenAt ? `cartola de las ${inChile(p.lastSeenAt).time}` : 'con cartola, sin hora conocida';
}

/**
 * El saldo consolidado (el total de las cuentas) al final de cada día: un gráfico, la lista día a día y el detalle
 * con los movimientos de cada día y el saldo relativo que deja cada uno. Con una sola cuenta, el de esa cuenta.
 */
export function BalanceSheet({
  data,
  error,
  movements,
  hasCredit,
  hasCards,
  expectedClosing,
  scope,
  caption,
  imageName,
}: {
  data: DailyBalances | null;
  error: string | null;
  /** Todos los movimientos del período, también los traspasos internos. */
  movements: Movement[] | null;
  hasCredit: boolean;
  hasCards: boolean;
  /** El saldo (o disponible) final del resumen: el último punto tiene que ser ese. */
  expectedClosing: number;
  /** De qué cuentas es: "Todas las cuentas" o el nombre de la cuenta (para copiar un día). */
  scope: string;
  /** Para la imagen del gráfico: las cuentas y el período, y el nombre del archivo si hay que descargarla. */
  caption: string;
  imageName: string;
}) {
  const { categories, dates } = useShared();
  const chartCard = useRef<HTMLElement>(null);
  const [showInternal, setShowInternal] = useState(savedShowInternal);
  const toggleInternal = (show: boolean) => {
    setShowInternal(show);
    try {
      localStorage.setItem(SHOW_INTERNAL_KEY, show ? '1' : '0');
    } catch {
      // Sin almacenamiento (ventana privada): vale para esta visita.
    }
  };
  const series = useMemo(() => (data ? timelines(data) : null), [data]);
  const ledgerDays = useMemo(
    () => (data && movements ? dayLedger(data, movements, dates, showInternal) : null),
    [data, movements, dates, showInternal],
  );
  if (error) return <p className="error">{error}</p>;
  if (!data || !series) return <p className="muted">Cargando…</p>;
  const { total, accounts } = series;
  const main = total ?? accounts[0];
  if (!main) return <p className="card">No hay cuentas con saldo en este informe{hasCards ? ': las tarjetas no tienen saldo' : ''}.</p>;
  if (main.points.length < 2) return <p className="card">El período todavía no empieza: no hay saldos que mostrar.</p>;

  // Con línea de crédito, el disponible (saldo + línea libre), como en el resumen.
  const measure = (total ? hasCredit : data.accounts.some((a) => a.accountId === main.accountId && a.hasCredit)) ? 'Disponible' : 'Saldo';
  const last = main.points[main.points.length - 1].value;
  const accountDetail = (t: Timeline) => (i: number) => <span className="muted">{seenText(t.points[i])}</span>;
  const totalDetail = (i: number) => (
    <ul>
      {accounts.map((a) => (
        <li key={a.accountId}>
          {a.name}: <strong>{clp(a.points[i].value)}</strong> <small className="muted">· {seenText(a.points[i])}</small>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      {last !== expectedClosing && (
        <p className="warning">
          El último saldo de esta hoja ({clp(last)}) no es el saldo final del resumen ({clp(expectedClosing)}).
        </p>
      )}
      <section ref={chartCard} className="card balance-card">
        <TimelineHead
          timeline={main}
          measure={measure}
          action={
            <CopyImageButton
              filename={imageName}
              image={() => {
                const chart = chartCard.current?.querySelector<SVGSVGElement>('.balance-chart svg');
                if (!chart) return Promise.reject(new Error('No hay gráfico'));
                const title = total ? 'Saldo consolidado día a día' : 'Saldo día a día';
                const { svg, width, height } = chartImageSvg(chart, { title, subtitle: caption, summary: summaryText(main, measure) });
                return svgToPng(svg, width, height);
              }}
            />
          }
        />
        <BalanceChart timeline={main} height={200} printWidth={PRINT_WIDTH} detail={total ? totalDetail : accountDetail(main)} />
        <p className="muted small balance-key">
          <span className="mark-key seen" aria-hidden="true" /> con cartola ese día{total ? ' (de todas las cuentas)' : ''} ·{' '}
          <span className="mark-key unseen" aria-hidden="true" /> sin cartola: sale de los movimientos · sábados y domingos, sombreados
        </p>
      </section>
      <section className="card balance-list">
        <table className="compact">
          <thead>
            <tr>
              <th>Día</th>
              <th className="num">
                {measure}
                {total ? ' consolidado' : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {main.points.slice(1).map((p) => (
              <tr key={p.day}>
                <td className="nowrap">{shortDate(p.day!, true)}</td>
                <td className="num">{clp(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="ledger-head">
        <h2 className="ledger-title">Detalle día a día</h2>
        <label className="no-print">
          <input type="checkbox" checked={showInternal} onChange={(e) => toggleInternal(e.target.checked)} /> Mostrar traspasos internos
        </label>
      </div>
      <p className="muted small ledger-note">
        Saldo relativo: el {total ? 'consolidado' : 'saldo'} después de cada movimiento, en el orden de la cartola de cada cuenta. Dentro
        del día es aproximado, porque el banco no da la hora; el del final de cada día es el real.{' '}
        {showInternal
          ? 'Los traspasos con cuentas propias van atenuados y no suman ni restan: un abono en una cuenta y un cargo en otra se compensan.'
          : 'Sin los traspasos con cuentas propias: un abono en una cuenta y un cargo en otra se compensan, así que no suman ni restan.'}{' '}
        Si en un día no se compensan, lo que queda va en una línea.
        {hasCredit && ' Los giros y amortizaciones de la línea de crédito no van: no cambian el disponible.'}
      </p>
      {movements && movements.length >= MAX_MOVEMENTS && (
        <p className="warning">El período tiene más de 5.000 movimientos: al detalle le pueden faltar algunos.</p>
      )}
      {ledgerDays ? (
        <LedgerTable days={ledgerDays} opening={main.points[0].value} copy={{ scope, multi: total !== null, categories, dates }} />
      ) : (
        <p className="muted">Cargando…</p>
      )}
    </>
  );
}

/** Movimientos de cada día con el saldo relativo que deja cada uno, y el saldo con que terminó el día. */
function LedgerTable({ days, opening, copy }: { days: LedgerDay[]; opening: number; copy: DayCardOptions }) {
  const { multi, categories } = copy;
  const cols = multi ? 6 : 5;
  const categoryCell = (items: Movement[]) => {
    if (new Set(items.map((m) => m.category_id)).size > 1) return <span className="muted">(varias)</span>;
    const c = categories.find((x) => x.id === items[0].category_id);
    if (!c) return <span className="muted">Sin categoría</span>;
    return (
      <>
        <span className="dot" style={{ background: c.color }} />
        {c.name}
      </>
    );
  };
  const amounts = (amount: number, balance: number) => (
    <>
      <td className="num pos" data-label="Entró">
        {amount > 0 ? clp(amount) : ''}
      </td>
      <td className="num neg" data-label="Salió">
        {amount < 0 ? clp(-amount) : ''}
      </td>
      <td className="num" data-label="Saldo relativo">
        {clp(balance)}
      </td>
    </>
  );
  const account = (m: Movement) =>
    multi && (
      <td className="nowrap small" data-label="Cuenta">
        {m.account_name}
      </td>
    );
  const row = (r: LedgerRow) => {
    if (r.type === 'gap') {
      return (
        <tr key="gap" className="ledger-gap">
          <td colSpan={cols - 3} className="detail-cell">
            No cuadra con el día anterior: falta o sobra algún movimiento por cargar
          </td>
          {amounts(r.amount, r.balance)}
        </tr>
      );
    }
    if (r.type === 'internal') {
      return (
        <tr key="internal" className="internal">
          <td colSpan={cols - 3} className="detail-cell">
            Traspasos con cuentas propias que no se compensan en el día
          </td>
          {amounts(r.amount, r.balance)}
        </tr>
      );
    }
    if (r.type === 'movement') {
      return (
        <tr key={r.m.id} className={r.m.system_key === 'internal' ? 'internal' : undefined}>
          {account(r.m)}
          <td className="detail-cell">
            {movementTitle(r.m)}
            {r.m.label && <small className="muted"> · {r.m.label}</small>}
            {r.m.provisional === 1 && <small className="badge">provisorio</small>}
            <MovedBadge items={[r.m]} />
          </td>
          <td data-label="Categoría">{categoryCell([r.m])}</td>
          {amounts(r.amount, r.balance)}
        </tr>
      );
    }
    const comments = [...new Set(r.items.map((m) => m.label).filter(Boolean))].join(' · ');
    return (
      <tr key={r.key}>
        {account(r.items[0])}
        <td className="detail-cell">
          Nómina Pago Fácil · {r.items.length} pagos
          {r.batchesInDay > 1 && ` · nómina ${r.batch} de ${r.batchesInDay}`}
          {comments && <small className="muted"> · {comments}</small>}
          <MovedBadge items={r.items} />
        </td>
        <td data-label="Categoría">{categoryCell(r.items)}</td>
        {amounts(r.amount, r.balance)}
      </tr>
    );
  };

  // Cada día es una tarjeta, como las categorías en Gastos: entre una y otra, un respiro.
  const gap = (
    <tbody className="group-gap-body" aria-hidden="true">
      <tr className="group-gap">
        <td colSpan={cols} />
      </tr>
    </tbody>
  );

  return (
    <table className="detail grouped ledger">
      <thead>
        <tr>
          {multi && <th>Cuenta</th>}
          <th>Detalle</th>
          <th>Categoría</th>
          <th className="num">Entró</th>
          <th className="num">Salió</th>
          <th className="num">Saldo relativo</th>
        </tr>
      </thead>
      <tbody className="category-group group-end ledger-single">
        <tr className="group-header">
          <th colSpan={cols - 1}>Saldo inicial · al empezar el {dayMonth(days[0].day)}</th>
          <th className="num">{clp(opening)}</th>
        </tr>
      </tbody>
      {days.map((d) => (
        <Fragment key={d.day}>
          {gap}
          {d.rows.length === 0 ? (
            <tbody className="category-group group-end ledger-single quiet">
              <tr className="group-header">
                <th colSpan={cols - 1}>
                  {shortDate(d.day, true)} <small>· {d.hiddenInternal ? 'solo traspasos con cuentas propias' : 'sin movimientos'}</small>
                </th>
                <th className="num">{clp(d.closing)}</th>
              </tr>
            </tbody>
          ) : (
            <tbody className="category-group group-end">
              <tr className="group-header">
                <th colSpan={cols - 1}>{shortDate(d.day, true)}</th>
                <th className="num">
                  {/* La foto de la tarjeta del día, para pegarla en un chat o un correo. */}
                  <CopyImageButton
                    filename={`Saldo ${d.day.split('-').reverse().join('-')} - ${copy.scope}.png`.replace(/[\/:*?"<>|]/g, '')}
                    image={() => {
                      const { svg, width, height } = dayCardSvg(d, copy);
                      return svgToPng(svg, width, height);
                    }}
                  />
                </th>
              </tr>
              {d.rows.map(row)}
              <tr className="group-subtotal">
                <td colSpan={cols - 3}>Saldo al final del {dayMonth(d.day)}</td>
                <td className="num pos">{d.income ? clp(d.income) : ''}</td>
                <td className="num neg">{d.expenses ? clp(d.expenses) : ''}</td>
                <td className="num">{clp(d.closing)}</td>
              </tr>
            </tbody>
          )}
          {/* Otra tarjeta, que se copia aparte: el saldo final de cada cuenta y de qué cartola sale; suman el del día. */}
          {(d.rows.length > 0 || d.accounts.some((a) => a.cartolas > 0)) && (
            <>
              {gap}
              <tbody className="category-group group-end ledger-balances">
                <tr className="group-header">
                  <th colSpan={cols - 1}>Saldo final por cuenta · {dayMonth(d.day)}</th>
                  <th className="num">
                    <CopyImageButton
                      filename={`Saldos ${d.day.split('-').reverse().join('-')} - ${copy.scope}.png`.replace(/[\/:*?"<>|]/g, '')}
                      image={() => {
                        const { svg, width, height } = balancesCardSvg(d, copy);
                        return svgToPng(svg, width, height);
                      }}
                    />
                  </th>
                </tr>
                {d.accounts.map((a) => (
                  <tr key={a.accountId} className="ledger-account">
                    <td colSpan={cols - 1} className="detail-cell">
                      {a.name} <small className="muted">· {accountNote(a)}</small>
                    </td>
                    <td className="num" data-label="Saldo final">
                      {clp(a.available)}
                    </td>
                  </tr>
                ))}
                <tr className="group-subtotal">
                  <td colSpan={cols - 1}>{multi ? 'Total de las cuentas' : 'Saldo final'}</td>
                  <td className="num">{clp(d.closing)}</td>
                </tr>
              </tbody>
            </>
          )}
        </Fragment>
      ))}
    </table>
  );
}

/** Lo que dice el encabezado del gráfico, en una línea de texto (para la imagen). */
function summaryText(timeline: Timeline, measure: string): string {
  const s = timelineSummary(timeline);
  const change = s.change === 0 ? 'sin cambio' : clpSigned(s.change);
  const lowest = s.lowest ? ` · lo más bajo: ${clp(s.lowest.value)} el ${dayMonth(s.lowest.day!)}` : '';
  return `${timeline.name}: ${measure.toLowerCase()} de ${clp(s.start)} a ${clp(s.end)} (${change})${lowest}`;
}

/** Nombre de la línea y lo que pasó en el período: de cuánto a cuánto, y lo más bajo si fue entre medio. */
function TimelineHead({ timeline, measure, action }: { timeline: Timeline; measure: string; action?: ReactNode }) {
  const s = timelineSummary(timeline);
  return (
    <header className="balance-head">
      <div className="balance-title">
        <h2>{timeline.name}</h2>
        {action}
      </div>
      <p className="small">
        {measure} de {clp(s.start)} a <strong>{clp(s.end)}</strong>{' '}
        <span className={s.change < 0 ? 'neg' : s.change > 0 ? 'pos' : 'muted'}>({s.change === 0 ? 'sin cambio' : clpSigned(s.change)})</span>
        {s.lowest && (
          <span className="muted">
            {' '}
            · lo más bajo: {clp(s.lowest.value)} el {dayMonth(s.lowest.day!)}
          </span>
        )}
      </p>
    </header>
  );
}

// ---------- Hoja 3: Entradas ----------

function IncomeSheet({ movements, expectedTotal, onEdit }: { movements: Movement[] | null; expectedTotal: number; onEdit: (m: Movement, edit: Edit) => void }) {
  const { dates } = useShared();
  const rows = useMemo(() => chronological(movements ?? [], dates), [movements, dates]);
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
            <th className="no-print">Comentario</th>
            <th className="no-print">Categoría</th>
            <th className="num">Monto</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td className="nowrap" data-label="Fecha">{shortDate(dayOf(m, dates))}</td>
              <td className="nowrap" data-label="Cuenta">{m.account_name}</td>
              <td className="detail-cell">
                {movementTitle(m)}
                {m.provisional === 1 && <small className="badge">provisorio</small>}
                <MovedBadge items={[m]} />
              </td>
              <td className="no-print" data-label="Comentario">
                <LabelInput value={m.label ?? ''} fromRule={m.label_source === 'rule'} onCommit={(label) => onEdit(m, { label })} />
              </td>
              <td className="no-print" data-label="Categoría">
                <CategorySelect value={m.category_id} source={m.category_source} onChange={(categoryId) => onEdit(m, { categoryId })} />
              </td>
              <td className="num amount-cell" data-label="Monto">{clp(m.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="grand-total">
            <td colSpan={3}>Total entró · {rows.length} movimientos</td>
            <td className="no-print" colSpan={2} />
            <td className="num">{clp(total)}</td>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

// ---------- Hoja 4: Gastos por categoría ----------

function ExpensesSheet({
  movements,
  expectedTotal,
  categories,
  onEditOne,
  onEditAll,
}: {
  movements: Movement[] | null;
  expectedTotal: number;
  categories: Category[];
  onEditOne: (m: Movement, edit: Edit) => void;
  onEditAll: (ids: number[], edit: Edit) => void;
}) {
  const { dates } = useShared();
  const groups = useMemo(() => groupByCategory(movements ?? [], categories, dates), [movements, categories, dates]);
  if (!movements) return <p className="muted">Cargando…</p>;
  const total = groups.reduce((s, g) => s + g.total, 0);
  const renderRow = (r: DisplayRow) =>
    r.type === 'single' ? (
      <tr key={r.m.id}>
        <td className="nowrap" data-label="Fecha">{shortDate(dayOf(r.m, dates))}</td>
        <td className="nowrap small" data-label="Cuenta">{r.m.account_name}</td>
        <td className="detail-cell">
          {movementTitle(r.m)}
          {r.m.provisional === 1 && <small className="badge">provisorio</small>}
          <MovedBadge items={[r.m]} />
        </td>
        {/* El comentario editable solo en pantalla; al imprimir queda el texto. */}
        <td className="small" data-label="Comentario">
          <span className="no-print">
            <LabelInput value={r.m.label ?? ''} fromRule={r.m.label_source === 'rule'} onCommit={(label) => onEditOne(r.m, { label })} />
          </span>
          <span className="print-only">{r.m.label}</span>
        </td>
        <td className="no-print" data-label="Categoría">
          <CategorySelect value={r.m.category_id} source={r.m.category_source} onChange={(categoryId) => onEditOne(r.m, { categoryId })} />
        </td>
        <td className="num amount-cell" data-label="Monto">{clp(r.m.amount)}</td>
      </tr>
    ) : (
      (() => {
        const ids = r.items.map((m) => m.id);
        const label = new Set(r.items.map((m) => m.label ?? '')).size === 1 ? r.items[0].label : '';
        const singleCategory = new Set(r.items.map((m) => m.category_id)).size === 1;
        // Impreso: todos los comentarios distintos de la nómina, aunque no sean iguales en todos los pagos.
        const comments = [...new Set(r.items.map((m) => m.label).filter(Boolean))].join(' · ');
        return (
          <tr key={r.key}>
            <td className="nowrap" data-label="Fecha">{shortDate(dayOf(r.items[0], dates))}</td>
            <td className="nowrap small" data-label="Cuenta">{r.items[0].account_name}</td>
            <td className="detail-cell">
              Nómina Pago Fácil · {r.items.length} pagos
              {r.batchesInDay > 1 && ` · nómina ${r.batch} de ${r.batchesInDay}`}
              <MovedBadge items={r.items} />
            </td>
            <td className="small" data-label="Comentario">
              <span className="no-print">
                <LabelInput
                  value={label ?? ''}
                  placeholder={label === '' ? '(varias)' : ''}
                  onCommit={(l) => onEditAll(ids, { label: l })}
                />
              </span>
              <span className="print-only">{comments}</span>
            </td>
            <td className="no-print" data-label="Categoría">
              <CategorySelect
                value={singleCategory ? r.items[0].category_id : null}
                placeholder={singleCategory ? '— Sin categoría —' : '(varias)'}
                onChange={(categoryId) => onEditAll(ids, { categoryId })}
              />
            </td>
            <td className="num amount-cell" data-label="Monto">{clp(r.items.reduce((s, m) => s + m.amount, 0))}</td>
          </tr>
        );
      })()
    );
  return (
    <>
      <TotalMismatch total={total} expected={expectedTotal} />
      <table className="detail grouped">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Cuenta</th>
            <th>Detalle</th>
            <th>Comentario</th>
            <th className="no-print">Categoría</th>
            <th className="num">Monto</th>
          </tr>
        </thead>
        {groups.map((g, i) => {
          // La cabecera viaja con los primeros movimientos: al imprimir no queda sola al pie de una página.
          const head = g.rows.slice(0, HEAD_ROWS);
          const rest = g.rows.slice(HEAD_ROWS);
          const subtotal = (
            <tr className="group-subtotal">
              <td colSpan={4}>Subtotal {g.name}</td>
              <td className="no-print" />
              <td className="num">{clp(g.total)}</td>
            </tr>
          );
          return (
            <Fragment key={String(g.categoryId)}>
              <tbody className={`category-group category-head ${rest.length ? '' : 'group-end'}`}>
                <tr className="group-header">
                  <th colSpan={6}>
                    <span className="dot" style={{ background: g.color ?? 'var(--muted)' }} />
                    {g.name} <small className="muted">· {g.count} mov. · {total ? Math.round((g.total / total) * 100) : 0}%</small>
                  </th>
                </tr>
                {head.map(renderRow)}
                {!rest.length && subtotal}
              </tbody>
              {rest.length > 0 && (
                <tbody className="category-group group-end">
                  {rest.map(renderRow)}
                  {subtotal}
                </tbody>
              )}
              {/* Respiro entre burbujas de categoría (en móvil se separan con margen). */}
              {i < groups.length - 1 && (
                <tbody className="group-gap-body" aria-hidden="true">
                  <tr className="group-gap">
                    <td colSpan={6} />
                  </tr>
                </tbody>
              )}
            </Fragment>
          );
        })}
      </table>

      {/* Cierre de la hoja: una línea por categoría y el total de lo que salió. */}
      <section className="card category-summary">
        <h2>Resumen por categoría</h2>
        <table className="compact">
          <thead>
            <tr>
              <th>Categoría</th>
              <th className="num">Movimientos</th>
              <th className="num">%</th>
              <th className="num">Monto</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={String(g.categoryId)}>
                <td>
                  <span className="dot" style={{ background: g.color ?? 'var(--muted)' }} />
                  {g.name}
                </td>
                <td className="num">{g.count}</td>
                <td className="num">{total ? Math.round((g.total / total) * 100) : 0}%</td>
                <td className="num">{clp(g.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="grand-total">
              <td>Total salió</td>
              <td className="num">{movements.length}</td>
              <td className="num">{total ? '100%' : ''}</td>
              <td className="num">{clp(total)}</td>
            </tr>
          </tfoot>
        </table>
      </section>
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

// ---------- Comentario del informe ----------

/** Comentario por período y alcance de cuentas. Se edita en pantalla; al imprimir queda solo el texto. */
export function NoteCard({ note, onSave }: { note: ReportNote | null; onSave: (text: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const startEdit = () => {
    setText(note?.text ?? '');
    setFailed(false);
    setEditing(true);
  };

  const save = async (value: string) => {
    setSaving(true);
    setFailed(false);
    try {
      await onSave(value.trim());
      setEditing(false);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <section className="card note">
        <h2>Comentario del informe</h2>
        <textarea
          className="note-input"
          aria-label="Comentario del informe"
          placeholder="Anotaciones sobre el período: qué explica el resultado, algo a recordar…"
          maxLength={NOTE_MAX}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="note-actions">
          <span className="muted small">
            {text.length}/{NOTE_MAX}
          </span>
          <button type="button" onClick={() => setEditing(false)} disabled={saving}>
            Cancelar
          </button>
          <button type="button" className="primary" onClick={() => save(text)} disabled={saving}>
            Guardar
          </button>
        </div>
        {failed && <p className="error">No se pudo guardar el comentario. Intenta de nuevo.</p>}
      </section>
    );
  }

  // Sin comentario: la tarjeta solo se ve en pantalla (no ensucia el PDF).
  if (!note) {
    return (
      <section className="card note no-print">
        <h2>Comentario del informe</h2>
        <p className="muted note-text">Sin comentario para este período.</p>
        <div className="note-actions">
          <button type="button" onClick={startEdit}>
            Agregar comentario
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card note">
      <h2>Comentario del informe</h2>
      <p className="note-text">{note.text}</p>
      <p className="muted small note-meta no-print">
        Guardado el {shortDate(note.updated_at.slice(0, 10))}
        {note.username ? ` por ${note.username}` : ''}.
      </p>
      <div className="note-actions no-print">
        <button type="button" onClick={startEdit}>
          Editar
        </button>
        <button type="button" className="danger" onClick={() => save('')} disabled={saving}>
          Borrar
        </button>
      </div>
    </section>
  );
}
