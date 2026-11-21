# Plan: informes diarios automáticos

> **Propuesta del 19-11-2026; nada de esto está implementado.** Las tareas están en el backlog de
> [AGENTS.md](AGENTS.md). Cómo funciona la app hoy: [INFORME_TECNICO.md](INFORME_TECNICO.md).

## Resumen

- **Objetivo.** Que cada noche, sin que nadie haga nada, quede cerrado el día: el informe tal como se
  sabía a las 23:59, con una marca en los movimientos que el banco anotó en otro día. Si después el banco
  corrige algo (consolida, cambia la redacción o la fecha), el informe pasado no cambia en silencio: el
  cambio queda como **corrección** de ese cierre.
- **Tres ideas:**
  1. **Dos tiempos por movimiento:** la fecha contable que imprime el banco y el instante en que
     SyncBanks lo vio por primera vez. Si ya estaba en la descarga del 13 a las 23:59, pasó el 13 aunque
     el banco diga 14.
  2. **Un movimiento conserva su id para siempre.** Si el banco le cambia la redacción, la fecha o el N°
     de operación, se guarda una **versión** nueva en vez de borrarlo y volver a insertarlo. El recambio
     de nombre deja de ser una lista fija y pasa a ser un emparejamiento con puntaje, verificado con el
     saldo, que aprende alias.
  3. **El cierre es una foto con hora:** saldos observados, el informe del día congelado y un hash
     encadenado al cierre anterior. Con las versiones se puede rearmar "lo que se sabía al cierre del 13"
     para cualquier rango.
- **Programación.** El día D se cierra a las **02:00 de Chile del día D+1** (hora fija, decidida el
  20-11-2026), dentro del servidor, que revisa cada 5 minutos si ya pasó la hora y se pone al día si estuvo
  apagado. A las 02:00 no hay cambio de hora (en Chile es a medianoche). `npm run cierre` hace lo mismo a
  mano. **Hecho:** cierre, diario día por día y hitos (ver AGENTS.md).
- **El cuello de botella es traer las cartolas solas.** La vía oficial (Finanzas Abiertas) se postergó a
  julio de 2027. Hoy hay tres caminos: un agregador (Fintoc), un descargador automático del sitio del
  banco o los avisos por correo, y los tres tienen costo o riesgo (§3.7). Las fases 0 a 4 funcionan con la
  subida manual de hoy, así que se puede avanzar sin decidir eso todavía. **La clave del banco nunca va
  en el servidor de la app.**
- **Antes de empezar:** commitear el trabajo que no está en git (desde el 22 de octubre), parchar dos
  vulnerabilidades de dependencias y unificar la hora de Chile.

## 1. Cómo está hoy

- **Entrada de datos:** subida manual (web o `npm run import`). Lo único programado es el respaldo de las
  3:30 (`deploy/respaldar.sh`).
- **Identidad de un movimiento:** el archivo no trae id. El importador compara día por día como
  multiconjunto con la llave `sentido|monto|descripción|documento`
  ([importer.ts:45](server/src/domain/importer.ts#L45)). Si entre dos descargas el banco cambia la
  **fecha** de un movimiento, no calza y entra duplicado: el saldo lo avisa, pero no lo arregla. Si cambia
  la **redacción**, solo se reconoce lo que está en `SAME_MOVEMENT`
  ([importer.ts:42](server/src/domain/importer.ts#L42)). Con una descarga cada noche esto va a pasar
  seguido; ya pasa con el giro de la línea, que el mismo día sale con otra redacción.
- **Provisorio → consolidado (BancoEstado):** los provisorios se borran y se reinsertan
  ([importer.ts:246](server/src/domain/importer.ts#L246)), y las ediciones manuales se traspasan por día,
  sentido y monto ([importer.ts:261](server/src/domain/importer.ts#L261)). Cambian los ids; con dos montos
  iguales el mismo día, la edición puede caer en el otro, y lo que desaparece no deja rastro.
- **Cuatro emparejadores distintos,** cada uno con su tolerancia: el multiconjunto de las cuentas, el
  reemplazo de provisorios, `sameCardPurchase` para tarjetas
  ([parser/creditCard.ts:169](server/src/parser/creditCard.ts#L169)) y `findInternalPairs` para
  traspasos internos ([categorize.ts:76](server/src/domain/categorize.ts#L76)).
- **Hora:** las fechas no tienen hora; `imports.imported_at` y `movements.created_at` quedan en UTC
  (`datetime('now')`), y "hoy" se calcula con `toISOString()`, que también es UTC
  ([report.ts:180](server/src/domain/report.ts#L180), [bancoestado.ts:141](server/src/parser/bancoestado.ts#L141)).
  Desde las 20:00 o 21:00 de Chile, para ese código ya es mañana: un cierre de medianoche con esa lógica
  cerraría el día equivocado. La cartola de BancoEstado trae la hora de descarga y el lector la bota
  ([bancoestado.ts:82](server/src/parser/bancoestado.ts#L82)).
- **Informe:** se calcula al vuelo (`buildReport`). No queda registro de lo que se informó un día, y si
  llega un cambio, el informe pasado cambia sin aviso.

## 2. Cómo lo resuelven otros

| Quién | Cómo | Qué tomamos |
|---|---|---|
| **ISO 20022** (mensajería bancaria) | `camt.052` es el reporte intradía (provisorio) y `camt.053` la cartola de cierre. Cada movimiento trae estado `BOOK` (contabilizado) o `PDNG` (pendiente) y dos fechas: contable (`BookgDt`) y valor (`ValDt`). | Estados del movimiento y dos fechas. |
| **OFX** (Quicken, GnuCash) | Id por movimiento (`FITID`) y dos fechas: `DTPOSTED` (contable) y `DTUSER` (cuando lo hizo el cliente). GnuCash empareja lo importado por puntaje (monto, fecha, descripción), con umbrales. | Fecha real aparte de la contable; emparejar por puntaje. |
| **Plaid** | El pendiente sale en `removed` y el contabilizado entra en `added`, con `pending_transaction_id` apuntando al pendiente; entre ambos pueden cambiar el nombre y el monto. La sincronización entrega solo diferencias. | Cada carga como diferencia; enlazar versiones. |
| **Fintoc** (Chile) | `post_date` (contable, sin hora) y `transaction_date` (con hora; en una transferencia es cuándo se hizo: una del sábado puede salir con `post_date` lunes). `status`: `confirmed`, `processing` o `reversed`. El banco cambia movimientos "días o semanas" después y Fintoc conserva el id; avisa los cambios con webhooks. | Confirma que el cambio viene del banco. Si se usa Fintoc, su id y su hora resuelven buena parte. |
| **YNAB** | `import_id = YNAB:monto:fecha:ocurrencia` (la ocurrencia separa idénticos del mismo día). Empareja con lo ingresado a mano si el monto es igual y la fecha está a 10 días o menos. Conciliar contra el saldo del banco **bloquea** esos movimientos. | La ocurrencia (el multiconjunto ya lo hace) y el bloqueo al cerrar. |
| **Actual Budget** | Primero el id del banco; si no hay, mismo monto, beneficiario parecido y fecha cercana. Guarda el nombre tal como vino del banco aparte del que se muestra. | Descripción original y vigente por separado. |
| **Firefly III** | La importación automática entra por un endpoint apagado por defecto, que exige un flag, un secreto de 16 caracteres o más y una carpeta permitida; lo llama un cron. | Así debe ser la puerta de ingesta. |
| **hledger, Beancount** | Aserciones de saldo: "el día X el saldo era Y"; si no calza, error. | Cada cierre es una aserción de saldo. |
| **Modelo bitemporal** (Fowler; tablas temporales de SQL:2011) | Cada dato tiene "cuándo pasó" y "cuándo lo supimos"; se consulta "según lo sabido al día X". | Versiones y consultas "al cierre". |
| **Cierre contable** | Un período cerrado no se edita; lo que llega después es un ajuste visible. | Correcciones posteriores al cierre, a la vista. |

## 3. Diseño

### 3.1 Tres fotos distintas

| Foto | Qué guarda | Para qué | Hoy |
|---|---|---|---|
| **De la descarga** | El archivo tal como llegó y la hora en que se bajó | Prueba de qué decía el banco y cuándo; reprocesar si mejora un lector | No: se descarta |
| **Del cierre** | Saldos observados, informe del día congelado y hash | Lo que se informó, para compararlo con lo que se sabe después | No existe |
| **De la base** | Copia cifrada completa | Recuperarse de un desastre | Sí: `npm run backup` |

### 3.2 Dos tiempos por movimiento

- **Fecha contable:** la que imprime el banco (`movements.date`, como hoy). Manda la última versión,
  porque es la que cuadra con el saldo del banco.
- **Visto:** instante, en UTC, de la primera descarga que lo trajo (`first_seen_at`). Sale de la mejor
  hora disponible:
  1. la que anota el descargador automático;
  2. la que trae el archivo: BancoEstado anota fecha y hora de descarga; Banco de Chile, la fecha de la
     línea de saldo (solo el día, y hay que confirmar que siga siendo el de la descarga pasada la hora
     de corte);
  3. la hora de subida, que siempre sirve de cota, pero floja si se sube días después.
- **Fecha real:** cuándo pasó (`real_date`). La manual si la hay; si no, la que se deduce de cuándo se
  vio; si no, la contable. Se guarda de dónde salió (`real_date_source`).
- **Estado:** provisorio, contabilizado o **anulado** (era provisorio y el banco dejó de mostrarlo).

### 3.3 Fecha real y marcas

Regla base, válida siempre: **un movimiento no pudo pasar después de que se vio.**

| Caso | Ejemplo | Fecha real | Marca |
|---|---|---|---|
| La contable es posterior al día en que se vio | Dice 14 y ya estaba en la descarga del 13 a las 23:59 | 13 | **adelantado** |
| El banco le cambia la fecha entre descargas | 13 en la descarga de la noche, 14 en la del día siguiente | 13 (la contable vigente pasa a ser 14) | **movido 13 → 14** |
| La contable es anterior a cuando se vio | Compra del 10 que aparece recién el 13 | 10, la del banco | **tardío**: corrige el cierre del 10 |

- La contable vigente es la última que informa el banco: para sus libros y su saldo, "los siguientes son
  los reales". La fecha real no se pierde.
- Precisión: con una descarga a las 23:59, el error queda acotado a lo que pase entre esa descarga y la
  medianoche. Con hora exacta (`transaction_date` de Fintoc o el correo de aviso) no hay error.
- Se puede corregir a mano y, como con la categoría, lo automático nunca pisa lo manual.
- En pantalla: una insignia junto a la fecha ("↶ 13") con el porqué en el detalle, un filtro "solo
  movidos" y, en el informe, elegir **fecha contable** (cuadra con la cartola, como hoy) o **fecha real**
  (lo que pasó cada día).
- **Antes de programarlo, verificar con cartolas reales** qué fecha traen el movimiento y la línea de
  saldo en una descarga nocturna, y si ese saldo ya incluye lo hecho después de la hora de corte (fase 1).
  De eso depende con cuál de las dos fechas cuadra el saldo de cada cierre.
- *Hecho, sin esperar ese experimento:* el caso **adelantado** y la fecha que se conserva cuando el banco la
  cambia entre versiones (`server/src/domain/seen.ts`). Las cartolas ya cargadas confirman lo principal:
  Banco de Chile nunca fecha en sábado ni domingo, la línea de saldo lleva el día de la descarga aunque sea
  fin de semana, y su saldo casi siempre ya incluye lo fechado después. Informes, diario, listados y
  cierres van por fecha real por defecto (el cierre guarda también la foto por fecha contable) y se puede
  cambiar a la fecha contable. Faltan *tardío* y la corrección a mano.

### 3.4 Identidad estable, versiones y recambio de nombre

- **Un movimiento conserva su id.** Cada carga se trata como una diferencia contra lo ya cargado:
  iguales (solo se actualiza `last_seen_at`), modificados (versión nueva con lo que cambió), nuevos y
  desaparecidos.
- **`movement_versions`** guarda cada cambio: fecha, descripción, N° de documento u operación, saldo,
  estado, la carga que lo trajo y desde y hasta cuándo rigió. Solo se escribe cuando algo cambia.
- **Reconciliador único** (`server/src/domain/reconcile.ts`), por pasadas:
  1. **Exacta:** mismo día y misma llave, como hoy (con idénticos sigue la regla de emparejar de abajo
     hacia arriba).
  2. **Llave fuerte por banco:** BancoEstado trae el saldo de cada fila, así que sentido + monto + saldo
     después casi no se repite y resiste cambios de redacción, de N° de operación y de fecha (justo lo que
     falta saber de la cartola 041). Si el banco reordena el día, cambia el saldo por fila y esos pasan a
     la pasada siguiente. En Banco de Chile, el N° de documento de los cheques.
  3. **Difusa,** para lo que sobra: mismo sentido y monto, fecha a ±3 días y descripción parecida (alias
     conocido, misma contraparte o mismo tipo). Con puntaje; se acepta solo si hay un único candidato
     claro.
  4. **Verificación con el saldo:** después de aplicar, el saldo de la cartola debe calzar (como hoy en
     `checkBalances`). Si no calza, se deshacen las decisiones difusas de esa carga y se avisa.
  5. **Ambiguos** (dos candidatos igual de buenos): no se adivina. Van a *Por revisar*, donde el usuario
     dice "es el mismo" o "son distintos".
- **Alias aprendidos** (`description_aliases`): cada vez que se confirma "X ahora se llama Y", queda como
  alias de ese banco y la próxima vez calza en la pasada exacta. `SAME_MOVEMENT` queda como semilla.
- **Desaparecidos:** un provisorio que ya no viene queda **anulado** (`voided_at`): no se borra, no suma
  y se ve tachado. Si desaparece uno contabilizado, no se toca y se avisa. Solo cuenta como desaparecido
  lo que está dentro del rango que cubre el archivo; en Banco de Chile, el día más antiguo viene cortado.
- Las ediciones manuales quedan pegadas al id: ya no hace falta traspasarlas por día, sentido y monto.
- Después, tarjetas (`sameCardPurchase`) y traspasos internos (`findInternalPairs`) pasan al mismo
  puntaje.

### 3.5 Cierre diario

- **Qué guarda,** por usuario y por día de Chile: el instante del cierre; por cuenta, el último saldo
  observado, hasta cuándo hay datos y de qué fuente; el informe del día congelado (el JSON de
  `buildReport`); un hash de los movimientos incluidos (id y versión); el hash del cierre anterior, para
  que se note si alguien altera uno, y la versión de la app.
- **Cuándo se cierra el día D:** a las 02:00 de Chile del día D+1, siempre a la misma hora
  (`CIERRE_HORA`). Se anota la cobertura de cada cuenta (día de su última cartola): si alguna no tenía
  datos posteriores a D, el cierre lo dice, y lo que llegue después aparece como cambio. *Hecho*, sin la
  versión de cada movimiento: la huella es de lo que informa el banco (monto, glosa, saldo…), sin ids.
- **Correcciones:** toda carga posterior que cambie algo con fecha igual o anterior a D queda registrada
  contra el cierre de D: qué movimiento, qué cambió, antes, después y cuándo se supo.
- **Provisorio → definitivo:** el cierre queda definitivo cuando llega la consolidada que cubre ese día
  (BancoEstado) o pasan N días sin cambios. Banco de Chile no tiene consolidada, y según Fintoc los datos
  de una transferencia pueden cambiar hasta 5 días después. Una corrección sobre un cierre definitivo es
  una alerta.
- **Aserción de saldo,** como en hledger: saldo observado del cierre anterior + movimientos del día =
  saldo observado de este cierre. Si no calza, falta o sobra algo.
- **En pantalla,** una página *Cierres*: un calendario con el estado de cada día y, en cada uno, el informe
  "al cierre" (el congelado), el "actual" y la lista de correcciones. Un rango se arma con los cierres de
  sus días o se recalcula "según lo sabido" con las versiones. Las categorías y comentarios que se ven
  ahí son los de ahora; lo único congelado del todo es el JSON del cierre. *Hecho como página Diario*:
  un día por fila con saldos, cartolas (hitos: el saldo del banco y si cuadra con la cartola anterior) y
  estado del cierre; al abrir un día, la línea de tiempo y "al cierre" contra "ahora". Falta la lista
  de correcciones.

### 3.6 Programación y hora de Chile

- **`npm run cierre`** abre cada base de usuario y cierra todos los días pendientes, también los
  atrasados si el servidor estuvo apagado (hasta 31). Correrlo dos veces no duplica nada (`UNIQUE(day)`).
- **Dentro del servidor** (`server/src/scheduler.ts`): cada 5 minutos revisa si ya pasaron las 02:00 de
  Chile y cierra lo pendiente. Se descartó el cron cada 15 minutos que proponía la primera versión de este
  plan: así no hay que configurar nada en el servidor, funciona igual en el computador de desarrollo, y
  cerrar un día tarda milisegundos. La hora se decide con `Intl`, no con el reloj del sistema, y a las
  02:00 no hay cambio de hora: en Chile es a medianoche. El sábado 5 de septiembre de 2026 se pasó de las
  23:59 a la 01:00 (las 00:00 del domingo no existieron), y el sábado 3 de abril de 2027, a medianoche, el
  reloj vuelve a las 23:00 y esa hora se repite.
- **Toda fecha de Chile sale de un solo módulo** (`server/src/time.ts`) con `Intl` y la zona
  `America/Santiago`. Los instantes se guardan en UTC y los días como `YYYY-MM-DD` de Chile. El reloj se
  inyecta para poder probar el cambio de hora y el tramo de 21:00 a 24:00, cuando en UTC ya es el día
  siguiente. *Hecho* (falta guardar la hora de descarga de BancoEstado).
- **`job_runs`** registra cada ejecución (inicio, fin, resultado y qué cerró). La app muestra la última y
  avisa si falló.
- **Aviso diario** (opcional): un mensaje **sin montos** ("Cierre del 13 listo: 2 movimientos con fecha
  corregida; BancoEstado sin descarga desde el 12"), con el enlace y el hash del cierre, por correo o por
  ntfy. Mandar el PDF por correo es aceptar que montos y nombres viajen sin cifrado de punta a punta. Si
  hace falta el PDF automático: Chromium sin pantalla en un servicio aparte.

### 3.7 Traer las cartolas solas

| Camino | Qué resuelve | Riesgos y límites |
|---|---|---|
| **Agregador** (Fintoc; Floid es otro) | Descarga sola, id estable, hora de las transferencias, y avisa cambios y anulaciones. Fintoc cubre Banco de Chile (personas y empresas, 24 meses) y BancoEstado (personas y empresas, 12 meses), en cuentas corrientes y vista. | No cubre Banco Falabella ni tarjetas. La clave del banco se le entrega al agregador (en su widget). El servidor guarda una API key: si se filtra, permite leer movimientos y se puede revocar. Precio no publicado: hay que pedir cotización. |
| **Descargador automático** (un navegador sin pantalla, p. ej. Playwright, que entra al sitio del banco y baja la cartola) | Gratis; sirve para cualquier banco y producto, con los mismos archivos de hoy. | La clave del banco queda en el equipo que lo corre. Se rompe cuando el banco cambia su sitio y puede chocar con la segunda clave (app de autorización o clave dinámica). Hay que revisar las condiciones de uso de cada banco, y un banco puede bloquear entradas desde un datacenter. |
| **Avisos por correo** (comprobantes de transferencia y de compra) | Hora exacta, sin entregar la clave del banco. | No todo movimiento genera aviso y no traen saldo: complementan la fecha real, no reemplazan la cartola. Las plantillas cambian. Requiere una casilla dedicada, con acceso solo de lectura. |
| **Finanzas Abiertas** (Ley Fintec 21.521, NCG 514 modificada en 2026) | APIs reguladas, con consentimiento y sin compartir la clave. | Postergado a julio de 2027. |
| **Subida manual** (hoy) + cierres automáticos | Ningún riesgo nuevo; ya da cierres, correcciones y marcas. | La fecha real solo se deduce bien si se sube la misma noche. |

**Recomendación:** fases 0 a 4 con la subida manual. Para la 5, pedir cotización a Fintoc y probar a mano
si los bancos piden la segunda clave al entrar. Si Fintoc no conviene, el descargador va **fuera del
servidor de la app**, en un equipo siempre encendido en la oficina o en una segunda VM gratis de Oracle
sin puertos abiertos (el límite gratis de 2 OCPU / 12 GB alcanza para dos de 1 OCPU / 6 GB), y solo
puede *subir* archivos.

**Puerta de ingesta,** para el descargador o el agregador, como la de Firefly III: `POST /api/ingesta`,
apagada por defecto. Un **token por usuario** que solo permite importar a sus cuentas (no leer nada),
guardado como hash igual que las sesiones, revocable desde *Configuración*, con último uso y límites de
tamaño y de frecuencia. El pedido trae la hora de descarga (`x-observed-at`); el servidor anota además la
suya y usa la menor como cota.

### 3.8 Boceto del esquema

Los nombres se ajustan al implementar. Todo va idempotente en `db.ts`, como pide AGENTS.md, y el
relleno de datos con migraciones numeradas (fase 0).

```sql
-- Cuándo se bajó cada archivo, quién lo trajo y el archivo mismo (dentro de la base cifrada).
ALTER TABLE imports ADD COLUMN observed_at TEXT;   -- instante de la descarga, UTC
ALTER TABLE imports ADD COLUMN source TEXT;        -- web | cli | ingesta
ALTER TABLE imports ADD COLUMN file_sha256 TEXT;
CREATE TABLE import_files (import_id INTEGER PRIMARY KEY REFERENCES imports(id), bytes BLOB NOT NULL);

-- Lo vigente sigue en movements; se agregan los dos tiempos y el estado.
ALTER TABLE movements ADD COLUMN first_seen_at TEXT;
ALTER TABLE movements ADD COLUMN last_seen_at TEXT;
ALTER TABLE movements ADD COLUMN original_description TEXT;
ALTER TABLE movements ADD COLUMN voided_at TEXT;          -- anulado: provisorio que desapareció
ALTER TABLE movements ADD COLUMN real_date TEXT;
ALTER TABLE movements ADD COLUMN real_date_source TEXT;   -- banco | observada | manual

CREATE TABLE movement_versions (
  id INTEGER PRIMARY KEY,
  movement_id INTEGER NOT NULL REFERENCES movements(id),
  import_id INTEGER NOT NULL REFERENCES imports(id),
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  doc_number TEXT,
  balance_after INTEGER,
  provisional INTEGER NOT NULL,
  change TEXT NOT NULL,       -- nuevo | redaccion | fecha | documento | consolidado | anulado
  valid_from TEXT NOT NULL,   -- observed_at de la carga que trajo esta versión
  valid_to TEXT               -- NULL = vigente
);

CREATE TABLE description_aliases (
  bank TEXT NOT NULL, from_text TEXT NOT NULL, to_text TEXT NOT NULL,
  source TEXT NOT NULL,       -- semilla | auto | manual
  created_at TEXT NOT NULL,
  PRIMARY KEY (bank, from_text)
);

CREATE TABLE closings (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,   -- YYYY-MM-DD, día de Chile
  closed_at TEXT NOT NULL,    -- UTC
  status TEXT NOT NULL,       -- provisorio | definitivo
  coverage TEXT NOT NULL,     -- JSON por cuenta: último saldo observado, cuándo y de qué fuente
  report TEXT NOT NULL,       -- JSON del informe del día, tal como se entregó
  movements_hash TEXT NOT NULL,
  prev_hash TEXT,
  hash TEXT NOT NULL,
  app_version TEXT
);
CREATE TABLE closing_corrections (
  closing_id INTEGER NOT NULL REFERENCES closings(id),
  movement_id INTEGER NOT NULL REFERENCES movements(id),
  change TEXT NOT NULL, before TEXT, after TEXT, detected_at TEXT NOT NULL
);
CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, status TEXT, detail TEXT
);
```

## 4. Seguridad

**Bien hoy:** base cifrada (SQLCipher), contraseñas con scrypt, sesiones guardadas como hash, cookie
`SameSite=Strict` más el header anti-CSRF, Helmet, una base por usuario, contenedor sin root y sin puertos
propios, HTTPS con HSTS, SSH solo con llave y actualizaciones automáticas del sistema.

Lo que hay que resolver, de más a menos urgente:

1. **Dependencias con vulnerabilidades conocidas.** `npm audit --omit=dev` en `server/` (19-11-2026):
   `body-parser` 2.0.0–2.3.0, severidad alta (DoS con bytes extra después de un cuerpo comprimido,
   [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828)), y `qs` 6.7.0–6.16.0,
   moderada (DoS, [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw)). Las dos se
   arreglan con `npm audit fix`; la web no tiene hallazgos. Dependabot (gratis en un repositorio público)
   y `npm audit` en CI evitan que vuelva a pasar sin que nadie se entere.
2. **Lo automático suma secretos.** La `DB_KEY` ya vive en el `.env` del servidor: el cifrado protege
   discos y respaldos, no un servidor tomado (DESPLIEGUE.md lo advierte). No agregar ahí la clave del
   banco. Si se usa un agregador, su API key va en un archivo aparte que solo lee el servicio que la usa.
3. **La ingesta automática es una puerta nueva:** apagada por defecto y con un token de alcance mínimo
   (§3.7).
4. **Login.** Si el usuario no existe, no se calcula scrypt ([app.ts:101](server/src/app.ts#L101)): la
   respuesta es más rápida y delata qué usuarios existen. Hay que calcularlo igual contra un hash de
   relleno. El límite de intentos es solo por IP: agregar uno por usuario. TOTP para los administradores,
   que ven las cuentas de sus usuarios.
5. **No hay registro de auditoría.** No queda constancia de entradas, importaciones, cierres ni de cuándo
   un administrador ve las cuentas de otro. Tabla `audit_log` en `usuarios.db`: solo agregar, sin montos.
6. **Respaldos.** El diario queda en el mismo servidor y la copia fuera es un `scp` semanal a mano.
   Automatizar la copia fuera (los archivos ya van cifrados) y restaurar uno de prueba cada mes.
7. **Hashes viejos.** Las tablas `users` y `sessions` de antes quedaron sin uso en `data/syncbanks.db`,
   con los hashes de contraseñas antiguas. Borrarlas cuando se confirme que la adopción funcionó.
8. **Integridad de la historia:** hash encadenado de los cierres, y el hash de cada cierre en el aviso
   diario, que queda fuera del servidor.
9. **Repositorio público:** este plan, los tests y los ejemplos van con datos ficticios.

## 5. Deuda técnica

Línea base del 19-11-2026: `npm run typecheck` sin errores y `npm test` pasa (95 tests del server y 33 de
la web).

1. **Trabajo sin commit.** El último commit es del 22 de octubre: hay 33 archivos modificados (+978
   líneas) y 15 nuevos sin seguimiento (~1.500 líneas), con las cuentas por usuario, las tarjetas y el
   despliegue. Se puede perder, y el servidor se instala con `git clone` (DESPLIEGUE.md §7): lo que no
   esté en GitHub no llega.
2. **Sin CI.** Typecheck, tests y auditoría se corren a mano. Con cierres automáticos, una regresión del
   importador ensucia la historia sin que nadie mire. GitHub Actions es gratis en un repositorio público.
3. **Cuatro emparejadores distintos** (§1): pasan a un solo reconciliador (§3.4).
4. **Borrar y reinsertar provisorios:** pasa a versiones.
5. **UTC y hora de Chile mezclados** (§1): pasa a `server/src/time.ts`.
6. **Errores silenciosos en el lector de BancoEstado:** una fila cuya fecha no se entiende se salta sin
   aviso ([bancoestado.ts:109](server/src/parser/bancoestado.ts#L109)). Con descargas automáticas, un
   cambio de formato del banco perdería movimientos sin que nadie se entere: hay que contar las filas
   saltadas y avisar.
7. **Migraciones sin número.** `ADDED_COLUMNS` sirve para agregar columnas, no para rellenar datos (por
   ejemplo, `first_seen_at` a partir de `created_at`). Hacen falta migraciones numeradas con
   `PRAGMA user_version`, que corran solo al arrancar la app, con un test que abra una base de la versión
   anterior.
8. **Costo que crece con la historia.** `recategorize` recorre todos los movimientos en cada edición, y
   `findInternalPairs` compara cada cargo con todos los abonos
   ([categorize.ts:112](server/src/domain/categorize.ts#L112)). Con años de descargas diarias se va a
   notar: indexar por monto y recalcular solo los días afectados.
9. **`app.ts` de 600 líneas** con todas las rutas: separarlo por tema al agregar ingesta y cierres.
10. **Tipos de la API copiados a mano** en `web/src/api.ts`: con cierres y versiones crece el riesgo de
    que se desalineen.
11. **Tests de la web** (ya está en el backlog).

## 6. Fases

| Fase | Entrega | Depende de |
|---|---|---|
| 0. Base | Trabajo commiteado, dependencias al día, CI, hora de Chile, migraciones numeradas | — |
| 1. Identidad estable | Experimento con cartolas reales, versiones, reconciliador, alias, anulados, *Por revisar* | 0 |
| 2. Fecha real | Fecha real, marcas, informe por fecha real | 1 |
| 3. Cierres | Cierres diarios a las 02:00 y página *Diario* (hechos), correcciones, aserción de saldo, aviso | 1 (y 2 para el informe por fecha real) |
| 4. Seguridad desatendida | Login, auditoría, respaldo fuera del servidor, limpieza, rendimiento | 0; va antes de la 5 |
| 5. Ingesta automática | Fuente elegida, puerta de ingesta, descargador o agregador | 3 y 4 |

El detalle de cada tarea está en el backlog de [AGENTS.md](AGENTS.md).

## Fuentes

- Plaid, estados de una transacción: <https://plaid.com/docs/transactions/transactions-data/>
- Fintoc, el objeto Movement: <https://docs.fintoc.com/api/movements-api/movements/movements-object.md>;
  bancos y productos: <https://docs.fintoc.com/guides/movements/overview-data-aggregation/products-and-institutions-movements.md>
- YNAB, importación y emparejamiento: <https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo.md>;
  formato de `import_id`: <https://docs.rs/crate/ynab-api/4.0.0/source/docs/NewTransaction.md>
- Actual Budget, importar transacciones: <https://actualbudget.org/docs/transactions/importing>
- Firefly III, importación automática: <https://docs.firefly-iii.org/how-to/data-importer/import/automated/>
- hledger, aserciones de saldo: <https://hledger.org/hledger.html#balance-assertions>
- Martin Fowler, *Bitemporal History*: <https://martinfowler.com/articles/bitemporal-history.html>
- Finanzas Abiertas, postergación a julio de 2027: <https://chocale.cl/2026/06/finanzas-abiertas-en-chile-que-paso-con-los-plazos-y-que-viene-para-los-clientes/>;
  CMF: <https://www.cmfchile.cl/portal/principal/613/articles-100979_doc_pdf.pdf>
- Floid, términos y condiciones (piden las claves del banco): <https://floid.io/terminos-y-condiciones>
- Cambio de hora en Chile: <https://www.emol.com/noticias/Nacional/2026/09/05/1210638/cambio-de-hora-verano.html>,
  <https://www.reporteminero.cl/noticia/noticias/2026/08/cambio-de-hora-chile-2026-cuando-es-horario-de-verano-decreto-98>
