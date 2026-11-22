'use strict';
// Слово пользователя «X отвалился» (team-v18, К1): журнал только дописывается, под замком; правок и удалений нет.
// team-v19 (К1): в том же журнале — записи о Claude (record, return, handover, conductor); прежние читатели их пропускают.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { stateDir } = require('./paths');
const locks = require('./locks');
const DAY = 24 * 3600000;
const WHO = require('./members').dynamic(() => [...new Set([...require('./members').seatIds, ...require('./members').fallbackIds])], true);
const NAMES = require('./members').names;
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
  const historical = new Set([...require('./members').all().map(m => m.id), 'grok']);
  return lines().filter(r => r.who_down !== 'claude' && historical.has(r.who_down) && (r.kind === undefined || r.kind === 'record') && typeof r.quote === 'string' && r.quote.trim());
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
  const access = require('./access');
  // team-v58: признак поручения — первым; из поручения слово человека не пишется.
  if (access.jobSession()) throw Error('Слово пользователя записывает чат участника; из поручения запрещено.');
  access.guard('team', 'team_word', { ...a, action: 'record' });
  // team-v58: чат любого участника записывает слово о помощнике как чат Claude (слово человека); в запасном режиме
  // прежний путь гостя (дирижёр/слово о дирижёре) ведёт fallback.helperWord до вызова record.
  if (access.guest() && !access.chatSession() && !require('./fallback').helperAllowed(a)) throw Error('Гостю это действие запрещено: слово о помощнике записывает чат Claude; в запасном режиме — дирижёр.');
  if (a.who_down !== 'grok') require('./members').assertAvailable(a.who_down);
  if (!WHO.includes(a.who_down)) throw Error('who_down: нужен голосующий помощник или запасной дирижёр из team_status.');
  if (typeof a.quote !== 'string' || !a.quote.trim()) throw Error('Нужно слово пользователя дословно (quote).');
  const client = access.client();
  return { who_down: a.who_down, quote: a.quote, source: 'chat-' + client, recorded_by: client, ...(a.owner ? { owner: a.owner } : {}) };
}
async function record(a) {
  const r = await append(entry(a));
  return { record: r, text: line(r) };
}

// Запись остановки: поиск и дописывание под тем же замком журнала.
async function recordStopConfirmation(job_ids, quote, apply = async r => r) {
  // team-v58 (task10 а): слово владельца пишет ТОЛЬКО доказанный чат (chatSession). Поручение — первым; недоказанный сеанс
  // (подмена MOST_CLIENT, сброс MOST_JOB_ID) слово не пишет. Запасной режим доказанный чат не ограничивает. source — клиент чата.
  const acc = require('./access');
  if (acc.jobSession()) throw Error('Подтверждение остановки записывает чат участника; из поручения запрещено.');
  if (!acc.chatSession()) throw Error('Подтверждение остановки записывает доказанный чат участника; происхождение чата не доказано: ' + acc.chatOriginReason() + '.');
  const client = acc.client();
  return locked(async () => {
    const ids = [...new Set(job_ids)].sort();
    const record = lines().find(r => r.kind === 'stop_confirm' && r.quote === quote && JSON.stringify(r.job_ids) === JSON.stringify(ids)) ||
      write({ kind: 'stop_confirm', job_ids: ids, quote, recorded_by: client, source: 'chat-' + client });
    return apply(record);
  });
}

// Запись закрытия карточек «нужно решение» словом пользователя: поиск и дописывание под тем же замком журнала.
async function recordJobClose(job_ids, quote, apply = async r => r) {
  // team-v58 (task10 а): слово владельца пишет ТОЛЬКО доказанный чат (chatSession). Поручение — первым; недоказанный сеанс
  // слово не пишет. Запасной режим доказанный чат не ограничивает. source/recorded_by — клиент чата.
  const acc = require('./access');
  if (acc.jobSession()) throw Error('Закрытие словом записывает чат участника; из поручения запрещено.');
  if (!acc.chatSession()) throw Error('Закрытие словом записывает доказанный чат участника; происхождение чата не доказано: ' + acc.chatOriginReason() + '.');
  const client = acc.client();
  return locked(async () => {
    const ids = [...new Set(job_ids)].sort();
    const record = lines().find(r => r.kind === 'job_close' && r.quote === quote && JSON.stringify(r.job_ids) === JSON.stringify(ids)) ||
      write({ kind: 'job_close', job_ids: ids, quote, recorded_by: client, source: 'chat-' + client });
    return apply(record);
  });
}

// team-v56 Б0 п.5: запись снятия осиротевшего замка словом. Идемпотентна по точному instance; поиск и дописывание —
// под тем же замком журнала. Снятие самого замка выполняет apply под этим же замком (см. common/release-orphan.js).
async function recordOrphanRelease(instance, jobId, folder, quote, apply = async r => r, extra = {}) {
  // team-v58 (task10 а): слово владельца пишет ТОЛЬКО доказанный чат (chatSession). Поручение — первым; недоказанный сеанс
  // слово не пишет. Запасной режим доказанный чат не ограничивает. source/recorded_by — клиент чата.
  const acc = require('./access');
  if (acc.jobSession()) throw Error('Снятие осиротевшего замка записывает чат участника; из поручения запрещено.');
  if (!acc.chatSession()) throw Error('Снятие осиротевшего замка записывает доказанный чат участника; происхождение чата не доказано: ' + acc.chatOriginReason() + '.');
  const client = acc.client();
  return locked(async () => {
    // team-v56 И7 (ревью Kimi 5): повтор сверяется по instance+jobId+folder. Прежняя запись того же instance с ДРУГИМ
    // поручением/папкой — конфликт (идемпотентность request_id/instance не нарушается скрытым перенаправлением).
    const prior = lines().filter(r => r.kind === 'release_orphan' && r.lock_instance === instance);
    const exact = prior.find(r => r.job_id === jobId && r.folder === folder);
    const conflict = prior.find(r => r.job_id !== jobId || r.folder !== folder);
    if (!exact && conflict) throw Error('instance ' + instance + ' уже снимался с другим поручением/папкой (' + conflict.job_id + ', ' + conflict.folder + '): конфликт release_orphan.');
    // team-v56 К2 (ревью круг 3): extra.revoked_admission явно фиксирует в записи слова, отзывалась ли постановка (замок без
    // собственного jobId снимается, но admission/session не отзывается — связь не доказана).
    const record = exact || write({ kind: 'release_orphan', lock_instance: instance, job_id: jobId, folder, quote, recorded_by: client, source: 'chat-' + client, ...extra });
    return apply(record);
  });
}
// Точная прежняя запись освобождения (instance+jobId+folder) для идемпотентного «уже снято» без нового отзыва.
function findOrphanRelease(instance, jobId, folder) {
  return lines().find(r => r.kind === 'release_orphan' && r.lock_instance === instance && r.job_id === jobId && r.folder === folder) || null;
}

function listText(now = Date.now()) {
  const rows = read(), m = mode(now);
  const fallback = claudeEntries().map(r => local(Date.parse(r.at)) + ' · Claude · ' + ({ record: 'слово', return: 'возврат', handover: 'дирижёр остановился', conductor: 'смена дирижёра' }[r.kind]) +
    (r.quote ? ' „' + r.quote + '“' : '') + (r.recorded_by || r.conductor || r.by ? ' · ' + NAMES[r.conductor || r.recorded_by || r.by] : '') + ' · ' + r.id);
  const stops = lines().filter(r => ['stop_confirm', 'job_close', 'release_orphan'].includes(r.kind)).map(r => local(Date.parse(r.at)) + ' · ' +
    (r.kind === 'stop_confirm' ? 'подтверждение остановки' : r.kind === 'job_close' ? 'закрытие словом' : 'снятие осиротевшего замка') + ' · ' +
    (r.kind === 'release_orphan' ? r.job_id + ' (instance ' + r.lock_instance + ')' : r.job_ids.join(', ')) + ' · „' + r.quote + '“ · ' + r.id);
  // team-v59: слово владельца, перекрывшее правило (голоса при слиянии, вход, запись слова), — отдельной строкой.
  const overrides = lines().filter(r => r.kind === 'owner_override').map(r => local(Date.parse(r.at)) + ' · слово владельца перекрыло · ' +
    (r.overrides || '?') + ' · „' + r.quote + '“ · ' + r.id);
  if (!rows.length && !fallback.length && !stops.length && !overrides.length) return 'Записей слова нет.';
  return [...stops, ...overrides, ...(fallback.length ? ['Запасной режим: ' + (m.active ? 'действует, дирижёр ' + NAMES[m.conductor] : 'не действует'), ...fallback] : []), ...rows.map(r => {
    const at = Date.parse(r.at), back = success(r.who_down, at, now);
    const state = back ? 'не действует: успешный ответ ' + back.id
      : now - at >= DAY ? 'истекло' : 'действует до ' + local(at + DAY);
    return local(at) + ' · ' + NAMES[r.who_down] + ' · „' + r.quote + '“ · ' + state + ' · ' + r.id;
  })].join('\n');
}

module.exports = { DAY, NAMES, dir, file, ms, lines, read, claudeEntries, mode, append, transact, entry, holds, active, latest, byId, success, record, line, local, listText, recordStopConfirmation, recordJobClose, recordOrphanRelease, findOrphanRelease };
