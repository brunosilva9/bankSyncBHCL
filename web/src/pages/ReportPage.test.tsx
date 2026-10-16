import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NOTE_MAX, type ReportNote } from '../api';
import { NoteCard } from './ReportPage';

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
