'use strict';
// Заявки на игру (whitelist): подаются с сайта или через Discord-бота, одобряются
// в боте. Хранятся одним JSON-файлом - заявок единицы, БД не нужна. Все операции
// синхронные, поэтому двое одобряющих, нажавших кнопку одновременно, не решат одну
// заявку дважды - второй получит уже принятое решение.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Ограничения ника в Minecraft; заодно исключает подстановку чего-либо в RCON-команду.
const NICKNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const MAX_TEXT = 200;
// Чтобы спам с сайта не завалил одобряющих личными сообщениями.
const MAX_PENDING = 30;

class ApplicationError extends Error {
  constructor(message, status = 400, application = null) {
    super(message);
    this.status = status;
    this.application = application;
  }
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function createApplicationStore({ filePath, isWhitelisted }) {
  function read() {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return [];
    }
  }

  function write(list) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf8');
  }

  function get(id) {
    return read().find((app) => app.id === id) || null;
  }

  function list({ status } = {}) {
    const all = read();
    return status ? all.filter((app) => app.status === status) : all;
  }

  /** source: 'site' | 'discord'; discordUserId/discordTag - только для заявок из бота. */
  function create({ nickname, contact, comment, source, discordUserId, discordTag }) {
    const nick = String(nickname ?? '').trim();
    if (!NICKNAME_RE.test(nick)) {
      throw new ApplicationError('Ник должен быть 3–16 символов: латиница, цифры и _.');
    }
    if (isWhitelisted(nick)) {
      throw new ApplicationError(`Ник ${nick} уже в whitelist — можно заходить.`, 409);
    }

    const all = read();
    const pending = all.filter((app) => app.status === 'pending');
    const duplicate = pending.find((app) => app.nickname.toLowerCase() === nick.toLowerCase());
    if (duplicate) {
      throw new ApplicationError(`Заявка на ник ${duplicate.nickname} уже ждёт решения.`, 409, duplicate);
    }
    if (pending.length >= MAX_PENDING) {
      throw new ApplicationError('Слишком много необработанных заявок, попробуй позже.', 429);
    }

    const application = {
      id: crypto.randomBytes(8).toString('hex'),
      nickname: nick,
      contact: cleanText(contact),
      comment: cleanText(comment),
      source,
      discordUserId: discordUserId || null,
      discordTag: discordTag || null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      decidedAt: null,
      decidedBy: null,
    };
    all.push(application);
    write(all);
    return application;
  }

  /**
   * Переводит заявку в approved/rejected. apply() вызывается перед сохранением
   * (добавление в whitelist через RCON): если он упал - заявка остаётся pending.
   */
  async function decide(id, decision, decidedBy, apply = async () => {}) {
    const application = get(id);
    if (!application) throw new ApplicationError('Заявка не найдена.', 404);
    if (application.status !== 'pending') {
      throw new ApplicationError('Заявка уже рассмотрена.', 409, application);
    }

    await apply(application);

    // Перечитываем после await: за время RCON-запроса заявку мог решить кто-то другой.
    const all = read();
    const current = all.find((app) => app.id === id);
    if (current.status !== 'pending') throw new ApplicationError('Заявка уже рассмотрена.', 409, current);
    current.status = decision;
    current.decidedAt = new Date().toISOString();
    current.decidedBy = cleanText(decidedBy) || null;
    write(all);
    return current;
  }

  return { get, list, create, decide };
}

module.exports = { createApplicationStore, ApplicationError, NICKNAME_RE };
