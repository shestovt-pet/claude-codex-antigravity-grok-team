'use strict';
// team-v36: подпоручение из поручения-сеанса — *_send; места — атомарные файлы, создаются через wx и не освобождаются;
// голосом не засчитывается (team-store.review); основной сервер перепроверяет карточку очереди (queuedRefusal).
// team-v48e Г3: числовые кепки цепочки (глубина/у родителя/у корня) и запреты вида подпоручения (полный доступ, этап,
// продолжение, роль «проверка», «не шире родителя») сняты безусловно (тумблеры MOST_CHAIN_* удалены). Остаются всегда:
// защита от самозацикливания (lineageRefusal — возврат к предку/повтор участника запрещён), подпись места
// (reserve/chainNonce), живой родитель и подлинность полей (Number.isInteger/≥1).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
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
  // PID переиспользуется: принимается только окно фактического запуска процесса поручения.
  // team-v48e (ревью п.3): сверяем с реальным временем запуска процесса (childStartedAt/agyStartedAt, как
  // chain-deadline.js), а не с временем постановки (startedAt). Иначе после ожидания очереди >10 мин законная
  // отмена своего потомка отклонялась бы. Откат к startedAt — только если фактического времени запуска ещё нет.
  const starts = new Map((chain || []).map(p => [p.pid, p.startedAt]));
  const launched = j => j.childStartedAt || j.agyStartedAt || j.startedAt;
  const runs = j => PID_FIELDS.some(f => Number.isInteger(j[f]) && starts.has(j[f]) && startedAfter(starts.get(j[f]), launched(j)));
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
// Атомарное место: файл создаётся флагом wx; занятое место не освобождается. team-v48e: число мест не ограничено —
// выдаётся первый свободный номер (подпись места/nonce сохраняется, верхнего предела нет).
function reserve(kind, key, nonce) {
  const d = path.join(dir(), kind, key);
  fs.mkdirSync(d, { recursive: true });
  for (let n = 1; ; n++) {
    try { fs.writeFileSync(path.join(d, String(n)), nonce, { flag: 'wx' }); return n; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}
function admit(server, tool, a = {}, opts = {}) {
  if (granted.has(a)) return granted.get(a);
  if (!/_send$/.test(tool) || tool === 'team_word') refuse('из поручения доступна только отправка *_send');
  if (server === 'team') refuse('сервер team поручений не принимает');
  // team-v48e Г3: запреты вида подпоручения и числовые кепки сняты безусловно; остаётся подлинность/подпись/живой родитель/lineage.
  let all;
  try { all = opts.cards || cards(); } catch (e) { refuse(e.message); }
  const p = parent(all, opts.ancestors);
  if (p.error) refuse(p.error);
  // Возврат к предку/повтор участника запрещён всегда (защита от рекурсивной лавины).
  const cycle = lineageRefusal(server, p.job, all);
  if (cycle) refuse(cycle);
  const depth = (Number.isInteger(p.job.depth) ? p.job.depth : 0) + 1;
  const root = p.job.rootJob || p.job.id, nonce = crypto.randomUUID();
  const rootSlot = reserve('root', root, nonce);
  const parentSlot = reserve('parent', p.job.id, nonce);
  const c = { parentJob: p.job.id, rootJob: root, depth, parentSlot, rootSlot, chainNonce: nonce };
  granted.set(a, c);
  return c;
}
// Поля цепочки в карточку — только выданные admit этому же объекту аргументов.
function fields(a) {
  return a && typeof a === 'object' && granted.has(a) ? { ...granted.get(a) } : {};
}
// team-v48 Г4d (§D.3): вызов из поручения-сеанса (MOST_CLIENT=job, MOST_JOB_ID задан).
function fromJob() {
  const id = process.env.MOST_JOB_ID;
  return process.env.MOST_CLIENT === 'job' && !!id && SAFE.test(id);
}
// Целевая карточка — потомок вызывающего поручения: её parentJob-путь ведёт к MOST_JOB_ID. Сам родитель и чужие карточки — нет.
function isDescendant(targetId, opts = {}) {
  const id = process.env.MOST_JOB_ID;
  if (!id || !SAFE.test(id) || !SAFE.test(targetId || '') || targetId === id) return false;
  let all;
  try { all = opts.cards || cards(); } catch { return false; }
  const hits = all.filter(j => j.id === targetId);
  if (hits.length !== 1) return false;
  const seen = new Set();
  let j = hits[0];
  while (j && j.parentJob) {
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    if (j.parentJob === id) return true;
    const up = all.filter(x => x.id === j.parentJob);
    if (up.length !== 1) return false;
    j = up[0];
  }
  return false;
}
// Отмена/остановка из поручения-сеанса допустима только для своих потомков (§D.3, защита stop-confirm родителя).
// team-v48e (ревью п.2): вызывающего подтверждаем той же проверкой предков процесса, что и parent() —
// MOST_JOB_ID должен совпадать с идущим поручением, чьи childPid/agyPid среди предков процесса. Иначе чужой
// процесс (поручение A), подставив MOST_JOB_ID=B, отменил бы потомков B. Только после подтверждения — проверка родства.
function assertDescendant(targetId, opts = {}) {
  const id = process.env.MOST_JOB_ID;
  if (!id || !SAFE.test(id)) throw Error('Отмена из поручения отклонена: нет номера поручения-родителя (MOST_JOB_ID). Изменения не выполнены.');
  let all;
  try { all = opts.cards || cards(); } catch (e) { throw Error('Отмена из поручения отклонена: ' + e.message + '. Изменения не выполнены.'); }
  // team-v48e (ревью п.3): положительное подтверждение — parent() находит карточку MOST_JOB_ID всегда (p.job.id === id
  // по построению), поэтому проверка id была мёртвой. Отмену разрешаем только когда childPid/agyPid этой карточки реально
  // среди предков процесса (byAncestors === true): иначе чужой процесс, подставив MOST_JOB_ID=B, отменил бы потомков B.
  const p = parent(all, opts.ancestors);
  if (p.error || !p.byAncestors)
    throw Error('Отмена из поручения отклонена: вызывающее поручение не подтверждено предками процесса' + (p.error ? ' (' + p.error + ')' : '') + '. Изменения не выполнены.');
  if (!isDescendant(targetId, { cards: all }))
    throw Error('Отмена из поручения отклонена: допустима только для своих потомков (не предка и не чужой карточки). Изменения не выполнены.');
}
// Основной сервер перед запуском карточки из очереди: подпоручение — только чтение, место в цепочке подтверждено файлом.
function queuedRefusal(card, all, server) {
  if (!card || (card.parentJob === undefined && card.rootJob === undefined && card.depth === undefined)) return null;
  const bad = 'Подпоручение отклонено основным сервером: ';
  // У Antigravity work — прочитанный исходный материал, имя работы хранится в workName.
  server = server || card.member;
  if (!server) return bad + 'неизвестен исполнитель подпоручения.';
  // team-v48e Г3: вид подпоручения (полный доступ/этап/продолжение) и верхние границы (глубина/у корня/у родителя) не
  // ограничиваются (тумблеры MOST_CHAIN_* удалены). Подлинность полей (целое ≥1), подпись места (nonce), живой родитель
  // и lineageRefusal — всегда.
  if (!SAFE.test(card.parentJob || '') || !SAFE.test(card.rootJob || '') || !Number.isInteger(card.depth) || card.depth < 1 ||
      !Number.isInteger(card.rootSlot) || card.rootSlot < 1 ||
      !Number.isInteger(card.parentSlot) || card.parentSlot < 1)
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
  const cycle = lineageRefusal(server, p, list, !first);
  if (cycle) return bad + cycle + '.';
  if ((p.rootJob || p.id) !== card.rootJob || ((Number.isInteger(p.depth) ? p.depth : 0) + 1) !== card.depth) return bad + 'цепочка не сходится с родителем.';
  return null;
}

module.exports = { admit, parent, fields, queuedRefusal, cards, reserve, fromJob, isDescendant, assertDescendant };
