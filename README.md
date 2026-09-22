# Minecraft Forge 1.21.1 Server — деплой на Ubuntu VPS (Docker)

Сервер запускается в Docker на базе образа
[itzg/minecraft-server](https://github.com/itzg/docker-minecraft-server)
(самый популярный и активно поддерживаемый Docker-образ для Minecraft-серверов).
Forge ставится из уже скачанного `forge-1.21.1-52.1.16-installer.jar` (лежит в корне
репозитория и монтируется в контейнер) — интернет на VPS для скачивания Forge не нужен.
Автоматические бэкапы через [itzg/mc-backup](https://github.com/itzg/docker-mc-backup).
RCON включён для управления консолью и бэкапов, наружу не публикуется.

## Состав репозитория

```
minecraft-server/
├── docker-compose.yml                      # сервисы: mc (сервер) + backup (авто-бэкапы)
├── forge-1.21.1-52.1.16-installer.jar       # Forge-инсталлятор, монтируется в контейнер
├── .env.example                             # шаблон настроек (скопировать в .env)
├── .env                                     # реальные настройки (не коммитить! RCON-пароль уже сгенерирован)
├── mods/                                    # сюда класть .jar моды — см. раздел "Моды" ниже
├── data/                                    # мир, конфиги, логи (создаётся автоматически при первом запуске)
├── backups/                                 # архивы бэкапов мира
├── client-pack.zip                          # собирается scripts/build-client-pack.sh, раздаётся через /client
├── link-server/
│   └── server.js                           # отдаёт /latest и /client по токену (см. 6.1)
└── scripts/
    ├── install-docker-ubuntu.sh   # установка Docker + firewall на чистом VPS
    ├── console.sh                  # консоль сервера через RCON
    ├── backup-now.sh                # ручной бэкап
    ├── build-client-pack.sh          # собрать client-pack.zip
    └── update.sh                     # обновление образов/пересоздание контейнера
```

## 1. Разовая подготовка VPS (Ubuntu 22.04/24.04)

Скопируйте эту папку на сервер (вместе с `forge-*-installer.jar`):

```bash
scp -r minecraft-server user@your-vps-ip:~/
ssh user@your-vps-ip
cd minecraft-server
```

Установите Docker и откройте нужный порт в firewall:

```bash
sudo bash scripts/install-docker-ubuntu.sh
```

Скрипт ставит Docker Engine + Compose plugin, включает `ufw` и открывает
`25565/tcp` (игровой порт) и SSH. Порт RCON (`25575`) наружу не открывается —
он используется только внутри Docker-сети, доступ к нему снаружи только через
`docker compose exec` (см. `scripts/console.sh`).

Если у VPS мало RAM (< 6 ГБ), рекомендуется добавить swap:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Настройка

Отредактируйте `.env` (или сначала `cp .env.example .env`, если начинаете с нуля):

- `FORGE_INSTALLER_FILE` — имя installer-jar в корне репозитория (должно совпадать
  с реальным файлом, сейчас `forge-1.21.1-52.1.16-installer.jar`).
- `MEMORY` — сколько RAM выделить Java (оставьте VPS минимум 1-1.5 ГБ сверху под ОС/Docker).
- `RCON_PASSWORD` — уже сгенерирован случайно, менять не обязательно, но не публикуйте его.
- `WHITELIST` / `OPS` — никнеймы через запятую (только при `ONLINE_MODE=true`, см. 4.1).

## 3. Запуск

```bash
docker compose up -d
docker compose logs -f mc
```

Первый запуск займёт несколько минут — устанавливается Forge из смонтированного
installer-jar, принимается EULA, генерируется мир. Готовность видна по строке
`Done (...)! For help, type "help"`.

Сервер слушает `0.0.0.0:25565` — подключайтесь по IP вашего VPS.

## 4. Повседневное управление

```bash
docker compose ps                          # статус контейнеров
docker compose logs -f mc                  # логи сервера
docker compose restart mc                  # перезапуск
docker compose down                        # остановка (данные в ./data сохраняются)
bash scripts/console.sh                    # интерактивная консоль сервера (RCON)
bash scripts/console.sh op ИмяИгрока       # одна команда без интерактива
bash scripts/backup-now.sh                 # ручной бэкап прямо сейчас
```

Контейнеры подняты с `restart: unless-stopped` — после перезагрузки VPS сервер
поднимется автоматически вместе с Docker (`systemctl enable docker` уже сделан
скриптом установки).

## 4.1 Whitelist в offline-режиме (ONLINE_MODE=false)

Если сервер запущен без проверки лицензии Mojang (`ONLINE_MODE=false`, пиратские
клиенты), **нельзя** задавать `WHITELIST`/`OPS` через `.env` — переменные окружения
резолвят UUID по лицензионному аккаунту (Mojang/PlayerDB API), а офлайн-сервер
считает UUID игрока локально по нику (`OfflinePlayer:<ник>`). Эти UUID не совпадают,
и сервер отклоняет подключение с `You are not white-listed on this server!`,
даже если ник присутствует в списке.

Правильный порядок для offline-режима:

1. В `.env`: `ENABLE_WHITELIST=true`, а `WHITELIST=` и `OPS=` оставить пустыми.
2. Перезапустить: `docker compose up -d`.
3. Добавить игроков командами прямо в консоли сервера (там UUID считается верно):

   ```bash
   bash scripts/console.sh
   whitelist add Nulls
   op Nulls
   ```

   Эти команды создают/обновляют `data/whitelist.json` и `data/ops.json` с правильными
   offline-UUID и сохраняются между перезапусками — повторять их при каждом старте не нужно.

> Если такой сложности хочется избежать — используйте `ONLINE_MODE=true` (значение
> по умолчанию в `.env.example`), тогда `WHITELIST=`/`OPS=` из `.env` работают как есть,
> но подключаться смогут только владельцы лицензионных аккаунтов Minecraft.

## 5. Моды

Кладите `.jar`-файлы модов (и их зависимости — например, библиотечные моды вроде
Architectury API, если конкретный мод их требует) прямо в папку **`mods/`** в корне
репозитория, рядом с `docker-compose.yml`:

```
minecraft-server/
└── mods/
    ├── jei-1.21.1-....jar
    └── ...
```

Эта папка смонтирована в контейнер как `/mods:ro`, и при **каждом старте** контейнера
itzg-образ копирует всё из `/mods` в `/data/mods`. Чтобы применить изменения после
добавления/удаления модов, достаточно перезапустить контейнер (полная пересборка не
нужна, `docker compose down`/`up -d` тоже не нужен):

```bash
docker compose restart mc
```

Клиенты должны использовать те же версии модов (и тот же Forge `52.1.16`), что и сервер.

### Контент-моды (подземелья/декор/QoL)

В `mods/` уже лежат (все проверены на Forge 1.21.1, скачаны с Modrinth с проверкой SHA1):

| Мод | Зачем |
|---|---|
| [Structory](https://modrinth.com/mod/structory) + [Structory: Towers](https://modrinth.com/mod/structory-towers) | Новые небольшие структуры (руины, башни) в ванильном стиле, свой лут не добавляют |
| [Dungeons and Taverns](https://modrinth.com/mod/dungeons-and-taverns) | Таверны, аванпосты, новые деревенские постройки |
| [Macaw's Furniture](https://modrinth.com/mod/macaws-furniture), [Macaw's Bridges](https://modrinth.com/mod/macaws-bridges) | Декоративные блоки: мебель, мосты, заборы — чистая косметика |
| [Waystones](https://modrinth.com/mod/waystones) | Телепорт между поставленными камнями (удобство, не боевая сила). Требует **Balm** |
| [Balm](https://modrinth.com/mod/balm) | Библиотека, обязательна для Waystones |
| [Xaero's Minimap](https://modrinth.com/mod/xaeros-minimap), [Xaero's World Map](https://modrinth.com/mod/xaeros-world-map) | Миникарта и общая карта, видно друг друга |

Ни один не даёт игрокам боевого/экономического преимущества — только контент и удобство.
После добавления/замены модов не забудьте пересобрать клиент-пак (раздел 5.1)
и синхронизировать `mods/` с VPS.

### Мод авторизации: EasyLogin

В `mods/` уже лежит [EasyLogin](https://modrinth.com/mod/easylogin) `1.0.2` —
server-side мод авторизации (`/register <пароль>` при первом входе, затем
`/login <пароль>` при каждом подключении). Полезен в первую очередь при
`ONLINE_MODE=false`, чтобы никто не мог зайти под чужим ником без пароля —
клиентам ничего ставить не нужно, работает "из коробки" с ванильным лаунчером.

Применить на VPS:

```bash
scp minecraft-server/mods/EasyLogin-forge-1.21.1-1.0.2.jar user@your-vps-ip:~/minecraft-server/mods/
ssh user@your-vps-ip
cd minecraft-server && docker compose restart mc
docker compose logs -f mc   # проверить, что мод загрузился без ошибок
```

## 6. Бэкапы

Сервис `backup` каждые `BACKUP_INTERVAL` (по умолчанию 24h) делает `save-off` /
`save-all` / архивацию мира через RCON и кладёт `tar.gz` в `./backups`, храня
их `PRUNE_BACKUPS_DAYS` дней (по умолчанию 7). Рекомендуется дополнительно
копировать `./backups` за пределы VPS (например, через `rsync`/`rclone` в облако) —
локальные бэкапы не спасут при потере самого сервера.

Восстановление: остановите сервер (`docker compose down`), замените содержимое
`./data` на данные из нужного архива бэкапа, снова `docker compose up -d`.

## 6.1 Бессрочные ссылки на бэкап и клиент-пак (link-server)

Сервис `link-server` (запускается вместе с остальными, см. `docker-compose.yml`) отдаёт
по HTTP два файла по токену — ссылки **не меняются** и всегда возвращают самое свежее:

- `http://<IP-VPS>:<BACKUP_SERVER_PORT>/latest?token=<BACKUP_LINK_TOKEN>` — самый новый
  файл из `./backups` (какой бы `backup` ни сделал последним).
- `http://<IP-VPS>:<BACKUP_SERVER_PORT>/client?token=<BACKUP_LINK_TOKEN>` — `client-pack.zip`
  (Forge-инсталлятор + моды + инструкция), см. раздел 5.1.

`BACKUP_SERVER_PORT` (по умолчанию `8090`) и `BACKUP_LINK_TOKEN` — в `.env`, токен уже
сгенерирован случайно. Порт открывается в ufw скриптом `install-docker-ubuntu.sh`.

Эти же значения (базовый URL + токен) нужно будет указать в Discord-боте, который умеет
запрашивать `/latest` и `/client` и публиковать их в Discord — см. документацию бота.

> ⚠️ Токен передаётся как есть, без TLS (обычный `http://`, не `https://`) — это не
> секрет военного уровня, но относитесь к ссылке как к паролю: не постите её в публичные
> каналы/чаты, только в закрытый Discord-канал сервера. Скомпрометировали — смените
> `BACKUP_LINK_TOKEN` в `.env` и `docker compose up -d`, старая ссылка перестанет работать.

## 5.1 Клиент-пак для игроков

`scripts/build-client-pack.sh` собирает `client-pack.zip` (Forge-инсталлятор из корня
репозитория + все `.jar` из `mods/` + `README.txt` с инструкцией по установке). Запускайте
его на VPS каждый раз после изменения модов или обновления Forge:

```bash
bash scripts/build-client-pack.sh
```

Результат сразу становится доступен по бессрочной ссылке `/client` (раздел 6.1) —
пересобирать `docker compose` не нужно, `link-server` подхватывает файл на лету.

## 7. Обновление версии Forge / модов

1. Положите новый `forge-*-installer.jar` в корень репозитория, обновите
   `FORGE_INSTALLER_FILE` в `.env`.
2. Обновите содержимое `mods/`, если нужно.
3. Выполните `bash scripts/update.sh` — подтянет свежие образы и пересоздаст контейнер `mc`.
4. Пересоберите клиент-пак: `bash scripts/build-client-pack.sh`.

## Безопасность

- RCON-порт не публикуется наружу (доступен только внутри Docker-сети / через `docker compose exec`).
- `.env` содержит секреты (`RCON_PASSWORD`, `BACKUP_LINK_TOKEN`) — не коммитьте его в публичный
  репозиторий (уже добавлен в `.gitignore`).
- `link-server` публикует `BACKUP_SERVER_PORT` наружу без TLS — отдаёт файлы только с верным
  `token` в query, но сам токен идёт открытым текстом (см. раздел 6.1).
- `ONLINE_MODE=true` по умолчанию — проверка лицензии Mojang, не отключайте на публичном сервере
  без необходимости (см. раздел 4.1).
