# Despliegue: SyncBanks en un servidor gratis y seguro

Guía paso a paso para dejar la app en internet, con HTTPS, para entrar desde cualquier computador (por
ejemplo, la secretaria desde la oficina). Todo es **gratis**:

| Pieza | Qué hace | Costo |
|---|---|---|
| **Oracle Cloud "Always Free"** | El servidor (una máquina virtual Ubuntu en Santiago) | $0 (pide una tarjeta solo para verificar identidad) |
| **DuckDNS** | El nombre, p. ej. `tu-subdominio.duckdns.org` | $0 |
| **Caddy + Let's Encrypt** | El candado HTTPS, que se obtiene y se renueva solo | $0 |
| **Docker** | Corre la app y Caddy en el servidor | $0 |

```
Navegador ──HTTPS──▶ Caddy (puertos 80/443) ──red interna de Docker──▶ app (puerto 3001, no expuesto)
                                                                         └─ data/  (bases cifradas)
```

Los comandos de **tu computador** son de PowerShell (Windows). Los del **servidor** son de Linux y van
después de entrar con `ssh`. Donde dice `TU-IP` o `tu-subdominio`, pon los tuyos.

---

## 0. Antes de empezar

- [ ] Los cambios de esta guía (`compose.yaml`, `Caddyfile`, `deploy/`) están subidos a GitHub.
- [ ] Tienes tu **`DB_KEY`** guardada en un gestor de contraseñas. Está en el archivo `.env` de
      `C:\dev\SyncBanks`. **No la mandes por chat ni correo**: en el paso 7 se pega directo en el servidor.
- [ ] Sabes la contraseña de tu usuario administrador (si no: `npm run user:password -- tu-usuario`).

## 1. Cuenta de Oracle Cloud

1. Entra a <https://signup.cloud.oracle.com> y crea la cuenta (Free Tier).
2. **Región de origen: `Chile Central (Santiago)`.** Queda cerca de ustedes y **no se puede cambiar
   después**.
3. La tarjeta es solo para verificar. Puede aparecer una retención temporal de ~US$1 que se devuelve.
4. Activa la **verificación en dos pasos** de la cuenta (si no te la pide sola, en tu perfil → *Security*).
   Quien entra a esta cuenta controla el servidor.

## 2. Llave SSH en tu computador

La llave reemplaza a la contraseña para entrar al servidor (más segura: no se puede adivinar).

```powershell
ssh-keygen -t ed25519 -C "syncbanks-servidor"
```

Acepta la ubicación que propone y **ponle una frase de paso**. Después muestra la parte pública (esa sí
se puede compartir) y cópiala:

```powershell
Get-Content $HOME\.ssh\id_ed25519.pub
```

## 3. Crear el servidor

En la consola de Oracle: **Compute → Instances → Create instance**.

- **Name:** `syncbanks`
- **Image:** *Change image* → **Canonical Ubuntu 24.04**.
- **Shape:** *Change shape* → **Ampere → VM.Standard.A1.Flex**, **1 OCPU y 6 GB** de memoria. Sobra para
  la app y queda dentro del límite gratis (Oracle lo bajó en 2026 a 2 OCPU / 12 GB en total).
- **Networking:** crear una red nueva (VCN) con subred pública y **asignar IPv4 pública**.
- **Add SSH keys:** *Paste public keys* → pega la llave del paso 2.
- **Boot volume:** el que viene por defecto (~50 GB; el límite gratis es 200 GB).

Crea la instancia y anota su **IP pública**.

> **"Out of capacity"**: a veces no hay máquinas A1 libres. Reintenta en unas horas. Otra opción es
> **VM.Standard.E2.1.Micro** (también gratis, 1 GB de memoria): sirve, pero antes del paso 8 agrega
> memoria de intercambio (ver *Problemas comunes*).

## 4. Abrir los puertos web en Oracle

Oracle bloquea todo salvo SSH. En la instancia → **Subnet** → **Security** (o *Security Lists*) →
la *Default Security List* → **Add Ingress Rules**, tres reglas con *Source CIDR* `0.0.0.0/0`:

| Protocolo | Puerto destino | Para qué |
|---|---|---|
| TCP | 80 | Que Let's Encrypt verifique el dominio, y redirigir a HTTPS |
| TCP | 443 | La app (HTTPS) |
| UDP | 443 | HTTP/3 (opcional) |

## 5. El nombre en DuckDNS

1. Entra a <https://www.duckdns.org> con tu cuenta de Google o GitHub.
2. Crea un subdominio (p. ej. `tu-subdominio`) y en *current ip* pon la **IP pública** del paso 3 →
   *update ip*.
3. Copia el **token** que aparece arriba. Es secreto: con él se puede redirigir tu dominio.

## 6. Preparar el servidor

Entra desde PowerShell (la primera vez pregunta si confías en el servidor: `yes`):

```powershell
ssh ubuntu@TU-IP
```

Ya en el servidor:

```bash
# Sistema al día y hora de Chile (para que los respaldos de las 3:30 sean a las 3:30 de acá)
sudo apt update && sudo apt full-upgrade -y
sudo timedatectl set-timezone America/Santiago

# Firewall propio de la máquina: las imágenes de Oracle bloquean todo salvo SSH
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save

# Docker desde los paquetes de Ubuntu (reciben las actualizaciones de seguridad automáticas)
sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker ubuntu
```

Comprueba que el servidor solo acepta llaves (debe decir `passwordauthentication no`) y que las
actualizaciones de seguridad automáticas están activas (dos líneas con `"1"`):

```bash
sudo sshd -T | grep -E '^(passwordauthentication|permitrootlogin)'
cat /etc/apt/apt.conf.d/20auto-upgrades
```

Sal (`exit`) y vuelve a entrar con `ssh ubuntu@TU-IP`, para que tome el permiso de Docker.

## 7. Bajar la app y su configuración

```bash
git clone https://github.com/brunosilva9/bankSyncBHCL.git SyncBanks
cd SyncBanks
mkdir -p data backups
nano .env
```

En el editor escribe estas dos líneas. **La `DB_KEY` tiene que ser la misma de tu computador**: sin
ella las bases que vas a subir no se pueden abrir.

```
DB_KEY=la-misma-clave-de-tu-computador
DOMAIN=tu-subdominio.duckdns.org
```

Guarda (`Ctrl+O`, Enter, `Ctrl+X`) y deja el archivo legible solo por ti:

```bash
chmod 600 .env
```

## 8. Pasar los datos que ya tienes

En **tu computador**, en `C:\dev\SyncBanks`, genera un respaldo completo y súbelo:

```powershell
npm run backup
```

El comando dice la carpeta que creó, por ejemplo `backups\syncbanks-20261103-1200`. Súbela:

```powershell
scp -r backups\syncbanks-20261103-1200 ubuntu@TU-IP:
```

En el **servidor**, cópiala dentro de `data/`. Debe quedar `usuarios.db`, `syncbanks.db` y la carpeta
`bases/`:

```bash
cp -r ~/syncbanks-20261103-1200/. ~/SyncBanks/data/
ls -R ~/SyncBanks/data
rm -r ~/syncbanks-20261103-1200
```

> Hazlo **antes** de levantar la app por primera vez. Si ya la levantaste, primero
> `docker compose down` y borra `data/usuarios.db*` (la base vacía que creó).

**Desde aquí, la copia buena es la del servidor.** No sigas importando cartolas en tu computador: esa
copia queda solo como respaldo de hoy.

## 9. Levantar la app

```bash
cd ~/SyncBanks
docker compose up -d --build
docker compose logs -f
```

La primera vez arma la imagen (unos minutos). Espera `SyncBanks escuchando en http://localhost:3001` y,
de Caddy, `certificate obtained successfully`. Sal de los logs con `Ctrl+C` (la app sigue corriendo).

Abre **https://tu-subdominio.duckdns.org** y entra con tu usuario de siempre.

## 10. Respaldos automáticos y DuckDNS al día

Guarda el token de DuckDNS en un archivo que solo tú puedes leer:

```bash
nano ~/.duckdns-token     # pega el token, guarda y sal
chmod 600 ~/.duckdns-token
```

El cierre diario de las 02:00 (ver el README) lo hace la app sola y no necesita cron. Las dos tareas que
siguen sí: prográmalas con `crontab -e` (elige `nano` si pregunta) y agrega al final:

```
# Respaldo diario a las 3:30: backups/ con fecha, guarda 30 días
30 3 * * * sh $HOME/SyncBanks/deploy/respaldar.sh >> $HOME/respaldos.log 2>&1
# Que tu-subdominio siga apuntando a este servidor si cambia la IP
*/5 * * * * curl -fsS "https://www.duckdns.org/update?domains=tu-subdominio&token=$(cat $HOME/.duckdns-token)&ip=" > /dev/null 2>&1
```

Prueba el respaldo ahora mismo:

```bash
sh ~/SyncBanks/deploy/respaldar.sh && ls ~/SyncBanks/backups
```

**Copia los respaldos fuera del servidor** (si Oracle cierra la máquina, son lo único que queda). Una vez
por semana, en **tu computador**:

```powershell
scp -r ubuntu@tu-subdominio.duckdns.org:SyncBanks/backups C:\Respaldos\SyncBanks
```

Los respaldos van cifrados con la `DB_KEY`: sin ella no se pueden leer, y sin ella tampoco se pueden
restaurar.

## 11. Que Oracle no recupere el servidor

Oracle puede **reclamar** las máquinas gratis que pasan "ociosas" una semana (poco uso de CPU, red y
memoria), y esta app casi no consume. Para evitarlo:

1. **Billing → Upgrade and Manage Payment → Upgrade to Pay As You Go.** Lo gratis sigue siendo gratis;
   solo se cobra lo que pase de los límites gratis, y con 1 OCPU / 6 GB no se pasa.
2. **Billing → Budgets → Create Budget** de **US$1** con aviso a tu correo. Si algo empezara a cobrar, te
   enteras el mismo día.
3. Aunque no subas de plan, mantén la **copia semanal** del paso 10.

## 12. Acceso para la secretaria

En la app: **Usuarios → Nuevo usuario** (o el que ya creaste), y pásale la dirección
`https://tu-subdominio.duckdns.org`, su usuario y su contraseña (en persona o por un canal seguro). Si la
olvida, se la cambias en **Usuarios → Cambiar contraseña**.

## Actualizar la app

Cuando haya cambios nuevos en GitHub:

```bash
cd ~/SyncBanks
sh deploy/respaldar.sh            # respaldo antes de tocar nada
git pull
docker compose up -d --build
docker image prune -f             # borra las imágenes viejas
```

Los comandos de consola de la app se corren dentro del contenedor, por ejemplo:

```bash
docker compose exec app npm run user:password -- tu-usuario
docker compose exec app npm run user:add -- otro-admin
```

## Qué queda protegido

- **HTTPS obligatorio** con certificado de Let's Encrypt (Caddy redirige http → https). La cookie de
  sesión es `Secure`, `HttpOnly` y `SameSite=Strict`, y el navegador recibe HSTS (siempre HTTPS).
- **Solo 3 puertos abiertos:** 22 (SSH con llave, sin contraseñas), 80 y 443 (Caddy). La app no se puede
  alcanzar directo desde internet.
- **Límite de intentos de login por persona:** 10 fallos en 15 minutos bloquean esa IP, no a todos.
- **Bases cifradas en disco** (SQLCipher) y respaldos cifrados. Ojo: la `DB_KEY` vive en el `.env` del
  servidor, así que el cifrado protege copias y discos robados, no a alguien que tome control del
  servidor. Por eso importan la llave SSH con frase de paso y la verificación en dos pasos de Oracle.
- **Cada usuario ve solo sus cuentas** (una base por usuario); un administrador, solo las de sus usuarios.
- **Actualizaciones de seguridad automáticas** del sistema y de Docker (paquetes de Ubuntu).

Lo que depende de ti: la `DB_KEY` en un gestor de contraseñas (si se pierde, los datos no se recuperan),
la cuenta de Oracle con verificación en dos pasos, el token de DuckDNS y la llave SSH sin compartir.

## Restaurar desde un respaldo

Si hay que rehacer el servidor: pasos 3 a 7 en una máquina nueva, copiar el contenido de una carpeta
`syncbanks-AAAAMMDD-HHMM` dentro de `data/` (como en el paso 8), con **la misma `DB_KEY`**, y paso 9.
Si cambia la IP, actualízala en DuckDNS.

## Problemas comunes

- **La página no carga.** Revisa las reglas del paso 4 en Oracle y las del paso 6
  (`sudo iptables -L INPUT -n --line-numbers`: las de 80 y 443 deben estar antes del `REJECT`). Luego
  `docker compose ps` (los dos servicios `running`) y `docker compose logs caddy`.
- **Caddy no obtiene el certificado.** `nslookup tu-subdominio.duckdns.org` debe dar la IP del servidor,
  y el puerto 80 debe estar abierto. Caddy reintenta solo.
- **"No se pudo abrir la base de datos: DB_KEY incorrecta".** La `DB_KEY` del `.env` del servidor no es
  la misma de tu computador.
- **"Demasiados intentos. Espera 15 minutos."** Espera, o `docker compose restart app` (el contador vive
  en memoria).
- **La imagen no termina de armarse en la máquina de 1 GB (E2.1.Micro).** Agrega 2 GB de intercambio y
  repite el paso 9:

  ```bash
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```
