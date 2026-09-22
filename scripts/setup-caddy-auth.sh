#!/usr/bin/env bash
# Генерирует bcrypt-хеш BACKUP_LINK_TOKEN для HTTP Basic Auth в Caddy и
# записывает его в .env как BASIC_AUTH_HASH. Запускать один раз при первой
# настройке домена и заново - при каждой смене BACKUP_LINK_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN="$(grep -E '^BACKUP_LINK_TOKEN=' .env | tail -n1 | cut -d= -f2-)"
if [[ -z "$TOKEN" ]]; then
  echo "BACKUP_LINK_TOKEN не задан в .env" >&2
  exit 1
fi

HASH="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$TOKEN")"

if grep -q '^BASIC_AUTH_HASH=' .env; then
  sed -i "s#^BASIC_AUTH_HASH=.*#BASIC_AUTH_HASH=${HASH}#" .env
else
  echo "BASIC_AUTH_HASH=${HASH}" >> .env
fi

echo "BASIC_AUTH_HASH обновлён в .env."
echo "Логин: mc / Пароль: значение BACKUP_LINK_TOKEN из .env"
echo "Дальше: docker compose up -d caddy"
