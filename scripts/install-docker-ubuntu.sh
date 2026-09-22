#!/usr/bin/env bash
# Установка Docker Engine + плагина Docker Compose на чистый Ubuntu VPS.
# Запускать один раз: sudo bash scripts/install-docker-ubuntu.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Запустите скрипт с правами root (sudo bash $0)" >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl gnupg ufw zip

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

# shellcheck disable=SC1091
. /etc/os-release
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker

if [[ -n "${SUDO_USER:-}" ]]; then
  usermod -aG docker "$SUDO_USER"
  echo "Пользователь $SUDO_USER добавлен в группу docker. Перелогиньтесь, чтобы применить."
fi

# Открываем порт Minecraft-сервера и link-server (бэкап/клиент-пак по токену) в файрволе
# (порт RCON 25575 наружу не открываем). Порт link-server берём из .env, если он уже
# лежит рядом со скриптом - иначе используем значение по умолчанию (8090).
BACKUP_SERVER_PORT="8090"
ENV_FILE="$(dirname "$0")/../.env"
if [[ -f "$ENV_FILE" ]]; then
  value="$(grep -E '^BACKUP_SERVER_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
  [[ -n "$value" ]] && BACKUP_SERVER_PORT="$value"
fi

ufw allow OpenSSH
ufw allow 25565/tcp
ufw allow "${BACKUP_SERVER_PORT}/tcp"
ufw --force enable

echo "Docker установлен и запущен. Firewall (ufw) активен, порты 25565/tcp и ${BACKUP_SERVER_PORT}/tcp открыты."
