#!/bin/sh
# Считает bcrypt-хеш DOWNLOAD_PASSWORD прямо в контейнере при старте и передаёт его
# Caddy как переменную окружения текущего процесса. Хеш (полный "$"-синтаксис bcrypt)
# никогда не попадает в .env/docker-compose.yml - там его подстановка "$..." ломает
# (Docker Compose сам интерпретирует "$" в .env как ссылку на переменную).
set -eu

if [ -z "${DOWNLOAD_PASSWORD:-}" ]; then
  echo "DOWNLOAD_PASSWORD не задан" >&2
  exit 1
fi

export HASHED_PASSWORD="$(caddy hash-password --plaintext "$DOWNLOAD_PASSWORD")"

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
