'use strict';
// Минимальная работа с zip на встроенном zlib - без zip/unzip из apt: на VPS нет доступа к
// deb.debian.org, так что образ link-server не должен ничего доставлять при сборке.
// Без zip64: архивы < 4 ГБ и < 65535 файлов, для модов и client-pack этого с запасом.
const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Содержимое одного файла из zip/jar или null, если его там нет. */
function readZipEntry(zipPath, entryName) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    // EOCD - в последних 22 байтах + до 64 КБ комментария архива.
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(`${zipPath}: не zip-архив`);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    for (let p = 0; p + 46 <= cdSize && cd.readUInt32LE(p) === CENTRAL_SIG; ) {
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (name !== entryName) continue;

      const local = Buffer.alloc(30);
      fs.readSync(fd, local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`${zipPath}: битый локальный заголовок ${name}`);
      const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const data = Buffer.alloc(compSize);
      fs.readSync(fd, data, 0, compSize, dataStart);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`${zipPath}: неподдерживаемое сжатие ${method} у ${name}`);
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Время/дата в формате MS-DOS для заголовков zip.
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Пишет zip из entries: [{ name: 'mods/a.jar', data: Buffer }]. .jar уже сжаты - их кладём
 * как есть (store), остальное (README) - deflate.
 */
function writeZip(outPath, entries) {
  const fd = fs.openSync(outPath, 'w');
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date());
  const write = (buf) => {
    fs.writeSync(fd, buf);
    offset += buf.length;
  };
  try {
    for (const { name, data } of entries) {
      const nameBuf = Buffer.from(name, 'utf8');
      const store = name.endsWith('.jar');
      const body = store ? data : zlib.deflateRawSync(data);
      const crc = zlib.crc32(data);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_SIG, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0800, 6); // флаг: имя в UTF-8
      local.writeUInt16LE(store ? 0 : 8, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);

      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(CENTRAL_SIG, 0);
      cdh.writeUInt16LE(20, 4); // version made by
      local.copy(cdh, 6, 4, 30); // version needed .. name length - те же поля
      cdh.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([cdh, nameBuf]));

      write(local);
      write(nameBuf);
      write(body);
    }

    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    write(cdBuf);
    write(eocd);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readZipEntry, writeZip };
