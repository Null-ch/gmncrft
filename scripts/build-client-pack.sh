#!/usr/bin/env bash
# Собирает client-pack.zip (Forge-инсталлятор + моды + инструкция) для раздачи через
# link-server (/client). Перезапускать после каждого изменения mods/ или обновления Forge.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTALLER="$(ls forge-*-installer.jar 2>/dev/null | head -n1 || true)"
if [[ -z "$INSTALLER" ]]; then
  echo "forge-*-installer.jar не найден в корне репозитория" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cp "$INSTALLER" "$WORKDIR/"
mkdir -p "$WORKDIR/mods"
find mods -maxdepth 1 -name '*.jar' -exec cp {} "$WORKDIR/mods/" \;

cat > "$WORKDIR/README.txt" <<EOF
Установка клиента для игры на сервере (Forge 1.21.1)
======================================================

1. Установи ванильный Minecraft-лаунчер (launcher.mojang.com), если ещё нет.
2. Запусти ${INSTALLER} двойным щелчком, выбери "Install Client", подтверди путь
   до стандартной папки .minecraft, дождись завершения.
3. В лаунчере выбери появившийся профиль Forge и один раз запусти игру через него,
   чтобы лаунчер создал нужные папки.
4. Скопируй все .jar-файлы из папки mods/ (рядом с этим README) в:
     Windows:      %appdata%\\.minecraft\\mods
     Linux/macOS:  ~/.minecraft/mods
5. Запускай игру через профиль Forge и подключайся к серверу.
EOF

OUT="client-pack.zip"
rm -f "$OUT"
(cd "$WORKDIR" && zip -r -q "$OLDPWD/$OUT" .)

echo "Готово: $OUT ($(du -h "$OUT" | cut -f1))"
