#!/usr/bin/env bash
# Обновляет образы (itzg/minecraft-server, itzg/mc-backup) и пересоздаёт контейнеры.
# Чтобы обновить Minecraft/Fabric - положите новый fabric-server-*.jar в корень репозитория,
# поменяйте FABRIC_LAUNCHER_FILE и MC_VERSION в .env, затем запустите этот скрипт.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose pull
docker compose up -d --force-recreate mc
docker compose logs -f mc
