'use strict';
// Минимальный HTTP-сервер без зависимостей: главная страница с инфо о сервере/модах,
// страница /backup, инструкция установки клиента /client (+ /client/readme.txt),
// и сами файлы (/backup/file, /client/file - архив README.txt + моды) - защищены
// своей формой пароля в стиле сайта (не нативным browser-alert Basic Auth, его нельзя
// стилизовать). Пароль бот тоже умеет передавать напрямую заголовком (без формы).
// Ссылки бессрочные: /backup/file всегда резолвит САМЫЙ НОВЫЙ файл в BACKUP_DIR.
// Плюс заявки на игру (/apply с сайта, /api/applications для Discord-бота): одобренный
// ник добавляется в whitelist через RCON - контейнер mc в той же Docker-сети.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildClientPack, clientGuide, guideToText } = require('./build-client-pack');
const { rconCommand } = require('./rcon');
const { createApplicationStore, ApplicationError } = require('./applications');

const PORT = Number(process.env.PORT || 8080);
const DOWNLOAD_PASSWORD = process.env.DOWNLOAD_PASSWORD;
const BACKUP_DIR = process.env.BACKUP_DIR || '/repo/backups';
const CLIENT_PACK_PATH = process.env.CLIENT_PACK_PATH || '/repo/client-pack.zip';
const MODS_DIR = process.env.MODS_DIR || '/repo/mods';
const SERVER_ADDRESS = process.env.SERVER_ADDRESS || '2.26.224.164:25565';
const MOTD = process.env.MOTD || 'Minecraft-сервер';
const FABRIC_LAUNCHER_FILE = process.env.FABRIC_LAUNCHER_FILE || '';
const APPLICATIONS_FILE = process.env.APPLICATIONS_FILE || '/data/applications.json';
const WHITELIST_FILE = process.env.WHITELIST_FILE || '/repo/data/whitelist.json';
// Токен, которым Discord-бот ходит в /api/applications. Без него API выключено,
// а заявки с сайта копятся, но уведомлять о них некому.
const BOT_API_TOKEN = process.env.BOT_API_TOKEN || '';
const RCON = {
  host: process.env.RCON_HOST || 'mc',
  port: Number(process.env.RCON_PORT || 25575),
  password: process.env.RCON_PASSWORD || '',
};

if (!DOWNLOAD_PASSWORD) {
  console.error('DOWNLOAD_PASSWORD не задан - без него сервер не может проверять доступ к файлам. Останавливаюсь.');
  process.exit(1);
}

if (!BOT_API_TOKEN) {
  console.warn('BOT_API_TOKEN не задан - API заявок для Discord-бота выключено.');
}

function secretMatches(candidate, secret) {
  const a = Buffer.from(String(candidate ?? ''));
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const passwordMatches = (candidate) => secretMatches(candidate, DOWNLOAD_PASSWORD);

// Имена из whitelist.json сервера (/repo/data смонтирован read-only). Сравнение точное:
// офлайн-UUID зависит от регистра ника, "nulls" и "Nulls" - разные игроки.
function isWhitelisted(nickname) {
  try {
    const entries = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    return entries.some((entry) => entry.name === nickname);
  } catch {
    return false;
  }
}

// Команда мода EasyWhitelist: whitelist по нику, без запроса UUID у Mojang (обычный
// "whitelist add" в offline-режиме может записать UUID лицензионного аккаунта).
// Ответы ванильные: "Added <ник> to the whitelist" / "Player is already whitelisted".
async function addToWhitelist(nickname) {
  const raw = await rconCommand({ ...RCON, command: `easywhitelist add ${nickname}` });
  const reply = raw.replace(/§./g, '').trim();
  if (/added .+ to the whitelist|already whitelisted/i.test(reply)) return reply;
  throw new Error(`Сервер не добавил ${nickname} в whitelist: ${reply || 'пустой ответ'}`);
}

const applications = createApplicationStore({ filePath: APPLICATIONS_FILE, isWhitelisted });

// Не больше APPLY_LIMIT заявок с одного IP за APPLY_WINDOW_MS - защита от спама формой.
const APPLY_LIMIT = 3;
const APPLY_WINDOW_MS = 60 * 60 * 1000;
const applyHits = new Map();

function clientIp(req) {
  // Снаружи запросы приходят только через caddy, он дописывает реальный IP в X-Forwarded-For.
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function recentApplies(ip) {
  const now = Date.now();
  const hits = (applyHits.get(ip) || []).filter((t) => now - t < APPLY_WINDOW_MS);
  if (hits.length) applyHits.set(ip, hits);
  else applyHits.delete(ip);
  return hits;
}

// Считаются только созданные заявки - опечатка в нике не должна съедать лимит.
function recordApply(ip) {
  applyHits.set(ip, [...recentApplies(ip), Date.now()]);
}

// "fabric-server-mc.26.1.2-loader.0.19.5-launcher.1.1.2.jar" -> { mcVersion: "26.1.2", loaderVersion: "0.19.5" }
function parseFabricVersion(filename) {
  const m = /^fabric-server-mc\.([\w.-]+)-loader\.([\d.]+)-launcher\.[\d.]+\.jar$/.exec(filename);
  return m ? { mcVersion: m[1], loaderVersion: m[2] } : { mcVersion: '26.1.2', loaderVersion: null };
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
  input[type=password], input[type=text], textarea {
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
  input[type=text], textarea { margin: 4px 0 12px; letter-spacing: 0; text-align: left; }
  textarea { resize: vertical; min-height: 70px; }
  input[type=password]:focus, input[type=text]:focus, textarea:focus { outline: 2px solid #7CFC00; }
  label { display: block; text-align: left; color: #2b2b2b; font-size: 13px; font-weight: bold; }
  .nav { margin-top: 18px; }
  .btn.secondary { background: #4a4a4a; font-size: 13px; padding: 8px 14px; }
  .status { padding: 10px; border: 2px solid #000; font-size: 15px; font-weight: bold; margin-bottom: 14px; }
  .status.pending { background: #5a4a1f; color: #ffcf4d; }
  .status.approved { background: #1f4a1f; color: #7CFC00; }
  .status.rejected { background: #5a1f1f; color: #ff8a8a; }
  .error {
    background: #5a1f1f;
    border: 2px solid #000;
    color: #ff8a8a;
    font-size: 13px;
    padding: 8px;
    margin-bottom: 12px;
  }
  .card.wide { max-width: 720px; }
  .guide {
    text-align: left;
    background: #2b2b2b;
    border: 2px solid #000;
    padding: 10px 14px;
    margin: 14px 0;
  }
  .guide ol { margin: 0; padding-left: 22px; }
  .guide li { color: #ddd; font-size: 13px; line-height: 1.6; margin-bottom: 4px; overflow-wrap: anywhere; }
  .guide a { color: #7CFC00; }
`;

const HOME_LINK = '<div class="nav"><a class="btn secondary" href="/">← На главную</a></div>';

// wide - для длинных страниц (инструкция на /client), остальным хватает узкой карточки.
function page(title, body, { wide = false } = {}) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_STYLE}</style>
</head>
<body>
  <div class="card${wide ? ' wide' : ''}">
${body}
  </div>
</body>
</html>`;
}

function renderHomePage() {
  const { mcVersion, loaderVersion } = parseFabricVersion(FABRIC_LAUNCHER_FILE);
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
    <p class="subtitle">Fabric-сервер Minecraft — присоединяйся!</p>

    <div class="info-row"><span>Версия Minecraft</span><b>${esc(mcVersion)}</b></div>
    ${loaderVersion ? `<div class="info-row"><span>Версия Fabric Loader</span><b>${esc(loaderVersion)}</b></div>` : ''}
    <div class="info-row"><span>Адрес сервера</span><b>${esc(SERVER_ADDRESS)}</b></div>

    ${modsList}

    <a class="btn" href="/apply">Подать заявку на игру</a>
    <a class="btn" href="/backup">Скачать бэкап мира</a>
    <a class="btn" href="/client">Установка клиента и моды</a>
    <div class="lock">🔒 Для скачивания файлов нужен пароль — спроси у администратора сервера.</div>

    <p class="tip">Совет: на сервере включён whitelist — сначала подай заявку со своим ником, после одобрения можно заходить.</p>
  </div>
</body>
</html>`;
}

// Скачивание запускается автоматически; кнопка остаётся как ручной запасной вариант.
// Ведёт на /backup/file, где встретит форму пароля (см. renderPasswordForm).
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
    ${HOME_LINK}
  </div>
  <script>
    window.addEventListener('load', function () {
      window.location.href = ${JSON.stringify(downloadPath)};
    });
  </script>
</body>
</html>`;
}

// Параметры инструкции установки - общие для /client, /client/readme.txt и README в архиве.
const guideOptions = () => ({ ...parseFabricVersion(FABRIC_LAUNCHER_FILE), serverAddress: SERVER_ADDRESS, modsDir: MODS_DIR });

// Ссылки в шагах инструкции делаем кликабельными; остальной текст экранируется.
const linkify = (text) =>
  esc(text).replace(/https?:\/\/[^\s,)]+/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);

// Инструкция установки клиента прямо на странице (без автоскачивания). Архив по паролю -
// README.txt с той же инструкцией + mods/*.jar; Minecraft с Fabric игрок ставит лаунчером.
function renderClientPage() {
  const guide = clientGuide(guideOptions());
  const facts = guide.facts
    .map(([k, v]) => `<div class="info-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
    .join('');
  const sections = guide.sections
    .map(
      (section) => `<div class="guide"><div class="mods-title">${esc(section.title)}</div><ol>${section.steps
        .map((step) => `<li>${linkify(step)}</li>`)
        .join('')}</ol></div>`,
    )
    .join('');
  const modsList = guide.mods.length
    ? `<div class="mods"><div class="mods-title">В архиве: моды (${guide.mods.length})</div><ul>${guide.mods
        .map((m) => `<li>${esc(m)}</li>`)
        .join('')}</ul></div>`
    : '';
  return page(
    'Установка клиента',
    `    <h1>Установка клиента</h1>
    <p class="subtitle">${esc(guide.intro)}</p>
    ${facts}
    <a class="btn" href="/client/file">Скачать архив (моды + README)</a>
    <a class="btn secondary" href="/client/readme.txt">Только README.txt</a>
    <div class="lock">🔒 Для скачивания архива нужен пароль — спроси у администратора сервера.</div>
    ${sections}
    ${modsList}
    ${HOME_LINK}`,
    { wide: true },
  );
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
    ${HOME_LINK}
  </div>
</body>
</html>`;
}

function renderApplyForm({ error, values = {} } = {}) {
  return page(
    'Заявка на игру',
    `    <h1>Заявка на игру</h1>
    <p class="subtitle">На сервере включён whitelist. Оставь ник — администратор одобрит заявку, и тебя добавят в список.</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form method="POST" action="/apply">
      <label for="nickname">Ник в Minecraft (точно как в лаунчере, с учётом регистра)</label>
      <input type="text" id="nickname" name="nickname" maxlength="16" pattern="[A-Za-z0-9_]{3,16}" value="${esc(values.nickname || '')}" required autofocus>
      <label for="contact">Как с тобой связаться (ник в Discord, Telegram…)</label>
      <input type="text" id="contact" name="contact" maxlength="200" value="${esc(values.contact || '')}" required>
      <label for="comment">Комментарий (необязательно)</label>
      <textarea id="comment" name="comment" maxlength="200">${esc(values.comment || '')}</textarea>
      <button class="btn" type="submit">Отправить заявку</button>
    </form>
    ${HOME_LINK}`,
  );
}

const STATUS_TEXT = {
  pending: '⏳ Ждёт решения администратора',
  approved: '✅ Одобрена — можно заходить на сервер',
  rejected: '❌ Отклонена',
};

function renderApplicationStatus(app) {
  return page(
    'Статус заявки',
    `    <h1>Заявка: ${esc(app.nickname)}</h1>
    <div class="status ${esc(app.status)}">${STATUS_TEXT[app.status]}</div>
    ${app.status === 'pending' ? '<p class="subtitle">Сохрани ссылку на эту страницу и загляни позже — статус обновится здесь.</p>' : ''}
    ${app.status === 'approved' ? `<div class="server">Адрес сервера: ${esc(SERVER_ADDRESS)}</div>` : ''}
    ${HOME_LINK}`,
  );
}

function handleApplyPost(req, res) {
  return readBody(req)
    .then((body) => {
      const values = Object.fromEntries(new URLSearchParams(body));
      if (!String(values.contact || '').trim()) {
        return sendHtml(res, renderApplyForm({ error: 'Укажи, как с тобой связаться.', values }), 400);
      }
      const ip = clientIp(req);
      if (recentApplies(ip).length >= APPLY_LIMIT) {
        return sendHtml(res, renderApplyForm({ error: 'Слишком много заявок с твоего адреса, попробуй через час.', values }), 429);
      }
      try {
        const app = applications.create({ ...values, source: 'site' });
        recordApply(ip);
        console.log(`[apply] Новая заявка с сайта: ${app.nickname}`);
        res.writeHead(303, { Location: `/apply/${app.id}` });
        return res.end();
      } catch (err) {
        if (!(err instanceof ApplicationError)) throw err;
        return sendHtml(res, renderApplyForm({ error: err.message, values }), err.status);
      }
    })
    .catch((err) => {
      console.error('[apply] Ошибка при приёме заявки:', err);
      res.writeHead(500);
      res.end();
    });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// API для Discord-бота, заголовок Authorization: Bearer <BOT_API_TOKEN>.
//   GET  /api/applications?status=pending     - список заявок
//   POST /api/applications                     - новая заявка из Discord
//   POST /api/applications/<id>/approve|reject - решение (approve добавляет в whitelist)
async function handleApi(req, res, url) {
  if (!BOT_API_TOKEN) return sendJson(res, 503, { error: 'API заявок выключено: не задан BOT_API_TOKEN' });
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ') || !secretMatches(auth.slice(7), BOT_API_TOKEN)) {
    return sendJson(res, 401, { error: 'Неверный токен' });
  }

  try {
    if (url.pathname === '/api/applications' && req.method === 'GET') {
      return sendJson(res, 200, applications.list({ status: url.searchParams.get('status') || undefined }));
    }

    if (url.pathname === '/api/applications' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const app = applications.create({ ...body, source: 'discord' });
      console.log(`[apply] Новая заявка из Discord: ${app.nickname}`);
      return sendJson(res, 201, app);
    }

    const decisionMatch = /^\/api\/applications\/([0-9a-f]{16})\/(approve|reject)$/.exec(url.pathname);
    if (decisionMatch && req.method === 'POST') {
      const [, id, action] = decisionMatch;
      const body = JSON.parse((await readBody(req)) || '{}');
      const decision = action === 'approve' ? 'approved' : 'rejected';
      const apply = action === 'approve' ? (app) => addToWhitelist(app.nickname) : undefined;
      const app = await applications.decide(id, decision, body.decidedBy, apply);
      console.log(`[apply] ${app.nickname}: ${decision} (${app.decidedBy || 'без имени'})`);
      return sendJson(res, 200, app);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return sendJson(res, err.status, { error: err.message, application: err.application });
    }
    if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'Некорректный JSON' });
    console.error('[api] Ошибка:', err);
    return sendJson(res, 502, { error: err.message });
  }
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
    return sendHtml(res, renderClientPage());
  }

  // README открыт без пароля: в нём только инструкция, адрес и версии.
  if (url.pathname === '/client/readme.txt' && (req.method === 'GET' || req.method === 'HEAD')) {
    const text = guideToText(clientGuide(guideOptions()));
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="README.txt"',
      'Cache-Control': 'no-store',
    });
    return res.end(req.method === 'HEAD' ? undefined : text);
  }

  if (url.pathname === '/apply' && req.method === 'GET') {
    return sendHtml(res, renderApplyForm());
  }

  if (url.pathname === '/apply' && req.method === 'POST') {
    return handleApplyPost(req, res);
  }

  const statusMatch = /^\/apply\/([0-9a-f]{16})$/.exec(url.pathname);
  if (statusMatch && req.method === 'GET') {
    const app = applications.get(statusMatch[1]);
    return app ? sendHtml(res, renderApplicationStatus(app)) : notFound(res, 'Заявка не найдена');
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
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
      notFoundMessage: 'client-pack.zip ещё не собран - проверь логи link-server (docker compose logs link-server) и наличие .jar в mods/',
      downloadName: 'minecraft-mods.zip',
      title: 'Моды для клиента',
      action: '/client/file',
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }

  return notFound(res, 'Not found');
});

// Пересобираем client-pack.zip на каждом старте контейнера - вместо ручного
// scripts/build-client-pack.sh на хосте. Не критично для работы сайта, поэтому
// ошибка здесь не должна мешать серверу запуститься (просто /client/file вернёт 404).
try {
  // CLIENT_PACK_PATH - в writable /app, а не в read-only /repo (см. docker-compose.yml).
  buildClientPack({ ...guideOptions(), outPath: CLIENT_PACK_PATH });
} catch (err) {
  console.error('[client-pack] Не удалось собрать client-pack.zip:', err.message);
}

server.listen(PORT, () => console.log(`link-server слушает на порту ${PORT}`));
