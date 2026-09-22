#!/usr/bin/env bash
# Делает архив мира в ./backups, предварительно отключая автосейв на время копирования.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p backups
ts="$(date +%Y%m%d-%H%M%S)"
out="backups/world-${ts}.tar.gz"

bash scripts/console.sh save-off
bash scripts/console.sh save-all flush
sleep 5

# level-name по умолчанию "world" (см. server.properties); архивируем world + Nether/End,
# если они существуют как отдельные папки (форматом world/DIM-1, world/DIM1 тоже ок).
tar -czf "$out" world 2>/dev/null

bash scripts/console.sh save-on

echo "Бэкап сохранён: $out"
