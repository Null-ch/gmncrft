# Minecraft Forge 1.21.1 Server — деплой на Ubuntu VPS напрямую из jar (без Docker)

Сервер запускается обычным `java -jar` через systemd, без Docker. Установка выполняется
официальным Forge-инсталлятором (`forge-*-installer.jar`), который либо уже лежит
в репозитории, либо скрипт сам скачает нужную версию с maven.minecraftforge.net.

## Состав репозитория

```
minecraft-server/
├── forge-1.21.1-52.1.16-installer.jar   # Forge-инсталлятор (можно не коммитить, см. .gitignore)
├── server.properties.template            # шаблон настроек сервера
├── systemd/minecraft.service.template    # шаблон systemd-юнита
└── scripts/
    ├── install-java-ubuntu.sh   # Java 21 + пользователь minecraft + firewall (разово, sudo)
    ├── setup-server.sh          # установка Forge + systemd-сервис (разово, sudo)
    ├── console.sh                # отправить команду в консоль сервера
    ├── backup-now.sh              # архив мира в ./backups
    └── update-forge.sh            # обновление версии Forge
```

После первого запуска `setup-server.sh` в этой же папке появятся: `run.sh`, `libraries/`,
`world/`, `eula.txt`, `server.properties`, `user_jvm_args.txt`, `console.fifo`,
`logs/` и т.д. — они попадают в `.gitignore` и не коммитятся.

## 1. Подготовка VPS (Ubuntu 22.04/24.04)

Скопируйте репозиторий на сервер (вместе с `forge-*-installer.jar`, если он уже скачан
локально — иначе его скачает `setup-server.sh`):

```bash
scp -r minecraft-server user@your-vps-ip:~/
ssh user@your-vps-ip
cd minecraft-server
```

Установите Java 21, создайте системного пользователя `minecraft` и откройте порт в firewall:

```bash
sudo bash scripts/install-java-ubuntu.sh
```

Открывается только `25565/tcp` (игровой порт) + SSH. Управление консолью идёт локально
через `console.fifo`, наружу ничего дополнительно не публикуется.

Если у VPS мало RAM (< 6 ГБ), добавьте swap:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Установка сервера

```bash
sudo bash scripts/setup-server.sh
```

Скрипт:
1. запускает `java -jar forge-*-installer.jar --installServer` (от имени пользователя `minecraft`);
2. принимает EULA (`eula.txt`);
3. создаёт `user_jvm_args.txt` с памятью `-Xms2G -Xmx4G` (поменяйте под свой VPS);
4. создаёт `server.properties` из `server.properties.template`, если его ещё нет;
5. ставит и включает systemd-юнит `minecraft.service` (автозапуск при загрузке VPS, `Restart=on-failure` при падении).

Перед первым реальным запуском стоит проверить `server.properties` (motd, online-mode,
max-players и т.д.) и `user_jvm_args.txt` (объём памяти).

## 3. Управление

```bash
systemctl status minecraft         # статус
journalctl -u minecraft -f         # логи в реальном времени
sudo systemctl restart minecraft   # перезапуск
sudo systemctl stop minecraft      # остановка (мир сохраняется - JVM ловит SIGTERM)
bash scripts/console.sh op Nulls   # команда в консоль сервера
bash scripts/backup-now.sh         # архив мира прямо сейчас
```

Консоль реализована через именованный канал `console.fifo` (без RCON и без screen/tmux):
`scripts/console.sh <команда>` дописывает строку в fifo, откуда её читает Java-процесс —
это то же самое, что ввести команду прямо в консоли сервера.

## 3.1 Whitelist в offline-режиме (online-mode=false)

Если сервер запущен без проверки лицензии Mojang (`online-mode=false` в
`server.properties`, пиратские клиенты), **нельзя** добавлять игроков в whitelist до
их первого реального подключения — команда `whitelist add <ник>` при отсутствии
игрока в локальном кэше обращается к Mojang API и берёт UUID лицензионного аккаунта,
который не совпадает с offline-UUID (`OfflinePlayer:<ник>`), которым сервер помечает
реально подключившегося клиента. Итог — `You are not white-listed`, даже если ник в списке.

Правильный порядок для offline-режима:

```bash
bash scripts/console.sh whitelist off
# -> сразу зайти в игру под нужным ником, whitelist временно выключен
bash scripts/console.sh whitelist on
bash scripts/console.sh whitelist add Nulls
bash scripts/console.sh op Nulls
```

Пока whitelist выключен, сервер открыт для подключения с любым ником (без авторизации) —
держите это окно максимально коротким. После этого шага записи в `whitelist.json`
берутся из локального кэша с верным offline-UUID и переживают перезапуски сервиса.

Если такой сложности хочется избежать — используйте `online-mode=true` (значение по
умолчанию в `server.properties.template`), тогда обычный `whitelist add <ник>` работает
сразу, но подключаться смогут только владельцы лицензионных аккаунтов Minecraft.

## 4. Бэкапы

`scripts/backup-now.sh` отключает автосейв, форсирует сохранение (`save-all flush`),
архивирует папку мира (`level-name` из `server.properties`, по умолчанию `world`) в
`./backups/world-<дата>.tar.gz` и включает автосейв обратно. Для регулярных бэкапов
добавьте в crontab пользователя root:

```bash
sudo crontab -e
# каждый день в 4:00
0 4 * * * cd /путь/до/minecraft-server && bash scripts/backup-now.sh >> backups/backup.log 2>&1
```

Рекомендуется дополнительно копировать `./backups` за пределы VPS (rsync/rclone в облако) —
локальные бэкапы не спасут при потере самого сервера.

## 5. Обновление версии Forge

```bash
FORGE_FULL_VERSION=1.21.1-52.1.20 sudo -E bash scripts/update-forge.sh
```

Скачивает нужный инсталлятор с `maven.minecraftforge.net`, останавливает сервис,
переустанавливает Forge поверх текущих файлов (мир/конфиги не трогает) и запускает заново.
Актуальные версии: https://files.minecraftforge.net/net/minecraftforge/forge/index_1.21.1.html

## Моды

Кладите `.jar` моды в папку `mods/` в корне репозитория (создаётся автоматически при
установке Forge) и перезапускайте сервис: `sudo systemctl restart minecraft`.

## Безопасность

- RCON по умолчанию выключен (`enable-rcon=false`) — управление только через локальный
  `console.fifo`, наружу ничего не торчит кроме игрового порта.
- `online-mode=true` по умолчанию — проверка лицензии Mojang, не отключайте на публичном
  сервере без необходимости (см. раздел про whitelist выше).
- Сервер работает от имени отдельного системного пользователя `minecraft`, не root.
