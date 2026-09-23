# Minecraft Fabric 26.1.2 Server (Docker)

Сервер Minecraft `26.1.2` на Fabric Loader `0.19.5` (Java 25) на образе [itzg/minecraft-server](https://github.com/itzg/docker-minecraft-server)
с автобэкапами ([itzg/mc-backup](https://github.com/itzg/docker-mc-backup)) и сайтом сервера
по HTTPS (главная страница, скачивание бэкапа и клиент-пака).

## Состав

```
minecraft-server/
├── docker-compose.yml                  # сервисы: mc, backup, link-server, caddy
├── Caddyfile                           # HTTPS для домена (reverse proxy на link-server)
├── fabric-server-mc.26.1.2-loader.0.19.5-launcher.1.1.2.jar  # Fabric-сервер ставится из него
├── .env.example                        # шаблон настроек -> скопировать в .env
├── mods/                               # .jar моды (копируются на сервер и в клиент-пак)
├── link-server/                        # сайт, заявки, сборка архива модов для клиента (Node, без зависимостей)
├── link-data/                          # заявки на игру (создаётся автоматически)
├── scripts/
│   ├── install-docker-ubuntu.sh        # Docker + ufw на чистом VPS
│   ├── console.sh                      # консоль сервера через RCON
│   ├── backup-now.sh                   # ручной бэкап
│   └── update.sh                       # обновить образы и пересоздать mc
├── data/                               # мир, конфиги, логи (создаётся при первом запуске)
└── backups/                            # архивы бэкапов
```

## Установка на VPS (Ubuntu 22.04/24.04)

```bash
scp -r minecraft-server user@your-vps-ip:~/
ssh user@your-vps-ip
cd minecraft-server
sudo bash scripts/install-docker-ubuntu.sh   # Docker, ufw: 22, 25565, 80, 443
cp .env.example .env                         # и отредактировать
docker compose up -d
docker compose logs -f mc                    # ждать "Done (...)! For help, type "help""
```

Основные параметры `.env`:

| Переменная | Что это |
|---|---|
| `MC_VERSION`, `FABRIC_LAUNCHER_FILE` | версия Minecraft и имя серверного Fabric launcher-jar в корне |
| `MEMORY` | RAM для Java (оставьте ОС 1–1.5 ГБ сверху) |
| `ONLINE_MODE` | `true` — только лицензия; `false` — пускает пиратские клиенты (T-Launcher) |
| `ENABLE_WHITELIST`, `WHITELIST`, `OPS` | whitelist и операторы, см. «Whitelist» |
| `RCON_PASSWORD` | для консоли и бэкапов, наружу порт не открыт |
| `LINK_DOMAIN`, `DOWNLOAD_PASSWORD`, `SERVER_ADDRESS` | сайт сервера, см. «Сайт» |
| `BOT_API_TOKEN` | токен Discord-бота для заявок на игру, см. «Заявки на игру» |
| `BACKUP_INTERVAL`, `PRUNE_BACKUPS_DAYS` | частота и срок хранения бэкапов |

## Управление

```bash
docker compose ps                       # статус
docker compose logs -f mc               # логи
docker compose restart mc               # перезапуск
docker compose down                     # остановка (data/ сохраняется)
bash scripts/console.sh                 # интерактивная консоль (RCON)
bash scripts/console.sh op Nick         # одна команда
bash scripts/backup-now.sh              # бэкап прямо сейчас
```

Контейнеры с `restart: unless-stopped` поднимаются сами после перезагрузки VPS.

## Whitelist

**`ONLINE_MODE=true`**: достаточно `.env` — `ENABLE_WHITELIST=true`, `WHITELIST=Nick1,Nick2`,
`OPS=Nick1`, затем `docker compose up -d`.

**`ONLINE_MODE=false`**: `WHITELIST`/`OPS` в `.env` оставить пустыми — образ получает
по ним лицензионные UUID, а офлайн-сервер считает UUID по нику, и игрок получит
`You are not white-listed on this server!`. Вместо этого `ENABLE_WHITELIST=true`, в
`mods/` уже лежит мод [EasyWhitelist](https://modrinth.com/mod/easywhitelist)
(`easywhitelist-1.1.4.jar`, только серверный, делает whitelist/op/ban по нику), и игроки
добавляются через заявки (см. ниже) или вручную:

```bash
bash scripts/console.sh
easywhitelist add Nick       # по нику, без запроса UUID у Mojang; регистр важен
easyop Nick
```

Обычный `whitelist add` в офлайн-режиме не подходит: если ник совпадает с чьим-то
лицензионным аккаунтом, он запишет лицензионный UUID, и игрок не зайдёт. Списки хранятся
в `data/whitelist.json` и `data/ops.json`.

> ⚠️ Whitelist в офлайн-режиме проверяет только ник: любой, кто знает ник из списка,
> может зайти под ним.

### Заявки на игру

Игрок подаёт заявку на сайте (`/apply`) или в Discord (`/minecraft apply`). Бот
(репозиторий `kgk44`) раз в 30 секунд забирает новые заявки и присылает их в личку
всем одобряющим (`MINECRAFT_APPROVER_IDS` в `.env` бота) с кнопками «Одобрить» /
«Отклонить». При одобрении `link-server` выполняет через RCON `easywhitelist add <ник>`,
RCON наружу по-прежнему не открыт. Подавший с сайта видит статус по ссылке
`/apply/<id>`, подавший из Discord получает сообщение от бота.

Настройка: `BOT_API_TOKEN` здесь (`openssl rand -hex 24`) = `MINECRAFT_API_TOKEN` в
`.env` бота, затем `docker compose up -d --build link-server`. Заявки хранятся в
`link-data/applications.json`. С одного IP — не больше 3 заявок в час, всего не больше
30 необработанных.

## Моды

Все `.jar` из `mods/` при каждом старте копируются в `data/mods` (старое содержимое
`data/mods` удаляется — `REMOVE_OLD_MODS`), а также попадают в архив для клиента и в
список на сайте. Моды должны быть **под Fabric и Minecraft 26.1.x** (Forge/NeoForge jar не
загрузятся). Искать версии удобно на [Modrinth](https://modrinth.com/mods?g=categories:fabric&v=26.1.2).

| Мод | Версия | Зачем |
|---|---|---|
| [Fabric API](https://modrinth.com/mod/fabric-api) | 0.155.3+26.1.2 | Библиотека, нужна почти всем Fabric-модам |
| [Structory](https://modrinth.com/mod/structory) + [Towers](https://modrinth.com/mod/structory-towers) | 1.3.17 / 1.0.17 | Небольшие структуры в ванильном стиле |
| [Dungeons and Taverns](https://modrinth.com/mod/dungeons-and-taverns) | 5.2.0 | Таверны, аванпосты, постройки в деревнях |
| [Macaw's Furniture](https://modrinth.com/mod/macaws-furniture), [Bridges](https://modrinth.com/mod/macaws-bridges) | 3.4.2 / 3.1.2 | Декоративные блоки |
| [Waystones](https://modrinth.com/mod/waystones) + [Balm](https://modrinth.com/mod/balm) + [Shogi](https://modrinth.com/mod/shogi) | 26.1.2.16 / 26.1.2.14 / 26.1.2.8 | Телепорт между камнями (Balm и Shogi — зависимости) |
| [Xaero's Minimap](https://modrinth.com/mod/xaeros-minimap), [World Map](https://modrinth.com/mod/xaeros-world-map) | 26.5.0 / 1.46.0 | Миникарта и карта мира (XaeroLib встроен в jar) |
| [EasyWhitelist](https://modrinth.com/mod/easywhitelist) | 1.1.4 | Только сервер: whitelist по нику для офлайн-режима |

После изменения `mods/`:

```bash
docker compose restart mc link-server   # сервер + пересборка архива для клиента
```

## Сайт, бэкап и клиент-пак

`caddy` получает HTTPS-сертификат для `LINK_DOMAIN` (A-запись → IP VPS) и проксирует на
`link-server`:

- `/` — MOTD, версия, адрес, список модов;
- `/apply` — заявка на игру, `/apply/<id>` — её статус;
- `/backup` — скачивание самого свежего архива из `backups/`;
- `/client` — инструкция по установке клиента (версии Minecraft/Fabric, T-Launcher и
  официальный лаунчер) и кнопка скачивания архива: `README.txt` с той же инструкцией,
  версиями и списком модов + папка `mods/`. Инсталляторы в архив не кладутся — Fabric
  игрок ставит лаунчером;
- `/client/readme.txt` — только README, без пароля;
- `/api/applications` — API заявок для бота (`Authorization: Bearer <BOT_API_TOKEN>`).

Страницы открыты, скачивание файла просит `DOWNLOAD_PASSWORD` (простой, его печатает
Discord-бот). Архив для клиента собирается автоматически при старте `link-server`.

> ⚠️ После правки переменных `link-server` в `.env` нужен `docker compose up -d link-server`,
> а не `restart` — `restart` не перечитывает окружение.

## Бэкапы

`backup` раз в `BACKUP_INTERVAL` (по умолчанию 24h) делает `tar.gz` мира в `backups/`,
хранит `PRUNE_BACKUPS_DAYS` дней. Копируйте `backups/` и за пределы VPS.

Восстановление: `docker compose down` → заменить `data/` содержимым архива →
`docker compose up -d`.

## Обновление Minecraft / Fabric

1. Скачать новый серверный launcher-jar на [fabricmc.net/use/server](https://fabricmc.net/use/server/),
   положить в корень, обновить `FABRIC_LAUNCHER_FILE` и `MC_VERSION` в `.env`.
2. Обновить `mods/` под новую версию (все моды, включая Fabric API).
3. Сделать бэкап (`bash scripts/backup-now.sh`), затем `bash scripts/update.sh` и
   `docker compose up -d link-server`.

### Переход с Forge 1.21.1 (один раз)

Мир Forge 1.21.1 конвертируется в 26.1.2 при первом запуске, но **обратно не откатить** —
сначала бэкап. Порядок на VPS:

```bash
bash scripts/backup-now.sh              # бэкап старого мира
git pull                                # или scp обновлённых файлов
# в .env заменить FORGE_INSTALLER_FILE/FORGE_FORCE_REINSTALL на
# MC_VERSION/FABRIC_LAUNCHER_FILE/FABRIC_FORCE_REINSTALL (см. .env.example)
docker compose up -d --force-recreate mc link-server
```

Старые Forge-моды из `data/mods` удалятся сами (`REMOVE_OLD_MODS`). Файлы Forge в `data/`
(`libraries/`, `run.sh`, `user_jvm_args.txt`, `forge-*.jar`) Fabric не мешают, их можно
удалить вручную. Блоки/предметы модов без Fabric-версии пропадут из мира. Игрокам — заново
скачать архив с `/client` и удалить старые моды из своей папки `mods`.

## Безопасность

- Наружу открыты только `25565` (игра) и `80/443` (caddy). RCON и `link-server` — только внутри Docker-сети.
- `.env` содержит секреты и в `.gitignore`.
