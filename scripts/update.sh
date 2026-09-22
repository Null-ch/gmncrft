#!/usr/bin/env bash
# Обновляет образы (itzg/minecraft-server, itzg/mc-backup) и пересоздаёт контейнеры.
# Чтобы обновить версию Forge - положите новый forge-*-installer.jar в корень репозитория,
# поменяйте FORGE_INSTALLER_FILE в .env, затем запустите этот скрипт.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose pull
docker compose up -d --force-recreate mc
docker compose logs -f mc
