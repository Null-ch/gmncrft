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

# Открываем порт Minecraft-сервера и HTTP/HTTPS для caddy (бэкап/клиент-пак по домену)
# в файрволе. Порт RCON 25575 и внутренний порт link-server наружу не открываем -
# снаружи к link-server можно достучаться только через caddy.
ufw allow OpenSSH
ufw allow 25565/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "Docker установлен и запущен. Firewall (ufw) активен, порты 25565/tcp, 80/tcp и 443/tcp открыты."
