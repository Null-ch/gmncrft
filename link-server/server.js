'use strict';
// Минимальный HTTP-сервер без зависимостей: главная страница с инфо о сервере/модах,
// страница /backup, инструкция установки клиента /client (+ /client/readme.txt),
// и сами файлы (/backup/file, /client/file - архив README.txt + моды) - защищены
// своей формой пароля в стиле сайта (не нативным browser-alert Basic Auth, его нельзя
// стилизовать). Пароль бот тоже умеет передавать напрямую заголовком (без формы).
// Ссылки бессрочные: /backup/file всегда резолвит САМЫЙ НОВЫЙ файл в BACKUP_DIR.
// Плюс заявки на игру (/apply с сайта, /api/applications для Discord-бота): одобренный
// ник добавляется в whitelist через RCON - контейнер mc в той же Docker-сети. Через RCON
// же главная показывает живой статус сервера (status.js, /status.json для автообновления).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildClientPack, clientGuide, guideToText, minLoaderVersion, listModJars } = require('./build-client-pack');
const { rconCommand } = require('./rcon');
const { createApplicationStore, ApplicationError } = require('./applications');
const { createStatusReader } = require('./status');

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
// Настройки игры из того же .env, что и у mc - только для показа на главной.
const GAME = {
  mode: process.env.GAME_MODE || 'survival',
  pvp: process.env.PVP !== 'false',
  onlineMode: process.env.ONLINE_MODE !== 'false',
  maxPlayers: Number(process.env.MAX_PLAYERS || 20),
};
const GAME_MODES = { survival: 'Выживание', creative: 'Творческий', adventure: 'Приключение', spectator: 'Наблюдатель' };

const getServerStatus = createStatusReader(RCON);

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
  /* Кнопки главной: заявка на всю ширину, под ней две в ряд (на узком экране - столбиком). */
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px; }
  .actions .btn { margin: 0; display: flex; align-items: center; justify-content: center; text-align: center; }
  .actions .btn.primary { grid-column: 1 / -1; }
  @media (max-width: 480px) { .actions { grid-template-columns: 1fr; } }
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
  .guide ul { margin: 0; padding-left: 18px; }

  /* Живой статус сервера (RCON), обновляется скриптом раз в 30 секунд. */
  .status-box {
    background: #2b2b2b;
    border: 2px solid #000;
    box-shadow: inset 2px 2px 0 #444, inset -2px -2px 0 #1a1a1a;
    padding: 12px;
    margin: 0 0 14px;
    text-align: left;
  }
  .status-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .status-badge { font-size: 15px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; text-shadow: 1px 1px 0 #000; }
  .status-badge .dot { display: inline-block; width: 10px; height: 10px; margin-right: 8px; border: 2px solid #000; vertical-align: middle; }
  .status-box.online .status-badge { color: #7CFC00; }
  .status-box.online .dot { background: #7CFC00; animation: blink 2s steps(1) infinite; }
  .status-box.offline .status-badge { color: #ff8a8a; }
  .status-box.offline .dot { background: #ff5555; }
  @keyframes blink { 50% { background: #3d6b26; } }
  .status-players { color: #fff; font-size: 20px; font-weight: bold; text-shadow: 2px 2px 0 #000; }
  .status-players small { color: #aaa; font-size: 13px; font-weight: normal; text-shadow: none; }
  .bar { height: 12px; margin: 10px 0 8px; background: #1a1a1a; border: 2px solid #000; }
  .bar > span { display: block; height: 100%; background: repeating-linear-gradient(90deg, #7CFC00 0 8px, #5fcf00 8px 16px); }
  .status-meta { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    background: #3a3a3a;
    border: 2px solid #000;
    color: #ddd;
    font-size: 12px;
    padding: 3px 8px;
  }
  .chip.player { color: #ffcf4d; }
  .status-note { color: #aaa; font-size: 12px; margin-top: 8px; }

  .section-title {
    color: #fff;
    font-size: 15px;
    text-transform: uppercase;
    letter-spacing: 1px;
    text-shadow: 2px 2px 0 #2b2b2b;
    margin: 18px 0 8px;
    text-align: left;
  }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 6px; }
  .stat { background: #2b2b2b; border: 2px solid #000; padding: 8px 4px; }
  .stat b { display: block; color: #7CFC00; font-size: 18px; text-shadow: 1px 1px 0 #000; }
  .stat span { color: #aaa; font-size: 11px; text-transform: uppercase; }
  @media (max-width: 420px) { .stats { grid-template-columns: repeat(2, 1fr); } }

  /* Адрес сервера: клик копирует его в буфер обмена. */
  .copy {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-weight: bold;
    color: #7CFC00;
    cursor: pointer;
    text-align: right;
    word-break: break-all;
  }
  .copy::after { content: ' ⧉'; color: #aaa; }
  .copy:hover { text-decoration: underline dotted; }
  .copy.copied::after { content: ' ✔'; color: #7CFC00; }
  .server .copy { text-align: center; font-weight: normal; font-size: 14px; }

  /* Сворачиваемый список модов: сводка - тёмная плашка со значком-кнопкой. */
  details.mods-box { margin: 14px 0; text-align: left; }
  details.mods-box > summary {
    list-style: none;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #2b2b2b;
    border: 2px solid #000;
    padding: 8px 10px;
    cursor: pointer;
    user-select: none;
  }
  details.mods-box > summary::-webkit-details-marker { display: none; }
  details.mods-box > summary .mods-title { margin: 0; }
  .toggle {
    width: 26px;
    height: 26px;
    line-height: 20px;
    text-align: center;
    background: #6b6b6b;
    border: 2px solid #000;
    box-shadow: inset 2px 2px 0 #b1b1b1, inset -2px -2px 0 #373737;
    color: #fff;
    font-size: 16px;
    font-weight: bold;
    text-shadow: 1px 1px 0 #000;
  }
  .toggle::before { content: '+'; }
  details[open] > summary .toggle::before { content: '−'; }
  details.mods-box > summary:hover .toggle { background: #7d7d7d; }
  details.mods-box .mods { margin: 0; border-top: 0; }

  .to-top {
    position: fixed;
    right: 16px;
    bottom: 16px;
    width: 48px;
    height: 48px;
    margin: 0;
    padding: 0;
    font-size: 20px;
    line-height: 1;
    opacity: 0;
    pointer-events: none;
    transform: translateY(8px);
    transition: opacity .2s, transform .2s;
    z-index: 10;
  }
  .to-top.visible { opacity: 1; pointer-events: auto; transform: none; }
  .btn:hover { background: #7d7d7d; }
  .btn.secondary:hover { background: #5a5a5a; }

  .toast {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translate(-50%, 16px);
    background: #1f4a1f;
    border: 3px solid #000;
    box-shadow: 4px 4px 0 rgba(0,0,0,.4);
    color: #7CFC00;
    font-size: 14px;
    font-weight: bold;
    padding: 10px 16px;
    opacity: 0;
    pointer-events: none;
    transition: opacity .2s, transform .2s;
    z-index: 11;
  }
  .toast.visible { opacity: 1; transform: translate(-50%, 0); }
`;

// Общий скрипт всех страниц: кнопка «Наверх» (появляется, когда страницу пролистали)
// и копирование адреса сервера по клику. navigator.clipboard работает только по HTTPS
// (сайт за caddy) - на http://localhost при разработке срабатывает запасной execCommand.
const UI_SCRIPT = `
(function () {
  var toTop = document.querySelector('.to-top');
  var toast = document.querySelector('.toast');
  var toastTimer;
  function onScroll() { toTop.classList.toggle('visible', window.scrollY > 200); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('visible'); }, 1800);
  }
  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(area);
    return ok ? Promise.resolve() : Promise.reject();
  }
  document.addEventListener('click', function (event) {
    var button = event.target.closest('.copy');
    if (!button) return;
    var text = button.getAttribute('data-copy');
    var copy = navigator.clipboard && window.isSecureContext
      ? navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); })
      : fallbackCopy(text);
    copy.then(function () {
      button.classList.add('copied');
      setTimeout(function () { button.classList.remove('copied'); }, 1800);
      showToast('Адрес скопирован: ' + text);
    }, function () { showToast('Не удалось скопировать — выдели адрес вручную'); });
  });
})();
`;

// Адрес сервера, который копируется по клику (см. UI_SCRIPT).
const copyAddress = () =>
  `<button type="button" class="copy" data-copy="${esc(SERVER_ADDRESS)}" title="Нажми, чтобы скопировать">${esc(SERVER_ADDRESS)}</button>`;

// Сворачиваемый список модов (по умолчанию свёрнут), внутри - прокручиваемый блок.
function modsDetails(title, mods) {
  if (!mods.length) return '';
  return `<details class="mods-box">
      <summary><span class="mods-title">${esc(title)} (${mods.length})</span><span class="toggle" aria-hidden="true"></span></summary>
      <div class="mods"><ul>${mods.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>
    </details>`;
}

const HOME_LINK = '<div class="nav"><a class="btn secondary" href="/">← На главную</a></div>';

// wide - для длинных страниц (инструкция на /client), остальным хватает узкой карточки.
// script - дополнительный JS страницы (выполняется после общего UI_SCRIPT).
function page(title, body, { wide = false, script = '' } = {}) {
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
  <button type="button" class="btn to-top" aria-label="Наверх" title="Наверх">▲</button>
  <div class="toast" role="status" aria-live="polite"></div>
  <script>${UI_SCRIPT}${script}</script>
</body>
</html>`;
}

const plural = (n, one, few, many) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

// Внутренность блока статуса - и для первой отрисовки, и для обновления скриптом
// (/status.json отдаёт готовый HTML, чтобы разметка жила в одном месте).
function renderStatusInner(status) {
  if (!status.online) {
    return `<div class="status-head">
        <span class="status-badge"><span class="dot"></span>Офлайн</span>
        <span class="status-players">— <small>/ ${GAME.maxPlayers}</small></span>
      </div>
      <div class="status-note">Сервер выключен или перезапускается — загляни через пару минут.</div>`;
  }
  const max = status.maxPlayers || GAME.maxPlayers;
  const online = status.players ?? 0;
  const fill = max ? Math.min(100, Math.round((online / max) * 100)) : 0;
  const meta = [
    status.day != null ? `<span class="chip">📅 День ${status.day}</span>` : '',
    status.clock ? `<span class="chip">${status.isDay ? '☀' : '☾'} ${esc(status.clock)}</span>` : '',
    status.difficulty ? `<span class="chip">⚔ ${esc(status.difficulty)}</span>` : '',
  ].join('');
  const players = status.playerNames.length
    ? status.playerNames.map((name) => `<span class="chip player"> ${esc(name)}</span>`).join('')
    : '<span class="status-note" style="margin:0">Сейчас никого нет — стань первым!</span>';
  return `<div class="status-head">
        <span class="status-badge"><span class="dot"></span>Онлайн</span>
        <span class="status-players">${online} <small>/ ${max} ${plural(max, 'игрок', 'игрока', 'игроков')}</small></span>
      </div>
      <div class="bar"><span style="width:${fill}%"></span></div>
      <div class="status-meta">${meta}</div>
      <div class="section-title" style="font-size:12px;margin:10px 0 6px">Сейчас играют</div>
      <div class="status-meta">${players}</div>`;
}

// Раз в 30 секунд подтягивает свежий статус без перезагрузки страницы.
const STATUS_SCRIPT = `
(function () {
  var box = document.getElementById('status');
  setInterval(function () {
    if (document.hidden) return;
    fetch('/status.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        box.className = 'status-box ' + (data.online ? 'online' : 'offline');
        box.innerHTML = data.html;
      })
      .catch(function () {});
  }, 30000);
})();
`;

function renderHomePage(status) {
  const { mcVersion } = parseFabricVersion(FABRIC_LAUNCHER_FILE);
  const modJars = listModJars(MODS_DIR);
  // Показываем минимум для клиента (из модов), а не версию loader'а сервера - см. minLoaderVersion.
  const minLoader = minLoaderVersion(MODS_DIR, modJars);
  const mods = listMods();
  const hasMod = (prefix) => modJars.some((jar) => jar.toLowerCase().startsWith(prefix));

  // Особенности собираются из настроек и списка модов - чтобы не врать, если что-то убрали.
  const features = [
    `${mods.length} ${plural(mods.length, 'мод', 'мода', 'модов')} на Fabric: новые структуры, мобы, предметы и декор`,
    hasMod('mca-') && 'Живые жители Minecraft Comes Alive — с ними можно дружить, торговать и даже создать семью',
    hasMod('waystones') && 'Путевые камни (Waystones) для быстрых перемещений по миру',
    hasMod('xaerominimap') && 'Мини-карта и карта мира Xaero',
    GAME.pvp ? 'PvP включено — будь осторожен вдали от дома' : 'PvP выключено — игроки не могут атаковать друг друга',
    'Whitelist: играют только одобренные игроки',
    !GAME.onlineMode && 'Лицензия не нужна — можно заходить через T-Launcher',
  ].filter(Boolean);

  return page(
    MOTD,
    `    <h1>${esc(MOTD)}</h1>
    <p class="subtitle">Fabric-сервер Minecraft — присоединяйся!</p>

    <div id="status" class="status-box ${status.online ? 'online' : 'offline'}">${renderStatusInner(status)}</div>

    <div class="info-row"><span>Адрес сервера</span>${copyAddress()}</div>
    <div class="info-row"><span>Версия Minecraft</span><b>${esc(mcVersion)}</b></div>
    ${minLoader ? `<div class="info-row"><span>Версия Fabric Loader</span><b>${esc(minLoader)}</b></div>` : ''}
    <div class="info-row"><span>Режим игры</span><b>${esc(GAME_MODES[GAME.mode] || GAME.mode)}</b></div>

    <div class="stats">
      <div class="stat"><b>${mods.length}</b><span>${plural(mods.length, 'мод', 'мода', 'модов')}</span></div>
      <div class="stat"><b>${status.online ? status.players ?? 0 : '—'}</b><span>онлайн</span></div>
      <div class="stat"><b>${status.online && status.day != null ? status.day : '—'}</b><span>игровой день</span></div>
    </div>

    <div class="actions">
      <a class="btn primary" href="/apply">Подать заявку на игру</a>
      <a class="btn" href="/client">Установка клиента и моды</a>
      <a class="btn" href="/backup">Скачать бэкап мира</a>
    </div>
    <div class="lock">🔒 Для скачивания файлов нужен пароль — спроси у администратора сервера.</div>

    <div class="section-title">Как начать играть</div>
    <div class="guide"><ol>
      <li>Подай <a href="/apply">заявку</a> со своим ником и дождись одобрения администратора.</li>
      <li>Поставь Fabric ${esc(mcVersion)} и моды из архива — пошагово на странице <a href="/client">установки клиента</a>.</li>
      <li>В игре: «Сетевая игра» → «Добавить сервер» → адрес ${copyAddress()}</li>
    </ol></div>

    <div class="section-title">Особенности сервера</div>
    <div class="guide"><ul>${features.map((f) => `<li>${f}</li>`).join('')}</ul></div>

    ${modsDetails('Установленные моды', mods)}

    <p class="tip">Совет: на сервере включён whitelist — сначала подай заявку со своим ником, после одобрения можно заходить.</p>`,
    { script: STATUS_SCRIPT },
  );
}

// Скачивание запускается автоматически; кнопка остаётся как ручной запасной вариант.
// Ведёт на /backup/file, где встретит форму пароля (см. renderPasswordForm).
function renderLandingPage({ title, subtitle, tip, downloadPath, buttonLabel }) {
  return page(
    title,
    `    <h1>${esc(title)}</h1>
    <p class="subtitle">${esc(subtitle)}</p>
    <a class="btn" id="dl" href="${esc(downloadPath)}">${esc(buttonLabel)}</a>
    <div class="server">Адрес сервера: ${copyAddress()}</div>
    <p class="tip">Совет: ${esc(tip)}</p>
    ${HOME_LINK}`,
    {
      script: `
    window.addEventListener('load', function () {
      window.location.href = ${JSON.stringify(downloadPath)};
    });`,
    },
  );
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
    .map(([k, v]) => `<div class="info-row"><span>${esc(k)}</span>${v === SERVER_ADDRESS ? copyAddress() : `<b>${esc(v)}</b>`}</div>`)
    .join('');
  const sections = guide.sections
    .map(
      (section) => `<div class="guide"><div class="mods-title">${esc(section.title)}</div><ol>${section.steps
        .map((step) => `<li>${linkify(step)}</li>`)
        .join('')}</ol></div>`,
    )
    .join('');
  const modsList = modsDetails('В архиве: моды', guide.mods);
  return page(
    'Установка клиента',
    `    <h1>Установка клиента</h1>
    <p class="subtitle">${esc(guide.intro)}</p>
    ${facts}
    <a class="btn" href="/client/file">Скачать архив (моды + README)</a>
    <a class="btn" href="/client/readme.txt">Только README.txt</a>
    <div class="lock">🔒 Для скачивания архива нужен пароль — спроси у администратора сервера.</div>
    ${sections}
    ${modsList}
    ${HOME_LINK}`,
    { wide: true },
  );
}

// Своя форма пароля вместо нативного Basic Auth диалога браузера - тот стилизовать нельзя.
function renderPasswordForm({ title, action, error }) {
  return page(
    title,
    `    <h1>${esc(title)}</h1>
    <p class="subtitle">Введи пароль, чтобы скачать файл.</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form method="POST" action="${esc(action)}">
      <input type="password" name="password" placeholder="Пароль" autofocus required>
      <button class="btn" type="submit">Скачать</button>
    </form>
    <div class="lock">🔒 Пароль знает тот, кто настраивал сервер (его же печатает Discord-бот).</div>
    ${HOME_LINK}`,
  );
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
    ${app.status === 'approved' ? `<div class="server">Адрес сервера: ${copyAddress()}</div>` : ''}
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
    return getServerStatus().then((status) => sendHtml(res, renderHomePage(status)));
  }

  // Для автообновления блока статуса на главной (STATUS_SCRIPT).
  if (url.pathname === '/status.json' && req.method === 'GET') {
    return getServerStatus().then((status) =>
      sendJson(res, 200, {
        online: status.online,
        players: status.online ? status.players : null,
        maxPlayers: status.online ? status.maxPlayers : GAME.maxPlayers,
        html: renderStatusInner(status),
      }),
    );
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
