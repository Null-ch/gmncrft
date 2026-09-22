'use strict';
// Минимальный HTTP-сервер без зависимостей: главная страница с инфо о сервере/модах,
// страницы /backup и /client, и сами файлы (/backup/file, /client/file) - защищены
// своей формой пароля в стиле сайта (не нативным browser-alert Basic Auth, его нельзя
// стилизовать). Пароль бот тоже умеет передавать напрямую заголовком (без формы).
// Ссылки бессрочные: /backup/file всегда резолвит САМЫЙ НОВЫЙ файл в BACKUP_DIR.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const DOWNLOAD_PASSWORD = process.env.DOWNLOAD_PASSWORD;
const BACKUP_DIR = process.env.BACKUP_DIR || '/repo/backups';
const CLIENT_PACK_PATH = process.env.CLIENT_PACK_PATH || '/repo/client-pack.zip';
const MODS_DIR = process.env.MODS_DIR || '/repo/mods';
const SERVER_ADDRESS = process.env.SERVER_ADDRESS || '2.26.224.164:25565';
const MOTD = process.env.MOTD || 'Minecraft-сервер';
const FORGE_INSTALLER_FILE = process.env.FORGE_INSTALLER_FILE || '';

if (!DOWNLOAD_PASSWORD) {
  console.error('DOWNLOAD_PASSWORD не задан - без него сервер не может проверять доступ к файлам. Останавливаюсь.');
  process.exit(1);
}

function passwordMatches(candidate) {
  const a = Buffer.from(String(candidate ?? ''));
  const b = Buffer.from(DOWNLOAD_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// "forge-1.21.1-52.1.16-installer.jar" -> { mcVersion: "1.21.1", forgeVersion: "52.1.16" }
function parseForgeVersion(filename) {
  const m = /^forge-([\d.]+)-([\d.]+)-installer\.jar$/.exec(filename);
  return m ? { mcVersion: m[1], forgeVersion: m[2] } : { mcVersion: '1.21.1', forgeVersion: null };
}

function listMods() {
  let entries;
  try {
    entries = fs.readdirSync(MODS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.jar'))
    .map((name) => name.replace(/\.jar$/, ''))
    .sort((a, b) => a.localeCompare(b));
}

function findLatestBackup() {
  let entries;
  try {
    entries = fs.readdirSync(BACKUP_DIR);
  } catch {
    return null;
  }
  const backups = entries
    .filter((name) => name.endsWith('.tar.gz'))
    .map((name) => {
      const full = path.join(BACKUP_DIR, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return backups[0] || null;
}

function sendFile(req, res, filePath, downloadName) {
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

function notFound(res, message) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function readBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Тело запроса слишком большое'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Общие стили в духе Minecraft: блочные тени на тексте, кнопка со скосом как в игровом
// меню, палитра травы/земли. Без внешних шрифтов/CDN - страница работает офлайн.
const BASE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background:
      repeating-linear-gradient(0deg, #3a3a3a 0 4px, #333 4px 8px),
      linear-gradient(#5b8c3a, #3d6b26);
    background-blend-mode: overlay;
    background-color: #4a4a4a;
    font-family: Consolas, 'Courier New', monospace;
    font-size: 16px;
    padding: 16px;
  }
  .card {
    max-width: 520px;
    width: 100%;
    background: #c6c6c6;
    border: 4px solid #000;
    box-shadow: inset 4px 4px 0 #fff, inset -4px -4px 0 #8b8b8b, 8px 8px 0 rgba(0,0,0,.4);
    padding: 28px 24px;
    text-align: center;
  }
  h1 {
    margin: 0 0 10px;
    font-size: 24px;
    letter-spacing: 1px;
    color: #fff;
    text-shadow: 2px 2px 0 #2b2b2b;
    text-transform: uppercase;
    line-height: 1.3;
  }
  p.subtitle { color: #2b2b2b; font-size: 15px; margin: 0 0 20px; line-height: 1.6; }
  .btn {
    display: inline-block;
    padding: 12px 22px;
    background: #6b6b6b;
    border: 3px solid #000;
    box-shadow: inset 2px 2px 0 #b1b1b1, inset -2px -2px 0 #373737;
    color: #fff;
    text-decoration: none;
    font-family: inherit;
    font-size: 15px;
    text-transform: uppercase;
    text-shadow: 1px 1px 0 #000;
    cursor: pointer;
    margin: 4px;
  }
  .btn:active { box-shadow: inset -2px -2px 0 #b1b1b1, inset 2px 2px 0 #373737; }
  .btn:disabled { opacity: .5; cursor: default; }
  .server {
    margin-top: 20px;
    padding: 10px;
    background: #2b2b2b;
    color: #7CFC00;
    font-size: 14px;
    border: 2px solid #000;
    word-break: break-all;
  }
  .tip { margin-top: 18px; color: #2b2b2b; font-size: 13px; font-style: italic; line-height: 1.5; }
  .info-row {
    display: flex;
    justify-content: space-between;
    background: #2b2b2b;
    color: #eee;
    font-size: 13px;
    padding: 8px 10px;
    border: 2px solid #000;
    margin-bottom: 6px;
    text-align: left;
  }
  .info-row b { color: #7CFC00; }
  .mods {
    text-align: left;
    background: #2b2b2b;
    border: 2px solid #000;
    max-height: 220px;
    overflow-y: auto;
    padding: 10px 14px;
    margin: 14px 0;
  }
  .mods ul { margin: 0; padding-left: 18px; }
  .mods li { color: #ddd; font-size: 13px; line-height: 1.8; }
  .mods-title { color: #fff; font-size: 13px; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 1px; }
  /* Отдельный тёмный блок (как .server), а не серый текст на светлой карточке -
     светло-серый текст на светло-сером фоне было почти не видно. */
  .lock {
    margin-top: 16px;
    padding: 8px 10px;
    background: #2b2b2b;
    border: 2px solid #000;
    color: #ffcf4d;
    font-size: 13px;
    font-weight: bold;
    line-height: 1.5;
  }
  input[type=password] {
    width: 100%;
    padding: 10px;
    margin: 14px 0;
    background: #2b2b2b;
    border: 3px solid #000;
    box-shadow: inset 2px 2px 0 #000, inset -1px -1px 0 #555;
    color: #fff;
    font-family: inherit;
    font-size: 15px;
    text-align: center;
    letter-spacing: 2px;
  }
  input[type=password]:focus { outline: 2px solid #7CFC00; }
  .error {
    background: #5a1f1f;
    border: 2px solid #000;
    color: #ff8a8a;
    font-size: 13px;
    padding: 8px;
    margin-bottom: 12px;
  }
`;

function renderHomePage() {
  const { mcVersion, forgeVersion } = parseForgeVersion(FORGE_INSTALLER_FILE);
  const mods = listMods();

  const modsList = mods.length
    ? `<div class="mods"><div class="mods-title">Установленные моды (${mods.length})</div><ul>${mods
        .map((m) => `<li>${esc(m)}</li>`)
        .join('')}</ul></div>`
    : '';

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(MOTD)}</title>
<style>${BASE_STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>${esc(MOTD)}</h1>
    <p class="subtitle">Forge-сервер Minecraft — присоединяйся!</p>

    <div class="info-row"><span>Версия Minecraft</span><b>${esc(mcVersion)}</b></div>
    ${forgeVersion ? `<div class="info-row"><span>Версия Forge</span><b>${esc(forgeVersion)}</b></div>` : ''}
    <div class="info-row"><span>Адрес сервера</span><b>${esc(SERVER_ADDRESS)}</b></div>

    ${modsList}

    <a class="btn" href="/backup">Скачать бэкап мира</a>
    <a class="btn" href="/client">Скачать клиент (Forge + моды)</a>
    <div class="lock">🔒 Для скачивания файлов нужен пароль — спроси у администратора сервера.</div>

    <p class="tip">Совет: перед первым входом придумай пароль и введи /register &lt;пароль&gt; &lt;пароль&gt; — без него не подвигаешься.</p>
  </div>
</body>
</html>`;
}

// Скачивание запускается автоматически; кнопка остаётся как ручной запасной вариант.
// Ведёт на /backup/file или /client/file, где встретит форму пароля (см. renderPasswordForm).
function renderLandingPage({ title, subtitle, tip, downloadPath, buttonLabel }) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>${esc(title)}</h1>
    <p class="subtitle">${esc(subtitle)}</p>
    <a class="btn" id="dl" href="${esc(downloadPath)}">${esc(buttonLabel)}</a>
    <div class="server">Адрес сервера: ${esc(SERVER_ADDRESS)}</div>
    <p class="tip">Совет: ${esc(tip)}</p>
  </div>
  <script>
    window.addEventListener('load', function () {
      window.location.href = ${JSON.stringify(downloadPath)};
    });
  </script>
</body>
</html>`;
}

// Своя форма пароля вместо нативного Basic Auth диалога браузера - тот стилизовать нельзя.
function renderPasswordForm({ title, action, error }) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>${esc(title)}</h1>
    <p class="subtitle">Введи пароль, чтобы скачать файл.</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form method="POST" action="${esc(action)}">
      <input type="password" name="password" placeholder="Пароль" autofocus required>
      <button class="btn" type="submit">Скачать</button>
    </form>
    <div class="lock">🔒 Пароль знает тот, кто настраивал сервер (его же печатает Discord-бот).</div>
  </div>
</body>
</html>`;
}

function handleProtectedFile(req, res, { getFile, notFoundMessage, downloadName, title, action }) {
  // Бот передаёт пароль заголовком - без формы, напрямую отдаём файл.
  const headerPassword = req.headers['x-download-password'];
  if (headerPassword != null) {
    if (!passwordMatches(headerPassword)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
    const file = getFile();
    if (!file) return notFound(res, notFoundMessage);
    return sendFile(req, res, file, downloadName);
  }

  if (req.method === 'GET') {
    return sendHtml(res, renderPasswordForm({ title, action }));
  }

  if (req.method === 'POST') {
    return readBody(req)
      .then((body) => {
        const submitted = new URLSearchParams(body).get('password');
        if (!passwordMatches(submitted)) {
          return sendHtml(res, renderPasswordForm({ title, action, error: 'Неверный пароль, попробуй ещё раз.' }), 403);
        }
        const file = getFile();
        if (!file) return notFound(res, notFoundMessage);
        return sendFile(req, res, file, downloadName);
      })
      .catch(() => {
        res.writeHead(400);
        res.end();
      });
  }

  res.writeHead(405);
  return res.end();
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400);
    return res.end();
  }

  // Публичные страницы - открыты всем, кто знает ссылку.
  if (url.pathname === '/' && req.method === 'GET') {
    return sendHtml(res, renderHomePage());
  }

  if (url.pathname === '/backup' && req.method === 'GET') {
    return sendHtml(
      res,
      renderLandingPage({
        title: 'Бэкап мира',
        subtitle: 'Сейчас начнётся скачивание самого свежего бэкапа сервера.',
        tip: 'пока файл качается, крипер за спиной не взрывается - можно спокойно подождать.',
        downloadPath: '/backup/file',
        buttonLabel: 'Скачать вручную',
      }),
    );
  }

  if (url.pathname === '/client' && req.method === 'GET') {
    return sendHtml(
      res,
      renderLandingPage({
        title: 'Клиент-пак',
        subtitle: 'Forge + моды + инструкция по установке (T-Launcher/официальный лаунчер) - в архиве.',
        tip: 'внутри архива README.txt отвечает на большинство вопросов.',
        downloadPath: '/client/file',
        buttonLabel: 'Скачать вручную',
      }),
    );
  }

  // Файлы - защищены собственной формой пароля (GET показывает форму, POST проверяет).
  if (url.pathname === '/backup/file') {
    return handleProtectedFile(req, res, {
      getFile: () => findLatestBackup()?.full ?? null,
      notFoundMessage: 'Бэкапов пока нет',
      downloadName: 'minecraft-backup-latest.tar.gz',
      title: 'Бэкап мира',
      action: '/backup/file',
    });
  }

  if (url.pathname === '/client/file') {
    return handleProtectedFile(req, res, {
      getFile: () => (fs.existsSync(CLIENT_PACK_PATH) ? CLIENT_PACK_PATH : null),
      notFoundMessage: 'client-pack.zip ещё не собран - запусти scripts/build-client-pack.sh на сервере',
      downloadName: 'minecraft-client-pack.zip',
      title: 'Клиент-пак',
      action: '/client/file',
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }

  return notFound(res, 'Not found');
});

server.listen(PORT, () => console.log(`link-server слушает на порту ${PORT}`));
