#!/usr/bin/env bash
# Установка Java 21 (Eclipse Temurin) + базовая настройка firewall на чистом Ubuntu VPS.
# Forge 1.21.1 требует Java 21. Запускать один раз: sudo bash scripts/install-java-ubuntu.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Запустите скрипт с правами root (sudo bash $0)" >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl gnupg ufw

# Eclipse Temurin репозиторий - в стандартных репах Ubuntu 22.04 нет пакета Java 21
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public -o /etc/apt/keyrings/adoptium.asc
chmod a+r /etc/apt/keyrings/adoptium.asc

# shellcheck disable=SC1091
. /etc/os-release
echo \
  "deb [signed-by=/etc/apt/keyrings/adoptium.asc] https://packages.adoptium.net/artifactory/deb \
  ${VERSION_CODENAME} main" > /etc/apt/sources.list.d/adoptium.list

apt-get update
apt-get install -y temurin-21-jre

# Выделенный системный пользователь для сервера (без домашнего логина)
if ! id -u minecraft >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /opt/minecraft --shell /usr/sbin/nologin minecraft
  echo "Создан системный пользователь minecraft"
fi

ufw allow OpenSSH
ufw allow 25565/tcp
ufw --force enable

echo "Java 21 установлена: $(java -version 2>&1 | head -n1)"
echo "Firewall (ufw) активен, порт 25565/tcp открыт."
