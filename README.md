# Minecraft Forge 1.21.1 Server — деплой на Ubuntu VPS

Готовый набор файлов для запуска Minecraft-сервера **Forge 1.21.1** в Docker на базе
образа [itzg/minecraft-server](https://github.com/itzg/docker-minecraft-server)
(самый популярный и активно поддерживаемый Docker-образ для Minecraft-серверов).
Автоматические бэкапы через [itzg/mc-backup](https://github.com/itzg/docker-mc-backup).

## Состав репозитория

```
minecraft-server/
├── docker-compose.yml      # сервисы: mc (сервер) + backup (авто-бэкапы)
├── .env.example             # шаблон настроек (скопировать в .env)
├── .env                     # реальные настройки (не коммитить! RCON-пароль уже сгенерирован)
├── mods/                    # сюда класть .jar моды — при старте копируются в /data/mods
├── data/                    # мир, конфиги, логи (создаётся автоматически при первом запуске)
├── backups/                 # архивы бэкапов мира
└── scripts/
    ├── install-docker-ubuntu.sh  # установка Docker + firewall на чистом VPS
    ├── console.sh                 # консоль сервера (rcon-cli)
    ├── backup-now.sh               # ручной бэкап
    └── update.sh                   # обновление образов/версии
```

## 1. Разовая подготовка VPS (Ubuntu 22.04/24.04)

Скопируйте эту папку на сервер, например через `git`/`scp`/`rsync`:

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
он используется только внутри Docker-сети для консоли и бэкапов.

Если у VPS мало RAM (< 6 ГБ), рекомендуется добавить swap:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Настройка

Отредактируйте `.env` (или сначала `cp .env.example .env`, если начинаете с нуля):

- `MEMORY` — сколько RAM выделить Java (оставьте VPS минимум 1-1.5 ГБ сверху под ОС/Docker).
- `RCON_PASSWORD` — уже сгенерирован случайно, менять не обязательно, но не публикуйте его.
- `WHITELIST` / `OPS` — никнеймы через запятую.
- `MC_VERSION` / `FORGE_VERSION` — зафиксированы на `1.21.1` / `52.1.0` (рекомендованная
  версия Forge). Актуальные версии Forge: https://files.minecraftforge.net/net/minecraftforge/forge/index_1.21.1.html

Положите нужные `.jar` моды (и их зависимости, например Forge-совместимые библиотеки)
в папку `mods/` — они будут автоматически скопированы в контейнер при старте.

## 3. Запуск

```bash
docker compose up -d
docker compose logs -f mc
```

Первый запуск займёт несколько минут — скачивается и устанавливается Forge,
принимается EULA, генерируется мир. Готовность видна по строке `Done (...)! For help, type "help"`.

Сервер слушает `0.0.0.0:25565` — подключайтесь по IP вашего VPS.

## 4. Повседневное управление

```bash
docker compose ps               # статус контейнеров
docker compose logs -f mc       # логи сервера
docker compose restart mc       # перезапуск
docker compose down             # остановка (данные в ./data сохраняются)
bash scripts/console.sh         # консоль сервера (RCON), например: op ИмяИгрока
bash scripts/backup-now.sh      # ручной бэкап прямо сейчас
```

Контейнеры подняты с `restart: unless-stopped` — после перезагрузки VPS сервер
поднимется автоматически вместе с Docker (`systemctl enable docker` уже сделан
скриптом установки).

## 5. Бэкапы

Сервис `backup` каждые `BACKUP_INTERVAL` (по умолчанию 24h) делает `save-off` /
`save-all` / архивацию мира через RCON и кладёт `tar.gz` в `./backups`, храня
их `PRUNE_BACKUPS_DAYS` дней (по умолчанию 7). Рекомендуется дополнительно
копировать `./backups` за пределы VPS (например, через `rsync`/`rclone` в облако) —
локальные бэкапы не спасут при потере самого сервера.

Восстановление: остановите сервер (`docker compose down`), замените содержимое
`./data` на данные из нужного архива бэкапа, снова `docker compose up -d`.

## 6. Обновление версии / модов

1. Обновите `mods/`, при необходимости поменяйте `MC_VERSION`/`FORGE_VERSION` в `.env`.
2. Выполните `bash scripts/update.sh` — подтянет свежие образы и пересоздаст контейнеры.

## Безопасность

- RCON-порт не публикуется наружу (доступен только внутри Docker-сети).
- `.env` содержит секрет (`RCON_PASSWORD`) — не коммитьте его в публичный репозиторий
  (уже добавлен в `.gitignore`).
- `ONLINE_MODE=true` по умолчанию — проверка лицензии Mojang, не отключайте на публичном сервере.
