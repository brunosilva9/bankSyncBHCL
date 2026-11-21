import { Fragment, useState, type MouseEvent } from 'react';
import { fechaParam, qs, type DailyResponse, type DateMode, type DayAccountDetail, type DayDetailResponse, type DayMovement, type DaySummary, type Hito } from '../api';
import { CopyButton } from '../components/CopyButton';
import { DatesSelect } from '../components/DatesSelect';
import { RangePicker } from '../components/RangePicker';
import { accountsToCopy, dayCopy } from '../dailyCopy';
import { useFetch, useShared } from '../data';
import { addDaysIso, chileDateTime, clp, clpSigned, inChile, presetRange, shortDate, type DateRange } from '../format';
import { groupDayPayroll, payrollComment, payrollTitle, type DayPayroll } from '../payroll';
import { href, navigate } from '../router';
import { MovedBadge } from '../components/MovedBadge';
import { earlierTitle, laterTitle, weekdayDay } from '../seen';

// Diario: cada día con su saldo inicial y final, lo que entró y salió, y las cartolas que se bajaron ese día
// (los hitos: el saldo que informó el banco y si cuadra con los movimientos cargados). El servidor cierra cada
// día a la hora del cierre (02:00 del día siguiente) y guarda lo que se sabía; si después llega algo que lo
// cambia, aquí se ve.

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const hh = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/** Lo que no cuadra de una cartola: contra la anterior; si es la primera de la cuenta, contra el saldo calculado. */
const hitoDelta = (h: Hito) => (h.previous ? h.diff : h.check);

/** Por qué una diferencia que se compensa con otra cartola no es plata que falte. */
const pairText = (h: Hito) =>
  `Se compensa con la cartola del ${shortDate(h.pair!.day)}: un movimiento quedó registrado en un tramo distinto del que el banco tenía en su saldo (por ejemplo, uno que el banco agregó después con fecha anterior). Juntas cuadran.`;

/** "descargada el vie 13/11/2026 a las 20:15, subida el 13/11/2026 20:20": la hora de descarga si se sabe. */
function hitoWhen(h: Hito, withWeekday = false): string {
  const downloaded = h.observedAt && h.observedSource !== 'subida' ? inChile(h.observedAt) : null;
  const at = downloaded && downloaded.day === h.day ? ` a las ${downloaded.time}` : '';
  return `descargada el ${shortDate(h.day, withWeekday)}${at}, subida el ${chileDateTime(h.importedAt)}`;
}

function hitoExplanation(h: Hito): string {
  const head = `Cartola ${h.filename}: ${hitoWhen(h)}. Saldo del banco ${clp(h.balance)}.`;
  if (h.previous && h.diff !== null) {
    const verdict =
      h.diff === 0 ? 'Cuadra.' : h.pair ? `Difiere en ${clpSigned(h.diff)}. ${pairText(h)}` : `No cuadra por ${clpSigned(h.diff)}: falta o sobra algún movimiento entre las dos cartolas.`;
    return `${head} Desde la cartola del ${shortDate(h.previous.day)}, el banco dice ${clpSigned(h.bankChange!)} y ${plural(h.movementsBetween!, 'movimiento cargado suma', 'movimientos cargados suman')} ${clpSigned(h.movementsChange!)}. ${verdict}`;
  }
  if (h.computed !== null) return `${head} Según los movimientos cargados: ${clp(h.computed)}. ${h.check === 0 ? 'Cuadra.' : 'No cuadra.'}`;
  return `${head} No trae movimientos con que compararla.`;
}

export function DailyPage({ params }: { params: Record<string, string> }) {
  const { accounts, dates } = useShared();
  const range: DateRange = params.from && params.to ? { from: params.from, to: params.to } : presetRange('last30');
  const accountId = params.account ?? '';
  const [open, setOpen] = useState<string | null>(params.dia ?? null);
  const setFilters = (patch: Record<string, string | undefined>) => navigate('/diario', { ...range, account: accountId || undefined, ...patch }, true);

  const { data, error, loading } = useFetch<DailyResponse>(`/api/daily${qs({ ...range, accounts: accountId, fecha: fechaParam(dates) })}`);
  const scopeName = accountId ? (accounts.find((a) => String(a.id) === accountId)?.name ?? 'Cuenta') : 'Todas las cuentas';
  const showAccount = !accountId && accounts.length > 1;
  // Traspasos entre cuentas propias, giros y pagos de la línea, compras con tarjeta por pagar: lo que mueve el
  // saldo sin ser entrada ni gasto. Se muestra solo si en el rango hay algo así.
  const other = (d: DaySummary) => d.totals.closing - d.totals.opening - d.totals.income + d.totals.expenses;
  const showOther = data?.days.some((d) => other(d) !== 0) ?? false;

  return (
    <div className="page daily">
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
        <DatesSelect />
      </div>

      <h1>
        Diario <span className="muted">{scopeName}</span>
      </h1>
      {data && (
        <p className="muted small daily-intro">
          {data.closingHour === null
            ? 'El cierre automático está apagado (CIERRE_HORA=no).'
            : `Cada día se cierra solo a las ${hh(data.closingHour)} del día siguiente y queda guardado lo que se sabía a esa hora.`}{' '}
          Las cartolas del día son el saldo que informó el banco al descargarlas: ✓ si cuadra con los movimientos cargados.{' '}
          {dates === 'real'
            ? 'Fechas reales: lo hecho de noche, en fin de semana o en feriado cuenta el día en que se hizo (lleva su fecha del banco), y en la fecha del banco se ve atenuado, sin sumar.'
            : 'Fechas del banco: lo hecho de noche, en fin de semana o en feriado cuenta el día hábil en que lo fechó el banco (lleva ↶ y el día en que ya aparecía), y en ese día se ve atenuado, sin sumar.'}
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {!data && loading && <p className="muted">Cargando…</p>}
      {data && accounts.length === 0 && (
        <p className="card">
          Aún no hay cartolas cargadas. <a href={href('/importar')}>Importar cartolas</a>
        </p>
      )}
      {data && accounts.length > 0 && data.days.length > 0 && (
        <div className="card table-wrap">
          <table className="daily-table">
            <thead>
              <tr>
                <th>Día</th>
                <th className="num">Saldo inicial</th>
                <th className="num">Entró</th>
                <th className="num">Salió</th>
                {showOther && (
                  <th className="num" title="Traspasos entre cuentas propias, giros y pagos de la línea de crédito, compras con tarjeta por pagar">
                    Traspasos y otros
                  </th>
                )}
                <th className="num">Saldo final</th>
                <th>Cartolas del día</th>
                <th>Cierre</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => (
                <Fragment key={d.day}>
                  <DayRow
                    d={d}
                    other={showOther ? other(d) : null}
                    expanded={open === d.day}
                    onToggle={() => setOpen(open === d.day ? null : d.day)}
                    showAccount={showAccount}
                    closingHour={data.closingHour}
                    lastClosable={data.lastClosable}
                  />
                  {open === d.day && (
                    <tr className="day-detail-row">
                      <td colSpan={showOther ? 8 : 7}>
                        <DayDetailView summary={d} accountId={accountId} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface DayRowProps {
  d: DaySummary;
  other: number | null;
  expanded: boolean;
  onToggle: () => void;
  showAccount: boolean;
  closingHour: number | null;
  lastClosable: string | null;
}

function DayRow({ d, other, expanded, onToggle, showAccount, closingHour, lastClosable }: DayRowProps) {
  const { dates } = useShared();
  const t = d.totals;
  const quiet = d.movements === 0 && d.hitos.length === 0;
  // Una tarjeta sola no tiene saldo: sus archivos solo traen compras y pagos.
  const noBalance = d.accounts.length > 0 && d.accounts.every((a) => a.isCard);
  // Arrastrar para seleccionar texto de la fila (y copiarlo) no abre ni cierra el día.
  const toggle = (e: MouseEvent<HTMLTableRowElement>) => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode)) return;
    onToggle();
  };
  return (
    <tr className={`day-row${quiet ? ' quiet' : ''}${expanded ? ' open' : ''}`} onClick={toggle}>
      <td data-label="Día">
        <button type="button" className="link day-toggle" aria-expanded={expanded}>
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {shortDate(d.day, true)}
        </button>
        <div className="muted small">{d.movements ? plural(d.movements, 'movimiento', 'movimientos') : 'sin movimientos'}</div>
        {(d.seenBefore > 0 || d.datedLater > 0) && (
          <div className="muted small">
            {d.seenBefore > 0 &&
              (dates === 'real' ? (
                <span title="El banco los fechó este día, pero ya aparecían en la cartola de un día anterior: por fecha real se cuentan ese día">
                  ↶ {plural(d.seenBefore, 'ya contado antes', 'ya contados antes')}
                </span>
              ) : (
                <span title="Ya estaban en la cartola de un día anterior: el banco los pasó a este día (lo hecho de noche, en fin de semana o en feriado)">
                  ↶ {plural(d.seenBefore, 'apareció antes', 'aparecieron antes')}
                </span>
              ))}
            {d.seenBefore > 0 && d.datedLater > 0 && ' · '}
            {d.datedLater > 0 &&
              (dates === 'real' ? (
                <span title="Se hicieron este día, pero el banco los fechó después (lo hecho de noche, en fin de semana o en feriado): por fecha real se cuentan hoy">
                  ↷ {plural(d.datedLater, 'que el banco fechó después', 'que el banco fechó después')}
                </span>
              ) : (
                <span title="Ya estaban en la cartola de este día, pero el banco los fechó después: suman en el saldo de esa fecha">
                  ↷ {plural(d.datedLater, 'con fecha posterior', 'con fecha posterior')}
                </span>
              ))}
          </div>
        )}
      </td>
      <td className="num" data-label="Saldo inicial">
        {noBalance ? '—' : clp(t.opening)}
      </td>
      <td className="num pos" data-label="Entró">
        {t.income ? `+${clp(t.income)}` : '—'}
      </td>
      <td className="num neg" data-label="Salió">
        {t.expenses ? `−${clp(t.expenses)}` : '—'}
      </td>
      {other !== null && (
        <td className="num" data-label="Traspasos y otros">
          {other && !noBalance ? clpSigned(other) : '—'}
        </td>
      )}
      <td className="num strong" data-label="Saldo final">
        {noBalance ? '—' : clp(t.closing)}
      </td>
      <td data-label="Cartolas">
        {d.hitos.length ? d.hitos.map((h) => <HitoChip key={h.importId} hito={h} showAccount={showAccount} />) : <span className="muted">—</span>}
      </td>
      <td data-label="Cierre">
        <ClosingCell d={d} closingHour={closingHour} lastClosable={lastClosable} />
      </td>
    </tr>
  );
}

function HitoChip({ hito, showAccount }: { hito: Hito; showAccount: boolean }) {
  const delta = hitoDelta(hito);
  const state = delta === null ? 'unknown' : delta === 0 ? 'ok' : hito.pair ? 'pair' : 'bad';
  return (
    <span className={`hito ${state}`} title={hitoExplanation(hito)}>
      {showAccount && <span className="hito-account">{hito.accountName}</span>}
      {clp(hito.balance)} {state === 'ok' ? '✓' : state === 'bad' ? `≠ ${clpSigned(delta!)}` : state === 'pair' ? `${clpSigned(delta!)} ⇄` : ''}
    </span>
  );
}

function ClosingCell({ d, closingHour, lastClosable }: { d: DaySummary; closingHour: number | null; lastClosable: string | null }) {
  if (d.closing) {
    const at = inChile(d.closing.closedAt);
    // A la hora de siempre basta la hora; si se cerró tarde (servidor apagado), también el día.
    const when = at.day === addDaysIso(d.day, 1) ? at.time : `${shortDate(at.day)} ${at.time}`;
    return d.closing.changed ? (
      <span className="badge" title={`Cerrado el ${chileDateTime(d.closing.closedAt)}. Después se cargó algo que cambia este día.`}>
        cambió después del cierre
      </span>
    ) : (
      <span className="closing-ok" title={`Cerrado el ${chileDateTime(d.closing.closedAt)}, sin cambios desde entonces.`}>
        ✓ cerrado {when}
      </span>
    );
  }
  if (closingHour === null) return <span className="muted">—</span>;
  if (!lastClosable || d.day > lastClosable) return <span className="muted">se cierra a las {hh(closingHour)}</span>;
  return (
    <span className="muted" title="Es anterior al primer cierre automático">
      sin cierre
    </span>
  );
}

function DayDetailView({ summary, accountId }: { summary: DaySummary; accountId: string }) {
  const day = summary.day;
  const { dates } = useShared();
  const { data, error } = useFetch<DayDetailResponse>(`/api/daily/${day}${qs({ accounts: accountId, fecha: fechaParam(dates) })}`);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Cargando…</p>;
  const active = data.accounts.filter((a) => a.entries.length > 0);
  const quiet = data.accounts.filter((a) => a.entries.length === 0);
  const copyable = accountsToCopy(data.accounts);
  return (
    <div className="day-detail">
      {data.closing && <ClosingSummary closing={data.closing} summary={summary} accountId={accountId} dates={dates} />}
      {active.map((a) => (
        <AccountTimeline key={a.accountId} day={day} account={a} />
      ))}
      {quiet.length > 0 && (
        <p className="muted small">
          Sin movimientos ni cartolas ese día: {quiet.map((a) => (a.isCard ? a.name : `${a.name} (${clp(a.closing)})`)).join(' · ')}
        </p>
      )}
      <p className="day-links small">
        {copyable.length > 1 && (
          <>
            <CopyButton
              label="Copiar el día, todas las cuentas"
              title="Saldo inicial, movimientos y saldo final de cada cuenta, y el total, para pegarlo en un mensaje o en Excel"
              content={() => dayCopy(day, copyable, dates)}
            />
            {' · '}
          </>
        )}
        <a href={href('/informe', { from: day, to: day, account: accountId || undefined })}>Informe del día{accountId ? '' : ', todas las cuentas'}</a>
        {' · '}
        <a href={href('/movimientos', { from: day, to: day, accountId: accountId || undefined })}>Ver en Movimientos</a>
      </p>
    </div>
  );
}

type Figures = { opening: number | null; closing: number | null; income: number; expenses: number };

function ClosingSummary({
  closing,
  summary,
  accountId,
  dates,
}: {
  closing: NonNullable<DayDetailResponse['closing']>;
  summary: DaySummary;
  accountId: string;
  dates: DateMode;
}) {
  const snap = closing.snapshot;
  // Un cierre de antes de la fecha real solo tiene la foto por fecha del banco: no se compara con la fecha real.
  const comparable = snap.dates === dates;
  const then: Figures | undefined = accountId ? snap.report.accounts.find((a) => String(a.accountId) === accountId) : snap.report.totals;
  const now: Figures | undefined = accountId ? summary.accounts.find((a) => String(a.accountId) === accountId) : summary.totals;
  // Las tarjetas no se descargan a diario: que su último archivo sea viejo no deja incompleto el día.
  const cards = new Set(snap.report.accounts.filter((a) => a.isCard).map((a) => a.accountId));
  const missing = snap.coverage.filter((c) => !cards.has(c.accountId) && (!accountId || String(c.accountId) === accountId) && (c.lastCartola ?? '') < snap.day);
  const rows: Array<[string, number | null | undefined, number | null | undefined]> = [
    ['Saldo inicial', then?.opening, now?.opening],
    ['Entró', then?.income, now?.income],
    ['Salió', then?.expenses, now?.expenses],
    ['Saldo final', then?.closing, now?.closing],
  ];
  return (
    <section className={`closing-summary${closing.changed ? ' changed' : ''}`}>
      <p>
        <strong>Cierre del {chileDateTime(closing.closedAt)}.</strong>{' '}
        {closing.changed ? `Después se cargó algo que cambia este día${comparable ? '; abajo se ve cómo está ahora' : ''}.` : 'Sin cambios desde entonces.'}
      </p>
      {!comparable && (
        <p className="muted small">Este cierre es de antes de la fecha real: quedó por fecha del banco. Para compararlo, cambia Fechas a «Del banco».</p>
      )}
      {closing.changed && comparable && then && now && (
        <table className="closing-compare">
          <thead>
            <tr>
              <th />
              <th className="num">Al cierre</th>
              <th className="num">Ahora</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, before, after]) => (
              <tr key={label} className={before !== after ? 'differs' : undefined}>
                <td>{label}</td>
                <td className="num">{clp(before)}</td>
                <td className="num">{clp(after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {missing.length > 0 && (
        <p className="warning small">
          Al cerrar faltaban cartolas: {missing.map((c) => `${c.name} (la última era del ${c.lastCartola ? shortDate(c.lastCartola) : '—'})`).join(', ')}. Lo que llegó
          después aparece como cambio.
        </p>
      )}
    </section>
  );
}

function AccountTimeline({ day, account: a }: { day: string; account: DayAccountDetail }) {
  const { dates } = useShared();
  // Nóminas abiertas, por su primer pago.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <section className="day-account">
      <header>
        <h3>{a.name}</h3>
        <span className="day-account-actions small">
          <CopyButton
            title={a.isCard ? 'Compras y pagos del día, para pegarlos en un mensaje o en Excel' : 'Saldo inicial, movimientos y saldo final, para pegarlos en un mensaje o en Excel'}
            content={() => dayCopy(day, [a], dates)}
          />
          <a href={href('/informe', { from: day, to: day, account: a.accountId })}>Informe de esta cuenta</a>
        </span>
      </header>
      <ol className="timeline">
        {!a.isCard && (
          <li className="tl-balance">
            Saldo inicial <strong>{clp(a.opening)}</strong>
          </li>
        )}
        {groupDayPayroll(a.entries).map((r) =>
          r.type === 'movement' || r.type === 'later' || r.type === 'earlier' ? (
            <MovementItem key={`${r.type}${r.movement.id}`} m={r.movement} isCard={a.isCard} aside={r.type === 'movement' ? null : r.type} />
          ) : r.type === 'hito' ? (
            <HitoItem key={`h${r.hito.importId}`} hito={r.hito} day={day} dates={dates} />
          ) : (
            <PayrollItem key={r.key} p={r} isCard={a.isCard} open={open.has(r.key)} onToggle={() => toggle(r.key)} />
          ),
        )}
        {!a.isCard && (
          <li className="tl-balance">
            Saldo final <strong>{clp(a.closing)}</strong>
          </li>
        )}
      </ol>
    </section>
  );
}

/** Una nómina en una línea, como en Nóminas: se abre para ver cada pago. */
function PayrollItem({ p, isCard, open, onToggle }: { p: DayPayroll; isCard: boolean; open: boolean; onToggle: () => void }) {
  const first = p.items[0];
  const comment = payrollComment(p);
  const sameCategory = new Set(p.items.map((m) => m.category_name)).size === 1;
  return (
    <>
      <li className={`tl-movement tl-payroll${p.aside ? ' tl-later' : ''}`} title={p.aside ? asideTitle(first, p.aside) : undefined}>
        <span className="tl-desc">
          <button type="button" className="link" aria-expanded={open} onClick={onToggle}>
            <span aria-hidden="true">{open ? '▾' : '▸'}</span> {payrollTitle(p)}
          </button>
          {comment && <span className="muted"> · {comment}</span>}
          {p.items.some((m) => m.provisional) ? <span className="badge">provisorio</span> : null}
          {p.aside ? <AsideBadge m={first} aside={p.aside} /> : <MovedBadge items={p.items} />}
        </span>
        <span className="tl-cat small muted">
          <span className="dot" style={{ background: (sameCategory && first.category_color) || 'var(--muted)' }} />{' '}
          {sameCategory ? (first.category_name ?? 'Sin categoría') : '(varias)'}
        </span>
        <span className={`num ${p.net >= 0 ? 'pos' : 'neg'}`}>{clpSigned(p.net)}</span>
        {!isCard && (
          <span className="num muted small" title={p.aside ? 'Se cuenta en otro día: no mueve el saldo de este' : 'Saldo después de la nómina'}>
            {p.aside ? '—' : clp(p.balanceAfter)}
          </span>
        )}
      </li>
      {open && p.items.map((m) => <MovementItem key={`m${m.id}`} m={m} isCard={isCard} nested aside={p.aside} />)}
    </>
  );
}

/**
 * Un movimiento del día. Con `aside` se ve atenuado y sin saldo, porque se cuenta en otro día: 'later' (por fecha
 * del banco) ya estaba en una cartola de este día, pero el banco lo fechó después; 'earlier' (por fecha real) el
 * banco lo fechó este día, pero es de antes.
 */
function MovementItem({ m, isCard, nested = false, aside = null }: { m: DayMovement; isCard: boolean; nested?: boolean; aside?: 'later' | 'earlier' | null }) {
  return (
    <li
      className={`tl-movement${m.system_key === 'internal' ? ' internal' : ''}${nested ? ' nested' : ''}${aside ? ' tl-later' : ''}`}
      title={aside && !nested ? asideTitle(m, aside) : undefined}
    >
      <span className="tl-desc">
        {m.payee_name ? `${m.payee_name} · ${m.description}` : m.description}
        {m.label && <span className="muted"> · {m.label}</span>}
        {m.provisional ? <span className="badge">provisorio</span> : null}
        {!nested && (aside ? <AsideBadge m={m} aside={aside} /> : <MovedBadge items={[m]} />)}
      </span>
      <span className="tl-cat small muted">
        <span className="dot" style={{ background: m.category_color ?? 'var(--muted)' }} /> {m.category_name ?? 'Sin categoría'}
      </span>
      <span className={`num ${m.direction === 'A' ? 'pos' : 'neg'}`}>
        {m.direction === 'A' ? '+' : '−'}
        {clp(m.amount)}
      </span>
      {!isCard && (
        <span className="num muted small" title={aside ? 'Se cuenta en otro día: no mueve el saldo de este' : 'Saldo después del movimiento'}>
          {aside ? '—' : clp(m.balance_after)}
        </span>
      )}
    </li>
  );
}

const asideTitle = (m: DayMovement, aside: 'later' | 'earlier') => (aside === 'later' ? laterTitle(m) : earlierTitle(m));

/** Lo que se cuenta en otro día: por fecha del banco, "fecha del banco: lun 16"; por fecha real, "se contó el vie 13". */
function AsideBadge({ m, aside }: { m: DayMovement; aside: 'later' | 'earlier' }) {
  return (
    <span className="badge moved" title={asideTitle(m, aside)}>
      {aside === 'later' ? `fecha del banco: ${weekdayDay(m.date)}` : `se contó el ${weekdayDay(m.real_date ?? m.date)}`}
    </span>
  );
}

function HitoItem({ hito, day, dates }: { hito: Hito; day: string; dates: DateMode }) {
  const delta = hitoDelta(hito);
  const state = delta === null ? '' : delta === 0 ? ' ok' : hito.pair ? ' pair' : ' bad';
  const statement = hito.statement === 'provisional' ? ' · en línea (provisoria)' : hito.statement === 'consolidated' ? ' · consolidada' : '';
  // Por fecha real, el día de su movimiento más reciente es su día real.
  const anchorDay = hito.anchor ? (dates === 'real' ? hito.anchor.realDate : hito.anchor.date) : null;
  const where = !hito.anchor
    ? 'No trae movimientos con que compararla.'
    : anchorDay! < day
      ? `Sin movimientos nuevos desde el ${shortDate(anchorDay!, true)}.`
      : hito.anchor.date > day
        ? `Ya trae movimientos con fecha del ${shortDate(hito.anchor.date, true)}.`
        : null;
  return (
    <li className={`tl-hito${state}`}>
      <div className="tl-hito-head">
        <strong>Cartola: el banco informa {clp(hito.balance)}</strong>
        <span className="muted small">
          {hitoWhen(hito, true)}
          {statement}
        </span>
      </div>
      {where && <div className="small muted">{where}</div>}
      {hito.previous && hito.diff !== null ? (
        <div className="small">
          Desde la cartola del {shortDate(hito.previous.day, true)} ({clp(hito.previous.balance)}): el banco dice {clpSigned(hito.bankChange!)} y{' '}
          {plural(hito.movementsBetween!, 'movimiento cargado suma', 'movimientos cargados suman')} {clpSigned(hito.movementsChange!)}.{' '}
          {hito.diff === 0 ? (
            <strong className="pos">Cuadra ✓</strong>
          ) : hito.pair ? (
            <>
              <strong>Difiere en {clpSigned(hito.diff)} ⇄</strong> {pairText(hito)}
            </>
          ) : (
            <strong className="neg">No cuadra por {clpSigned(hito.diff)}</strong>
          )}
        </div>
      ) : (
        hito.computed !== null && (
          <div className="small">
            Según los movimientos cargados: {clp(hito.computed)}.{' '}
            <strong className={hito.check === 0 ? 'pos' : 'neg'}>{hito.check === 0 ? 'Cuadra ✓' : `No cuadra por ${clpSigned(hito.check!)}`}</strong>
          </div>
        )
      )}
    </li>
  );
}
