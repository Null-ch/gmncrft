#!/usr/bin/env bash
# Консоль сервера через RCON. Без аргументов - интерактивный режим (rcon-cli),
# с аргументами - одна команда и выход: bash scripts/console.sh whitelist add Nulls
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec mc rcon-cli "$@"
