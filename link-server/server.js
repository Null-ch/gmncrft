'use strict';
// Минимальный HTTP-сервер без зависимостей: отдаёт по токену два файла -
// самый свежий бэкап мира и собранный клиент-пак (Forge + моды).
// Ссылки бессрочные: /latest всегда резолвит САМЫЙ НОВЫЙ файл в BACKUP_DIR на момент запроса.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.TOKEN;
const BACKUP_DIR = process.env.BACKUP_DIR || '/repo/backups';
const CLIENT_PACK_PATH = process.env.CLIENT_PACK_PATH || '/repo/client-pack.zip';

if (!TOKEN) {
  console.error('TOKEN не задан - без него сервер не может проверять доступ. Останавливаюсь.');
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

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400);
    return res.end();
  }

  if (url.searchParams.get('token') !== TOKEN) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }

  if (url.pathname === '/latest') {
    const latest = findLatestBackup();
    if (!latest) return notFound(res, 'Бэкапов пока нет');
    return sendFile(req, res, latest.full, 'minecraft-backup-latest.tar.gz');
  }

  if (url.pathname === '/client') {
    if (!fs.existsSync(CLIENT_PACK_PATH)) {
      return notFound(res, 'client-pack.zip ещё не собран - запусти scripts/build-client-pack.sh на сервере');
    }
    return sendFile(req, res, CLIENT_PACK_PATH, 'minecraft-client-pack.zip');
  }

  return notFound(res, 'Not found');
});

server.listen(PORT, () => console.log(`link-server слушает на порту ${PORT}`));
