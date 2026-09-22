#!/usr/bin/env bash
# Отправляет команду в консоль запущенного сервера через console.fifo.
# Использование: bash scripts/console.sh whitelist add Nulls
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -eq 0 ]]; then
  echo "Использование: $0 <команда...>   например: $0 op Nulls" >&2
  exit 1
fi

if [[ ! -p console.fifo ]]; then
  echo "console.fifo не найден - сервер ещё не запускался через systemd (scripts/setup-server.sh)?" >&2
  exit 1
fi

echo "$*" > console.fifo
