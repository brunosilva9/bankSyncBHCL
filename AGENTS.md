# AGENTS.md

Guía para agentes que trabajan en este repositorio, y backlog único de tareas pendientes.
Mantener este archivo actualizado: es la fuente de verdad del trabajo futuro. El `README.md` es para
la persona que usa la app; **no** duplicar aquí su contenido, solo lo necesario para trabajar.

## Qué es SyncBanks

Vista global de los movimientos de cuentas de Banco de Chile y BancoEstado. Importa cartolas
(`.txt` de Banco de Chile, `.xlsx` de BancoEstado), categoriza y comenta movimientos, y genera un
informe en 4 hojas (resumen, saldo consolidado día a día, entradas, gastos) listo para PDF.

- **Backend:** Node + Express + SQLite cifrado (SQLCipher vía `better-sqlite3-multiple-ciphers`).
- **Frontend:** React + Vite.
- **Tests:** Vitest en ambos.
- Todo el código, los comentarios y la UI están **en español**.

Detalle funcional (formatos de cartola, traspasos, línea de crédito, etc.) en [README.md](README.md).
Despliegue en producción (Oracle Cloud + DuckDNS + Caddy, con `compose.yaml`) en [DESPLIEGUE.md](DESPLIEGUE.md).
Plan de automatización (cierres diarios, fecha real, ingesta automática) en [PLAN_AUTOMATIZACION.md](PLAN_AUTOMATIZACION.md).

## Comandos

Desde la raíz del repo:

| Comando | Qué hace |
|---|---|
| `npm run setup` | Instala dependencias de raíz, server y web |
| `npm run dev` | API en :3001 + web en http://localhost:5173 (concurrently) |
| `npm test` | Tests del server y de la web |
| `npm run typecheck` | `tsc --noEmit` en server y web |
| `npm run build` | Compila la web en `web/dist` |
| `npm start` | Levanta el server, que también sirve `web/dist` |
| `npm run import -- <usuario> a.txt b.xlsx` | Importa cartolas desde la consola a las cuentas de ese usuario |
| `npm run backup` | Respaldo cifrado de todas las bases en `backups/<fecha>/` |
| `npm run cierre [-- AAAA-MM-DD]` | Cierra los días pendientes de cada base, como el servidor a las 02:00 (o un día puntual) |
| `npm run user:add -- <usuario>` | Crea un administrador (pide contraseña, mínimo 10 caracteres) |
| `npm run user:transfer -- <de> <a>` | Pasa todas las cuentas de un usuario a otro que no tiene cuentas |
| `npm run user:password -- <usuario>` | Contraseña nueva para un usuario (sin usuario, lista los existentes) |
| `npm run detect -- <archivos o carpetas>` | Qué reconoce la app en cada archivo, sin importar |
| `npm run check:real -- guardar\|comparar <carpetas>` | Red de seguridad con cartolas reales (foto en `data/`, fuera de git) |

Antes de dar una tarea por terminada: `npm run typecheck` y `npm test` deben pasar. Si se tocan los
lectores de cartolas (`server/src/parser/`), además `npm run check:real -- comparar <carpetas>`: los
archivos reales que ya se leían deben dar exactamente lo mismo.

En Windows, correr los tests con `npm test` desde la raíz y en PowerShell: `npm --prefix server test`, un
filtro de archivo o el mismo `npm test` desde Git Bash (`cd /c/dev/...`) a veces fallan al cargar vitest
(«Cannot read properties of undefined (reading 'config')») en todos los archivos, sin que sea culpa del código.

Si `npm run dev` está corriendo, `tsx watch` reinicia el server con cada cambio en `server/src`, y al
arrancar el server corre el cierre diario sobre las bases de `data/`.

## Estructura

```
server/src/
  app.ts            # rutas de la API (Express)
  auth.ts           # login scrypt, sesión por cookie, límite de intentos, roles, traspaso de cuentas
  db.ts             # esquemas SQLite (datos de un usuario / acceso) y migraciones idempotentes
  store.ts          # usuarios.db + una base por usuario (data/bases/); migra la base de antes
  config.ts         # lectura de .env (DB_KEY, PORT, DB_PATH...)
  index.ts          # arranque del server (y del cierre diario automático)
  scheduler.ts      # cierre diario dentro del server: cada 5 min revisa si ya pasó CIERRE_HORA (02:00)
  time.ts           # hora de Chile (Intl, America/Santiago): todo "hoy" o "qué día es" sale de aquí
  cli/              # addUser, setPassword, transferData, importFiles, backup, detect, realFilesCheck, closeDays
  domain/           # importer, categorize, classify, creditLine, creditCard, report,
                    # daily (día por día, hitos y saldo de cada día para el informe: dailyBalances),
                    # closing (cierres congelados y su cadena de hashes),
                    # seen (hora de descarga, primera vez que se vio cada movimiento y su fecha real)
  parser/           # cartola.ts (Banco de Chile), bancoestado.ts, creditCard.ts, detect.ts, index.ts
server/test/        # tests Vitest con datos ficticios
compose.yaml, Caddyfile, deploy/   # producción: app detrás de Caddy (HTTPS), respaldo diario (DESPLIEGUE.md)
web/src/
  api.ts            # cliente HTTP y tipos de la API
  App.tsx, router.ts, data.tsx
  pages/            # LoginPage, ImportPage, MovementsPage, PayrollPage, ReportPage, DailyPage, SettingsPage, UsersPage
  components/       # BalanceChart, CategorySelect, CopyButton, CopyImageButton, DatesSelect, LabelInput, MovedBadge,
                    # RangePicker, RealDateSelect
  clipboard.ts      # copiar texto y tabla HTML (con respaldo por execCommand sin HTTPS) o una imagen al portapapeles
  format.ts, payroll.ts, reportDetail.ts, dailyCopy.ts, seen.ts, balances.ts, chartImage.ts, ledgerImage.ts (+ sus .test.ts)
```

## Convenciones

- **ESM en el server:** los imports locales llevan extensión `.js` (`import { x } from './db.js'`),
  aunque el fuente sea `.ts`.
- **Base de datos:** el esquema se aplica con `CREATE TABLE IF NOT EXISTS`; al agregar una tabla o
  columna, agregarla también a `db.ts` de forma idempotente (no romper bases existentes).
- **Tests:** Vitest. Usar datos ficticios; nunca cartolas reales. Los helpers están en
  `server/test/helpers.ts`.
- **Fecha y dinero:** las fechas son `YYYY-MM-DD` (solo fecha contable, sin hora). No asumir que el
  orden dentro de un día coincide con la hora real salvo por `seq`. `movements.date` es la del banco: con
  ella se reconstruyen los saldos y se ordena el día. `real_date` (ver `domain/seen.ts`) es la más temprana
  que se conoce: solo baja, y todo cambio de `date` debe pasar por `seenStatements(db).dated` para no
  perderla. Informes, *Diario*, listados y cierres van por fecha real por defecto (`DateMode`, `dayColumn`
  en `domain/report.ts`; `?fecha=banco` en la API para la del banco).
- **Saldo de cada día:** `buildReport` calcula el saldo y el disponible de un rango; `dailyBalances`
  (`domain/daily.ts`) calcula lo mismo día por día en una pasada. Si cambia cómo se calcula uno, cambiar el
  otro: `server/test/balances.test.ts` los compara día por día en los dos modos.
- **Comentarios:** en español, explicando el *por qué* (reglas del banco, casos borde), no el *qué*.

## Reglas críticas (no romper)

- **Nunca commitear datos reales.** `.env`, `data/`, `backups/`, `*.txt`, `*.xls`, `*.xlsx` están en
  `.gitignore`. Los tests usan datos ficticios.
- **`DB_KEY`** es la única forma de abrir la base; si se pierde, los datos no se recuperan. No
  imprimirla ni loguearla.
- Toda escritura en la API exige el header `x-requested-with: syncbanks` (protección CSRF).
- **Cada usuario tiene su propia base** (`users.data_file`). Las rutas de datos van en `dataRoutes(db)`
  de `server/src/app.ts` y solo usan esa `db`; nada de datos de cuentas en `usuarios.db`, y ninguna
  ruta mezcla bases de dos usuarios. Lo de administrador va en `adminRoutes` y solo sobre usuarios con
  `admin_id` = el administrador.
- Las ediciones manuales de categoría/comentario/nota **nunca** se pisan por las reglas automáticas.
  Única excepción, intencional: un movimiento con pareja en otra cuenta propia pasa a *Traspaso
  interno* aunque su categoría sea manual (el comentario se conserva); si no, la plata se cuenta dos
  veces. Ver `recategorize` en `server/src/domain/categorize.ts`.

## Flujo de trabajo

1. Tomar la primera tarea desmarcada del backlog de abajo y marcarla **en curso** (moverla a la
   sección *En curso*, con la rama si aplica).
2. Implementar siguiendo las convenciones y agregar/actualizar tests.
3. Correr `npm run typecheck` y `npm test`.
4. Mover la tarea a *Hecho* (o borrarla) y, si cambia el comportamiento de cara al usuario, actualizar
   el `README.md`.
5. Commit con mensaje en el estilo del repo, p. ej. `SyncBanks: <descripción corta>`. **Solo commitear
   cuando el usuario lo pida.**

## Backlog

### En curso

- **Probar la API de Saldos y Movimientos de Banco de Chile** (sandbox del API Store) en un proyecto aparte,
  fuera de este repo público: `../SyncBanks-ApiBancoChile`. Preguntas: si cada movimiento trae hora,
  identificador y saldo, y si un script pasa el firewall del banco (Incapsula). Con identificador, la fase 1
  se simplifica para Banco de Chile; además es una fuente candidata para la fase 5.

### Pendiente

Automatización (informes diarios, cierres, fecha real, ingesta): diseño y razones en
[PLAN_AUTOMATIZACION.md](PLAN_AUTOMATIZACION.md). El orden sigue las dependencias; dentro de cada fase,
la primera casilla libre es la siguiente tarea.

- [ ] **Fase 0 — Base para automatizar** (plan §4 y §5).
  - [ ] Dependabot (o el aviso de `npm audit` en la CI): el `npm audit fix` de body-parser y qs ya se hizo.
  - [ ] CI con GitHub Actions: `npm run typecheck`, `npm test` y `npm audit --omit=dev` en cada push.
  - [ ] Hora de descarga de las tarjetas (`parser/creditCard.ts`: la de BancoEstado ya se lee para
        `asOf`, pero sin la hora; CMR no la trae). Las cuentas ya la guardan (ver *Hecho*: fecha real).
  - [ ] Lector de BancoEstado: contar y avisar las filas que se saltan (hoy `if (!date) return` las bota
        en silencio).
  - [ ] Migraciones numeradas con `PRAGMA user_version`, solo al arrancar la app; test que abre una base
        de la versión anterior.
- [ ] **Fase 1 — Identidad estable de los movimientos y recambio de nombre** (plan §3.4).
  - [ ] Experimento con cartolas reales (resultados en `data/`, fuera de git): bajar cada cuenta a
        mediodía, a las 23:50, a las 00:10 y al día siguiente, después de una transferencia hecha tarde.
        Anotar la fecha del movimiento, la fecha y el saldo de la línea de saldo, si ese saldo ya lo
        incluye y qué redacción cambia. Agregar a `check:real` un modo que diga qué cambió entre dos
        descargas de la misma cuenta.
  - [ ] Columnas y tablas del plan §3.8 que faltan: `imports.source` y `file_sha256`; el archivo crudo
        en `import_files`; `movements.last_seen_at`, `original_description` y `voided_at`;
        `movement_versions`. (Ya están `imports.observed_at`, `movements.first_seen_day`, `first_seen_at`,
        `real_date` y `real_date_source`, con su relleno en las bases existentes: `domain/seen.ts`.)
  - [ ] Reconciliador único `server/src/domain/reconcile.ts`: pasada exacta → llave fuerte por banco
        (BancoEstado: sentido + monto + saldo) → difusa (±3 días, alias, puntaje, un solo candidato claro)
        → verificación con el saldo (si no calza, se deshace lo difuso y se avisa). Cada carga es una
        diferencia: iguales, modificados (versión nueva), nuevos y desaparecidos. Reemplaza `keyOf`,
        `SAME_MOVEMENT`, `removeProvisional` y `carryOver` (que ya busca el reemplazo de un provisorio por
        saldo, por día o a ±3 días); las ediciones manuales quedan pegadas al id. Tests: redacción nueva,
        fecha ±1, idénticos, provisorio que se consolida con otra redacción y provisorio que desaparece.
  - [ ] Alias aprendidos (`description_aliases`); `SAME_MOVEMENT` queda como semilla.
  - [ ] Provisorio que desaparece → anulado (`voided_at`): no se borra ni suma, y se ve tachado. Test de
        que el informe y los listados lo excluyen.
  - [ ] *Por revisar* para los ambiguos ("es el mismo" / "son distintos") e historial de versiones de un
        movimiento en *Movimientos*.
  - [ ] Tarjetas (`sameCardPurchase`) y traspasos internos (`findInternalPairs`) con el mismo puntaje.
- [ ] **Verificar la consolidación de la cartola de BancoEstado (N° 041).** Confirmar con la cartola
      041 real cómo cambian los movimientos al consolidarse (descripción, N° de operación, fecha). Hoy
      se reemplazan por período, y la fecha real y las ediciones manuales pasan al reemplazo por sentido
      + monto + saldo, luego por día, luego a ±3 días (`carryOver` en `importer.ts`). Ojo
      además con el traspaso genérico `TRANSFERENCIA FONDOS INTERNET`
      ([server/src/domain/classify.ts](server/src/domain/classify.ts)): si al consolidarse cambia la
      redacción, puede dejar de parearse como interno.
      Ver `TODO` en [server/src/domain/importer.ts](server/src/domain/importer.ts).
      Con el reconciliador de la fase 1, las ediciones quedan pegadas al id y la llave sentido + monto +
      saldo no depende de la redacción: la 041 real sirve para confirmarlo.
- [ ] **Importar los formatos que ya se reconocen** (`server/src/parser/detect.ts`, `supported: false`):
      cuenta corriente y línea de crédito de BancoEstado persona y de Banco Falabella. Para los archivos
      sin número de cuenta (Banco Falabella): asignar sola si el usuario tiene una sola cuenta de ese
      banco y producto, o por traslape de movimientos con lo ya cargado, o preguntar una vez y
      recordarlo. Al cargar la cuenta que paga una tarjeta, parear su "Pago tarjeta" con el pago que
      registra la tarjeta (hoy el lado de la tarjeta ya es *Traspaso interno*; el de la cuenta contaría
      como gasto). Conviene después de la fase 1, para que use el reconciliador y no sume otro
      emparejador.
- [ ] **Fase 2 — Fecha real y marca de los movimientos movidos** (plan §3.3). La base está hecha (ver
      *Hecho*: fecha real por el día en que apareció); falta:
  - [ ] *Tardío* (llegó después del cierre de su día): marcarlo contra ese cierre. Va con las
        correcciones de la fase 3.
  - [ ] Feriados de Chile en la ventana de la fecha real a mano (`previousBusinessDay` en `domain/seen.ts`): hoy
        solo se saltan sábados y domingos, así que el día siguiente a un feriado no deja elegir el día hábil anterior
        al feriado.
  - [ ] Confirmar con el experimento de la fase 1 que el saldo de una cartola nocturna siempre incluye lo
        fechado al día siguiente (con las cartolas ya cargadas, casi siempre calza): de eso depende que el
        saldo por fecha real cuadre con la cartola.
- [ ] **Fase 3 — Cierres diarios automáticos** (plan §3.5 y §3.6). La base está hecha (ver *Hecho*:
      diario y cierre de las 02:00); falta:
  - [ ] Correcciones: toda carga que cambie algo con fecha igual o anterior a D queda registrada contra
        el cierre de D (`closing_corrections`: qué movimiento, antes, después, cuándo se supo). Hoy solo se
        sabe *que* el día cambió (la huella de sus movimientos ya no es la del cierre). Necesita la fase 1.
  - [ ] El cierre pasa de provisorio a definitivo con la consolidada o tras N días sin cambios.
  - [ ] Aserción de saldo por cierre: saldo observado del cierre anterior + movimientos del día = saldo
        observado. Hoy el *Diario* compara cada cartola con la anterior (`hitosOf` en `domain/daily.ts`).
  - [ ] `job_runs`: registrar cada vuelta del cierre automático y avisar en la app si falló (hoy solo va
        al log del server).
  - [ ] Aviso diario sin montos (correo o ntfy) con el enlace y el hash del cierre. PDF automático solo
        si hace falta (Chromium sin pantalla, en un servicio aparte).
- [ ] **Fase 4 — Seguridad para operación desatendida** (plan §4). Va antes de abrir la ingesta.
  - [ ] Login: calcular scrypt aunque el usuario no exista (`app.ts`: hoy la respuesta más rápida delata
        qué usuarios existen); límite por usuario además de por IP; TOTP para administradores.
  - [ ] `audit_log` en `usuarios.db`, solo agregar y sin montos: entradas, importaciones, cierres y
        vistas de un administrador a las cuentas de otro.
  - [ ] Respaldo automático fuera del servidor y una restauración de prueba al mes.
  - [ ] Borrar las tablas `users` y `sessions` viejas de `data/syncbanks.db`, que guardan hashes de
        contraseñas antiguas.
  - [ ] Rendimiento: `findInternalPairs` indexado por monto y `recategorize` solo sobre los días
        afectados.
- [ ] **Fase 5 — Traer las cartolas solas** (plan §3.7).
  - [ ] Decidir la fuente: cotizar Fintoc (Banco de Chile y BancoEstado; no Banco Falabella ni
        tarjetas), probar si los bancos piden la segunda clave al entrar y seguir Finanzas Abiertas
        (julio de 2027).
  - [ ] Puerta de ingesta `POST /api/ingesta`, apagada por defecto: token por usuario que solo importa a
        sus cuentas (hash, revocable, último uso, límites de tamaño y frecuencia), con la hora de
        descarga.
  - [ ] Descargador fuera del servidor de la app (un equipo siempre encendido o una segunda VM sin
        puertos abiertos), o integración con el agregador en un servicio aparte con su propia llave.
        Nunca la clave del banco en el servidor de la app.
- [ ] **Cobertura de tests de la web:** hoy hay tests de utilidades (`format`, `payroll`,
      `reportDetail`) y el primero de componente/página (`ReportPage.test.tsx`, la tarjeta de
      comentario); faltan los de las demás páginas.

### Hecho

- **Fecha real a mano** (fase 2). En *Movimientos*, por fecha real, la fecha es un selector
      (`web/src/components/RealDateSelect.tsx`) con los días en que pudo pasar el movimiento.
      - `realDateWindows` en `domain/seen.ts` calcula esos días. Lo más temprano es el día hábil anterior a la
        fecha del banco, o el día de la última descarga de su cuenta en que todavía no aparecía, si es posterior.
        Lo más tardío es la primera cartola que lo trajo, o la fecha del banco si es anterior.
      - No cuentan las consolidadas de BancoEstado (traen solo su período) ni las tarjetas.
      - `GET /api/movements` lo manda en `real_date_window`. `PATCH /api/movements/:id` y `/bulk` aceptan `realDate`
        dentro de esa ventana y la dejan `manual`. Una nómina cambia entera.
      - `seenStatements` ya no se salta las fechas manuales: igual solo baja la fecha, así que cambia una manual solo
        si una cartola muestra que el movimiento ya existía antes.
      - Tests: `server/test/seen.test.ts`, `web/src/seen.test.ts` y `web/src/components/RealDateSelect.test.tsx`.

- **Hoja *Saldos* del informe** (la segunda): el saldo consolidado (total de las cuentas) al final de cada día,
      en un gráfico, una lista día a día y el detalle día a día. El usuario no quiso gráficos ni tabla de saldos por
      cuenta.
      - El detalle sale de `dayLedger` (`web/src/balances.ts`): los movimientos de cada día, con las nóminas en una
        línea y el saldo relativo calculado hacia atrás desde el saldo real del día. Si no cuadra, lleva una fila
        `gap`.
      - Usa `GET /api/movements` sin `excludeInternal`. Los traspasos internos no mueven el saldo relativo.
      - Se ven por defecto; la casilla *Mostrar traspasos internos* los oculta (`syncbanks.traspasos` en
        `localStorage`).
      - *Copiar imagen* (`components/CopyImageButton.tsx`) copia como PNG y, si no se puede, lo descarga. Está en el
        gráfico (`web/src/chartImage.ts`: una copia del SVG con los colores del tema claro escritos en cada parte,
        bajo un encabezado) y en las dos tarjetas de cada día del detalle, que se copian por separado
        (`web/src/ledgerImage.ts`, dibujadas como SVG; lo que no cabe en su columna se corta con «…», midiendo el texto
        con canvas). Las dos tarjetas son la de movimientos (`dayCardSvg`) y la de saldo final por cuenta
        (`balancesCardSvg`): cada cuenta con la cartola de la que sale, `lastSeenAt`/`lastImportedAt` de
        `dailyBalances`. El usuario pidió la foto, no el texto.
      - Lo que no se compensa en el día va en una fila `internal`. `GET /api/balances` (`dailyBalances` en `domain/daily.ts`, hasta
      1.100 días) da lo mismo que `buildReport` de cada día, en una pasada: un informe por día tardaba segundos
      en un año. Cada día dice cuántas cartolas se bajaron y la hora de la última. El gráfico
      (`web/src/components/BalanceChart.tsx`, SVG sin bibliotecas):
      - Pinta lleno el punto de un día con cartola de todas las cuentas y vacío el de uno sin ella.
      - Se redibuja al ancho de la hoja al imprimir (`beforeprint`).
      - Tiene recuadro al pasar el mouse o con las flechas, y sombrea los fines de semana.

      Lógica en `web/src/balances.ts`. Tests: `server/test/balances.test.ts`, `web/src/balances.test.ts` y
      `web/src/pages/ReportPage.test.tsx`.

- **Fecha real por el día en que apareció** (fase 2, sin esperar la API de Banco de Chile). `domain/seen.ts`:
      - `imports.observed_at` y `observed_source` guardan la hora de descarga. Sale de la hoja Resumen de
        BancoEstado, del `File.lastModified` que manda `ImportPage` (`x-file-modified`) o del mtime en
        `npm run import`, o de la hora de subida. Las tres últimas solo valen si son del mismo día que la
        cartola.
      - `movements.first_seen_day` y `first_seen_at`: la primera cartola que lo trajo.
      - `real_date` y `real_date_source` (`banco`, `observada` o `manual`): la fecha más temprana conocida.
        Solo baja: con una cartola anterior subida después, con lo que traía el provisorio reemplazado
        (`carryOver` en `importer.ts`, que también pasa las ediciones manuales) o con la fecha anterior de
        una compra de tarjeta que el facturado movió.
      - La migración (`backfillFirstSeen`) rellena las bases existentes desde `import_id`. En BancoEstado
        ubica además las cartolas en línea ya reemplazadas por el saldo de su movimiento más reciente.
      - **Por fecha real por defecto, en todo** (`DateMode` y `dayColumn` en `domain/report.ts`):
        - `buildReport` suma al saldo del banco lo ya hecho y fechado después (`shiftedBefore`/`shiftedUntil`).
        - `dayDetail` pone al final del día lo hecho ese día y fechado después, con el saldo calculado hacia
          atrás desde el saldo final, y deja lo fechado ese día pero de antes como entradas `earlier`.
        - Las nóminas se numeran por día real.
        - El cierre guarda la foto por fecha real (`dates`, `realHash` con `realMovementsHash`) y la del banco
          (`bank`). `getClosing` y `closingStatuses` reciben el modo. Los cierres de antes solo tienen la del
          banco.
        - La API acepta `?fecha=banco` en `/movements`, `/report`, `/daily` y `/daily/:day`.
        - En la web, el selector `DatesSelect` (en `data.tsx`, guardado en `localStorage`).
      - En pantalla:
        - Insignia `MovedBadge`, con el porqué: por fecha real «banco: lun 23»; por la del banco «↶ sáb 14».
          Va en *Movimientos*, el informe, *Nóminas* y el *Diario*.
        - Filtro `postdated=1` en *Movimientos*.
        - En el *Diario*, lo que se cuenta en otro día va atenuado y sin sumar: `earlier` por fecha real,
          `later` por la del banco. La fila del día lleva `seenBefore` y `datedLater`.
        - En *Copiar*, eso va aparte, al final del día.
        - En los hitos, la hora de descarga.
      - Tests: `server/test/seen.test.ts` (diario e informe por las dos fechas), `closing.test.ts`,
        `daily.test.ts`, `bancoestado.test.ts` (consolidación con otra redacción y fecha, relleno),
        `creditCard.test.ts`, `time.test.ts` (`chileInstant`), `web/src/seen.test.ts`, `payroll.test.ts`,
        `dailyCopy.test.ts` y `DailyPage.test.tsx`.

- **Diario y cierre automático de las 02:00.** `server/src/time.ts` (hora de Chile con `Intl`);
      `domain/daily.ts`: cada día con saldo inicial y final, y los hitos, que son las cartolas importadas
      con el saldo del banco y lo que no explican los movimientos entre una y la anterior
      (`bankChange − movementsChange`, comparando por la posición del movimiento más reciente de cada
      archivo). `domain/closing.ts`: tabla `closings` con el informe del día, el detalle y la cobertura en
      JSON, la huella de los movimientos (sin categorías ni comentarios), la cadena de hashes y
      `pendingDays`, que la primera vez cierra solo ayer y después se pone al día hasta 31 días.
      `scheduler.ts` revisa cada 5 min dentro del server (`CIERRE_HORA`, por defecto 2; se descartó el
      cron del plan). También `npm run cierre`, `GET /api/daily`, `GET /api/daily/:day` y la página
      *Diario* (`web/src/pages/DailyPage.tsx`). Tests en `server/test/{time,daily,closing,dailyApi}.test.ts`
      y `web/src/pages/DailyPage.test.tsx`. *Copiar* en el día abierto (`web/src/dailyCopy.ts`, con test): por
      cuenta, saldo inicial con su fecha, movimientos y saldo final con su fecha, como texto y como tabla HTML.
      Las nóminas van en una línea, como en *Nóminas* (`groupDayPayroll` en `web/src/payroll.ts`, con el
      `payroll_batch` que ahora trae `dayDetail`), en la línea de tiempo y al copiar.

- **Guía de despliegue gratis y segura** ([DESPLIEGUE.md](DESPLIEGUE.md)): Oracle Cloud *Always Free*
      (Santiago, A1 1 OCPU / 6 GB), DuckDNS, Caddy con Let's Encrypt, respaldo diario (`deploy/respaldar.sh`)
      y copia semanal fuera del servidor. `TRUST_PROXY` (`config.trustProxy`) para que el límite de login
      vea la IP real detrás de Caddy (test en `server/test/proxy.test.ts`); el Dockerfile crea `/app/backups`.

- **Tarjetas de crédito: CMR (facturados y no facturados) y BancoEstado (por facturar).** Lector en
      `server/src/parser/creditCard.ts`, importación en `server/src/domain/creditCard.ts`. La tarjeta es una
      cuenta con `kind = 'tarjeta_credito'` y sin saldo. Cada compra entra una vez, completa y en su fecha
      (`sameCardPurchase`: mismo comercio sin "COMPRA EN CUOTAS"/"COMPRA CUOTAS SIN INTERES", mismo monto
      o cuota con redondeo, ±3 días). Lo no facturado de CMR es provisorio hasta su estado de cuenta.
      Pagos y avances transferidos son *Traspaso interno*. El informe agrega `cardDebtChange` para que el
      resumen cuadre. Tests en `server/test/creditCard.test.ts`.

- **Cuentas por usuario y roles.** Una base cifrada por usuario (`data/bases/<uuid>.db`) y una de acceso
      (`data/usuarios.db`, ver `server/src/store.ts`). Rol `usuario` = la app completa con sus cuentas;
      `admin` = además crea, cambia la contraseña y desactiva a sus usuarios (página *Usuarios*), y ve o
      trabaja en sus cuentas (`users.view_user_id`, selector *Cuentas de* en la barra). Una pestaña con las
      cuentas de otro dueño recibe 409 (`x-syncbanks-owner`) y se recarga. `npm run user:transfer` pasa
      las cuentas de un usuario a otro sin copiar datos. La base de antes (`data/syncbanks.db`) se adopta
      sola: sus usuarios pasan a administradores apuntando a ella; quedan ahí las tablas `users` y
      `sessions` viejas, sin uso. Tests en `server/test/users.test.ts` y `web/src/pages/UsersPage.test.tsx`.
      Además: `DELETE /api/accounts/:id` (*Eliminar cuenta* en Configuración) y, para administradores, aviso
      antes de crear en un usuario una cuenta que ya está en otra de sus bases (409 `account-elsewhere`,
      *Importar igual* en `ImportPage`).

- **Detección de banco y producto por contenido** (`server/src/parser/detect.ts`, `npm run detect`).
      Firmas para Banco de Chile, BancoEstado (empresa/persona: cuenta, línea, tarjeta) y Banco Falabella
      (cuenta, línea, CMR). Lo que ya se importaba sigue por el mismo camino. `.xls` con SheetJS 0.20.3.
      Red de seguridad con archivos reales: `npm run check:real`.
- **Giros de la línea duplicados por cambio de redacción.** Banco de Chile informa el giro automático
      como `Trasp.fondos A Ctacte-l.cred-c.vista` y en la cartola siguiente el mismo giro como
      `Transferencia Desde Linea De Credito`. El importador los compara como uno solo (`SAME_MOVEMENT` en
      `server/src/domain/importer.ts`) y deja la redacción más reciente. Si aparece otro renombre del banco,
      se agrega ahí. Test en `server/test/importer.test.ts`.
- **Separar nóminas a mano.** `movements.payroll_split_after` marca el último pago de una nómina;
      `recomputePayrollBatches` abre una nómina nueva en ese pago (recorre de abajo hacia arriba).
      `POST /api/movements/:id/payroll-split` y botones *Cortar aquí* / *Unir con la de abajo* en
      `PayrollPage`. Test en `server/test/api.test.ts`.
- **Hoja Gastos para imprimir.** Primero va lo sin categoría, para asignarla rápido desde el informe
      (`groupByCategory` en `web/src/reportDetail.ts`). Subtotal al pie de cada categoría, espacio entre categorías y cabecera
      pegada a sus primeros `HEAD_ROWS` (4) movimientos (`tbody.category-head` con `break-inside: avoid`).
      Los avisos de cobertura del resumen son `no-print`. Al final, *Resumen por categoría* con el total; en
      impresión `tfoot` es `table-row-group` para que el total no se repita en cada página.
- **Comentario del informe (nota por período y cuentas).** UI en
      [web/src/pages/ReportPage.tsx](web/src/pages/ReportPage.tsx) (`NoteCard`): muestra, edita (máx.
      `NOTE_MAX`) y borra el comentario en la hoja *Resumen*; sale impreso en el PDF. Test en
      `web/src/pages/ReportPage.test.tsx` (`web/src/test-setup.ts` ahora limpia el DOM entre tests).

## Sugerencias de interfaz (a evaluar, no son tareas comprometidas)

- **Móvil en las tablas restantes.** Solo el informe tiene vista de tarjetas; faltan Movimientos
  (`web/src/pages/MovementsPage.tsx`), Nóminas/Trabajadores (`web/src/pages/PayrollPage.tsx`) y las
  tablas de Configuración (`web/src/pages/SettingsPage.tsx`). Reusar el patrón `data-label` del informe.
- **Feedback y estados.** Hoy la carga es texto (`' · cargando…'`), no hay estados vacíos (la tabla de
  Movimientos queda solo con encabezados), las confirmaciones usan `confirm()` nativo
  (`SettingsPage.tsx`) y el acuse de guardado es inconsistente (solo «Guardado ✓» en cuentas). Un
  *toast* global + estados vacíos + confirmación con estilo propio unificarían.
- **Búsqueda de Movimientos** con *debounce* en vivo en vez de enviar el formulario con Enter.
- **Accesibilidad y color.** Los montos se distinguen solo por color (`pos`/`neg`): agregar signo
  `+`/`−`. Revisar `focus-visible` y contraste de `.muted` y `input[type=color]` en tema oscuro.
- **Íconos.** Se mezclan glifos (`▸ ▾ ✕ ✓ →`); evaluar un set consistente.
- **Configuración** es una página larga con 4 secciones siempre abiertas: evaluar tabs/acordeón.
