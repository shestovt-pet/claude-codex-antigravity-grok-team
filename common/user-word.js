'use strict';
// Слово пользователя «X отвалился» (team-v18, К1): журнал только дописывается, под замком; правок и удалений нет.
// team-v19 (К1): в том же журнале — записи о Claude (record, return, handover, conductor); прежние читатели их пропускают.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { stateDir } = require('./paths');
const locks = require('./locks');
const DAY = 24 * 3600000;
const WHO = ['codex', 'antigravity', 'grok'];
const NAMES = { codex: 'Codex', antigravity: 'Antigravity', grok: 'Grok', claude: 'Claude' };
const KINDS = ['record', 'return', 'handover', 'conductor'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Один источник пути журнала для записи и чтения во всех местах (team_word, ворота этапа, workflow, team_change):
// state\team\words.jsonl хранилища состояния, независимо от папки карточек конкретного экземпляра Team.
const dir = () => path.join(stateDir, 'team');
const file = () => path.join(dir(), 'words.jsonl');
// Время — числом: ISO-строка, число или Date приводятся к миллисекундам (NaN — неизвестно).
const ms = at => at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);

// Все разобранные записи журнала. Неполная строка (сбой посреди записи) пропускается: остальные записи целы.
function lines() {
  const f = file();
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try {
      const r = JSON.parse(line);
      return r && typeof r.id === 'string' && Number.isFinite(Date.parse(r.at)) ? [r] : [];
    } catch { return []; }
  });
}
// Слова о помощниках (правила team-v18).
function read() {
  return lines().filter(r => WHO.includes(r.who_down) && (r.kind === undefined || r.kind === 'record') && typeof r.quote === 'string' && r.quote.trim());
}
// Записи о Claude: слово, возврат, остановка дирижёра, смена дирижёра.
function claudeEntries() {
  return lines().filter(r => r.who_down === 'claude' && KINDS.includes(r.kind) && (r.kind === 'handover' || (typeof r.quote === 'string' && r.quote.trim())));
}
// Состояние запасного режима на момент at (К1, Р-в): активен, если после последнего return есть слово о Claude; без предела
// в сутки. Дирижёр — записавший первое слово после return; запись conductor его меняет; handover — остановка дирижёра.
function mode(at = Date.now()) {
  const t = ms(at);
  let cur = null, last = null;
  for (const r of claudeEntries().filter(r => Date.parse(r.at) <= t)) {
    // Запись участника режим не включает: она пишется только при действующем режиме (Codex 1c35bf39 п. 3).
    if (r.kind === 'record' && !cur && !r.participant) cur = { active: true, word: r, since: r.at, conductor: r.recorded_by, owner: r.owner, fingerprint: r.fingerprint, entry: r, handover: null };
    else if (r.kind === 'conductor' && cur) Object.assign(cur, { conductor: r.conductor, owner: r.owner, fingerprint: r.fingerprint, entry: r, handover: null });
    else if (r.kind === 'handover' && (cur || last)) (cur || last).handover = r;
    else if (r.kind === 'return' && cur) { last = { ...cur, active: false, returned: r, handover: null }; cur = null; }
  }
  return cur || last || { active: false };
}
// Дописывание строки; вызывается только под замком журнала.
function write(entry) {
  const r = { id: 'word-' + crypto.randomUUID(), at: new Date().toISOString(), ...entry };
  const fd = fs.openSync(file(), 'a');
  try { fs.writeSync(fd, JSON.stringify(r) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return r;
}
async function append(entry) {
  return locked(async () => write(entry));
}
// Переход режима (team-v19, Codex 1c35bf39 п. 3): проверка текущего режима и запись — под одним замком журнала.
async function transact(fn) {
  return locked(async () => fn({ mode, write }));
}

async function locked(fn) {
  fs.mkdirSync(dir(), { recursive: true });
  let lock;
  for (let n = 0; n < 150; n++) {
    lock = await locks.tryLock('team_words', path.resolve(file()));
    if (lock.ok) break;
    if (!lock.busy) throw Error('Не удалось открыть журнал слов: ' + (lock.error || 'замок'));
    await sleep(50);
  }
  if (!lock?.ok) throw Error('Журнал слов занят.');
  try { return await fn(); } finally { await lock.release(); }
}

// Успешное поручение — завершено с проверенным ответом (для Grok — подписанным); отменённые, потерянные, пустые не считаются.
function finished(j) { return Date.parse(j.finishedAt || j.appliedAt || ''); }
function success(who, from, until) {
  from = ms(from); until = ms(until);
  const stores = require('./team-store');
  const found = stores.list(who, false).jobs.filter(j => ['done', 'applied'].includes(j.status) && !j.cancelled && !j.lateHash && !j.test &&
    finished(j) > from && finished(j) <= until).sort((a, b) => finished(a) - finished(b));
  for (const j of found) {
    try { if (stores.source(who, j.id).trim()) return j; } catch {}
  }
  return null;
}

// Запись действует на момент at: не позже at, младше суток, после неё до at у участника нет успешного поручения.
function holds(r, at = Date.now()) {
  const t = ms(at), from = ms(r?.at);
  return Boolean(r) && Number.isFinite(t) && Number.isFinite(from) && from <= t && t - from < DAY && !success(r.who_down, from, t);
}
// Действующее слово о who на момент at (последнее из действующих).
function active(who, at = Date.now()) {
  return read().filter(r => r.who_down === who).reverse().find(r => holds(r, at)) || null;
}
// Последняя запись о who не позже at (действующая или нет).
function latest(who, at = Date.now()) {
  const t = ms(at);
  return read().filter(r => r.who_down === who && Date.parse(r.at) <= t).at(-1) || null;
}
function byId(id) {
  return read().find(r => r.id === id) || null;
}

const two = n => String(n).padStart(2, '0');
function local(ms) {
  const d = new Date(ms);
  return two(d.getHours()) + ':' + two(d.getMinutes()) + ' ' + two(d.getDate()) + '.' + two(d.getMonth() + 1);
}
function line(r) {
  return 'Записал: „' + r.quote + '“ — недоступен ' + NAMES[r.who_down] + ' до первого его успешного ответа, но не дольше суток (до ' +
    local(Date.parse(r.at) + DAY) + ')';
}

// Слово о помощнике. Из чата Claude — как в team-v18; в запасном режиме — от гостя-чата (дирижёр или слово о дирижёре, К1).
// Строка слова о помощнике (без записи): права и поля.
function entry(a) {
  require('./access').guard('team', 'team_word', { ...a, action: 'record' });
  if (require('./access').guest() && !require('./fallback').helperAllowed(a)) throw Error('Гостю это действие запрещено: слово о помощнике записывает чат Claude; в запасном режиме — дирижёр.');
  if (!WHO.includes(a.who_down)) throw Error('who_down: codex, antigravity или grok.');
  if (typeof a.quote !== 'string' || !a.quote.trim()) throw Error('Нужно слово пользователя дословно (quote).');
  const client = require('./access').client();
  return { who_down: a.who_down, quote: a.quote, source: 'chat-' + (require('./access').guest() ? client : 'claude'), recorded_by: client, ...(a.owner ? { owner: a.owner } : {}) };
}
async function record(a) {
  const r = await append(entry(a));
  return { record: r, text: line(r) };
}

function listText(now = Date.now()) {
  const rows = read(), m = mode(now);
  const fallback = claudeEntries().map(r => local(Date.parse(r.at)) + ' · Claude · ' + ({ record: 'слово', return: 'возврат', handover: 'дирижёр остановился', conductor: 'смена дирижёра' }[r.kind]) +
    (r.quote ? ' „' + r.quote + '“' : '') + (r.recorded_by || r.conductor || r.by ? ' · ' + NAMES[r.conductor || r.recorded_by || r.by] : '') + ' · ' + r.id);
  if (!rows.length && !fallback.length) return 'Записей слова нет.';
  return [...(fallback.length ? ['Запасной режим: ' + (m.active ? 'действует, дирижёр ' + NAMES[m.conductor] : 'не действует'), ...fallback] : []), ...rows.map(r => {
    const at = Date.parse(r.at), back = success(r.who_down, at, now);
    const state = back ? 'не действует: успешный ответ ' + back.id
      : now - at >= DAY ? 'истекло' : 'действует до ' + local(at + DAY);
    return local(at) + ' · ' + NAMES[r.who_down] + ' · „' + r.quote + '“ · ' + state + ' · ' + r.id;
  })].join('\n');
}

module.exports = { DAY, NAMES, dir, file, ms, lines, read, claudeEntries, mode, append, transact, entry, holds, active, latest, byId, success, record, line, local, listText };
