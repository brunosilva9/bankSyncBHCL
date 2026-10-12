# AGENTS.md

Guía para agentes que trabajan en este repositorio, y backlog único de tareas pendientes.
Mantener este archivo actualizado: es la fuente de verdad del trabajo futuro. El `README.md` es para
la persona que usa la app; **no** duplicar aquí su contenido, solo lo necesario para trabajar.

## Qué es SyncBanks

Vista global de los movimientos de cuentas de Banco de Chile y BancoEstado. Importa cartolas
(`.txt` de Banco de Chile, `.xlsx` de BancoEstado), categoriza y etiqueta movimientos, y genera un
informe en 3 hojas (resumen, entradas, gastos) listo para PDF.

- **Backend:** Node + Express + SQLite cifrado (SQLCipher vía `better-sqlite3-multiple-ciphers`).
- **Frontend:** React + Vite.
- **Tests:** Vitest en ambos.
- Todo el código, los comentarios y la UI están **en español**.

Detalle funcional (formatos de cartola, traspasos, línea de crédito, etc.) en [README.md](README.md).

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
| `npm run import -- a.txt b.xlsx` | Importa cartolas desde la consola |
| `npm run backup` | Respaldo cifrado de la base en `backups/` |
| `npm run user:add -- <usuario>` | Crea un usuario (pide contraseña, mínimo 10 caracteres) |

Antes de dar una tarea por terminada: `npm run typecheck` y `npm test` deben pasar.

## Estructura

```
server/src/
  app.ts            # rutas de la API (Express)
  auth.ts           # login scrypt, sesión por cookie, límite de intentos
  db.ts             # esquema SQLite y migraciones idempotentes (CREATE TABLE IF NOT EXISTS)
  config.ts         # lectura de .env (DB_KEY, PORT, DB_PATH...)
  index.ts          # arranque del server
  cli/              # addUser, importFiles, backup
  domain/           # importer, categorize, classify, creditLine, report
  parser/           # cartola.ts (Banco de Chile), bancoestado.ts, index.ts
server/test/        # tests Vitest con datos ficticios
web/src/
  api.ts            # cliente HTTP y tipos de la API
  App.tsx, router.ts, data.tsx
  pages/            # LoginPage, ImportPage, MovementsPage, PayrollPage, ReportPage, SettingsPage
  components/       # CategorySelect, LabelInput, RangePicker
  format.ts, payroll.ts, reportDetail.ts (+ sus .test.ts)
```

## Convenciones

- **ESM en el server:** los imports locales llevan extensión `.js` (`import { x } from './db.js'`),
  aunque el fuente sea `.ts`.
- **Base de datos:** el esquema se aplica con `CREATE TABLE IF NOT EXISTS`; al agregar una tabla o
  columna, agregarla también a `db.ts` de forma idempotente (no romper bases existentes).
- **Tests:** Vitest. Usar datos ficticios; nunca cartolas reales. Los helpers están en
  `server/test/helpers.ts`.
- **Fecha y dinero:** las fechas son `YYYY-MM-DD` (solo fecha contable, sin hora). No asumir que el
  orden dentro de un día coincide con la hora real salvo por `seq`.
- **Comentarios:** en español, explicando el *por qué* (reglas del banco, casos borde), no el *qué*.

## Reglas críticas (no romper)

- **Nunca commitear datos reales.** `.env`, `data/`, `backups/`, `*.txt`, `*.xls`, `*.xlsx` están en
  `.gitignore`. Los tests usan datos ficticios.
- **`DB_KEY`** es la única forma de abrir la base; si se pierde, los datos no se recuperan. No
  imprimirla ni loguearla.
- Toda escritura en la API exige el header `x-requested-with: syncbanks` (protección CSRF).
- Las ediciones manuales de categoría/etiqueta/nota **nunca** se pisan por las reglas automáticas.

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

- [ ] **Comentario del informe (nota por período y cuentas).** Backend listo (`report_notes` en
      `server/src/db.ts`, `GET /api/report` devuelve `note`, `PUT /api/report-note` la guarda; tests en
      `server/test/api.test.ts`). Tipos en `web/src/api.ts` (`ReportNote`, `NOTE_MAX`).
      **Falta:** la UI en `web/src/pages/ReportPage.tsx` para mostrar, editar (máx. `NOTE_MAX`
      caracteres) y borrar la nota, y su test.

### Pendiente

- [ ] **Verificar la consolidación de la cartola de BancoEstado (N° 041).** Confirmar con la cartola
      041 real cómo cambian los movimientos al consolidarse (descripción, N° de operación, fecha). Hoy
      se reemplazan por período y las ediciones manuales se traspasan por día, sentido y monto.
      Ver `TODO` en [server/src/domain/importer.ts](server/src/domain/importer.ts).
- [ ] **Cobertura de tests de la web:** hoy solo hay tests de utilidades (`format`, `payroll`,
      `reportDetail`); no hay tests de componentes/páginas.

### Hecho

- (vacío)

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
