import { useState, type DragEvent } from 'react';
import { api, ApiError, type CardImportResult, type CreditLineImportResult, type ImportResult, type ImportRow } from '../api';
import { useFetch, useShared } from '../data';
import { clp, shortDate } from '../format';
import { href } from '../router';

type FileResult = {
  filename: string;
  file: File;
  result?: ImportResult | CreditLineImportResult | CardImportResult;
  error?: string;
  /** El administrador ya tiene esta cuenta en las de otro usuario: se puede importar igual. */
  elsewhere?: boolean;
};

async function sendFile(f: File, anyway = false): Promise<FileResult> {
  try {
    // La última modificación de un archivo recién bajado es la hora de la descarga, que la cartola de Banco de
    // Chile no trae: sirve para saber en qué día apareció cada movimiento.
    const headers: Record<string, string> = { 'x-file-modified': String(f.lastModified), ...(anyway ? { 'x-import-anyway': '1' } : {}) };
    const result = await api.upload<ImportResult | CreditLineImportResult | CardImportResult>('/api/imports', await f.arrayBuffer(), f.name, headers);
    return { filename: f.name, file: f, result };
  } catch (e) {
    return { filename: f.name, file: f, error: (e as Error).message, elsewhere: e instanceof ApiError && e.code === 'account-elsewhere' };
  }
}

/** viewing: usuario cuyas cuentas está viendo el administrador (null si son las propias). */
export function ImportPage({ viewing = null }: { viewing?: string | null }) {
  const { reload } = useShared();
  const history = useFetch<ImportRow[]>('/api/imports');
  const [results, setResults] = useState<FileResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    const out = new Map<string, FileResult>();
    const send = async (f: File) => {
      out.set(f.name, await sendFile(f));
      setResults([...out.values()]);
    };
    const list = Array.from(files);
    for (const f of list) await send(f);
    // La cartola de la línea necesita la de la cuenta corriente del mismo día: si vinieron juntas y la
    // línea se procesó primero, se reintenta al final.
    for (const f of list.filter((f) => out.get(f.name)?.error && !out.get(f.name)?.elsewhere)) await send(f);
    setBusy(false);
    history.refresh();
    reload();
  };

  const importAnyway = async (r: FileResult) => {
    setBusy(true);
    const updated = await sendFile(r.file, true);
    setResults((prev) => prev.map((x) => (x.filename === r.filename ? updated : x)));
    setBusy(false);
    history.refresh();
    reload();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    upload(e.dataTransfer.files);
  };

  return (
    <div className="page">
      <h1>Importar cartolas</h1>
      <p className="muted">
        <strong>Banco de Chile:</strong> cartola en formato <strong>.txt</strong>. <strong>BancoEstado:</strong> cartola histórica (consolidada)
        o cartola en línea, en <strong>Excel (.xlsx)</strong>. <strong>Tarjetas de crédito:</strong> CMR de Banco Falabella (facturados y no
        facturados) y movimientos por facturar de BancoEstado, en Excel. Puedes subir varias a la vez y repetir archivos que se traslapan: lo
        que ya estaba no se duplica. La cuenta o tarjeta se reconoce automáticamente desde el archivo.
        Las cartolas de cuentas de persona y las cuentas de Banco Falabella ya se reconocen (la app te dice qué son), pero todavía no se
        importan.
      </p>

      {viewing && (
        <p className="info">
          Estás importando a las cuentas de <strong>{viewing}</strong>.
        </p>
      )}

      <label
        className={`dropzone ${dragging ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input type="file" accept=".txt,.xlsx,.xls,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} disabled={busy} />
        {busy ? 'Importando…' : 'Arrastra las cartolas (.txt, .xlsx o .xls) aquí o haz clic para elegirlas'}
      </label>

      {results.map((r) => (
        <div key={r.filename} className={`card import-result ${r.error ? 'failed' : ''}`}>
          <strong>{r.filename}</strong>
          {r.error && <p className="error">{r.error}</p>}
          {r.elsewhere && (
            <p>
              <button disabled={busy} onClick={() => importAnyway(r)}>
                Importar igual en {viewing ? `las cuentas de ${viewing}` : 'tus cuentas'}
              </button>{' '}
              <span className="muted small">o cambia de cuentas arriba, en «Cuentas de».</span>
            </p>
          )}
          {r.result?.type === 'credit_line' && (
            <>
              <p>
                Cartola de la <strong>línea de crédito</strong> ({r.result.lineNumber}) de {r.result.accountName}. No se cargan sus movimientos (son
                los mismos de la cuenta corriente); se usó para calibrar la línea.
              </p>
              <p>
                Usado {clp(r.result.used)}
                {r.result.available !== null && <> · disponible {clp(r.result.available)}</>}
              </p>
              {r.result.warnings.map((w) => (
                <p key={w} className="warning">
                  {w}
                </p>
              ))}
            </>
          )}
          {r.result?.type === 'card' && (
            <>
              <p>
                {r.result.accountName} · {r.result.billed ? 'estado de cuenta facturado' : 'movimientos por facturar'}
                {r.result.fromDate && ` · ${shortDate(r.result.fromDate)} al ${shortDate(r.result.toDate!)}`}
              </p>
              <p>
                <strong>{r.result.inserted}</strong> movimientos nuevos, {r.result.alreadyLoaded} ya estaban cargados
                {r.result.confirmed > 0 && `, ${r.result.confirmed} por facturar quedaron confirmados`}.
              </p>
              <p className="muted small">
                Cada compra cuenta una vez, completa y en la fecha en que se hizo, aunque sus cuotas vuelvan a aparecer en otros estados de cuenta.
                {r.result.bank === 'BancoEstado' && ' BancoEstado solo informa la cuota: el total de una compra en cuotas es cuota × número de cuotas.'}
              </p>
            </>
          )}
          {r.result?.type === 'account' && (
            <>
              <p>
                {r.result.accountName} ({r.result.accountNumber}) · {r.result.fromDate && shortDate(r.result.fromDate)} al{' '}
                {r.result.toDate && shortDate(r.result.toDate)}
                {r.result.statement?.kind === 'consolidated' && ` · cartola N° ${r.result.statement.number}`}
              </p>
              {r.result.statement?.kind === 'provisional' && (
                <p className="info">
                  Cartola en línea: sus movimientos quedan como <strong>provisorios</strong> y se reemplazan cuando importes la próxima cartola
                  consolidada (tus categorías y comentarios se traspasan).
                </p>
              )}
              {r.result.replacedProvisional > 0 && <p>Reemplazó {r.result.replacedProvisional} movimientos provisorios.</p>}
              <p>
                <strong>{r.result.inserted}</strong> movimientos nuevos, {r.result.alreadyLoaded} ya estaban cargados. Saldo contable:{' '}
                {clp(r.result.balance)}
              </p>
              {r.result.warnings.map((w) => (
                <p key={w} className="warning">
                  {w}
                </p>
              ))}
              {r.result.accountName.startsWith('Cuenta ') && (
                <p className="info">
                  Cuenta nueva. <a href={href('/configuracion')}>Ponle nombre</a> y agrega cómo aparece en las otras cartolas para detectar los
                  traspasos internos.
                </p>
              )}
            </>
          )}
        </div>
      ))}

      <h2>Historial</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Importada</th>
              <th>Archivo</th>
              <th>Cuenta</th>
              <th>Período</th>
              <th className="num">Nuevos</th>
              <th className="num">Saldo</th>
              <th>Usuario</th>
            </tr>
          </thead>
          <tbody>
            {(history.data ?? []).map((i) => (
              <tr key={i.id}>
                <td className="nowrap">{i.imported_at.replace('T', ' ').slice(0, 16)}</td>
                <td>{i.filename}</td>
                <td>
                  {i.account_name}
                  {i.kind === 'credit_line' && <small className="muted"> · línea de crédito</small>}
                  {i.kind === 'card' && <small className="muted"> · {i.statement_kind === 'consolidated' ? 'facturados' : 'por facturar'}</small>}
                  {i.kind === 'account' && i.statement_kind === 'consolidated' && <small className="muted"> · cartola N° {i.statement_number}</small>}
                  {i.kind === 'account' && i.statement_kind === 'provisional' && <small className="muted"> · en línea (provisoria)</small>}
                </td>
                <td className="nowrap">
                  {i.from_date && shortDate(i.from_date)} – {i.to_date && shortDate(i.to_date)}
                </td>
                <td className="num">
                  {i.inserted} / {i.movements_in_file}
                </td>
                <td className="num">{i.kind === 'card' ? '—' : clp(i.balance)}</td>
                <td>{i.username ?? 'consola'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
