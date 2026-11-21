# SyncBanks

Vista global de los movimientos de las cuentas de Banco de Chile: importa las cartolas `.txt`, categoriza y comenta cada movimiento, y genera un informe del tipo *"partimos el viernes con $X, entró $Y, salió $Z en esto, y quedamos con $W"*.

- **Backend:** Node + Express + SQLite cifrado (SQLCipher vía `better-sqlite3-multiple-ciphers`).
- **Frontend:** React + Vite.
- **Tests:** Vitest en ambos.

## Puesta en marcha

```bash
npm run setup                       # instala dependencias de la raíz, server y web
cp .env.example .env                # y completar DB_KEY (ver abajo)
npm run user:add -- <usuario>       # crea un administrador; pide la contraseña (mínimo 10 caracteres)
npm run user:password -- <usuario>  # contraseña nueva si se olvidó (sin usuario, lista los que hay)
npm run dev                         # API en :3001, web en http://localhost:5173
```

Generar `DB_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> **La `DB_KEY` es la única forma de abrir la base.** Si se pierde, los datos no se recuperan. Hay que guardarla en un gestor de contraseñas.

Otros comandos:

| Comando | Qué hace |
|---|---|
| `npm test` | Tests del server y de la web |
| `npm run build` | Compila la web en `web/dist` |
| `npm start` | Levanta el server, que también sirve `web/dist` |
| `npm run import -- <usuario> a.txt b.xlsx` | Importa cartolas desde la consola, a las cuentas de ese usuario |
| `npm run backup` | Respaldo completo y cifrado de todas las bases en `backups/` |
| `npm run user:transfer -- <de> <a>` | Le pasa todas las cuentas de un usuario a otro que no tiene cuentas (ver *Usuarios y roles*) |
| `npm run detect -- <archivos o carpetas>` | Dice qué es cada archivo (banco, producto, cuenta) sin importar nada |
| `npm run check:real -- guardar\|comparar <carpetas>` | Red de seguridad con cartolas reales al cambiar los lectores (ver abajo) |

## Cómo funciona

### La cartola `.txt`

Ancho fijo de 121 caracteres, en latin-1. La cuenta va en los primeros 11 caracteres de cada línea, así que el archivo se asocia solo a su cuenta (el nombre del archivo da lo mismo). Las tres primeras líneas traen las retenciones y el **saldo contable** al momento de la descarga. El detalle de las posiciones está en [server/src/parser/cartola.ts](server/src/parser/cartola.ts).

El `.txt` no trae el saldo de cada movimiento. Se reconstruye hacia atrás desde el saldo contable de la descarga más reciente. Comparado contra el `.xls` del banco, coincide en el 100% de las filas.

### Importar sin duplicar

Cada cartola trae los últimos ~45 días, así que se traslapan. Además el archivo no trae un ID por movimiento, y hay movimientos idénticos legítimos (dos pagos del mismo monto el mismo día). Por eso la carga compara **día por día como multiconjunto** y agrega solo lo que falta.

Al final se verifica que el saldo de cada cartola calce con los movimientos cargados. Si no calza, falta una cartola entre medio y se muestra una advertencia.

### Categorías, comentarios y reglas

- **Categoría** (Sueldos, Proveedores, Oficina…): se asigna automáticamente cuando se puede (nómina, gastos bancarios, línea de crédito, traspasos internos) o a mano.
- **Comentario**: texto libre, por ejemplo «Gastos Pedro». Sirve para agrupar gastos que cruzan categorías.
- **Reglas**: al cambiar la categoría o el comentario de un movimiento, la app ofrece aplicarla a todos los de esa contraparte y a los de próximas cartolas. Las ediciones manuales nunca se pisan.

Se puede categorizar y comentar directamente desde el informe (hojas *Entradas* y *Gastos*, en pantalla; al imprimir no aparecen los controles de edición).

En la hoja *Gastos* va primero lo que no tiene categoría, para asignarla rápido. Después siguen las categorías, de la que suma más a la que suma menos. Cada categoría tiene su cabecera arriba y su subtotal abajo, y la hoja cierra con un **resumen por categoría** con el total de lo que salió (el total no se repite al pie de cada página). Al imprimir, la cabecera va siempre junto a sus primeros 4 movimientos: si no caben al final de la página, pasan juntos a la siguiente. Los avisos de cobertura de cartolas (por ejemplo, «la última cartola cargada llega hasta…») se ven en pantalla, pero no salen en el PDF.

### Saldo consolidado día a día

La hoja *Saldos* del informe (la segunda) muestra el saldo consolidado, es decir el total de las cuentas, al final de cada día del período: un gráfico, la lista día a día y el detalle día a día. Si el informe es de una sola cuenta, muestra el de esa cuenta. Con línea de crédito es el disponible (saldo + lo libre de la línea), como en el *Resumen*.

**Detalle día a día:**

- Cada día es una tarjeta con sus movimientos: cuenta, detalle con su comentario, categoría, lo que entró o salió y el **saldo relativo**, que es el consolidado después de ese movimiento.
- Debajo de cada día va otra tarjeta, **Saldo final por cuenta**: el saldo de cada cuenta al final del día y de qué cartola sale (cuándo se bajó o, si no se sabe, cuándo se subió; o «sin cartola ese día»). Con línea de crédito cuenta el disponible, como en el *Resumen*. La suma es el saldo del día. Sale en los días con movimientos o con alguna cartola.
- Cada tarjeta tiene su **Copiar imagen**, que copia su foto para pegarla en un chat o un correo. Si el navegador no deja copiar imágenes, la descarga como PNG.
- Al final de cada día van lo que entró, lo que salió y el saldo consolidado con que terminó.
- Cada nómina de Pago Fácil va en una línea.
- Los traspasos entre cuentas propias no suman ni restan: son un abono en una cuenta y un cargo en otra que se compensan.
  - Se muestran atenuados, con su monto y sin cambiar el saldo relativo. La casilla **Mostrar traspasos internos** los oculta, y el navegador recuerda la elección.
  - Lo que se ve en pantalla es lo que sale al imprimir.
  - Si en un día no se compensan (el otro lado quedó en otro día, o en una cuenta que no está en el informe), lo que queda va en una línea, que sí mueve el saldo.
- Los giros y amortizaciones de una línea de crédito calibrada no van, porque no cambian el disponible.
- El saldo relativo dentro del día es aproximado: el banco no da la hora, así que el orden entre cuentas no se sabe. Se calcula hacia atrás desde el saldo final del día, que es el real.
- Si los movimientos cargados no explican el cambio desde el día anterior, el día empieza con una fila «No cuadra con el día anterior».

**Gráfico:**

- Entre dos puntos la línea es recta: los movimientos no traen hora, así que no se sabe por dónde anduvo el saldo durante el día.
- El punto va **lleno** si ese día se descargó cartola de todas las cuentas y **vacío** si no. Un día sin cartola tiene el saldo que dan los movimientos, y por fecha real lo hecho ese día que el banco fechó después cuenta el día de la cartola siguiente (ver *Fechas*).
- Sábados y domingos van sombreados.
- Al pasar el mouse, o con las flechas con el foco en el gráfico, se ve el saldo de cada cuenta ese día y la hora de su cartola.
- **Copiar imagen** copia el gráfico con su título, las cuentas, el período y el resumen, para pegarlo en un chat o un correo. La imagen sale siempre en colores claros. Si el navegador no deja copiar imágenes (por ejemplo, con la app abierta por http en la red local), la descarga como PNG.
- El último saldo es el saldo final del *Resumen*; si no, la hoja lo avisa.

### Comentario del informe

En la hoja *Resumen* se puede escribir un **comentario por período y conjunto de cuentas** (hasta 500 caracteres), para anotar qué explica el resultado. Queda guardado para ese período y ese alcance de cuentas: el mismo rango visto con otra cuenta tiene su propio comentario. Sale impreso en el PDF del informe y en pantalla se puede editar o borrar.

### Diario y cierre de cada día

La página **Diario** muestra un día por fila, del más reciente al más antiguo, para todas las cuentas juntas o para una sola: saldo inicial, lo que entró y salió, saldo final y las **cartolas del día**, es decir, el saldo que informó el banco en cada cartola descargada ese día. Cada cartola se compara con la anterior de la misma cuenta: lo que según el banco cambió el saldo tiene que ser lo que suman los movimientos cargados entre ambas. Si cuadra sale ✓; si no, la diferencia (falta o sobra algún movimiento entre esas dos cartolas, por ejemplo porque no se cargó una).

Al abrir un día se ven:

- Sus movimientos en el orden del banco, con el saldo después de cada uno.
- Cada cartola justo después de su último movimiento, con la hora en que se descargó (si se sabe) y la hora en que se subió.
- Cada nómina de Pago Fácil en una línea, como en *Nóminas*: cuántos pagos, el total y el saldo después del último. Se abre para ver cada pago. Una nómina de un solo pago va como un movimiento más.
- Por fecha real (ver *Fechas*), lo hecho ese día que el banco fechó después va al final del día y suma, con «banco: lun 23». Lo que el banco fechó ese día pero es de antes se ve atenuado y sin sumar, con «se contó el vie 20».

La fila del día lo resume:

- «↷ 3 que el banco fechó después»: se hicieron ese día y el banco les puso una fecha posterior.
- «↶ 3 ya contados antes»: el banco los fechó ese día, pero se contaron el día en que se hicieron.

Desde ahí se abre el informe imprimible de ese día, de todas las cuentas o de cada una por separado.

**Copiar**, en cada cuenta del día abierto, copia el saldo inicial con su fecha, los movimientos con el saldo que deja cada uno (cada nómina en una línea) y el saldo final con su fecha. *Copiar el día, todas las cuentas* copia lo mismo de cada cuenta y al final el total. En un mensaje o un correo se pega como texto; en Excel, Google Sheets o Word, como tabla (Fecha, Detalle, Entró, Salió, Saldo). Las cartolas no se copian.

Lo que el banco fechó después lleva su fecha del banco («fecha del banco: lun 23»). Lo que se contó otro día va aparte, después del saldo final, con la fecha en que se contó: no mueve el saldo del día.

**Cierre automático.** Todos los días a las 02:00 (hora de Chile) el servidor cierra el día anterior: guarda el informe del día (general y de cada cuenta), sus movimientos y cartolas, y hasta qué día llegaban las cartolas de cada cuenta. El cierre va por fecha real y guarda también la versión por fecha del banco. Los cierres anteriores a la fecha real solo tienen la del banco, y el diario lo avisa. Un cierre no se reescribe. Si después se carga algo que cambia ese día (una cartola que llegó tarde, un movimiento que el banco cambió de fecha), el diario lo marca con *cambió después del cierre* y muestra lo que había al cierre junto a lo de ahora. Para que el cierre quede completo, la cartola del día tiene que estar cargada antes de las 02:00.

- Si el servidor estuvo apagado, al volver cierra los días que falten (hasta 31 hacia atrás). La primera vez solo cierra el día anterior: un cierre hecho hoy de un día pasado no sería lo que se sabía esa noche.
- `CIERRE_HORA` en `.env` cambia la hora (de 0 a 23); con `CIERRE_HORA=no` el servidor no cierra solo.
- `npm run cierre` hace lo mismo a mano. `npm run cierre -- AAAA-MM-DD` cierra un día puntual: queda como cierre tardío, con la hora en que se hizo.
- Cada cierre guarda el hash del anterior: si alguien altera uno directamente en la base, `npm run cierre` lo avisa.

### Pago Fácil (nómina)

En la cartola aparece como una línea por trabajador (`Pago Fácil Bch: <RUT>`). La app las agrupa en un **lote de nómina** por día y cuenta. En *Configuración → Trabajadores* se le puede poner nombre a cada RUT.

Cada nómina es un bloque de pagos seguidos en la cartola; si entre medio hay otro movimiento, son nóminas distintas. Si dos nóminas se cargaron una tras otra, la cartola no dice dónde termina una y empieza la otra: en *Nóminas* se abre la nómina y se usa **✂ Cortar aquí** en la última persona de la primera; las de abajo pasan a otra nómina (si hay más de dos, se corta de nuevo). **Unir con la de abajo** deshace el corte. El corte queda guardado, sobrevive a nuevas importaciones y se refleja en el informe.

### Traspasos internos

En *Configuración → Cuentas*, el campo «Aparece como» indica cómo se ve cada empresa en las cartolas de las otras. Un traspaso se marca como **Traspaso interno** solo si tiene su pareja en otra cuenta cargada: un cargo en una cuenta y un abono en la otra, el mismo día y por el mismo monto. Esos no cuentan como ingreso ni como gasto en la vista global.

Un traspaso desde o hacia una cuenta propia que no se carga (por ejemplo, otro banco) no tiene pareja, así que cuenta como ingreso o gasto normal y se identifica con un comentario. Así no hace falta importar más cuentas por uno o dos movimientos.

### Línea de crédito

La línea de crédito es otra cuenta en el banco, pero cada giro ("Transferencia Desde Linea De Credito", "Trasp.fondos A Ctacte-l.cred") y cada amortización ("Amortizacion A Linea De Credito") aparece también en la cuenta corriente. Por eso, con el **cupo** y un **punto de calibración**, el uso de la línea se sigue solo con la cartola de la cuenta corriente.

- En *Configuración → Cuentas* se define el cupo, y se puede calibrar escribiendo el disponible que muestra el banco (en la cartola Excel aparece como «Línea de Crédito»).
- También se puede calibrar importando la cartola `.txt` de la línea, descargada el mismo día que la de la cuenta corriente. Se reconoce sola y no carga movimientos. Su saldo incluye el sobregiro de la cuenta corriente, así que lo usado es |saldo línea| − sobregiro.
- El informe muestra el **disponible = saldo + línea disponible**. Girar o amortizar solo mueve plata entre la línea y la cuenta corriente, así que no cuenta como entrada ni como salida.

### BancoEstado

BancoEstado no entrega `.txt`. Se importan sus Excel (`.xlsx`), que traen el **saldo de cada movimiento**, así que no hay que reconstruirlo. Hay dos formatos y se reconocen solos:

- **Cartola histórica** (consolidada y numerada; ej. N° 040 = una semana): es la definitiva.
- **Cartola en línea** (provisoria): lo ocurrido desde la última consolidada. Sus movimientos quedan marcados como *provisorios*. Una cartola en línea nueva reemplaza a la anterior completa, y una consolidada reemplaza lo provisorio de su período.
  - Las categorías, comentarios y notas puestas a mano, y la fecha real, pasan al movimiento que reemplaza al provisorio.
  - Para encontrarlo se busca primero el de mismo sentido, monto y saldo después. Si no hay, el del mismo día, sentido y monto. Si tampoco, el de mismo sentido y monto a ±3 días, siempre que sea uno solo.
  - Así el reemplazo se encuentra aunque el banco cambie la redacción, el N° de operación o la fecha al consolidar.

Las transferencias de BancoEstado traen el RUT de la contraparte («Transferencia otro banco a rut 11111111-1»). Por eso los traspasos internos también se parean por RUT, y las cuentas de una misma empresa (mismo RUT, en distintos bancos) comparten nombres y alias. Entre bancos distintos se acepta hasta 3 días de diferencia entre la salida y la llegada. Los envíos hechos por la banca en línea aparecen como «TRANSFERENCIA FONDOS INTERNET», sin contraparte; igual se reconocen y se parean cuando la otra cuenta nombra a la empresa que los emitió.

Un traspaso con pareja confirmada siempre se marca como interno, aunque antes se haya categorizado a mano (por ejemplo, cuando la otra cuenta aún no se cargaba). Si no fuera así, se contaría dos veces. El comentario se conserva.

### Tarjetas de crédito

Se importan la **tarjeta CMR** de Banco Falabella (Excel de movimientos facturados y no facturados) y los **movimientos nacionales por facturar** de las tarjetas de BancoEstado. Cada tarjeta queda como una cuenta más, pero **sin saldo**: estos archivos no traen la deuda, solo movimientos.

- **Cada compra cuenta una vez, completa y en la fecha en que se hizo.** Una compra en cuotas vuelve a aparecer en cada estado de cuenta mientras se paga (con su fecha original) y entre "no facturados" y "facturados" cambia la redacción y hasta dos días la fecha; la app la reconoce como la misma compra (mismo comercio y monto, fecha cercana).
- **CMR:** lo no facturado queda *provisorio* y se confirma (con la redacción y fecha del banco) al importar el estado de cuenta facturado. Las filas con valor cuota 0 (p. ej. "aceleración de capital") no son un cargo nuevo y no se cargan. La CMR no trae número: cada usuario tiene una sola tarjeta CMR. Las compras de una tarjeta adicional llevan "(adicional)".
- **BancoEstado:** solo informa la cuota ("10-12 CUOTA"), así que el total de una compra en cuotas se calcula como **cuota × número de cuotas** (incluye los intereses de la cuota).
- **Pagar la tarjeta** y los **avances transferidos a una cuenta** son *Traspaso interno*: es plata propia que cambia de lugar. Comisiones, impuestos e intereses van a *Gastos bancarios*. Un avance en efectivo cuenta como un giro.
- **En el informe** las compras con tarjeta son gasto. Como la tarjeta no tiene saldo, el resumen agrega *Quedó por pagar en tarjetas* (compras menos pagos del período), para que saldo inicial, entradas, salidas y saldo final sigan cuadrando.

### Otros bancos y productos

La app reconoce qué es cada archivo por su **contenido**, no por el nombre: banco, producto (cuenta corriente, línea de crédito, tarjeta de crédito) y, si el archivo lo trae, el número de cuenta o los últimos dígitos de la tarjeta. Hoy se reconocen, pero **todavía no se importan**:

- **BancoEstado persona:** cartola histórica y últimos movimientos de cuenta corriente (traen el número de cuenta) y línea de crédito (trae su número y la cuenta asociada).
- **Banco Falabella:** `.xls` de cuenta corriente y de línea de crédito. **No traen número de cuenta.**
- **Banco de Chile:** el `.xls` antiguo (se recomienda el `.txt`).

Al subir uno de estos archivos, la app responde qué reconoció. Las cartolas en PDF y los `.txt` de otros bancos sin datos de la cuenta no se reconocen.

### Fechas

El `.txt` y el `.xls` traen solo la fecha contable, sin hora. Lo que se hace después del horario de corte del banco, en fin de semana o feriado aparece con fecha del día hábil siguiente, aunque ya salga en la cartola de ese mismo día: una transferencia del sábado ya está en la cartola del sábado, pero con fecha del lunes. El orden dentro de un mismo día sí es el real. Por eso los atajos de fecha del informe incluyen 7 días hacia adelante.

**Fecha real (por defecto).** Cada movimiento recuerda el día, y la hora de descarga si se sabe, de la primera cartola que lo trajo. Si ese día es anterior a la fecha del banco, es su fecha real. Toda la app va por fecha real: el *Diario*, el informe, *Movimientos*, *Nóminas*, *Copiar* y el cierre de las 02:00. Lo hecho el viernes en la noche cuenta el viernes, aunque el banco lo feche el lunes.

- Junto a la fecha va la del banco: **banco: lun 23**.
- Los saldos cuadran con la cartola: al descargarla, el banco ya descuenta lo que fechó después. El saldo final del viernes es el que informa la cartola del viernes en la noche.
- El selector **Fechas** (*Reales* / *Del banco*), en cada página, cambia a la fecha del banco: la de las cartolas día a día y la de su cuadratura oficial, por ejemplo a fin de mes. Por fecha del banco, la insignia es **↶ vie 20** (el día en que pasó) y en el *Diario* ese día lo muestra atenuado, sin sumar. El navegador recuerda la elección.
- En *Movimientos*, **Solo los que el banco fechó después** los muestra todos juntos.

- La fecha real no se pierde cuando el banco cambia la redacción (el giro de la línea de crédito), consolida un movimiento (la cartola en línea de BancoEstado) o le cambia la fecha (una compra «no facturada» que el estado de cuenta fecha un día después). Queda la más temprana que se conoce y la insignia lo explica.
- **Hora de descarga:**
  - BancoEstado la anota en la hoja Resumen.
  - Para Banco de Chile se usa la fecha de modificación del archivo, que manda el navegador, si es del mismo día que la cartola.
  - Si ninguna sirve, se usa la hora de subida, también solo si es del mismo día que la cartola.

  Conviene subir la cartola recién bajada, el mismo día.
- La fecha real es una cota: la app sabe que algo pasó antes de la cartola que lo trajo, no cuándo. Si después de la del viernes en la noche la siguiente se baja el domingo en la noche, todo lo de entre medio queda como del domingo. Si se baja recién el lunes temprano, queda como del lunes y sin insignia, porque la fecha del banco y el día en que apareció coinciden: se ve igual que lo hecho el lunes. Con una descarga cada noche, fines de semana incluidos, el error es de horas.
- **Corregirla a mano:** en *Movimientos*, con *Fechas: Reales*, la fecha de cada movimiento es un selector con los días en que pudo pasar.
  - Lo más temprano es el día hábil anterior a la fecha del banco: para un martes, el lunes; para un lunes, el viernes, el sábado o el domingo. Los feriados no se conocen, así que cuentan como días hábiles.
  - Las cartolas lo acotan. No pudo pasar antes de la última descarga de esa cuenta en que todavía no aparecía: ese mismo día sí, más tarde. Tampoco después de la primera que ya lo traía. Si ya estaba en la del sábado, es del sábado o de antes. Si apareció recién el lunes temprano y la descarga anterior fue el sábado, pudo ser el sábado (después de esa descarga), el domingo o el lunes.
  - Al pasar el mouse sobre la fecha se ve entre qué cartolas quedó, con sus horas. Si hay un solo día posible, la fecha va sin selector.
  - Una nómina cambia de día entera. En un traspaso entre cuentas propias, cada lado se corrige en su cuenta.
  - Lo elegido se mantiene al subir más cartolas, salvo que una muestre que el movimiento ya existía antes: entonces vale esa.
- Las bases anteriores a esta función se completan solas al abrir la app, a partir de las cartolas ya cargadas.

## Usuarios y roles

Cada usuario tiene **sus propias cuentas**: sus cartolas, movimientos, categorías, reglas, comentarios y trabajadores. Nadie ve las cuentas de otro.

- **Usuario:** usa la app completa con sus cuentas.
- **Administrador:** además, en **Usuarios**, crea a sus usuarios, les cambia la contraseña y los desactiva (sin borrar sus cuentas). Puede **ver las cuentas de cada uno tal como las ve él** y trabajar en ellas: con «Ver sus cuentas» o con el selector *Cuentas de* junto a su nombre. Lo que importe o comente ahí queda en las cuentas del usuario, firmado con su propio nombre.

Los administradores se crean por consola (`npm run user:add -- <usuario>`); los usuarios, cada administrador desde la app.

Cuando el administrador está viendo las cuentas de un usuario, *Importar cartolas* lo dice. Si importa una cuenta que no está en esas cuentas pero sí en las de otro de sus usuarios (o en las suyas), la app pregunta antes de crearla: lo más probable es que se haya equivocado de usuario. Si de verdad corresponde, *Importar igual*.

Una cuenta importada por error se elimina en **Configuración → Cuentas → Eliminar cuenta**, con sus movimientos e importaciones (sus cartolas se pueden volver a importar donde corresponde). Las categorías, reglas y nombres de trabajadores no se tocan.

Para entregarle a otro usuario las cuentas que ya tiene uno (por ejemplo, las que cargó el administrador a la persona que las va a llevar): crear al usuario en la app y correr `npm run user:transfer -- <de> <a>`. Pasan completas, con todo su historial; quien las tenía queda sin cuentas y, si es su administrador, queda viéndolas.

Las bases que vienen de antes de los usuarios se adaptan solas al iniciar: sus usuarios pasan a ser administradores y siguen viendo las mismas cuentas.

## Seguridad

- Base de datos cifrada en disco (SQLCipher, AES-256). Sin `DB_KEY` el archivo no se puede leer.
- Login con contraseña (scrypt), sesión en cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` en producción), con un límite de intentos fallidos.
- Toda escritura exige el header `x-requested-with: syncbanks`, como protección CSRF.
- Cada usuario tiene su propia base cifrada: una consulta no puede mezclar cuentas de dos usuarios. Un administrador solo ve las de los usuarios que él creó.
- Las cartolas (`*.txt`, `*.xls`), la base (`data/`) y el `.env` están en `.gitignore`. **Nunca se suben datos reales al repositorio**: los tests usan datos ficticios.

## Cambiar los lectores sin romper lo que funciona

Además de los tests (con datos ficticios), hay una comprobación con **cartolas reales** que nunca sale del computador:

```bash
npm run check:real -- guardar  C:/ruta/descargas C:/otra/carpeta   # antes de tocar los lectores
npm run check:real -- comparar C:/ruta/descargas C:/otra/carpeta   # después
```

`guardar` pasa cada archivo por el lector actual y guarda un resumen en `data/` (fuera de git). `comparar` avisa si algún archivo que ya se leía cambió en algo: cuenta, saldo, fechas o movimientos.

## Respaldo y traspaso al servidor

Todo vive en la carpeta `data/`, cifrado con `DB_KEY`, y **no va a git**: `usuarios.db` (usuarios, roles y sesiones) y una base por usuario con sus cuentas (en `data/bases/`; en instalaciones de antes de los usuarios, la primera es `data/syncbanks.db`).

- `npm run backup` genera una copia completa y consistente de todas las bases en una carpeta con fecha dentro de `backups/`, cifradas con la misma clave. Se puede correr con la app abierta.
- No basta con copiar los `.db` a mano: los cambios recientes quedan en los `-wal` hasta que SQLite los consolida.
- Para llevar los datos al servidor: `npm run backup`, subir el contenido de esa carpeta a `data/` (en Docker, al volumen `/app/data`) y configurar allá **la misma `DB_KEY`**.

## Despliegue

Paso a paso para dejarla en internet, gratis y con HTTPS (Oracle Cloud *Always Free* + DuckDNS + Caddy): **[DESPLIEGUE.md](DESPLIEGUE.md)**.

En resumen, en el servidor y con un `.env` que tenga `DB_KEY` y `DOMAIN`:

```bash
docker compose up -d --build                                # app + Caddy (HTTPS automático)
docker compose exec app npm run user:add -- <usuario>       # el primer administrador, si no traes datos
```

`compose.yaml` deja la app sin puertos propios, detrás de Caddy, y le indica (`TRUST_PROXY`) que crea la IP que informa Caddy, para que el límite de intentos de login sea por persona. Con `NODE_ENV=production` la cookie de sesión solo viaja por HTTPS.

## Pendientes

- [ ] **BancoEstado, cartola consolidada que reemplaza a la cartola en línea:** verificar con la cartola N° 041 real cómo cambian los movimientos al consolidarse (descripción, N° de operación, fecha). Hoy se reemplazan por el período de la consolidada y las ediciones manuales se traspasan por día, sentido y monto. Ver `TODO` en [server/src/domain/importer.ts](server/src/domain/importer.ts).
