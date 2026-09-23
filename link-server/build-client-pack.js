'use strict';
// Пересобирает client-pack.zip (README.txt + mods/*.jar, без инсталляторов) при каждом
// старте link-server - раньше это был ручной шаг (scripts/build-client-pack.sh на хосте),
// теперь просто docker compose restart link-server после правки mods/.
// Та же инструкция показывается на сайте (/client и /client/readme.txt): её текст
// собирается здесь - clientGuide() - чтобы сайт и README в архиве не расходились.
const fs = require('fs');
const path = require('path');
const { readZipEntry, writeZip } = require('./zip');

const FABRIC_INSTALLER_URL = 'https://fabricmc.net/use/installer/';

function listModJars(modsDir) {
  try {
    return fs
      .readdirSync(modsDir)
      .filter((f) => f.endsWith('.jar'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return []; // mods/ может отсутствовать
  }
}

// "fabric-api-0.155.3+26.1.2.jar" -> "0.155.3+26.1.2": версию Fabric API полезно знать
// игроку, который ставит моды не из архива.
function fabricApiVersion(modJars) {
  const jar = modJars.find((f) => /^fabric-api-.+\.jar$/.test(f));
  return jar ? jar.replace(/^fabric-api-(.+)\.jar$/, '$1') : null;
}

const compareVersions = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

// Минимальный Fabric Loader для клиента = максимум из ">=X" в depends.fabricloader модов.
// Версия loader'а на сервере (из имени launcher-jar) игроку не важна: T-Launcher ставит
// свой loader, и подходит любой не ниже этого минимума. Кэш по списку jar - на главной
// и /client это считается на каждый запрос, а чтение 10+ jar не бесплатное.
let loaderCache = { key: null, value: null };
function minLoaderVersion(modsDir, modJars) {
  const key = modJars.join('\n');
  if (loaderCache.key === key) return loaderCache.value;
  let min = null;
  for (const jar of modJars) {
    try {
      const raw = readZipEntry(path.join(modsDir, jar), 'fabric.mod.json');
      if (!raw) continue; // не Fabric-мод
      // В fabric.mod.json бывают сырые переводы строк внутри строк - JSON.parse на них падает.
      const meta = JSON.parse(raw.toString('utf8').replace(/[\u0000-\u001f]+/g, ' '));
      const m = /(?:>=|\^|~)?\s*(\d+\.\d+\.\d+)/.exec(String(meta.depends?.fabricloader || ''));
      if (m && (!min || compareVersions(m[1], min) > 0)) min = m[1];
    } catch (err) {
      console.warn(`[client-pack] Не удалось прочитать fabric.mod.json из ${jar}: ${err.message}`);
    }
  }
  loaderCache = { key, value: min };
  return min;
}

/**
 * Инструкция установки клиента: версии, шаги по разделам и список модов. Из неё
 * рендерятся и HTML на /client (server.js), и README.txt (guideToText ниже).
 */
function clientGuide({ mcVersion, serverAddress, modsDir }) {
  const mods = modsDir ? listModJars(modsDir) : [];
  const apiVersion = fabricApiVersion(mods);
  const minLoader = modsDir ? minLoaderVersion(modsDir, mods) : null;
  const loaderLabel = minLoader ? `${minLoader} или новее` : 'последняя стабильная';
  return {
    title: `Установка клиента (Fabric, Minecraft ${mcVersion})`,
    facts: [
      ['Адрес сервера', serverAddress],
      ['Версия Minecraft', mcVersion],
      ['Версия Fabric Loader', loaderLabel],
      ...(apiVersion ? [['Версия Fabric API', apiVersion]] : []),
      ['Java', '25 или новее'],
    ],
    intro:
      'В архиве с сервера — этот README и папка mods с модами (.jar). Сам Minecraft с Fabric ставится лаунчером. ' +
      'Если не уверен, что выбрать — используй вариант 1 (T-Launcher): он проще и не требует лицензии.',
    sections: [
      {
        title: 'Вариант 1. T-Launcher (без лицензии)',
        steps: [
          'Скачай и установи T-Launcher с официального сайта: https://tlauncher.org',
          'Введи никнейм и нажми «Войти». Ник выбери сразу постоянный: доступ на сервер выдаётся именно на него (whitelist).',
          `В списке версий внизу окна выбери «Fabric ${mcVersion}» — T-Launcher сам поставит Fabric и нужную Java. Именно Fabric: с «Forge ${mcVersion}» сервер не пустит («requires Fabric Loader and Fabric API»).`,
          'Нажми «Играть» один раз и дождись главного меню — так создастся папка mods. Закрой игру.',
          'Открой папку игры (значок папки рядом с кнопкой «Играть» → «Открыть папку игры»), зайди в mods и скопируй туда все .jar из папки mods архива.',
          `Запусти игру через «Fabric ${mcVersion}» → «Сетевая игра» → «Добавить сервер» → адрес ${serverAddress}.`,
        ],
      },
      {
        title: 'Первый вход на сервер',
        steps: [
          'На сервере включён whitelist: сначала подай заявку на сайте сервера (/apply) со своим ником, дождись одобрения.',
          'Без этого при подключении будет ошибка «You are not white-listed on this server!».',
          `Моды нужны именно из архива сервера: Forge-моды и моды под другую версию Minecraft с Fabric ${mcVersion} не загрузятся.`,
          'Старые моды (например, от прошлой версии сервера) из папки mods игры удали — с ними игра не запустится.',
          `Ошибка «Replace mod 'Fabric Loader' … with version … or later» значит, что Fabric Loader в лаунчере слишком старый (нужен ${loaderLabel}): поставь новее через Fabric Installer (${FABRIC_INSTALLER_URL}) и выбери в лаунчере появившуюся версию «fabric-loader-…-${mcVersion}».`,
        ],
      },
    ],
    mods,
  };
}

function guideToText(guide) {
  const line = '='.repeat(60);
  const out = [line, ` ${guide.title.toUpperCase()}`, line, ''];
  for (const [k, v] of guide.facts) out.push(`${`${k}:`.padEnd(22)}${v}`);
  out.push('', guide.intro);
  for (const section of guide.sections) {
    out.push('', '', section.title, '-'.repeat(60));
    section.steps.forEach((step, i) => out.push(`${i + 1}. ${step}`));
  }
  if (guide.mods.length) {
    out.push('', '', `Моды сервера (${guide.mods.length})`, '-'.repeat(60));
    for (const jar of guide.mods) out.push(`- ${jar}`);
  }
  out.push('', 'Приятной игры!', '');
  return out.join('\n');
}

/**
 * В архив: README.txt (инструкция, версии, список модов) + mods/*.jar.
 * guideOptions - то же, что для clientGuide (mcVersion, serverAddress).
 */
function buildClientPack({ modsDir, outPath, ...guideOptions }) {
  const modJars = listModJars(modsDir);
  if (!modJars.length) {
    console.warn(`[client-pack] В ${modsDir} нет .jar - пропускаю сборку`);
    return false;
  }

  // CRLF - чтобы README нормально открывался и в Блокноте на старых Windows.
  const readme = guideToText(clientGuide({ ...guideOptions, modsDir })).replace(/\n/g, '\r\n');
  const entries = [
    { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
    ...modJars.map((jar) => ({ name: `mods/${jar}`, data: fs.readFileSync(path.join(modsDir, jar)) })),
  ];

  // Пишем во временный файл и переименовываем: /client/file не отдаст недописанный архив.
  const tmpPath = `${outPath}.tmp`;
  writeZip(tmpPath, entries);
  fs.renameSync(tmpPath, outPath);

  const { size } = fs.statSync(outPath);
  console.log(`[client-pack] Собран ${outPath} (${modJars.length} модов + README.txt, ${(size / 1024 / 1024).toFixed(1)} МБ)`);
  return true;
}

module.exports = { buildClientPack, clientGuide, guideToText, minLoaderVersion, listModJars };
