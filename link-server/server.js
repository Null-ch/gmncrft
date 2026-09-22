'use strict';
// Минимальный HTTP-сервер без зависимостей: отдаёт самый свежий бэкап мира и собранный
// клиент-пак (Forge + моды), плюс красивые HTML-страницы для людей (/backup, /client),
// которые сами запускают скачивание файла (/backup/file, /client/file).
// Ссылки бессрочные: /latest всегда резолвит САМЫЙ НОВЫЙ файл в BACKUP_DIR на момент запроса.
//
// Публичные страницы /backup и /client не защищены - доступ по ссылке. Сами файлы
// (/latest, /client) всё ещё сверяют TOKEN - его подставляет caddy при проксировании
// с /backup/file и /client/file, это внутренний секрет, не видимый снаружи.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.TOKEN;
const BACKUP_DIR = process.env.BACKUP_DIR || '/repo/backups';
const CLIENT_PACK_PATH = process.env.CLIENT_PACK_PATH || '/repo/client-pack.zip';
const SERVER_ADDRESS = process.env.SERVER_ADDRESS || '2.26.224.164:25565';

if (!TOKEN) {
  console.error('TOKEN не задан - без него сервер не может проверять доступ к файлам. Останавливаюсь.');
  process.exit(1);
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

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

// Простая HTML-страница в стиле Minecraft (блочные тени на тексте, палитра травы/земли,
// "кнопка" с 3D-скосом как в игровом меню). Скачивание запускает сама страница через JS -
// это единственный надёжный способ одновременно показать страницу и отдать файл по одной
// ссылке (сервер не может в одном ответе и показать HTML, и отдать файл).
function renderLandingPage({ title, subtitle, tip, downloadPath, buttonLabel }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
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
    font-family: 'Courier New', Consolas, monospace;
    padding: 16px;
  }
  .card {
    max-width: 480px;
    width: 100%;
    background: #c6c6c6;
    border: 4px solid #000;
    box-shadow: inset 4px 4px 0 #fff, inset -4px -4px 0 #8b8b8b, 8px 8px 0 rgba(0,0,0,.4);
    padding: 28px 24px;
    text-align: center;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 22px;
    letter-spacing: 1px;
    color: #fff;
    text-shadow: 2px 2px 0 #3f3f3f;
    text-transform: uppercase;
  }
  p.subtitle { color: #2b2b2b; font-size: 14px; margin: 0 0 20px; line-height: 1.5; }
  .btn {
    display: inline-block;
    padding: 12px 22px;
    background: #6b6b6b;
    border: 3px solid #000;
    box-shadow: inset 2px 2px 0 #b1b1b1, inset -2px -2px 0 #373737;
    color: #fff;
    text-decoration: none;
    font-family: inherit;
    font-size: 14px;
    text-transform: uppercase;
    text-shadow: 1px 1px 0 #000;
    cursor: pointer;
  }
  .btn:active { box-shadow: inset -2px -2px 0 #b1b1b1, inset 2px 2px 0 #373737; }
  .server {
    margin-top: 20px;
    padding: 10px;
    background: #2b2b2b;
    color: #7CFC00;
    font-size: 13px;
    border: 2px solid #000;
    word-break: break-all;
  }
  .tip { margin-top: 18px; color: #444; font-size: 12px; font-style: italic; }
</style>
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
    // Скачивание запускается автоматически; кнопка выше остаётся как ручной запасной вариант.
    window.addEventListener('load', function () {
      window.location.href = ${JSON.stringify(downloadPath)};
    });
  </script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400);
    return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }

  // Публичные страницы - без проверки токена, доступны всем, кто знает ссылку.
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

  // Файлы - только с верным токеном (его подставляет caddy при проксировании
  // с /backup/file и /client/file, снаружи он не виден).
  if (url.pathname === '/latest' || url.pathname === '/client-file') {
    if (url.searchParams.get('token') !== TOKEN) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
  }

  if (url.pathname === '/latest') {
    const latest = findLatestBackup();
    if (!latest) return notFound(res, 'Бэкапов пока нет');
    return sendFile(req, res, latest.full, 'minecraft-backup-latest.tar.gz');
  }

  if (url.pathname === '/client-file') {
    if (!fs.existsSync(CLIENT_PACK_PATH)) {
      return notFound(res, 'client-pack.zip ещё не собран - запусти scripts/build-client-pack.sh на сервере');
    }
    return sendFile(req, res, CLIENT_PACK_PATH, 'minecraft-client-pack.zip');
  }

  return notFound(res, 'Not found');
});

server.listen(PORT, () => console.log(`link-server слушает на порту ${PORT}`));
