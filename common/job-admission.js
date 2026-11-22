'use strict';
// team-v56 Б0: устойчивая admission-запись между проверками допуска и публикацией карточки. Она закрывает окно
// «замок/постановка без карточки»: запись с request_id/jobId/фазой пишется до захвата замка, атомарно коммитится при
// сохранении карточки и узко откатывается до передачи исполнителю, не обходя чужие карточки.
//
// Область уникальности request_id: (канонический state, adapter/получатель, проверенный principal отправителя,
// request_id). Повтор того же request_id с тем же каноническим запросом возвращает тот же jobId и сохранённое
// состояние без повторных prepare/lock/spawn; иные параметры того же ключа — REQUEST_ID_CONFLICT без новой карточки,
// замка и следов на диске. В диагностике печатается только SHA-256 запроса, не его текст/секреты.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const locks = require('./locks');
const { stateDir: STATE_DIR, canon } = require('./paths');

const dir = (state = STATE_DIR) => path.join(state, 'admissions');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const fileOf = (state, key) => path.join(dir(state), key + '.json');

// Принципал отправителя выводится из access/job-chain: поручение — по его собственному поручению, чат — по каналу.
// Произвольный owner из текста принципалом не становится.
function principal(access = require('./access')) {
  let job = null;
  try { job = require('./job-identity').currentJob(); } catch {}
  if (job && job.id) return 'job:' + job.id;
  return (access.guest() ? 'guest:' : 'chat:') + access.client();
}

// Канонический запрос: пропуск поля (undefined) отличается от значения пустой строки/false через сторожевой маркер.
// values — упорядоченный массив [имя, значение]; значения — уже безопасные поля (текст поручения передаётся как его SHA).
function canonicalRequest(values) {
  return JSON.stringify(values.map(([k, v]) => [k, v === undefined ? ['∅'] : v]));
}
function requestHash(values) { return sha(canonicalRequest(values)); }

function keyOf(state, adapter, who, requestId) {
  return sha(canon(path.resolve(state)) + '\0' + adapter + '\0' + who + '\0' + requestId);
}

function read(state, key) {
  try { return JSON.parse(fs.readFileSync(fileOf(state, key), 'utf8').replace(/^﻿/, '')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Резервирование под межпроцессным замком области request_id. До успешного возврата — никаких карточек/замков.
// Возвращает { admissionId, jobId, duplicate, record }. Конфликт параметров того же ключа — исключение, без записи.
async function reserve({ state = STATE_DIR, adapter, principal: who, requestId, hash, newJobId }) {
  if (!adapter || !who || !requestId || !hash || !newJobId) throw Error('Неполные параметры admission.');
  const key = keyOf(state, adapter, who, requestId);
  const l = await locks.waitLock('admission', key, { requestId }, 8000, state);
  if (!l.ok) throw Error('Область request_id занята; повторите позже.');
  try {
    const existing = read(state, key);
    if (existing) {
      if (existing.requestHash !== hash)
        throw Error('REQUEST_ID_CONFLICT: request_id уже использован с другими параметрами (запрос ' + hash.slice(0, 12) + '≠' + String(existing.requestHash).slice(0, 12) + '); новая карточка и замок не создаются.');
      return { admissionId: key, jobId: existing.jobId, duplicate: true, record: existing };
    }
    const record = { key, adapter, principal: who, requestId, requestHash: hash, jobId: newJobId,
      phase: 'validating', committed: false, launch: 'forbidden', createdAt: new Date().toISOString(), owner: locks.owner() };
    fs.mkdirSync(dir(state), { recursive: true });
    fs.writeFileSync(fileOf(state, key), JSON.stringify(record), { flag: 'wx' });
    return { admissionId: key, jobId: newJobId, duplicate: false, record };
  } finally { await l.release(); }
}

// team-v56 Б0 (этап 2): admission ВСЕГДА до захвата замка/публикации. request_id необязателен: при отсутствии сервер
// выдаёт новый ('auto-'+uuid) и показывает его в ответе, чтобы повтор был идемпотентным. Явный request_id проверяется по
// формату. Возвращает { admissionId, jobId, duplicate, requestId, generated, record }; дубликат только при повторе того же ID.
async function begin({ state = STATE_DIR, adapter, access, requestId, values, newJobId }) {
  let generated = false;
  if (requestId === undefined) { requestId = 'auto-' + crypto.randomUUID(); generated = true; }
  else if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(requestId)) throw Error('Недопустимый request_id.');
  const r = await reserve({ state, adapter, principal: principal(access), requestId, hash: requestHash(values), newJobId });
  return { ...r, requestId, generated };
}

function update(state, key, fn) {
  const rec = read(state, key); if (!rec) return null;
  fn(rec); fs.writeFileSync(fileOf(state, key), JSON.stringify(rec)); return rec;
}
// Публикация карточки состоялась — commit admission; запуск исполнителя разрешён.
function commit(state, admissionId, { instance } = {}) {
  return update(state, admissionId, r => { r.committed = true; r.phase = 'prepared'; r.launch = 'allowed'; if (instance) r.lockInstance = instance; r.committedAt = new Date().toISOString(); });
}
// team-v56 Б0 п.1–3: узкий откат постановки до передачи исполнителю. Снимаем только свою незакоммиченную запись и
// ровно тот write-lock, который взяла эта постановка (по instance замка, БЕЗ обхода чужих карточек через job-chain.cards —
// иначе ошибка постороннего хранилища удержала бы ещё не переданный замок). После публикации карточки (published) или
// commit — no-op: releaseUnpublished не удаляет admission после публикации. При неудаче снятия замка — не «тихое»
// удержание, а recovery_required с диагностическим ID в самой записи (её увидит установочный барьер).
//   instance — опциональный сторож владельца (сверяется с owner.instance записи);
//   lock { instance, folder, jobId } — точный write-lock этой постановки для узкого снятия.
function markRecovery(state, admissionId, error) {
  const recoveryId = crypto.randomUUID();
  try { update(state, admissionId, r => { r.phase = 'recovery_required'; r.recoveryId = recoveryId; r.recoveryError = error; r.recoveryAt = new Date().toISOString(); }); } catch {}
  return recoveryId;
}
function releaseUnpublished(state, admissionId, { instance, lock, published } = {}) {
  const rec = read(state, admissionId);
  if (!rec || rec.committed || published) return { released: false };
  if (instance && rec.owner && rec.owner.instance && rec.owner.instance !== instance) return { released: false };
  // Узкое снятие точного замка постановки по его instance (без обхода чужих хранилищ).
  if (lock && lock.instance) {
    let r;
    try { r = require('./write-lock').releaseOrphan({ instance: lock.instance, folder: lock.folder, jobId: lock.jobId }, state); }
    catch (e) { const recoveryId = markRecovery(state, admissionId, 'откат замка: ' + e.message); return { released: false, recovery: true, recoveryId, error: e.message }; }
    if (!r.released && !r.absent) { const recoveryId = markRecovery(state, admissionId, 'замок постановки не снят'); return { released: false, recovery: true, recoveryId }; }
  }
  try { fs.unlinkSync(fileOf(state, admissionId)); return { released: true }; }
  catch (e) { if (e.code === 'ENOENT') return { released: true }; throw e; }
}
// team-v56 Б0 п.5: отзыв незавершённой постановки и session-reservation осиротевшего поручения по его jobId. Вызывается
// обработчиком release_orphan под барьером журнала слова ПОСЛЕ снимка (карточки нет, владелец мёртв). Снимаем только
// незакоммиченные admission и связанные reservation; после этого установочный барьер не блокируется этой записью.
function revokeByJob(state = STATE_DIR, jobId) {
  const removed = [];
  let names;
  try { names = fs.readdirSync(dir(state)); } catch (e) { if (e.code === 'ENOENT') return { removed }; throw e; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(dir(state), n);
    let rec; try { rec = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { continue; }
    if (rec.jobId !== jobId) continue;
    if (n.startsWith('session-') || rec.committed === false) { try { fs.unlinkSync(file); removed.push(n); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
  return { removed };
}

// team-v56 А2: устойчивая reservation продолжения сеанса. Ключ — тройка (cliIdentity.sha256, sessionId, canon(sessionCwd)).
// Запись/проверка идут под общим kimi_queue/all сервера (отдельный долгоживущий session-lock не нужен): любая active/
// recovery_required reservation той же тройки, чей jobId ещё жив, отказывает второму продолжению до публикации.
function sessionKey(cliSha, sessionId, sessionCwd) {
  if (!cliSha || !sessionId || !sessionCwd) throw Error('Неполная тройка сеанса продолжения.');
  return sha(String(cliSha) + '\0' + String(sessionId) + '\0' + canon(path.resolve(sessionCwd)));
}
const sessionFile = (state, key) => path.join(dir(state), 'session-' + key + '.json');
function readSession(state = STATE_DIR, key) {
  try { return JSON.parse(fs.readFileSync(sessionFile(state, key), 'utf8').replace(/^﻿/, '')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
// Публикуется под уже удерживаемым kimi_queue/all. isLive(jobId) → карточка продолжения всё ещё выполняется (не даёт
// второй параллельный запуск). Устаревшую reservation завершённого/мёртвого продолжения перезаписываем.
function reserveSession(state = STATE_DIR, key, { jobId, previous }, isLive = () => false) {
  const existing = readSession(state, key);
  // team-v56 И9 (ревью Codex 2): recovery_required (оборванная передача вершины) блокирует продолжение ВСЕГДА, даже если
  // его карточка уже не «живая» — иначе после перевода застрявшей карточки в failed запрет повтора исчезал бы. active
  // блокирует, только пока его карточка жива.
  if (existing && existing.jobId !== jobId && (existing.status === 'recovery_required' || (existing.status === 'active' && isLive(existing.jobId))))
    throw Error('SESSION_BUSY: продолжение этого сеанса уже выполняется или требует восстановления (' + existing.jobId + ', ' + existing.status + '); второй запуск запрещён.');
  const record = { key, jobId, previous: previous || null, status: 'active', at: new Date().toISOString(), owner: locks.owner() };
  fs.mkdirSync(dir(state), { recursive: true });
  fs.writeFileSync(sessionFile(state, key), JSON.stringify(record));
  return record;
}
function releaseSession(state = STATE_DIR, key, jobId) {
  const existing = readSession(state, key);
  if (!existing || (jobId && existing.jobId !== jobId)) return { released: false };
  try { fs.unlinkSync(sessionFile(state, key)); return { released: true }; }
  catch (e) { if (e.code === 'ENOENT') return { released: true }; throw e; }
}
// Оборванный commit перехода вершины цепочки помечает reservation recovery_required: повтор/spawn блокируются до восстановления.
function markSessionRecovery(state = STATE_DIR, key, jobId) {
  const existing = readSession(state, key);
  if (!existing || (jobId && existing.jobId !== jobId)) return { updated: false };
  existing.status = 'recovery_required'; existing.recoveryAt = new Date().toISOString();
  fs.writeFileSync(sessionFile(state, key), JSON.stringify(existing)); return { updated: true };
}

module.exports = { dir, fileOf, principal, canonicalRequest, requestHash, keyOf, read, reserve, begin, commit, releaseUnpublished, revokeByJob,
  sessionKey, sessionFile, readSession, reserveSession, releaseSession, markSessionRecovery };
