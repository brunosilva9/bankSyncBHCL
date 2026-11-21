// Cierre diario automático, dentro del servidor: a la hora del cierre (02:00 de Chile) se cierra el día
// anterior de cada base de usuario. Se revisa cada 5 minutos en vez de programar un temporizador a una hora
// exacta: así da lo mismo el cambio de hora, y si el servidor estuvo apagado cierra lo pendiente al volver.
// No hace falta cron; `npm run cierre` hace lo mismo a mano.
import { closePending } from './domain/closing.js';
import type { Store } from './store.js';

export function startDailyClosings(store: Store, hour: number, everyMs = 5 * 60_000): () => void {
  const run = () => {
    for (const file of store.dataFiles()) {
      try {
        const closed = closePending(store.data(file), Date.now(), hour);
        if (closed.length) console.log(`Cierre diario: ${closed.join(', ')}`);
      } catch (e) {
        // Una base con problemas no deja sin cierre a las demás; se reintenta en la próxima vuelta.
        console.error(`Cierre diario: no se pudo cerrar una base: ${(e as Error).message}`);
      }
    }
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
