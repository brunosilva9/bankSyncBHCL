# SyncBanks

Vista global de los movimientos de las cuentas de Banco de Chile: importa las cartolas `.txt`, categoriza y etiqueta cada movimiento, y genera un informe del tipo *"partimos el viernes con $X, entró $Y, salió $Z en esto, y quedamos con $W"*.

- **Backend:** Node + Express + SQLite cifrado (SQLCipher vía `better-sqlite3-multiple-ciphers`).
- **Frontend:** React + Vite.
- **Tests:** Vitest en ambos.

## Puesta en marcha

```bash
npm run setup                       # instala dependencias de la raíz, server y web
cp .env.example .env                # y completar DB_KEY (ver abajo)
npm run user:add -- <usuario>       # pide la contraseña (mínimo 10 caracteres)
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
| `npm run import -- a.txt b.xlsx` | Importa cartolas desde la consola |
| `npm run backup` | Respaldo completo y cifrado de la base en `backups/` |

## Cómo funciona

### La cartola `.txt`

Ancho fijo de 121 caracteres, en latin-1. La cuenta va en los primeros 11 caracteres de cada línea, así que el archivo se asocia solo a su cuenta (el nombre del archivo da lo mismo). Las tres primeras líneas traen las retenciones y el **saldo contable** al momento de la descarga. El detalle de las posiciones está en [server/src/parser/cartola.ts](server/src/parser/cartola.ts).

El `.txt` no trae el saldo de cada movimiento. Se reconstruye hacia atrás desde el saldo contable de la descarga más reciente. Comparado contra el `.xls` del banco, coincide en el 100% de las filas.

### Importar sin duplicar

Cada cartola trae los últimos ~45 días, así que se traslapan. Además el archivo no trae un ID por movimiento, y hay movimientos idénticos legítimos (dos pagos del mismo monto el mismo día). Por eso la carga compara **día por día como multiconjunto** y agrega solo lo que falta.

Al final se verifica que el saldo de cada cartola calce con los movimientos cargados. Si no calza, falta una cartola entre medio y se muestra una advertencia.

### Categorías, etiquetas y reglas

- **Categoría** (Sueldos, Proveedores, Oficina…): se asigna automáticamente cuando se puede (nómina, gastos bancarios, línea de crédito, traspasos internos) o a mano.
- **Etiqueta**: texto libre, por ejemplo «Gastos Pedro». Sirve para agrupar gastos que cruzan categorías.
- **Reglas**: al cambiar la categoría o la etiqueta de un movimiento, la app ofrece aplicarla a todos los de esa contraparte y a los de próximas cartolas. Las ediciones manuales nunca se pisan.

Se puede categorizar y etiquetar directamente desde el informe (hojas *Entradas* y *Gastos*, en pantalla; al imprimir no aparecen los controles de edición).

### Pago Fácil (nómina)

En la cartola aparece como una línea por trabajador (`Pago Fácil Bch: <RUT>`). La app las agrupa en un **lote de nómina** por día y cuenta. En *Configuración → Trabajadores* se le puede poner nombre a cada RUT.

### Traspasos internos

En *Configuración → Cuentas*, el campo «Aparece como» indica cómo se ve cada empresa en las cartolas de las otras. Un traspaso se marca como **Traspaso interno** solo si tiene su pareja en otra cuenta cargada: un cargo en una cuenta y un abono en la otra, el mismo día y por el mismo monto. Esos no cuentan como ingreso ni como gasto en la vista global.

Un traspaso desde o hacia una cuenta propia que no se carga (por ejemplo, otro banco) no tiene pareja, así que cuenta como ingreso o gasto normal y se identifica con una etiqueta. Así no hace falta importar más cuentas por uno o dos movimientos.

### Línea de crédito

La línea de crédito es otra cuenta en el banco, pero cada giro ("Transferencia Desde Linea De Credito", "Trasp.fondos A Ctacte-l.cred") y cada amortización ("Amortizacion A Linea De Credito") aparece también en la cuenta corriente. Por eso, con el **cupo** y un **punto de calibración**, el uso de la línea se sigue solo con la cartola de la cuenta corriente.

- En *Configuración → Cuentas* se define el cupo, y se puede calibrar escribiendo el disponible que muestra el banco (en la cartola Excel aparece como «Línea de Crédito»).
- También se puede calibrar importando la cartola `.txt` de la línea, descargada el mismo día que la de la cuenta corriente. Se reconoce sola y no carga movimientos. Su saldo incluye el sobregiro de la cuenta corriente, así que lo usado es |saldo línea| − sobregiro.
- El informe muestra el **disponible = saldo + línea disponible**. Girar o amortizar solo mueve plata entre la línea y la cuenta corriente, así que no cuenta como entrada ni como salida.

### BancoEstado

BancoEstado no entrega `.txt`. Se importan sus Excel (`.xlsx`), que traen el **saldo de cada movimiento**, así que no hay que reconstruirlo. Hay dos formatos y se reconocen solos:

- **Cartola histórica** (consolidada y numerada; ej. N° 040 = una semana): es la definitiva.
- **Cartola en línea** (provisoria): lo ocurrido desde la última consolidada. Sus movimientos quedan marcados como *provisorios*. Una cartola en línea nueva reemplaza a la anterior completa, y una consolidada reemplaza lo provisorio de su período. Las categorías, etiquetas y notas puestas a mano se traspasan al movimiento consolidado del mismo día, sentido y monto.

Las transferencias de BancoEstado traen el RUT de la contraparte («Transferencia otro banco a rut 11111111-1»). Por eso los traspasos internos también se parean por RUT, y las cuentas de una misma empresa (mismo RUT, en distintos bancos) comparten nombres y alias. Entre bancos distintos se acepta hasta 3 días de diferencia entre la salida y la llegada. Los envíos hechos por la banca en línea aparecen como «TRANSFERENCIA FONDOS INTERNET», sin contraparte; igual se reconocen y se parean cuando la otra cuenta nombra a la empresa que los emitió.

Un traspaso con pareja confirmada siempre se marca como interno, aunque antes se haya categorizado a mano (por ejemplo, cuando la otra cuenta aún no se cargaba). Si no fuera así, se contaría dos veces. La etiqueta se conserva.

### Fechas

El `.txt` y el `.xls` traen solo la fecha contable, sin hora. Lo que se hace después del horario de corte del banco, en fin de semana o feriado aparece con fecha del día hábil siguiente. El orden dentro de un mismo día sí es el real. Por eso los atajos de fecha del informe incluyen 7 días hacia adelante.

## Seguridad

- Base de datos cifrada en disco (SQLCipher, AES-256). Sin `DB_KEY` el archivo no se puede leer.
- Login con contraseña (scrypt), sesión en cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` en producción), con un límite de intentos fallidos.
- Toda escritura exige el header `x-requested-with: syncbanks`, como protección CSRF.
- Las cartolas (`*.txt`, `*.xls`), la base (`data/`) y el `.env` están en `.gitignore`. **Nunca se suben datos reales al repositorio**: los tests usan datos ficticios.

## Respaldo y traspaso al servidor

Todos los datos (movimientos, categorías, etiquetas, reglas, nombres de trabajadores y usuarios) viven en `data/syncbanks.db`, cifrada con `DB_KEY`. **No van a git.**

- `npm run backup` genera una copia completa y consistente en `backups/`, cifrada con la misma clave. Se puede correr con la app abierta.
- No basta con copiar `syncbanks.db` a mano: los cambios recientes quedan en `syncbanks.db-wal` hasta que SQLite los consolida.
- Para llevar los datos al servidor: `npm run backup`, subir ese archivo como `data/syncbanks.db` (en Docker, al volumen `/app/data`) y configurar allá **la misma `DB_KEY`**.

## Despliegue

```bash
docker build -t syncbanks .
docker run -d -p 3001:3001 -v syncbanks-data:/app/data -e DB_KEY=... -e NODE_ENV=production syncbanks
docker exec -it <contenedor> npm run user:add -- <usuario>
```

En producción el servidor debe ir detrás de HTTPS (proxy reverso, Caddy, o el que entregue el hosting). Con `NODE_ENV=production` la cookie de sesión solo viaja por HTTPS.

## Pendientes

- [ ] **BancoEstado, cartola consolidada que reemplaza a la cartola en línea:** verificar con la cartola N° 041 real cómo cambian los movimientos al consolidarse (descripción, N° de operación, fecha). Hoy se reemplazan por el período de la consolidada y las ediciones manuales se traspasan por día, sentido y monto. Ver `TODO` en [server/src/domain/importer.ts](server/src/domain/importer.ts).
