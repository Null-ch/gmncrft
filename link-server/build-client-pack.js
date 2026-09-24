'use strict';
// Пересобирает client-pack.zip (README.txt + mods/*.jar + shaderpacks/*.zip, без инсталляторов) при каждом
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

// Шейдерпаки (shaders/) и текстур-паки (resourcepacks/) - .zip, кладутся в архив как есть,
// игрок не распаковывает их.
function listPackZips(dir) {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.zip'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return []; // папка может отсутствовать
  }
}

// Путь к папке игры для шагов инструкции: "AppData\Roaming\.minecraft\<folder>" + как её открыть.
const gameFolderHint = (folder) =>
  `AppData\\Roaming\\.minecraft\\${folder} (полный путь: C:\\Users\\<имя пользователя>\\AppData\\Roaming\\.minecraft\\${folder}, быстро открыть — Win+R → %APPDATA%\\.minecraft\\${folder}). Если папки ${folder} нет — один раз запусти игру с модами или создай её сам.`;

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
function clientGuide({ mcVersion, serverAddress, modsDir, shadersDir, resourcePacksDir }) {
  const mods = modsDir ? listModJars(modsDir) : [];
  const shaders = listPackZips(shadersDir);
  const resourcePacks = listPackZips(resourcePacksDir);
  const extras = [
    ...(shaders.length ? ['папка shaderpacks с шейдерами (.zip)'] : []),
    ...(resourcePacks.length ? ['папка resourcepacks с текстур-паками (.zip)'] : []),
  ];
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
    intro: `В архиве с сервера — этот README и папка mods с модами (.jar)${
      extras.length ? `, а также ${extras.join(' и ')}` : ''
    }. Сам Minecraft с Fabric ставится лаунчером.`,
    sections: [
      {
        title: 'T-Launcher (без лицензии)',
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
      ...(shaders.length
        ? [
            {
              title: 'Шейдеры (по желанию)',
              steps: [
                'Шейдеры работают через моды Iris и Sodium — они уже есть в папке mods архива.',
                'Возьми архив шейдеров из папки shaderpacks архива (.zip) и НЕ распаковывай его.',
                `Положи этот .zip как есть в папку ${gameFolderHint('shaderpacks')}`,
                'Запусти игру и открой «Настройки» → «Настройки графики» → «Наборы шейдеров».',
                'Выбери в списке архив шейдеров, который положил ранее, и нажми «Применить».',
              ],
            },
          ]
        : []),
      ...(resourcePacks.length
        ? [
            {
              title: 'Текстур-пак (по желанию)',
              steps: [
                'Возьми текстур-пак из папки resourcepacks архива (.zip) и НЕ распаковывай его.',
                `Положи этот .zip как есть в папку ${gameFolderHint('resourcepacks')}`,
                'Запусти игру и открой «Настройки» → «Пакеты ресурсов».',
                'В левом списке («Доступные») наведи на текстур-пак и нажми стрелку — он переместится в правый список («Выбранные»). Нажми «Готово».',
              ],
            },
          ]
        : []),
    ],
    mods,
    shaders,
    resourcePacks,
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
  if (guide.shaders.length) {
    out.push('', '', `Шейдеры (${guide.shaders.length})`, '-'.repeat(60));
    for (const pack of guide.shaders) out.push(`- ${pack}`);
  }
  if (guide.resourcePacks.length) {
    out.push('', '', `Текстур-паки (${guide.resourcePacks.length})`, '-'.repeat(60));
    for (const pack of guide.resourcePacks) out.push(`- ${pack}`);
  }
  out.push('', 'Приятной игры!', '');
  return out.join('\n');
}

/**
 * В архив: README.txt (инструкция, версии, список модов) + mods/*.jar + shaderpacks/*.zip
 * + resourcepacks/*.zip. guideOptions - то же, что для clientGuide (mcVersion, serverAddress).
 */
function buildClientPack({ modsDir, shadersDir, resourcePacksDir, outPath, ...guideOptions }) {
  const modJars = listModJars(modsDir);
  const shaderPacks = listPackZips(shadersDir);
  const resourcePacks = listPackZips(resourcePacksDir);
  if (!modJars.length) {
    console.warn(`[client-pack] В ${modsDir} нет .jar - пропускаю сборку`);
    return false;
  }

  // CRLF - чтобы README нормально открывался и в Блокноте на старых Windows.
  const readme = guideToText(clientGuide({ ...guideOptions, modsDir, shadersDir, resourcePacksDir })).replace(/\n/g, '\r\n');
  const entries = [
    { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
    ...modJars.map((jar) => ({ name: `mods/${jar}`, data: fs.readFileSync(path.join(modsDir, jar)) })),
    ...shaderPacks.map((pack) => ({ name: `shaderpacks/${pack}`, data: fs.readFileSync(path.join(shadersDir, pack)) })),
    ...resourcePacks.map((pack) => ({ name: `resourcepacks/${pack}`, data: fs.readFileSync(path.join(resourcePacksDir, pack)) })),
  ];

  // Пишем во временный файл и переименовываем: /client/file не отдаст недописанный архив.
  const tmpPath = `${outPath}.tmp`;
  writeZip(tmpPath, entries);
  fs.renameSync(tmpPath, outPath);

  const { size } = fs.statSync(outPath);
  console.log(`[client-pack] Собран ${outPath} (${modJars.length} модов + ${shaderPacks.length} шейдеров + ${resourcePacks.length} текстур-паков + README.txt, ${(size / 1024 / 1024).toFixed(1)} МБ)`);
  return true;
}

module.exports = { buildClientPack, clientGuide, guideToText, minLoaderVersion, listModJars, listPackZips };
