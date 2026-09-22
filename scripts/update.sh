#!/usr/bin/env bash
# Обновляет образы (itzg/minecraft-server, itzg/mc-backup) и пересоздаёт контейнеры.
# Версии Minecraft/Forge задаются в .env (MC_VERSION, FORGE_VERSION) - меняйте их,
# затем запускайте этот скрипт.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose pull
docker compose up -d
docker compose logs -f mc
