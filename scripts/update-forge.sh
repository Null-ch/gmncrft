#!/usr/bin/env bash
# Обновление версии Forge на VPS:
#   FORGE_FULL_VERSION=1.21.1-52.1.20 sudo -E bash scripts/update-forge.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $EUID -ne 0 ]]; then
  echo "Запустите с sudo -E: sudo -E bash scripts/update-forge.sh" >&2
  exit 1
fi

: "${FORGE_FULL_VERSION:?Укажите версию, например: FORGE_FULL_VERSION=1.21.1-52.1.20 sudo -E bash scripts/update-forge.sh}"

INSTALLER="forge-${FORGE_FULL_VERSION}-installer.jar"
echo "Скачиваю ${INSTALLER} ..."
curl -fsSL -o "$INSTALLER" \
  "https://maven.minecraftforge.net/net/minecraftforge/forge/${FORGE_FULL_VERSION}/${INSTALLER}"
chown minecraft:minecraft "$INSTALLER"

systemctl stop minecraft
sudo -u minecraft java -jar "$INSTALLER" --installServer
systemctl start minecraft

echo "Обновлено до Forge ${FORGE_FULL_VERSION}, сервис перезапущен."
echo "Логи: journalctl -u minecraft -f"
