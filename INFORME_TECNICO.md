# SyncBanks — Informe técnico

Documento técnico de SyncBanks: cómo está construida la aplicación, qué tecnologías usa y cómo se
asegura que cada pieza esté conectada de punta a punta (importar → clasificar → informar).

> Para el uso de la app ver [README.md](README.md); para el trabajo pendiente y las convenciones del
> agente, ver [AGENTS.md](AGENTS.md).

## 1. Resumen

SyncBanks es una aplicación **web autocontenida** (monorepo) que da una vista global de los
movimientos de varias cuentas bancarias (Banco de Chile y BancoEstado). Importa cartolas, clasifica
automáticamente cada movimiento, permite ajustar categorías/comentarios a mano y emite un informe de 3
hojas (Resumen, Entradas, Gastos) listo para imprimir en PDF.

Es una app de un solo servidor: el mismo proceso **Express** sirve la **API** y, en producción, los
archivos estáticos del frontend. No hay base de datos externa ni servicios de terceros: todo vive en
un único archivo **SQLite cifrado**.

## 2. Stack tecnológico

| Capa | Tecnología | Versión | Para qué |
|---|---|---|---|
| Runtime | Node.js | 24 (imagen `node:24-slim`) | Ejecuta el backend en TypeScript vía `tsx` |
| Backend | Express | ^5.3.0 | Rutas HTTP de la API y servido del frontend |
| Base de datos | `better-sqlite3-multiple-ciphers` | ^13.0.3 | SQLite **cifrado** (SQLCipher/AES-256), sin servidor |
| Seguridad HTTP | Helmet | ^8.3.0 | Cabeceras HTTP seguras |
| Excel | ExcelJS | ^4.4.0 | Lee las cartolas `.xlsx` |
| Excel antiguo | SheetJS (`xlsx`) | 0.20.3 (CDN oficial) | Lee los `.xls` (BIFF). No se usa la 0.18.5 de npm, que tiene vulnerabilidades conocidas |
| Ejecución TS | `tsx` | ^4.23.15 | Corre TypeScript directo (dev y producción) |
| Frontend | React | ^19.3.0 | UI de una sola página (SPA) |
| Build frontend | Vite | ^8.3.4 | Dev server con proxy y build de producción |
| Lenguaje | TypeScript | ^7.0.2 | Tipado estático en server y web |
| Tests | Vitest | ^5.0.3 | Suite del server y de la web |
| Tests HTTP | Supertest | ^7.3.1 | Peticiones contra la app Express real |
| Tests UI | Testing Library (react, jest-dom), jsdom | ^16 / ^7 / ^29 | Entorno DOM para tests de la web |
| Dev | concurrently | ^10.0.6 | Levanta API y web a la vez |

No hay frameworks de ORM, ni gestor de estado (Redux, etc.), ni librería de ruteo externa: se usan
`better-sqlite3` directo (SQL a mano), Context API y un router por hash propio.

## 3. Arquitectura

Monorepo con tres `package.json`: raíz (orquestación), `server/` y `web/`.

```
┌────────────────────────── Navegador ──────────────────────────┐
│  React SPA (web/dist)                                          │
│  router por hash · Context de datos · fetch con CSRF header    │
└───────────────▲───────────────────────────────┬───────────────┘
   mismo origen │ JSON /api/*                    │ (dev) Vite proxy /api → :3001
                │                                ▼
┌───────────────┴────────────────────────────────────────────────┐
│  Express (server/src/app.ts)                                    │
│   helmet · express.json · CSRF (x-requested-with) · cookies     │
│   /api/auth/*  /api/accounts  /api/movements  /api/report ...   │
│                                                                 │
│   dominio: importer · categorize · classify · creditLine · report
│   parser:  cartola.ts (txt BCh) · bancoestado.ts (xlsx)          │
└───────────────┬────────────────────────────────────────────────┘
                │ better-sqlite3 (server/src/store.ts)
                ▼
   data/usuarios.db          usuarios, roles, sesiones
   data/bases/<uuid>.db      una base por usuario con sus cuentas
   (SQLCipher, todo cifrado en disco con la misma DB_KEY)
```

En desarrollo: `npm run dev` levanta la API en `:3001` y Vite en `:5173`; Vite redirige `/api` al
backend (`web/vite.config.ts`). En producción: `npm run build` deja `web/dist`, y el server lo sirve
con *fallback* SPA (`server/src/app.ts:408`), de modo que **un solo origen** atiende UI y API (importa
para las cookies de sesión).

## 4. Backend

### 4.1 Arranque y configuración

- `server/src/index.ts` abre las bases (`openStore`) y arranca Express. Si no hay usuarios, avisa por consola.
- `server/src/config.ts` lee el entorno con *defaults*: `PORT` (3001), `DB_PATH`
  (`data/syncbanks.db`: su carpeta es la carpeta de datos), `DB_KEY`, `SESSION_DAYS` (7), `NODE_ENV`, `WEB_DIST`.
  En desarrollo los scripts cargan `../.env` con `--env-file-if-exists`.

### 4.2 Base de datos (`server/src/db.ts`)

- Se abre siempre **cifrada**: `PRAGMA cipher='sqlcipher'` + `PRAGMA key=...`. Sin `DB_KEY` no abre.
- `journal_mode = WAL` (por eso el respaldo no puede ser una copia de archivo a mano) y
  `foreign_keys = ON`.
- Esquema **idempotente**: todo se crea con `CREATE TABLE IF NOT EXISTS`; las columnas agregadas
  después de la primera versión se aplican con `migrate()` (un `ALTER TABLE ... ADD COLUMN` por
  columna faltante). Así una base antigua sigue funcionando sin perder datos.
- `seed()` inserta las categorías por defecto solo si la tabla está vacía. Algunas categorías son
  **de sistema** (`system_key`: `payroll`, `bank_fee`, `credit_line`, `loan`, `internal`) y no se
  pueden borrar.

Dos esquemas: la **base de cada usuario** (`openDb`: `accounts`, `categories`, `imports`, `movements`,
`rules`, `payees`, `report_notes`) y la **base de acceso** (`openAuthDb`: `users`, `sessions`). Detalle en
la sección 7.

### 4.2.1 Una base por usuario (`server/src/store.ts`)

- `Store` abre `usuarios.db` y, a pedido, la base de cada usuario (`users.data_file`, relativa a la
  carpeta de datos); las deja abiertas. Se eligió una base por usuario en vez de una columna `user_id`
  en cada tabla: las restricciones de unicidad (número de cuenta, nombre de categoría, RUT del
  trabajador) siguen valiendo por usuario sin rehacer tablas, ninguna consulta puede mezclar cuentas
  de dos usuarios por olvidar un filtro, y pasarle las cuentas a otro usuario es cambiar a qué archivo
  apunta (`transferData`).
- **Migración de bases anteriores:** si `usuarios.db` está vacía y existe la base de siempre
  (`DB_PATH`), sus usuarios se copian como administradores (con el mismo id) apuntando a esa base.
  `report_notes` se rehace sin la clave foránea a `users` (los autores ahora viven en otra base). Las
  tablas `users`/`sessions` viejas quedan sin uso.

### 4.3 Autenticación y seguridad (`server/src/auth.ts`)

- **Contraseñas:** `scrypt` (N=2¹⁵) con *salt* aleatorio; se guarda `scrypt$N$r$p$salt$hash`.
  Comparación con `timingSafeEqual`. Mínimo 10 caracteres.
- **Sesión:** cookie `sb_session` (`HttpOnly`, `SameSite=Strict`, `Secure` en producción). En la base
  se guarda **solo el SHA-256 del token** (si se filtra el archivo, no sirve). Expira a los
  `SESSION_DAYS`; las sesiones vencidas se purgan al crear una nueva.
- **Límite de intentos:** `loginLimiter` bloquea por IP tras 10 fallos en 15 min (en memoria; suficiente
  para un solo servidor).
- **Roles:** `usuario` usa la app con sus cuentas; `admin` además gestiona a los usuarios que creó
  (`users.admin_id`) y puede ver sus cuentas (`users.view_user_id`). `requireAuth` deja en el pedido
  `user` (quién entró) y `owner` (de quién son las cuentas que ve); la vista elegida se valida en cada
  pedido, así que si el usuario se desactiva el administrador vuelve a las suyas.
- **CSRF:** además de `SameSite=Strict`, todo método no-GET debe traer el header
  `x-requested-with: syncbanks` (`server/src/app.ts:76`), que un formulario de otro sitio no puede
  enviar.

### 4.4 API (`server/src/app.ts`)

Todo pasa por `/api`. `requireAuth` protege el router. Las rutas de datos se arman una vez por base
(`dataRoutes(db)`) y cada pedido va a la base de su `owner`. Si la página manda `x-syncbanks-owner` con
otro dueño (un administrador que cambió de cuentas en otra pestaña), se rechaza con 409 para que no
edite por id en la base equivocada. Las rutas principales:

| Método y ruta | Qué hace |
|---|---|
| `POST /api/auth/login` · `logout` · `GET /auth/me` | Sesión (`me` dice rol y de quién son las cuentas que ve) |
| `GET/POST /api/admin/users` · `PUT /api/admin/users/:id/password` · `PUT .../active` | Administrador: sus usuarios |
| `PUT /api/admin/view` | Administrador: ver las cuentas de uno de sus usuarios (o las propias) |
| `GET /api/accounts` · `PATCH /api/accounts/:id` · `DELETE /api/accounts/:id` | Listar/editar cuentas (nombre, RUT, alias, cupo, calibrar línea) y eliminarlas con sus movimientos |
| `GET/POST/PATCH/DELETE /api/categories` | Categorías |
| `GET /api/movements` · `PATCH /api/movements/:id` · `POST /api/movements/bulk` | Listar (con muchos filtros) y editar movimiento(s) |
| `GET/POST/DELETE /api/rules` | Reglas por contraparte o texto |
| `GET /api/payees` · `PUT /api/payees/:rut` | Nombres de trabajadores (Pago Fácil) |
| `POST /api/imports` · `GET /api/imports` | Importar cartola (cuerpo binario) e historial. A un administrador, si la cuenta es nueva ahí pero ya está en otra de sus bases, le responde 409 `account-elsewhere`; con `x-import-anyway: 1` la importa igual |
| `GET /api/report` · `PUT /api/report-note` | Informe y comentario del informe |
| `GET /api/integrity` | Advertencias de saldos que no calzan |

Detalles de diseño: validación de entrada centralizada (`str`, `intOrNull`, `DATE`), errores como
`HttpError` que el middleware final traduce a `{ error }` con su código; el cuerpo del informe se
calcula en `buildReport`.

### 4.5 Dominio (`server/src/domain/`)

- **`classify.ts`** — Interpreta la descripción cruda de la cartola y decide el **tipo** de operación
  (`transfer_in/out`, `payroll`, `card_payment`, `credit_line`, `loan_payment`, `bank_fee`,
  `cheque`, `atm`, `other`) y la **contraparte** (nombre o RUT). Normaliza nombres y decide si dos
  nombres son la misma persona (la cartola corta a 45 caracteres, por eso compara prefijos).
- **`categorize.ts`** — Recalcula categoría/comentario de los movimientos **editados automáticamente**,
  con prioridad: traspaso interno detectado > reglas del usuario (la más nueva gana) > categoría de
  sistema según el tipo. Detecta **traspasos internos** pareando un cargo y un abono entre cuentas
  propias por nombre/RUT y monto, con hasta 3 días de diferencia (prefiere la fecha más cercana). Las
  ediciones **manuales no se pisan**, con una excepción: si un movimiento categorizado a mano resulta
  tener pareja en otra cuenta propia, pasa a *Traspaso interno* (conserva su comentario), porque si no la
  misma plata se contaría dos veces.
- **`importer.ts`** — Carga una cartola sin duplicar. Compara **día por día como multiconjunto** (hay
  movimientos idénticos legítimos y el archivo no trae un ID). Reconstruye el saldo por movimiento
  (Banco de Chile no lo trae) y **verifica** que cada saldo descargado calce; si no, avisa que falta
  una cartola. Maneja lo **provisorio** de BancoEstado: una cartola en línea nueva reemplaza a la
  anterior y una consolidada reemplaza lo provisorio de su período, traspasando las ediciones manuales
  (por día, sentido y monto).
- **`creditLine.ts`** — Sigue el uso de la línea de crédito desde la cuenta corriente: cada giro y
  amortización aparece en ambos lados, así que con un **punto de calibración** (cupo + disponible
  conocido) se calcula el uso hacia atrás. Una cartola de la línea solo sirve para calibrar.
- **`report.ts`** — Arma el informe: por cuenta y totales (apertura, cierre, entradas, gastos,
  traspasos internos, disponible = saldo + línea), las nóminas agrupadas y las advertencias de
  cobertura. Los traspasos internos y los movimientos de la línea **no cuentan** como ingreso ni gasto.

### 4.6 Parser (`server/src/parser/`)

- **`cartola.ts`** — `.txt` de Banco de Chile: ancho fijo de 121 caracteres en **latin-1** (decodifica
  el archivo tal cual, no con `windows-1252`). La cuenta va en los primeros 11 caracteres, así que el
  archivo se asocia solo a su cuenta. Las líneas de saldo/retención traen el saldo contable.
- **`bancoestado.ts`** — `.xlsx` de BancoEstado con dos formatos: *Cartola Histórica* (consolidada,
  numerada) y *Cartola en Línea* (provisoria). Ubica las columnas por el encabezado, reconoce hojas
  `Resumen` + `Movimientos`/`Registros`, y **cada fila trae su saldo**.
- **`detect.ts`** — `detectStatement` reconoce banco, producto y variante de un archivo por su
  **contenido** (título, columnas, nombre de hoja), con una "firma" por formato, y devuelve el número
  de cuenta o tarjeta si viene, la evidencia y si ya se puede importar. Cubre Banco de Chile, BancoEstado
  (empresa y persona, cuenta, línea y tarjeta) y Banco Falabella (cuenta, línea y CMR).
- **`creditCard.ts`** — tarjetas de crédito (CMR de Banco Falabella y BancoEstado por facturar) sobre la
  planilla que ya leyó `detect.ts`. Cada fila es una compra completa en su fecha (en BancoEstado, cuota ×
  número de cuotas); `sameCardPurchase` reconoce la misma compra cuando reaparece con otra redacción o
  fecha. La importación (`server/src/domain/creditCard.ts`) agrega solo las compras nuevas y confirma las
  de CMR que estaban por facturar.
- **`index.ts`** — `parseStatementFile`: lo que ya se importaba (Banco de Chile `.txt`, BancoEstado
  empresa) sigue por su lector, las tarjetas por `creditCard.ts` (devuelve `ParsedCard`, ver `isCard`) y
  los formatos reconocidos que aún no se importan responden qué son.

### 4.7 CLI (`server/src/cli/`)

Mismos módulos del dominio, usados desde consola: `addUser.ts` (crear administrador),
`setPassword.ts`, `transferData.ts` (pasar las cuentas de un usuario a otro), `importFiles.ts`
(importar cartolas a las cuentas de un usuario) y `backup.ts` (respaldo cifrado de todas las bases con
`VACUUM INTO`, que incluye el WAL y se puede correr con la app abierta).

## 5. Frontend

- **`web/src/api.ts`** — Cliente HTTP único. Agrega automáticamente el header CSRF en toda escritura,
  manda `credentials: 'same-origin'` y avisa a la app (`setUnauthorizedHandler`) ante un 401 para
  volver al login. Define los **tipos espejo** de lo que devuelve el server.
- **`web/src/router.ts`** — Router mínimo por **hash** (`#/informe?from=...`), sin dependencias.
- **`web/src/data.tsx`** — `DataProvider` (Context) carga una vez cuentas, categorías y comentarios, y
  expone `useFetch` para datos por pantalla (sin caché: vuelve a pedir cuando cambia la URL o al llamar
  `refresh`).
- **`web/src/App.tsx`** — Decide entre login y la app; arma la barra de navegación y monta la página
  según la ruta.
- **Páginas** (`web/src/pages/`): `LoginPage`, `ImportPage` (sube archivos), `MovementsPage` (lista
  filtrable y edición de categoría/comentario/nota), `PayrollPage` (nóminas por trabajador),
  `ReportPage` (las 4 hojas), `SettingsPage` (cuentas, categorías, reglas, trabajadores) y `UsersPage`
  (solo administradores: sus usuarios). En la barra, el administrador elige de quién son las cuentas
  que ve (`OwnerSelect`); al cambiar, la página se recarga entera.
- **Utilidades con tests** (`format`, `payroll`, `reportDetail`, `balances`) concentran la lógica de
  presentación (formato CLP/fechas, agrupación de nóminas, agrupación por categoría del informe, línea de
  tiempo del saldo).
- **`styles.css`** define el diseño; el informe usa `@media print` y `no-print` para que al imprimir
  salgan las 4 hojas, una por página.

## 6. Cómo se asegura que todo esté conectado

La integración entre las piezas se sostiene con varios mecanismos concretos:

1. **Un solo origen.** En producción Express sirve `web/dist` con *fallback* a `index.html` para
   cualquier ruta que no sea `/api` (`app.ts:408`). En desarrollo, Vite hace *proxy* de `/api` al
   backend. Así el navegador siempre habla con el mismo origen y las cookies de sesión funcionan.
2. **Contrato API ↔ UI.** Los tipos de `web/src/api.ts` son un **espejo manual** de lo que arma el
   server (`buildReport`, consultas de `app.ts`). Ambos lados compilan con `strict`, y correr
   `npm run typecheck` detecta cuando el contrato se desalinea.
3. **CSRF de punta a punta.** El cliente añade `x-requested-with: syncbanks` en cada escritura
   (`api.ts:23`) y el server lo exige en `/api` (`app.ts:76`). Los tests de API verifican que el
   server rechace una escritura sin el header.
4. **Verificación de datos en la carga.** Al importar se recalcula el saldo por movimiento y se
   compara con el saldo que trae cada cartola (`checkBalances`). Un descuadre genera una advertencia
   en el resultado de la importación (pantalla *Importar cartolas*) y en `GET /api/integrity`. El
   informe, aparte, avisa en pantalla (no en el PDF) cuando la cobertura de cartolas no alcanza el
   período. El **período real** del informe se deriva de los movimientos cargados, no del filtro, para
   que pantalla y PDF coincidan.
5. **Reprocesamiento consistente.** Tras cualquier cambio (importar, editar, borrar regla) se llama a
   `recategorize`, que recalcula todo lo automático respetando lo manual. Esto mantiene coherentes
   movimientos, informe e integridad aun cuando una carga nueva cambie la clasificación de otra cuenta
   (por ejemplo, al confirmarse un traspaso interno).
6. **Pruebas automatizadas como red.** El server se prueba con **Supertest** contra la app Express
   real y una base SQLCipher temporal (`server/test/helpers.ts` construye cartolas ficticias). La web
   prueba sus utilidades y la tarjeta de comentario del informe con Vitest + jsdom. `npm test` y `npm run typecheck` son el candado antes de
   dar por buena una tarea.
7. **Persistencia idempotente.** El esquema y las migraciones permiten abrir bases de cualquier versión
   anterior sin recrearlas, de modo que evolucionar el formato no “desconecta” datos existentes.

## 7. Modelo de datos

```
accounts ──< imports            (una cuenta tiene muchas importaciones)
accounts ──< movements          (una cuenta tiene muchos movimientos)
imports  ──< movements          (movimiento referencia la importación que lo trajo)
categories ──< movements        (categoría del movimiento; ON DELETE SET NULL)
categories ──< rules            (regla asigna categoría)
```

En `usuarios.db`:

```
users ──< sessions              (sesión de un usuario)
users ──< users                 (admin_id: el administrador que gestiona al usuario)
users ── data_file              (archivo con la base de sus cuentas)
```

`imports.user_id` y `report_notes.user_id` guardan quién importó o comentó (un id de `usuarios.db`,
sin clave foránea porque es otra base).

Notas clave de diseño:

- `movements.seq` = orden **dentro del día** (0 = el más reciente). Las fechas son `YYYY-MM-DD`
  (solo fecha contable, sin hora).
- `movements.category_source` (`auto`/`rule`/`manual`) y `label_source` (`rule`/`manual`) registran
  **por qué** un movimiento tiene esa categoría/comentario; lo `manual` es intocable por el recálculo.
- `movements.balance_after` y `credit_used_after` permiten reconstruir el saldo y el uso de la línea
  en cualquier momento; `provisional` marca lo que viene de una cartola en línea de BancoEstado.
- `accounts.kind` es `cuenta_corriente` o `tarjeta_credito`. Una tarjeta no tiene saldo (sus archivos no
  traen la deuda): `balance_after` queda vacío y el informe la deja fuera del saldo inicial y final, y
  suma `cardDebtChange` (compras − pagos) para que el resumen cuadre. `movements.installments` y
  `installment_amount` describen una compra en cuotas.
- `report_notes` guarda el comentario por `(scope, from_date, to_date)`: `scope` es `''` para todas las
  cuentas o los ids ordenados separados por coma, y el período es el **período real** del informe.

## 8. Seguridad (resumen)

- Base cifrada en disco (SQLCipher/AES-256); `DB_KEY` es la única llave.
- Contraseñas con `scrypt`; sesiones guardadas como hash; cookie `HttpOnly` + `SameSite=Strict`
  (+ `Secure` en producción); límite de intentos de login.
- Header anti-CSRF obligatorio en toda escritura + Helmet para cabeceras.
- Datos reales fuera del repositorio: `.env`, `data/`, `backups/`, `*.txt`, `*.xls`, `*.xlsx` están en
  `.gitignore`. Los tests usan datos ficticios.

## 9. Pruebas y verificación

```bash
npm run typecheck   # tsc --noEmit en server y web
npm test            # Vitest: server (supertest) + web (utilidades y componentes)
```

- **Server:** `parser`, `bancoestado`, `classify`, `creditLine`, `importer`, `report`, `detect`, `auth`,
  `api` (login, CSRF, importación, edición, informe y comentario de punta a punta) y `users` (cuentas
  separadas por usuario, roles, vista del administrador, traspaso y migración de bases anteriores).
- **Web:** `format`, `payroll`, `reportDetail`, `theme`, `ReportPage` (tarjeta de comentario) y
  `UsersPage`. Falta
  cobertura del resto de las páginas; ver [AGENTS.md](AGENTS.md).

## 10. Despliegue y operación

Multi-stage `Dockerfile`: una etapa compila la web (`web/dist`) y la final corre el server con Node 24,
sirviendo ese `dist`. La base vive en el volumen `/app/data`.

```bash
docker build -t syncbanks .
docker run -d -p 3001:3001 -v syncbanks-data:/app/data -e DB_KEY=... -e NODE_ENV=production syncbanks
docker exec -it <contenedor> npm run user:add -- <usuario>   # el primer administrador
```

La guía completa (Oracle Cloud *Always Free* + DuckDNS + Caddy) está en [DESPLIEGUE.md](DESPLIEGUE.md):
`compose.yaml` levanta la app sin puertos propios y Caddy delante, que obtiene y renueva el certificado.
`TRUST_PROXY=loopback, uniquelocal` hace que Express crea el `X-Forwarded-For` que pone Caddy (llega
por la red interna de Docker), así el límite de intentos de login es por IP real y no por la del proxy.

En producción debe ir detrás de HTTPS (el proxy reverso termina TLS). El respaldo se hace con
`npm run backup` (una carpeta con fecha en `backups/` con todas las bases cifradas), cuyo contenido se
sube a `data/` en el servidor.

## 11. Anexo — comandos

| Comando | Qué hace |
|---|---|
| `npm run setup` | Instala dependencias de raíz, server y web |
| `npm run dev` | API en :3001 + web en :5173 |
| `npm test` | Tests del server y de la web |
| `npm run typecheck` | `tsc --noEmit` en server y web |
| `npm run build` | Compila la web en `web/dist` |
| `npm start` | Levanta el server (sirve `web/dist`) |
| `npm run import -- <usuario> a.txt b.xlsx` | Importa cartolas desde la consola a las cuentas de un usuario |
| `npm run backup` | Respaldo cifrado de todas las bases en `backups/` |
| `npm run user:add -- <usuario>` | Crea un administrador |
| `npm run user:transfer -- <de> <a>` | Pasa todas las cuentas de un usuario a otro sin cuentas |
| `npm run user:password -- <usuario>` | Contraseña nueva (sin usuario, lista los existentes) |
