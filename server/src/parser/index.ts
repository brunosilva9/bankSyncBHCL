import { isXlsx, parseBancoEstadoXlsx } from './bancoestado.js';
import { CartolaParseError, decodeCartola, parseCartola, type ParsedCartola } from './cartola.js';

/** Reconoce el formato por su contenido (no por el nombre del archivo) y lo interpreta. */
export async function parseStatementFile(bytes: Uint8Array): Promise<ParsedCartola> {
  if (isXlsx(bytes)) return parseBancoEstadoXlsx(bytes);
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
    throw new CartolaParseError('Formato Excel antiguo (.xls). Para Banco de Chile usa la cartola en formato .txt.');
  }
  return parseCartola(decodeCartola(bytes));
}
