'use strict';
// Пересобирает client-pack.zip (Forge-инсталлятор + моды + инструкция) при каждом
// старте link-server - раньше это был ручной шаг (scripts/build-client-pack.sh на
// хосте), теперь просто docker compose restart link-server после правки mods/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function findInstaller(repoDir) {
  const files = fs.readdirSync(repoDir).filter((f) => /^forge-.+-installer\.jar$/.test(f));
  return files[0] || null;
}

function readme({ installer, forgeLabel, serverAddress }) {
  return `====================================================
 УСТАНОВКА КЛИЕНТА ДЛЯ ИГРЫ НА СЕРВЕРЕ (Forge ${forgeLabel})
====================================================

Адрес сервера: ${serverAddress}

В архиве два способа поставить игру. Если не уверен, что выбрать —
используй ВАРИАНТ 1 (T-Launcher): он проще и не требует лицензии Minecraft.


ВАРИАНТ 1. Через T-Launcher (проще всего, подходит без лицензии)
------------------------------------------------------------------

1. Скачай T-Launcher с официального сайта: https://tlauncher.org
   (там же выбери версию под свою систему - Windows/macOS/Linux) и установи.
2. Открой T-Launcher, введи любой никнейм и нажми "Войти" - лицензия Mojang
   не нужна, сервер работает в офлайн-режиме. Никнейм выбери сразу постоянный:
   доступ на сервер выдаётся именно на этот ник (whitelist).
3. В нижней части окна найди выбор версии игры и выбери
   "Forge ${forgeLabel}" из списка.
   Если такой версии Forge нет в списке T-Launcher - открой раздел "Модификации" /
   "Установить Forge/Fabric" и укажи версию Minecraft 1.21.1, T-Launcher поставит
   Forge сам. Если и там нет нужного билда - используй ВАРИАНТ 2 ниже, там версия
   Forge гарантированно совпадёт с серверной (это важно, иначе игра может не зайти).
4. Нажми "Играть" один раз и дождись загрузки главного меню - это нужно,
   чтобы T-Launcher создал папку mods.
5. Закрой игру. Открой папку .minecraft (в T-Launcher: значок папки/шестерёнка
   рядом с кнопкой "Играть" -> "Открыть папку игры") и скопируй туда все .jar
   файлы из папки mods/ этого архива - положи их в папку mods внутри .minecraft.
6. Запусти игру снова через профиль "Forge ${forgeLabel}", в главном меню
   выбери "Играть по сети" -> "Добавить сервер", впиши адрес: ${serverAddress}


ВАРИАНТ 2. Через официальный лаунчер Minecraft (нужна лицензия)
------------------------------------------------------------------

1. Установи официальный лаунчер: https://www.minecraft.net/ru-ru/download
   (нужен купленный аккаунт Minecraft Java Edition).
2. Запусти файл ${installer} из этого архива двойным щелчком, в открывшемся
   окне выбери "Install Client", подтверди путь до стандартной папки .minecraft
   и дождись надписи об успешной установке.
3. Открой официальный лаунчер, выбери появившийся профиль
   "forge-${forgeLabel}" и запусти игру один раз, чтобы создались нужные папки.
4. Закрой игру и скопируй все .jar файлы из папки mods/ этого архива в:
     Windows:      %appdata%\\.minecraft\\mods
     Linux/macOS:  ~/.minecraft/mods
5. Запусти игру через профиль Forge, зайди в "Играть по сети" -> "Добавить сервер",
   впиши адрес: ${serverAddress}


ПЕРВЫЙ ВХОД НА СЕРВЕР
------------------------------------------------------------------

На сервере включён whitelist: перед первым заходом сообщи администратору
свой ник, чтобы он добавил тебя в список. Иначе при подключении будет
ошибка "You are not white-listed on this server!".

Приятной игры!
`;
}

/** repoDir - где лежит forge-*-installer.jar; modsDir - откуда брать .jar модов. */
function buildClientPack({ repoDir, modsDir, outPath, serverAddress }) {
  const installer = findInstaller(repoDir);
  if (!installer) {
    console.warn(`[client-pack] forge-*-installer.jar не найден в ${repoDir} - пропускаю сборку`);
    return false;
  }

  const forgeLabel = installer.replace(/^forge-(.+)-installer\.jar$/, '$1');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-pack-'));
  try {
    fs.copyFileSync(path.join(repoDir, installer), path.join(tmpDir, installer));

    const modsOut = path.join(tmpDir, 'mods');
    fs.mkdirSync(modsOut);
    let modJars = [];
    try {
      modJars = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar'));
    } catch {
      // mods/ может отсутствовать - пак всё равно соберём, просто без модов
    }
    for (const jar of modJars) {
      fs.copyFileSync(path.join(modsDir, jar), path.join(modsOut, jar));
    }

    fs.writeFileSync(path.join(tmpDir, 'README.txt'), readme({ installer, forgeLabel, serverAddress }), 'utf8');

    fs.rmSync(outPath, { force: true });
    execFileSync('zip', ['-r', '-q', outPath, '.'], { cwd: tmpDir });

    const { size } = fs.statSync(outPath);
    console.log(`[client-pack] Собран ${outPath} (${modJars.length} модов, Forge ${forgeLabel}, ${(size / 1024 / 1024).toFixed(1)} МБ)`);
    return true;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { buildClientPack };
