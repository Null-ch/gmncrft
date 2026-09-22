#!/usr/bin/env bash
# Устанавливает Forge 1.21.1 в текущей директории и поднимает systemd-сервис.
# Запускать с sudo из корня репозитория на VPS (после install-java-ubuntu.sh):
#   sudo bash scripts/setup-server.sh
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Запустите с sudo: sudo bash scripts/setup-server.sh" >&2
  exit 1
fi

if ! id -u minecraft >/dev/null 2>&1; then
  echo "Пользователь 'minecraft' не найден. Сначала выполните: sudo bash scripts/install-java-ubuntu.sh" >&2
  exit 1
fi

# Версия используется только если forge-*-installer.jar не положен в репозиторий заранее
FORGE_FULL_VERSION="${FORGE_FULL_VERSION:-1.21.1-52.1.16}"

INSTALLER="$(ls forge-*-installer.jar 2>/dev/null | head -n1 || true)"
if [[ -z "$INSTALLER" ]]; then
  INSTALLER="forge-${FORGE_FULL_VERSION}-installer.jar"
  echo "forge-*-installer.jar не найден локально, скачиваю ${INSTALLER} ..."
  curl -fsSL -o "$INSTALLER" \
    "https://maven.minecraftforge.net/net/minecraftforge/forge/${FORGE_FULL_VERSION}/${INSTALLER}"
fi

chown minecraft:minecraft "$APP_DIR" -R

echo "Устанавливаю сервер из ${INSTALLER} (от имени пользователя minecraft) ..."
sudo -u minecraft java -jar "$INSTALLER" --installServer

echo "eula=true" | sudo -u minecraft tee "$APP_DIR/eula.txt" >/dev/null

if [[ ! -f "$APP_DIR/user_jvm_args.txt" ]]; then
  sudo -u minecraft tee "$APP_DIR/user_jvm_args.txt" >/dev/null <<'EOF'
# -Xms/-Xmx: начальный и максимальный размер кучи Java.
# Оставляйте системе минимум 1-1.5 ГБ сверху над этими значениями.
-Xms2G
-Xmx4G
EOF
fi

if [[ ! -f "$APP_DIR/server.properties" ]]; then
  sudo -u minecraft cp "$APP_DIR/server.properties.template" "$APP_DIR/server.properties"
  echo "server.properties создан из шаблона - проверьте motd/online-mode перед первым запуском."
fi

chmod +x "$APP_DIR/run.sh" 2>/dev/null || true
chown minecraft:minecraft "$APP_DIR" -R

sed "s#__APP_DIR__#${APP_DIR}#g" "$APP_DIR/systemd/minecraft.service.template" \
  > /etc/systemd/system/minecraft.service

systemctl daemon-reload
systemctl enable --now minecraft.service

echo
echo "Готово. Сервер установлен и запущен как systemd-сервис 'minecraft'."
echo "Логи:      journalctl -u minecraft -f"
echo "Консоль:   bash scripts/console.sh <команда>   (например: bash scripts/console.sh op Nulls)"
echo "Статус:    systemctl status minecraft"
