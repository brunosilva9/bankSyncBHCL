import { useState, type DragEvent } from 'react';
import { api, type CreditLineImportResult, type ImportResult, type ImportRow } from '../api';
import { useFetch, useShared } from '../data';
import { clp, shortDate } from '../format';
import { href } from '../router';

type FileResult = { filename: string; result?: ImportResult | CreditLineImportResult; error?: string };

export function ImportPage() {
  const { reload } = useShared();
  const history = useFetch<ImportRow[]>('/api/imports');
  const [results, setResults] = useState<FileResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    const out = new Map<string, FileResult>();
    const send = async (f: File) => {
      try {
        const result = await api.upload<ImportResult | CreditLineImportResult>('/api/imports', await f.arrayBuffer(), f.name);
        out.set(f.name, { filename: f.name, result });
      } catch (e) {
        out.set(f.name, { filename: f.name, error: (e as Error).message });
      }
      setResults([...out.values()]);
    };
    const list = Array.from(files);
    for (const f of list) await send(f);
    // La cartola de la línea necesita la de la cuenta corriente del mismo día: si vinieron juntas y la
    // línea se procesó primero, se reintenta al final.
    for (const f of list.filter((f) => out.get(f.name)?.error)) await send(f);
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
        o cartola en línea, en <strong>Excel (.xlsx)</strong>. Puedes subir varias a la vez y repetir cartolas que se traslapan: los movimientos
        que ya estaban no se duplican. La cuenta se reconoce automáticamente desde el archivo.
      </p>

      <label
        className={`dropzone ${dragging ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input type="file" accept=".txt,.xlsx,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} disabled={busy} />
        {busy ? 'Importando…' : 'Arrastra las cartolas (.txt o .xlsx) aquí o haz clic para elegirlas'}
      </label>

      {results.map((r) => (
        <div key={r.filename} className={`card import-result ${r.error ? 'failed' : ''}`}>
          <strong>{r.filename}</strong>
          {r.error && <p className="error">{r.error}</p>}
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
                  consolidada (tus categorías y etiquetas se traspasan).
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
                  {i.statement_kind === 'consolidated' && <small className="muted"> · cartola N° {i.statement_number}</small>}
                  {i.statement_kind === 'provisional' && <small className="muted"> · en línea (provisoria)</small>}
                </td>
                <td className="nowrap">
                  {i.from_date && shortDate(i.from_date)} – {i.to_date && shortDate(i.to_date)}
                </td>
                <td className="num">
                  {i.inserted} / {i.movements_in_file}
                </td>
                <td className="num">{clp(i.balance)}</td>
                <td>{i.username ?? 'consola'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
