// Uso: npm run cierre [-- AAAA-MM-DD]
// El servidor cierra solo cada día a la hora del cierre (CIERRE_HORA, 02:00). Esto hace lo mismo a mano en
// cada base: cierra lo pendiente y revisa la cadena de cierres. Con una fecha, cierra ese día si no estaba
// cerrado; queda con la hora de ahora, así que es un cierre tardío, no lo que se sabía esa noche.
import { config } from '../config.js';
import { closeDay, closePending, verifyClosings } from '../domain/closing.js';
import { openStore } from '../store.js';
import { chileDay } from '../time.js';

const day = process.argv[2];
if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error('Uso: npm run cierre [-- AAAA-MM-DD]');
  process.exit(1);
}
if (day !== undefined && day >= chileDay()) {
  console.error(`El ${day} todavía no termina (hora de Chile): no se puede cerrar.`);
  process.exit(1);
}

const store = openStore(config.dbPath, config.dbKey);
const files = store.dataFiles();
for (const [i, file] of files.entries()) {
  const db = store.data(file);
  const closed = day ? (closeDay(db, day) ? [day] : []) : closePending(db, Date.now(), config.closingHour ?? 2);
  const problems = verifyClosings(db);
  // Las bases se nombran por número: el nombre del archivo no dice nada útil y la lista de usuarios es privada.
  console.log(`Base ${i + 1} de ${files.length}: ${closed.length ? `cerrado ${closed.join(', ')}` : 'nada que cerrar'}`);
  for (const p of problems) console.log(`  ⚠ ${p}`);
}
store.close();
