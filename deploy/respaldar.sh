#!/bin/sh
# Respaldo diario en el servidor (lo corre cron, ver DESPLIEGUE.md). Deja una carpeta con fecha en
# backups/ con todas las bases cifradas, y borra las de más de 30 días. Las copias siguen cifradas con
# DB_KEY: sirven fuera del servidor, pero solo con esa clave.
set -eu
cd "$(dirname "$0")/.."
docker compose exec -T app npm run backup --silent
find backups -mindepth 1 -maxdepth 1 -type d -name 'syncbanks-*' -mtime +30 -exec rm -rf {} +
