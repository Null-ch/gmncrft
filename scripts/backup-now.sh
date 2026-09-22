#!/usr/bin/env bash
# Форсирует немедленный бэкап (обычно бэкапы идут по расписанию BACKUP_INTERVAL).
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec backup backup-now
