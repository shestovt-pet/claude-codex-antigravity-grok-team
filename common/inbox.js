'use strict';
// team-v46 п.7: входящие дирижёру. Хранилище state/inbox/<id>.json: текст, время, срок, автор и ответ.
// Автор запроса — по происхождению: поручение (MOST_JOB_ID → карточка + предки процесса) или чат-клиент.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { stateDir } = require('./paths');

function dir() { return path.join(stateDir, 'inbox'); }
function file(id) { return path.join(dir(), id + '.json'); }
const SAFE = /^[a-zA-Z0-9_-]{1,80}$/;

function read(id) {
  if (!SAFE.test(id || '')) return null;
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function atomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, target);
}
function save(entry) { atomic(file(entry.id), entry); return entry; }
function list() {
  let names; try { names = fs.readdirSync(dir()); } catch { return []; }
  return names.filter(n => /^[a-zA-Z0-9_-]{1,80}\.json$/.test(n))
    .map(n => read(n.slice(0, -5))).filter(Boolean)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
function expired(e, now = Date.now()) { return Number.isFinite(Date.parse(e.deadline)) && Date.parse(e.deadline) <= now; }
function pending(now = Date.now()) { return list().filter(e => e.status === 'open' && !expired(e, now)); }

// Происхождение автора запроса. Поручение — по карточке и предкам (byAncestors=false — отказ); чат — MOST_CLIENT.
function author(opts = {}) {
  const id = process.env.MOST_JOB_ID;
  if (!id) {
    const client = require('./access').client();
    return client && client !== 'job' ? { kind: 'chat', client } : { error: 'нет клиента запроса' };
  }
  try {
    const p = require('./job-chain').parent(require('./job-chain').cards(), opts.ancestors);
    if (p.error) return { error: p.error };
    if (!p.byAncestors) return { error: 'номер поручения верный, процесса среди предков нет' };
    return { kind: 'job', id, job: p.job };
  } catch (e) { return { error: e.message }; }
}

// Срок запроса: из поручения — min(ttl_min, остаток срока поручения − 2 мин); из чата — ttl_min (по умолчанию 24 ч).
function askDeadline(a, auth, now = Date.now()) {
  const ttl = Number.isFinite(a.ttl_min) && a.ttl_min > 0 ? a.ttl_min * 60000 : null;
  if (auth.kind === 'chat') return new Date(now + (ttl || 24 * 3600000)).toISOString();
  const remaining = require('./chain-deadline').parentRemainingMs(auth.job, auth.job?.member, now);
  // team-v48 «нет срока»: остаток родителя null → запрос без срока (deadline=null) либо только ttl_min, если задан.
  if (remaining == null) return ttl == null ? null : new Date(now + ttl).toISOString();
  const dl = now + remaining;
  const fromParent = dl - now - 2 * 60000;
  const budget = ttl == null ? fromParent : Math.min(ttl, fromParent);
  return new Date(now + Math.max(0, budget)).toISOString();
}

// Строка «Входящие дирижёру» для public-transport.decorate (только клиенту claude, не в сохранённый результат).
function banner(now = Date.now()) {
  const p = pending(now);
  if (!p.length) return '';
  const oldestMin = Math.max(0, Math.floor((now - Date.parse(p[0].at)) / 60000));
  return 'Входящие дирижёру: ' + p.length + ' (старейший — ' + oldestMin + ' мин)';
}

function whoText(author) {
  const members = require('./members');
  const key = author?.kind === 'chat' ? author.client : (author?.member || author?.from || author?.id);
  return members.names[key] || key || 'неизвестно';
}

function notify(auth, text) {
  const first = String(text || '').slice(0, 80);
  require('./notify').notify('Запрос дирижёру от ' + whoText(auth), first);
}

// team-v48c: вывод срока запроса. deadline=null — «без срока» (поручение без срока и без ttl_min).
function deadlineText(e) { return Number.isFinite(Date.parse(e && e.deadline)) ? String(e.deadline) : 'без срока'; }
function waitText(e, now = Date.now()) {
  const t = Date.parse(e && e.deadline);
  if (!Number.isFinite(t)) return 'ждёт дирижёра, без срока';
  return 'ждёт дирижёра ' + Math.max(0, Math.floor((t - now) / 60000)) + ' мин';
}

module.exports = { deadlineText, waitText, dir, file, read, save, list, pending, expired, author, askDeadline, banner, whoText, notify };
