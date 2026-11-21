import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTE_MAX, type BalancePoint, type Category, type DailyBalances, type Movement, type ReportNote } from '../api';
import { DataProvider } from '../data';
import { clp } from '../format';
import { BalanceSheet, NoteCard } from './ReportPage';

const saved = (text: string): ReportNote => ({ text, updated_at: '2026-10-30 12:00:00', username: 'admin' });
const okSave = () => vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

describe('NoteCard (comentario del informe)', () => {
  it('sin comentario muestra el estado vacío y permite agregarlo', async () => {
    const onSave = okSave();
    render(<NoteCard note={null} onSave={onSave} />);

    expect(screen.getByText('Sin comentario para este período.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Agregar comentario' }));

    const textarea = screen.getByRole('textbox', { name: 'Comentario del informe' });
    expect(textarea).toHaveAttribute('maxlength', String(NOTE_MAX));

    fireEvent.change(textarea, { target: { value: '  Se pagó la nómina.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Se pagó la nómina.'));
  });

  it('edita el comentario existente', async () => {
    const onSave = okSave();
    render(<NoteCard note={saved('Texto viejo')} onSave={onSave} />);

    expect(screen.getByText('Texto viejo')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));

    const textarea = screen.getByRole('textbox', { name: 'Comentario del informe' });
    expect(textarea).toHaveValue('Texto viejo');
    fireEvent.change(textarea, { target: { value: 'Texto nuevo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Texto nuevo'));
  });

  it('borra el comentario', async () => {
    const onSave = okSave();
    render(<NoteCard note={saved('Algo')} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Borrar' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(''));
  });

  it('cancelar descarta la edición sin guardar', () => {
    const onSave = okSave();
    render(<NoteCard note={saved('Algo')} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Comentario del informe' }), { target: { value: 'Otro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Algo')).toBeInTheDocument();
  });
});

describe('BalanceSheet (saldo al final de cada día)', () => {
  // Datos ficticios: del viernes 13 al lunes 16 de noviembre de 2026. La Cuenta Dos tiene línea de crédito.
  const point = (day: string, closing: number, available: number, cartolas = 0, lastSeenAt: string | null = null): BalancePoint => ({
    day,
    closing,
    available,
    cartolas,
    lastSeenAt,
    lastImportedAt: null,
  });
  const data: DailyBalances = {
    from: '2026-11-13',
    to: '2026-11-16',
    accounts: [
      {
        accountId: 1,
        name: 'Cuenta Uno',
        hasCredit: false,
        opening: { closing: 0, available: 0 },
        days: [point('2026-11-13', 1000, 1000, 1, '2026-11-14T01:00:00.000Z'), point('2026-11-14', 800, 800, 1, '2026-11-15T01:00:00.000Z'), point('2026-11-15', 800, 800), point('2026-11-16', 700, 700, 1)],
      },
      {
        accountId: 2,
        name: 'Cuenta Dos',
        hasCredit: true,
        opening: { closing: 400, available: 1400 },
        days: [point('2026-11-13', 400, 1400), point('2026-11-14', 400, 1400), point('2026-11-15', 400, 1400), point('2026-11-16', -100, 900, 1)],
      },
    ],
  };
  // Los movimientos que explican esos saldos. El sábado 14 una transferencia que el banco fechó el lunes 16; el lunes
  // una nómina de dos pagos en la Cuenta Dos y un giro de su línea, que no cambia el disponible.
  const mv = (id: number, account: 1 | 2, date: string, amount: number, direction: 'A' | 'C', description: string, extra: Partial<Movement> = {}): Movement => ({
    id,
    account_id: account,
    account_name: account === 1 ? 'Cuenta Uno' : 'Cuenta Dos',
    date,
    seq: 0,
    amount,
    direction,
    description,
    doc_number: null,
    kind: 'other',
    counterparty: null,
    payee_name: null,
    category_id: null,
    category_source: null,
    label: null,
    label_source: null,
    note: null,
    balance_after: null,
    provisional: 0,
    payroll_batch: null,
    payroll_split_after: 0,
    installments: null,
    installment_amount: null,
    system_key: null,
    first_seen_day: date,
    first_seen_at: null,
    real_date: date,
    real_date_source: 'banco',
    ...extra,
  });
  const movements: Movement[] = [
    mv(1, 1, '2026-11-13', 1000, 'A', 'Traspaso De: Cliente Uno', { category_id: 10 }),
    mv(2, 1, '2026-11-16', 200, 'C', 'Traspaso A: Proveedor Sabado', { seq: 1, first_seen_day: '2026-11-14', real_date: '2026-11-14', real_date_source: 'observada' }),
    mv(3, 1, '2026-11-16', 100, 'C', 'Pago: Proveedor Lunes'),
    mv(4, 2, '2026-11-16', 300, 'C', 'Pago Fácil Bch: 01', { seq: 3, kind: 'payroll', payroll_batch: 1, category_id: 11 }),
    mv(5, 2, '2026-11-16', 200, 'C', 'Pago Fácil Bch: 02', { seq: 2, kind: 'payroll', payroll_batch: 1, category_id: 11 }),
    mv(6, 2, '2026-11-16', 400, 'A', 'Transferencia Desde Linea De Credito', { seq: 1, kind: 'credit_line' }),
    // El domingo, 50 de una cuenta a la otra: no cambia el consolidado.
    mv(7, 1, '2026-11-15', 50, 'C', 'Traspaso A: Cuenta Dos', { category_id: 12, system_key: 'internal' }),
    mv(8, 2, '2026-11-15', 50, 'A', 'Traspaso De: Cuenta Uno', { category_id: 12, system_key: 'internal' }),
  ];
  const categories: Category[] = [
    { id: 10, name: 'Ventas e ingresos', color: '#16a34a', system_key: null, sort: 1 },
    { id: 11, name: 'Sueldos', color: '#2563eb', system_key: 'payroll', sort: 2 },
    { id: 12, name: 'Traspaso interno', color: '#8a94a6', system_key: 'internal', sort: 3 },
  ];
  const sheet = (expectedClosing = 1600) =>
    render(
      <DataProvider>
        <BalanceSheet
          data={data}
          error={null}
          movements={movements}
          hasCredit
          hasCards={false}
          expectedClosing={expectedClosing}
          scope="Todas las cuentas"
          caption="Todas las cuentas · del vie 13/11/2026 al lun 16/11/2026"
          imageName="Saldo.png"
        />
      </DataProvider>,
    );
  const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent);

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (url === '/api/categories' ? categories : []) })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  const ledgerRows = () =>
    within(screen.getAllByRole('table')[1])
      .getAllByRole('row')
      .map((row) => [...row.querySelectorAll('th, td')].map((c) => c.textContent));

  it('el gráfico del total y la lista con el saldo consolidado de cada día; nada por cuenta', () => {
    sheet();
    expect(screen.getByRole('heading', { name: 'Total de las cuentas' }).closest('header')).toHaveTextContent('Disponible de $1.400 a $1.600 (+$200)');
    expect(screen.queryByRole('heading', { name: 'Cuenta Uno' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('group')).toHaveLength(1);

    const rows = within(screen.getAllByRole('table')[0]).getAllByRole('row');
    expect(within(rows[0]).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Día', 'Disponible consolidado']);
    expect(rows.slice(1).map(cells)).toEqual([
      ['vie 13/11/2026', '$2.400'],
      ['sáb 14/11/2026', '$2.200'],
      ['dom 15/11/2026', '$2.200'],
      ['lun 16/11/2026', '$1.600'],
    ]);
    expect(screen.queryByText(/no es el saldo final del resumen/)).not.toBeInTheDocument();
  });

  it('el detalle día a día: cada movimiento con su categoría y el saldo relativo, y el saldo con que terminó cada día', async () => {
    sheet();
    const ledger = screen.getAllByRole('table')[1];
    await waitFor(() => expect(within(ledger).getByText('Ventas e ingresos')).toBeInTheDocument());
    const rows = ledgerRows();
    expect(rows[0]).toEqual(['Cuenta', 'Detalle', 'Categoría', 'Entró', 'Salió', 'Saldo relativo']);
    // Después de cada día, otra tarjeta que se copia aparte: el saldo final de cada cuenta y de qué cartola sale ("la
    // foto"). Suman el saldo del día.
    expect(rows.slice(1, 9)).toEqual([
      ['Saldo inicial · al empezar el vie 13/11', '$1.400'],
      ['vie 13/11/2026', 'Copiar imagen'],
      ['Cuenta Uno', 'Traspaso De: Cliente Uno', 'Ventas e ingresos', '$1.000', '', '$2.400'],
      ['Saldo al final del vie 13/11', '$1.000', '', '$2.400'],
      ['Saldo final por cuenta · vie 13/11', 'Copiar imagen'],
      ['Cuenta Uno · cartola del vie 13/11 22:00', '$1.000'],
      // Con línea de crédito cuenta el disponible, como en el resumen.
      [`Cuenta Dos · sin cartola ese día · saldo ${clp(400)} + línea ${clp(1000)}`, '$1.400'],
      ['Total de las cuentas', '$2.400'],
    ]);
    // Los traspasos entre las cuentas se ven con su monto, pero el saldo relativo no cambia: el abono en una cuenta y
    // el cargo en la otra se compensan.
    const sunday = rows.findIndex((r) => r[0] === 'dom 15/11/2026');
    expect(rows.slice(sunday + 1, sunday + 3)).toEqual([
      ['Cuenta Dos', 'Traspaso De: Cuenta Uno', 'Traspaso interno', '$50', '', '$2.200'],
      ['Cuenta Uno', 'Traspaso A: Cuenta Dos', 'Traspaso interno', '', '$50', '$2.200'],
    ]);
    expect(rows).toContainEqual(['Saldo al final del dom 15/11', '', '', '$2.200']);
    // El lunes, la nómina en una línea; el giro de la línea de crédito no va.
    const monday = rows.findIndex((r) => r[0] === 'lun 16/11/2026');
    expect(rows.slice(monday + 1)).toEqual([
      ['Cuenta Dos', 'Nómina Pago Fácil · 2 pagos', 'Sueldos', '', '$500', '$1.700'],
      ['Cuenta Uno', 'Pago: Proveedor Lunes', 'Sin categoría', '', '$100', '$1.600'],
      ['Saldo al final del lun 16/11', '', '$600', '$1.600'],
      ['Saldo final por cuenta · lun 16/11', 'Copiar imagen'],
      ['Cuenta Uno · cartola sin hora', '$700'],
      [`Cuenta Dos · cartola sin hora · saldo ${clp(-100)} + línea ${clp(1000)}`, '$900'],
      ['Total de las cuentas', '$1.600'],
    ]);
    expect(within(ledger).queryByText(/Linea De Credito/)).not.toBeInTheDocument();
  });

  it('los traspasos internos se pueden ocultar, y se recuerda', async () => {
    sheet();
    await waitFor(() => expect(within(screen.getAllByRole('table')[1]).getByText('Ventas e ingresos')).toBeInTheDocument());
    const toggle = screen.getByRole('checkbox', { name: 'Mostrar traspasos internos' });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(screen.queryByText('Traspaso A: Cuenta Dos')).not.toBeInTheDocument();
    // Un día que solo tuvo traspasos entre las cuentas es una línea, con su saldo.
    expect(ledgerRows()).toContainEqual(['dom 15/11/2026 · solo traspasos con cuentas propias', '$2.200']);
    expect(localStorage.getItem('syncbanks.traspasos')).toBe('0');
  });

  it('con el foco en el gráfico, las flechas recorren los días y el recuadro dice el saldo de cada cuenta', () => {
    sheet();
    const chart = screen.getByRole('group', { name: /^Total de las cuentas: saldo al final de cada día, de \$1\.400 a \$1\.600/ });
    fireEvent.focus(chart);
    const tip = () => within(chart).getByRole('status');
    expect(tip()).toHaveTextContent('$1.600');
    expect(tip()).toHaveTextContent('al final del lun 16/11/2026');
    expect(tip()).toHaveTextContent('−$600 en el día');
    expect(tip()).toHaveTextContent('Cuenta Dos: $900 · con cartola, sin hora conocida');
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(tip()).toHaveTextContent('al final del dom 15/11/2026');
    expect(tip()).toHaveTextContent('Sin cambio en el día');
    expect(tip()).toHaveTextContent('Cuenta Uno: $800 · sin cartola ese día');
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(tip()).toHaveTextContent('al final del vie 13/11/2026');
    fireEvent.blur(chart);
    expect(within(chart).queryByRole('status')).not.toBeInTheDocument();
  });

  it('avisa si el último saldo no es el saldo final del resumen', () => {
    sheet(1700);
    expect(screen.getByText(/no es el saldo final del resumen/)).toHaveTextContent('El último saldo de esta hoja ($1.600) no es el saldo final del resumen ($1.700).');
  });
});
