'use strict';
// team-v36: подпоручение из поручения-сеанса — только *_send без записи, полного доступа, этапа, продолжения и роли «проверка»;
// глубина ≤ 2, у родителя ≤ 3 прямых, у корня ≤ 6 всего (места — атомарные файлы, создаются через wx и не освобождаются);
// голосом не засчитывается (team-store.review); основной сервер перепроверяет карточку очереди (queuedRefusal).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const MAX_DEPTH = 2, PER_PARENT = 3, PER_ROOT = 6;
const PID_FIELDS = ['childPid', 'agyPid'];
const SAFE = /^[A-Za-z0-9_-]{1,80}$/;
// Поля цепочки живут вне аргументов: JSON вызова не может их задать, повторный guard того же вызова их не тратит.
const granted = new WeakMap();
const dir = () => path.join(require('./paths').stateDir, 'job-chain');

function cards() {
  const members = require('./members'), store = require('./team-store'), out = [];
  for (const who of members.scanIds) {
    const listed = store.list(who, false);
    if (listed.errors.length) throw Error('карточки ' + who + ' не читаются');
    for (const j of listed.jobs) out.push({ ...j, member: who });
  }
  return out;
}
function refuse(reason) {
  throw Error('Подпоручение из поручения отклонено: ' + reason + '. Изменения не выполнены.');
}
// Родитель: MOST_JOB_ID обязателен (ставит только fallback.jobEnv при запуске поручения); ровно одна карточка с этим номером,
// в статусе running. Если среди предков процесса есть идущее поручение (childPid/agyPid), это должно быть оно же.
function parent(all, chain) {
  const id = process.env.MOST_JOB_ID;
  if (!id || !SAFE.test(id)) return { error: 'нет номера поручения-родителя (MOST_JOB_ID)' };
  const hit = all.filter(j => j.id === id);
  if (hit.length !== 1) return { error: 'поручение ' + id + ' не найдено среди карточек' };
  const job = hit[0];
  if (job.archived || job.status !== 'running') return { error: 'поручение-родитель ' + id + ' не идёт (' + job.status + ')' };
  if (!SAFE.test(job.rootJob || job.id)) return { error: 'у родителя повреждён корень цепочки' };
  if (chain === undefined) { try { chain = require('./fallback').ancestors(); } catch { return { error: 'не удалось снять отпечаток процесса' }; } }
  if (!Array.isArray(chain) || !chain.length) return { error: 'не удалось снять отпечаток процесса' };
  // PID переиспользуется: принимается только окно старта поручения.
  const starts = new Map((chain || []).map(p => [p.pid, p.startedAt]));
  const runs = j => PID_FIELDS.some(f => Number.isInteger(j[f]) && starts.has(j[f]) && startedAfter(starts.get(j[f]), j.startedAt));
  const own = runs(job);
  const other = all.find(j => j.id !== id && j.status === 'running' && runs(j));
  if (other) return { error: 'MOST_JOB_ID и предки процесса указывают на разные поручения' };
  return { job, byAncestors: own };
}
function startedAfter(proc, card) {
  const a = Date.parse(proc), b = Date.parse(card);
  return Number.isFinite(a) && Number.isFinite(b) && a >= b - 5000 && a <= b + 600000;
}
// Исполнитель приходит из хранилища/сервера, а не из полей вызова.
function lineageRefusal(server, job, all, allowMissing = false) {
  const seen = new Set();
  while (job) {
    if (seen.has(job.id)) return 'цикл в цепочке поручений';
    seen.add(job.id);
    if (!job.member) return 'неизвестен исполнитель в цепочке';
    if (job.member === server) return 'получатель уже есть в цепочке поручений';
    if (!job.parentJob) return null;
    const hits = all.filter(j => j.id === job.parentJob);
    if (hits.length !== 1) return allowMissing && !hits.length ? null : 'предок цепочки не найден однозначно';
    job = hits[0];
  }
  return null;
}
// Атомарное место: файл создаётся флагом wx; занятое место не освобождается (лимит — на всю жизнь цепочки).
function reserve(kind, key, limit, nonce) {
  const d = path.join(dir(), kind, key);
  fs.mkdirSync(d, { recursive: true });
  for (let n = 1; n <= limit; n++) {
    try { fs.writeFileSync(path.join(d, String(n)), nonce, { flag: 'wx' }); return n; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return 0;
}
function admit(server, tool, a = {}, opts = {}) {
  if (granted.has(a)) return granted.get(a);
  if (!/_send$/.test(tool) || tool === 'team_word') refuse('из поручения доступна только отправка *_send');
  if (server === 'team') refuse('сервер team поручений не принимает');
  if (a.full_access === true) refuse('подпоручению полный доступ запрещён');
  if (a.work || a.stage) refuse('подпоручение не может быть этапом работы');
  if (a.continue_id) refuse('продолжение сеанса из поручения запрещено');
  let all;
  try { all = opts.cards || cards(); } catch (e) { refuse(e.message); }
  const p = parent(all, opts.ancestors);
  if (p.error) refuse(p.error);
  if (p.job.role === 'проверка') refuse('поручение с ролью «проверка» не может давать подпоручения');
  // team-v46 п.4: запись подпоручения — «дочернее не шире родителя» (у пишущего отправителя-исполнителя).
  if (a.write === true && p.job.write !== true) refuse('запись подпоручения допустима только у пишущего поручения-родителя');
  const cycle = lineageRefusal(server, p.job, all);
  if (cycle) refuse(cycle);
  const depth = (Number.isInteger(p.job.depth) ? p.job.depth : 0) + 1;
  if (depth > MAX_DEPTH) refuse('глубина цепочки больше ' + MAX_DEPTH);
  const root = p.job.rootJob || p.job.id, nonce = crypto.randomUUID();
  const rootSlot = reserve('root', root, PER_ROOT, nonce);
  if (!rootSlot) refuse('в цепочке уже ' + PER_ROOT + ' подпоручений');
  const parentSlot = reserve('parent', p.job.id, PER_PARENT, nonce);
  if (!parentSlot) refuse('у поручения уже ' + PER_PARENT + ' подпоручения');
  const c = { parentJob: p.job.id, rootJob: root, depth, parentSlot, rootSlot, chainNonce: nonce };
  granted.set(a, c);
  return c;
}
// Поля цепочки в карточку — только выданные admit этому же объекту аргументов.
function fields(a) {
  return a && typeof a === 'object' && granted.has(a) ? { ...granted.get(a) } : {};
}
// Основной сервер перед запуском карточки из очереди: подпоручение — только чтение, место в цепочке подтверждено файлом.
function queuedRefusal(card, all, server) {
  if (!card || (card.parentJob === undefined && card.rootJob === undefined && card.depth === undefined)) return null;
  const bad = 'Подпоручение отклонено основным сервером: ';
  // У Antigravity work — прочитанный исходный материал, имя работы хранится в workName.
  server = server || card.member;
  if (!server) return bad + 'неизвестен исполнитель подпоручения.';
  const work = server === 'antigravity' ? card.workName : card.work;
  // team-v46 п.4: подпоручение может писать; полный доступ, этап и продолжение — нет.
  if (card.fullAccess === true || work || card.stage || card.stageId || card.previous)
    return bad + 'полный доступ, этап и продолжение подпоручению запрещены.';
  if (!SAFE.test(card.parentJob || '') || !SAFE.test(card.rootJob || '') || !Number.isInteger(card.depth) || card.depth < 1 || card.depth > MAX_DEPTH ||
      !Number.isInteger(card.rootSlot) || card.rootSlot < 1 || card.rootSlot > PER_ROOT ||
      !Number.isInteger(card.parentSlot) || card.parentSlot < 1 || card.parentSlot > PER_PARENT)
    return bad + 'повреждены поля цепочки.';
  for (const [kind, key, slot] of [['root', card.rootJob, card.rootSlot], ['parent', card.parentJob, card.parentSlot]]) {
    let nonce;
    try { nonce = fs.readFileSync(path.join(dir(), kind, key, String(slot)), 'utf8'); } catch { nonce = null; }
    if (!nonce || nonce !== card.chainNonce) return bad + 'место в цепочке не подтверждено (' + kind + ').';
  }
  let list;
  try { list = all || cards(); } catch (e) { return bad + e.message + '.'; }
  // execute повторяет проверку уже после перевода в running; требование живого родителя — только до первого запуска.
  const hits = list.filter(j => j.id === card.parentJob), first = card.status === 'queued';
  if (!hits.length && !first) return null;
  if (hits.length !== 1) return bad + 'поручение-родитель не найдено однозначно.';
  const p = hits[0];
  if (first && (p.archived || p.status !== 'running')) return bad + 'поручение-родитель не идёт.';
  if (p.role === 'проверка') return bad + 'поручение с ролью «проверка» не может давать подпоручения.';
  // team-v46 п.4: запись подпоручения — «дочернее не шире родителя».
  if (card.write && p.write !== true) return bad + 'запись подпоручения допустима только у пишущего поручения-родителя.';
  const cycle = lineageRefusal(server, p, list, !first);
  if (cycle) return bad + cycle + '.';
  if ((p.rootJob || p.id) !== card.rootJob || ((Number.isInteger(p.depth) ? p.depth : 0) + 1) !== card.depth) return bad + 'цепочка не сходится с родителем.';
  return null;
}

module.exports = { admit, parent, fields, queuedRefusal, cards, reserve, MAX_DEPTH, PER_PARENT, PER_ROOT };
