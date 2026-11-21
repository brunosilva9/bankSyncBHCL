import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyResponse, DayDetailResponse, DayEntry, DayMovement, DaySummary, Hito, Report } from '../api';
import { DataProvider } from '../data';
import { clp, shortDate } from '../format';
import { weekdayDay } from '../seen';
import { DailyPage } from './DailyPage';

// Datos ficticios. El 14 una cartola no cuadra con la anterior: el banco dice +500 y los movimientos +200.
const totals = (opening: number, income: number, closing: number): Report['totals'] => ({
  opening,
  closing,
  income,
  expenses: 0,
  internalNet: 0,
  hasCredit: false,
  creditAvailableOpening: 0,
  creditAvailableClosing: 0,
  availableOpening: opening,
  availableClosing: closing,
  hasCards: false,
  cardDebtChange: 0,
});
const hito: Hito = {
  importId: 3,
  accountId: 1,
  accountName: 'Cuenta Prueba',
  day: '2026-11-14',
  importedAt: '2026-11-14 12:00:00',
  observedAt: null,
  observedSource: null,
  filename: 'c14.txt',
  statement: null,
  balance: 2000,
  anchor: { id: 9, date: '2026-11-14', realDate: '2026-11-14' },
  computed: 2000,
  check: 0,
  previous: { importId: 2, day: '2026-11-12', balance: 1500 },
  bankChange: 500,
  movementsChange: 200,
  movementsBetween: 1,
  diff: 300,
  pair: null,
};
const day = (d: string, movements: number, t: Report['totals'], hitos: Hito[], closing: DaySummary['closing']): DaySummary => ({
  day: d,
  movements,
  seenBefore: 0,
  datedLater: 0,
  totals: t,
  accounts: [],
  hitos,
  closing,
});
const daily: DailyResponse = {
  closingHour: 2,
  lastClosable: '2026-11-14',
  days: [
    day('2026-11-15', 0, totals(2000, 0, 2000), [], null),
    day('2026-11-14', 1, totals(1800, 200, 2000), [hito], { closedAt: '2026-11-15T05:00:00.000Z', changed: true }),
    day('2026-11-13', 0, totals(1800, 0, 1800), [], { closedAt: '2026-11-14T05:00:00.000Z', changed: false }),
  ],
};
const detail: DayDetailResponse = {
  day: '2026-11-14',
  accounts: [
    {
      accountId: 1,
      name: 'Cuenta Prueba',
      isCard: false,
      opening: 1800,
      closing: 2000,
      entries: [
        {
          type: 'movement',
          movement: {
            id: 9,
            date: '2026-11-14',
            first_seen_day: '2026-11-14',
            first_seen_at: null,
            real_date: '2026-11-14',
            real_date_source: 'banco',
            seq: 0,
            amount: 200,
            direction: 'A',
            description: 'Traspaso De: Cliente Tres',
            kind: 'transfer_in',
            counterparty: 'Cliente Tres',
            payee_name: null,
            category_name: 'Ventas e ingresos',
            category_color: '#16a34a',
            system_key: null,
            label: null,
            balance_after: 2000,
            provisional: 0,
            payroll_batch: null,
          },
        },
        { type: 'hito', hito },
      ],
    },
  ],
  closing: {
    day: '2026-11-14',
    closedAt: '2026-11-15T05:00:00.000Z',
    hash: 'h',
    changed: true,
    snapshot: {
      day: '2026-11-14',
      closedAt: '2026-11-15T05:00:00.000Z',
      dates: 'real',
      report: { params: { from: '2026-11-14', to: '2026-11-14' }, period: { from: '2026-11-14', to: '2026-11-14' }, accounts: [], totals: totals(1800, 0, 1800), payroll: [], uncategorizedCount: 0, warnings: [] },
      detail: { day: '2026-11-14', accounts: [] },
      coverage: [{ accountId: 1, name: 'Cuenta Prueba', lastMovement: '2026-11-12', lastCartola: '2026-11-12' }],
    },
  },
};

const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const api = async (url: string) => {
  if (url.startsWith('/api/daily/2026-11-14')) return reply(detail);
  if (url.startsWith('/api/daily?')) return reply(daily);
  if (url === '/api/accounts') return reply([{ id: 1, name: 'Cuenta Prueba', kind: 'cuenta_corriente' }]);
  return reply([]);
};
const fetchMock = vi.fn(api);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(api);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
  localStorage.clear();
});

/** jsdom no trae portapapeles: uno de mentira que guarda lo copiado. */
const stubClipboard = () => {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
};

describe('DailyPage', () => {
  it('muestra cada día con su saldo, sus cartolas y el estado de su cierre', async () => {
    render(
      <DataProvider>
        <DailyPage params={{ from: '2026-11-13', to: '2026-11-15' }} />
      </DataProvider>,
    );

    expect(await screen.findByText(/14\/11\/2026/)).toBeInTheDocument();
    // La cartola del 14 no cuadra con la anterior por 300.
    expect(screen.getByText(/≠ \+\$300/)).toBeInTheDocument();
    expect(screen.getByText('cambió después del cierre')).toBeInTheDocument();
    // El 13 se cerró a las 02:00 del 14 y nada cambió; el 15 todavía no es hora de cerrarlo.
    expect(screen.getByText('✓ cerrado 02:00')).toBeInTheDocument();
    expect(screen.getByText('se cierra a las 02:00')).toBeInTheDocument();
  });

  it('una diferencia que se compensa con otra cartola no se marca como plata que falta', async () => {
    const paired = { ...hito, diff: 200, pair: { importId: 5, day: '2026-11-17' } };
    const withPair: DailyResponse = { ...daily, days: [day('2026-11-14', 1, totals(1800, 200, 2000), [paired], null)] };
    fetchMock.mockImplementation(async (url: string) => (url.startsWith('/api/daily?') ? reply(withPair) : api(url)));
    render(
      <DataProvider>
        <DailyPage params={{ from: '2026-11-14', to: '2026-11-14' }} />
      </DataProvider>,
    );

    const chip = await screen.findByText(/\+\$200 ⇄/);
    expect(chip).toHaveClass('pair');
    expect(chip.getAttribute('title')).toContain('Se compensa con la cartola del 17/11/2026');
    expect(screen.queryByText(/≠/)).not.toBeInTheDocument();
  });

  it('al abrir un día muestra sus movimientos y cartolas en orden, y qué cambió desde el cierre', async () => {
    render(
      <DataProvider>
        <DailyPage params={{ from: '2026-11-13', to: '2026-11-15' }} />
      </DataProvider>,
    );

    const toggle = await screen.findByRole('button', { name: /14\/11\/2026/ });
    fireEvent.click(toggle);

    expect(await screen.findByText(/Traspaso De: Cliente Tres/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/daily/2026-11-14', expect.anything());
    expect(screen.getByText('No cuadra por +$300')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Al cierre' })).toBeInTheDocument();
    expect(screen.getByText(/Al cerrar faltaban cartolas: Cuenta Prueba \(la última era del 12\/11\/2026\)/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('copia el día de una cuenta: saldo inicial con su fecha, los movimientos y el saldo final con su fecha', async () => {
    const writeText = stubClipboard();
    render(
      <DataProvider>
        <DailyPage params={{ from: '2026-11-13', to: '2026-11-15' }} />
      </DataProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /14\/11\/2026/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copiar' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const date = shortDate('2026-11-14', true);
    // La cartola del día no va: es el control, no un movimiento.
    expect(writeText.mock.calls[0][0]).toBe(
      ['Cuenta Prueba', `Saldo inicial ${date}: ${clp(1800)}`, `+${clp(200)} Traspaso De: Cliente Tres (saldo ${clp(2000)})`, `Saldo final ${date}: ${clp(2000)}`].join('\n'),
    );
    expect(await screen.findByRole('button', { name: 'Copiado ✓' })).toBeInTheDocument();
    // Con una sola cuenta no hace falta copiar el día de todas.
    expect(screen.queryByRole('button', { name: /Copiar el día/ })).not.toBeInTheDocument();
  });

  it('con varias cuentas también copia el día completo, con el total', async () => {
    const writeText = stubClipboard();
    const two: DayDetailResponse = {
      ...detail,
      accounts: [...detail.accounts, { accountId: 2, name: 'Cuenta Dos', isCard: false, opening: 500, closing: 500, entries: [] }],
    };
    fetchMock.mockImplementation(async (url: string) => (url.startsWith('/api/daily/2026-11-14') ? reply(two) : api(url)));
    render(
      <DataProvider>
        <DailyPage params={{ from: '2026-11-13', to: '2026-11-15' }} />
      </DataProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /14\/11\/2026/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copiar el día, todas las cuentas' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const date = shortDate('2026-11-14', true);
    const text = writeText.mock.calls[0][0];
    expect(text).toMatch(/^Cuenta Prueba\n/);
    expect(text).toContain(['Cuenta Dos', `Saldo inicial ${date}: ${clp(500)}`, 'Sin movimientos.'].join('\n'));
    expect(text.endsWith(['Total de las cuentas', `Saldo inicial ${date}: ${clp(2300)}`, `Saldo final ${date}: ${clp(2500)}`].join('\n'))).toBe(true);
  });

  it('cada nómina va en una línea, como en Nóminas, y se abre para ver cada pago', async () => {
    const pago = (id: number, name: string, amount: number, balance_after: number): DayEntry => ({
      type: 'movement',
      movement: {
        id,
        date: '2026-11-14',
        first_seen_day: '2026-11-14',
        first_seen_at: null,
        real_date: '2026-11-14',
        real_date_source: 'banco',
        seq: 0,
        amount,
        direction: 'C',
        description: `Pago Fácil Bch: 0${id}`,
        kind: 'payroll',
        counterparty: null,
        payee_name: name,
        category_name: 'Sueldos',
        category_color: '#64748b',
        system_key: null,
        label: 'Sueldos noviembre',
        balance_after,
        provisional: 0,
        payroll_batch: 1,
      },
    });
    const [account] = detail.accounts;
    const withPayroll: DayDetailResponse = {
      ...detail,
      accounts: [{ ...account, closing: 1700, entries: [...account.entries, pago(10, 'Trabajador Uno', 100, 1900), pago(11, 'Trabajador Dos', 200, 1700)] }],
    };
    fetchMock.mockImplementation(async (url: string) => (url.startsWith('/api/daily/2026-11-14') ? reply(withPayroll) : api(url)));
    render(
      <DataProvider>
        <DailyPage params={{ from: '2026-11-13', to: '2026-11-15' }} />
      </DataProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /14\/11\/2026/ }));

    const batch = await screen.findByRole('button', { name: 'Nómina Pago Fácil · 2 pagos' });
    expect(screen.getByText(`−${clp(300)}`)).toBeInTheDocument();
    expect(screen.queryByText(/Trabajador Uno/)).not.toBeInTheDocument();
    fireEvent.click(batch);
    expect(batch).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Trabajador Uno · Pago Fácil Bch/)).toBeInTheDocument();
    expect(screen.getByText(/Trabajador Dos · Pago Fácil Bch/)).toBeInTheDocument();
  });

  it('por fecha real (por defecto): lo de la noche cuenta en su día, con su fecha del banco; lo ya contado se ve aparte', async () => {
    const [account] = detail.accounts;
    const base = (account.entries[0] as { movement: DayMovement }).movement;
    // El 14 en la noche, una transferencia que el banco fechó el 16; y una del 13 que el banco fechó el 14.
    const night: DayEntry = {
      type: 'movement',
      movement: { ...base, id: 20, date: '2026-11-16', real_date: '2026-11-14', real_date_source: 'observada', description: 'Traspaso A: Proveedor Noche', direction: 'C', amount: 50, balance_after: 1950 },
    };
    const counted: DayEntry = { type: 'earlier', movement: { ...base, id: 21, real_date: '2026-11-13', real_date_source: 'observada', description: 'Traspaso De: Cliente Viernes' } };
    const withMarks: DayDetailResponse = { ...detail, accounts: [{ ...account, closing: 1950, entries: [counted, ...account.entries, night] }] };
    const withCounts: DailyResponse = { ...daily, days: daily.days.map((d) => (d.day === '2026-11-14' ? { ...d, seenBefore: 1, datedLater: 1 } : d)) };
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('/api/daily/2026-11-14') ? reply(withMarks) : url.startsWith('/api/daily?') ? reply(withCounts) : api(url),
    );
    render(
      <DataProvider>
        <DailyPage params={{ from: '2026-11-13', to: '2026-11-15' }} />
      </DataProvider>,
    );

    expect(await screen.findByText('↷ 1 que el banco fechó después')).toBeInTheDocument();
    expect(screen.getByText('↶ 1 ya contado antes')).toBeInTheDocument();
    // Por fecha real no hace falta decirle nada a la API.
    expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((u) => u.startsWith('/api/daily'))).not.toContainEqual(expect.stringContaining('fecha='));
    fireEvent.click(screen.getByRole('button', { name: /14\/11\/2026/ }));

    // Suma hoy, con su saldo, y dice la fecha del banco.
    const nightItem = (await screen.findByText('Traspaso A: Proveedor Noche')).closest('li')!;
    expect(nightItem).not.toHaveClass('tl-later');
    expect(within(nightItem).getByText(`banco: ${weekdayDay('2026-11-16')}`)).toBeInTheDocument();
    expect(within(nightItem).getByText(clp(1950))).toBeInTheDocument();
    // Lo que el banco fechó hoy pero es del 13: atenuado, sin saldo.
    const countedItem = screen.getByText('Traspaso De: Cliente Viernes').closest('li')!;
    expect(countedItem).toHaveClass('tl-later');
    expect(within(countedItem).getByText(`se contó el ${weekdayDay('2026-11-13')}`)).toBeInTheDocument();
    expect(within(countedItem).getByText('—')).toBeInTheDocument();
  });

  it('por fecha del banco: lo de la noche se ve atenuado en el día en que apareció y con ↶ en su fecha', async () => {
    localStorage.setItem('syncbanks.fechas', 'banco');
    const [account] = detail.accounts;
    const base = (account.entries[0] as { movement: DayMovement }).movement;
    const later: DayEntry = {
      type: 'later',
      movement: { ...base, id: 20, date: '2026-11-16', real_date: '2026-11-14', real_date_source: 'observada', description: 'Traspaso A: Proveedor Sabado', direction: 'C', amount: 50 },
    };
    const moved: DayEntry = { type: 'movement', movement: { ...base, id: 21, first_seen_day: '2026-11-13', real_date: '2026-11-13', real_date_source: 'observada', description: 'Traspaso De: Cliente Viernes' } };
    const withMarks: DayDetailResponse = { ...detail, accounts: [{ ...account, entries: [moved, ...account.entries, later] }] };
    const withCounts: DailyResponse = { ...daily, days: daily.days.map((d) => (d.day === '2026-11-14' ? { ...d, seenBefore: 1, datedLater: 1 } : d)) };
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('/api/daily/2026-11-14') ? reply(withMarks) : url.startsWith('/api/daily?') ? reply(withCounts) : api(url),
    );
    render(
      <DataProvider>
        <DailyPage params={{ from: '2026-11-13', to: '2026-11-15' }} />
      </DataProvider>,
    );

    expect(await screen.findByText('↷ 1 con fecha posterior')).toBeInTheDocument();
    expect(screen.getByText('↶ 1 apareció antes')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('fecha=banco'), expect.anything());
    fireEvent.click(screen.getByRole('button', { name: /14\/11\/2026/ }));

    // En el día en que apareció: atenuado, con su fecha del banco y sin saldo (suma en el de esa fecha).
    const laterItem = (await screen.findByText('Traspaso A: Proveedor Sabado')).closest('li')!;
    expect(laterItem).toHaveClass('tl-later');
    expect(within(laterItem).getByText(`fecha del banco: ${weekdayDay('2026-11-16')}`)).toBeInTheDocument();
    expect(within(laterItem).getByText('—')).toBeInTheDocument();
    // En su fecha del banco: con el día en que ya aparecía.
    const movedItem = screen.getByText('Traspaso De: Cliente Viernes').closest('li')!;
    expect(within(movedItem).getByText(`↶ ${weekdayDay('2026-11-13')}`)).toBeInTheDocument();
  });

  it('seleccionar el texto de un día para copiarlo no lo abre', async () => {
    render(
      <DataProvider>
        <DailyPage params={{ from: '2026-11-13', to: '2026-11-15' }} />
      </DataProvider>,
    );
    const toggle = await screen.findByRole('button', { name: /14\/11\/2026/ });
    const closing = within(toggle.closest('tr')!).getByText(clp(2000));
    const selection = window.getSelection()!;

    selection.selectAllChildren(closing);
    fireEvent.click(closing);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    selection.removeAllRanges();
    fireEvent.click(closing);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});
