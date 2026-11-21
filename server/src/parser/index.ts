import { parseBancoEstadoXlsx } from './bancoestado.js';
import { CartolaParseError, decodeCartola, parseCartola, type ParsedCartola } from './cartola.js';
import { parseCreditCard, type ParsedCard } from './creditCard.js';
import { describeDetection, detectStatement, isXls, isXlsx, type Detection } from './detect.js';

export { isCard, type ParsedCard } from './creditCard.js';

/** Una cuenta (cartola con saldo) o una tarjeta de crédito (solo movimientos; ver creditCard.ts). */
export type ParsedStatement = ParsedCartola | ParsedCard;

const notYet = (d: Detection) =>
  new CartolaParseError(`Reconocí el archivo: ${describeDetection(d)}. Todavía no se puede importar este tipo de cartola.`);

/**
 * Reconoce el formato por su contenido (no por el nombre del archivo) y lo interpreta. Lo que ya se
 * importaba (Banco de Chile .txt, BancoEstado empresa) sigue por el mismo camino; los demás formatos
 * reconocidos (ver detect.ts) responden qué son, aunque aún no se puedan importar.
 */
export async function parseStatementFile(bytes: Uint8Array): Promise<ParsedStatement> {
  if (isXlsx(bytes)) {
    const d = await detectStatement(bytes);
    if (d && !d.supported) throw notYet(d);
    if (d?.product === 'tarjeta_credito') return parseCreditCard(bytes, d);
    try {
      return await parseBancoEstadoXlsx(bytes);
    } catch (e) {
      // Si la firma no lo reconoció y tampoco es de BancoEstado, el mensaje de BancoEstado confunde.
      if (!d && e instanceof CartolaParseError) {
        throw new CartolaParseError('No reconozco este Excel como cartola de un banco conocido (Banco de Chile, BancoEstado o Banco Falabella).');
      }
      throw e;
    }
  }
  if (isXls(bytes) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    const d = isXls(bytes) ? await detectStatement(bytes) : null;
    if (d?.format === 'bancochile-xls') {
      throw new CartolaParseError(`Reconocí el archivo: ${describeDetection(d)}. Para Banco de Chile usa la cartola en formato .txt.`);
    }
    if (d) throw notYet(d);
    throw new CartolaParseError('Formato Excel antiguo (.xls) que no reconozco. Para Banco de Chile usa la cartola en formato .txt.');
  }
  return parseCartola(decodeCartola(bytes));
}
