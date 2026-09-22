#!/usr/bin/env bash
# Подключение к консоли сервера через rcon-cli (интерактивный ввод команд).
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec mc rcon-cli
