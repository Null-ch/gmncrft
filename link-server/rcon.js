'use strict';
// Минимальный RCON-клиент (протокол Source RCON, который использует Minecraft) без
// зависимостей: одно соединение на одну команду - заявки одобряют редко, пул не нужен.
const net = require('net');

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;
const TYPE_AUTH_RESPONSE = 2;
const AUTH_ID = 1;
const COMMAND_ID = 2;

function encodePacket(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(14 + payload.length);
  packet.writeInt32LE(10 + payload.length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  // Два завершающих нуля (конец строки + пустая строка) уже есть в Buffer.alloc.
  return packet;
}

/** Выполняет одну команду и возвращает текстовый ответ сервера. */
function rconCommand({ host, port, password, command, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;

    function finish(error, result) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }

    socket.setTimeout(timeoutMs, () => finish(new Error(`RCON ${host}:${port} не ответил за ${timeoutMs} мс`)));
    socket.on('error', (err) => finish(new Error(`RCON ${host}:${port}: ${err.message}`)));
    socket.on('close', () => finish(new Error('RCON закрыл соединение, не ответив')));
    socket.on('connect', () => socket.write(encodePacket(AUTH_ID, TYPE_AUTH, password)));

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.length < 4 + length) return;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.toString('utf8', 12, 4 + length - 2);
        buffer = buffer.subarray(4 + length);

        if (type === TYPE_AUTH_RESPONSE) {
          if (id === -1) return finish(new Error('RCON: неверный пароль (RCON_PASSWORD)'));
          socket.write(encodePacket(COMMAND_ID, TYPE_COMMAND, command));
        } else if (id === COMMAND_ID) {
          return finish(null, body);
        }
      }
    });
  });
}

module.exports = { rconCommand };
