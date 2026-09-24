'use strict';
// Живой статус сервера для главной страницы через RCON (порт наружу не открыт, link-server
// ходит к mc внутри Docker-сети): онлайн ли, кто играет, игровой день и время, сложность.
// Результат кэшируется на CACHE_MS - главную и /status.json может дёргать много вкладок,
// а на каждую команду RCON открывается своё соединение.
const { rconCommand } = require('./rcon');

const CACHE_MS = 15 * 1000;
// Короткий таймаут: пока mc выключен или стартует, главная не должна висеть.
const TIMEOUT_MS = 2000;

const DIFFICULTY = { peaceful: 'Мирная', easy: 'Лёгкая', normal: 'Нормальная', hard: 'Сложная' };

const clean = (s) => String(s).replace(/§./g, '').trim();

// "There are 2 of a max of 20 players online: Steve, Alex"
function parseList(reply) {
  const m = /There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)$/is.exec(clean(reply));
  if (!m) return null;
  const players = m[3]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return { online: Number(m[1]), max: Number(m[2]), players };
}

// С 26.1 время - это «часы» мира: "time query time" -> "Clock minecraft:overworld is at
// 30555 tick(s)", общее число тиков с начала мира (старые "time query day/daytime" с
// "The time is N" больше не работают: day теперь таймлайн, daytime не существует).
const parseTime = (reply) => {
  const m = /(?:is at|time is) (\d+)/i.exec(clean(reply));
  return m ? Number(m[1]) : null;
};

// Тик 0 - 6:00 утра, 1000 тиков = 1 игровой час.
function describeDaytime(ticks) {
  const t = ticks % 24000;
  const hours = (Math.floor(t / 1000) + 6) % 24;
  const minutes = Math.floor(((t % 1000) * 60) / 1000);
  const clock = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  const isDay = t < 12500 || t >= 23500;
  return { clock, isDay };
}

function createStatusReader(rcon) {
  let cache = { at: 0, value: null, pending: null };

  const run = (command) => rconCommand({ ...rcon, command, timeoutMs: TIMEOUT_MS });

  async function fetchStatus() {
    try {
      const [list, time, difficulty] = await Promise.all([run('list'), run('time query time'), run('difficulty')]);
      const players = parseList(list);
      const ticks = parseTime(time);
      // 24000 тиков = игровые сутки; день считаем с 1, как в «День 1» у игроков.
      const dayNumber = ticks != null ? Math.floor(ticks / 24000) + 1 : null;
      const diff = /difficulty is (\w+)/i.exec(clean(difficulty));
      return {
        online: true,
        players: players ? players.online : null,
        maxPlayers: players ? players.max : null,
        playerNames: players ? players.players : [],
        day: dayNumber,
        ...(ticks != null ? describeDaytime(ticks) : { clock: null, isDay: null }),
        difficulty: diff ? DIFFICULTY[diff[1].toLowerCase()] || diff[1] : null,
      };
    } catch {
      // Любая ошибка RCON (контейнер выключен, ещё стартует, неверный пароль) = офлайн.
      return { online: false };
    }
  }

  /** Статус из кэша; параллельные запросы во время обновления ждут один и тот же опрос. */
  return function getStatus() {
    if (cache.value && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.value);
    if (!cache.pending) {
      cache.pending = fetchStatus().then((value) => {
        cache = { at: Date.now(), value, pending: null };
        return value;
      });
    }
    return cache.pending;
  };
}

module.exports = { createStatusReader };
