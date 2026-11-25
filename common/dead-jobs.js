'use strict';
// install-gate-simple (слово пользователя 24.11.2026): ОДНО определение «мёртвого поручения» для установщика, сводки, перезапуска
// и уборки. Ворота установки показывают только реально живое, одной строкой на поручение; нет живого — установка без вопроса;
// мёртвые поручения и замки закрываются сами. Любая неуверенность — в сторону «живое/не трогать», но без возврата мусора в
// ворота: если снимок неполон (не прочитана карточка/замок, не прочитана таблица процессов) — ворота дают технический отказ
// одной строкой «не удалось проверить, повторите», а уборка ничего не закрывает.
//
// Живой процесс поручения — PID из карточки, который сейчас существует И запущен НЕ позже момента, когда номер был записан
// (отметка записи номера — childStartedAt/agyStartedAt/owner.startedAt — или, если её нет, последняя запись карточки). Допуска
// нет: процесс, запущенный после записи карточки, — другой процесс на том же номере (так было с conhost.exe на месте
// сервера-владельца). Время запуска неизвестно — «не проверено», считается живым.
//
// Порядок оценки карточки (ревью Codex п.1/2/5, Gemini б):
//   1) живой исполнитель (pid, childPid, agyPid, observedPids, stopUnconfirmed.pid) — живое при ЛЮБОМ статусе, раньше
//      исключения завершённых и раньше правила «участник удалён»;
//   2) завершённая без флагов удержания — не наше дело;
//   3) живой сервер-владелец у идущего/очереди — живое;
//   4) неизвестный статус и migration_conflict — не закрываются никогда (только вручную);
//   5) очередь (queued/waiting_quota) действующего участника — не закрывается независимо от возраста (ручная пауза, ожидание
//      квоты с будущим nextAttemptAt);
//   6) участник удалён из реестра — мёртвое;
//   7) идущее без номера исполнителя моложе окна запуска (LAUNCH_WINDOW) — живое: владелец мог упасть между spawn и записью;
//   8) моложе суток не закрываются: без номеров, needs_decision, поручение с записью; иначе — мёртвое.
// Автоматически закрываются только статусы из CLOSABLE (и завершённые с флагами удержания).
const fs = require('fs'), path = require('path');
const DAY = 86400000;
const LAUNCH_WINDOW = 10 * 60000;
const RUNNING_LIKE = ['running', 'applying', 'cancelling', 'cancel_requested', 'delivery_unclear', 'stop_unconfirmed'];
const QUEUE = ['queued', 'waiting_quota'];
const TERMINAL = ['done', 'applied', 'failed', 'cancelled', 'stop_confirmed', 'lost'];
// Согласованный список незавершённых статусов, которые уборка закрывает сама. migration_conflict сюда НЕ входит.
const CLOSABLE = [...RUNNING_LIKE, 'needs_decision'];
const UNFINISHED = [...RUNNING_LIKE, ...QUEUE, 'needs_decision', 'migration_conflict'];
const LABEL = 'закрыто: мёртвое';
const INCOMPLETE_LINE = 'Установка не начата: не удалось проверить, идут ли поручения';
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------- таблица процессов ----------
// Таблица — Map pid → время запуска (мс; NaN — неизвестно, «не проверено»). Поле incomplete (строка) — снимок неполон.
function tableFrom(rows) {
  if (!Array.isArray(rows)) return null;
  const m = new Map();
  for (const r of rows) if (Number.isInteger(r.pid)) m.set(r.pid, Date.parse(r.startedAt));
  return m;
}
function killProbe(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'ESRCH' ? false : null; }
}
function existing(pids) { return [...new Set(pids)].filter(p => Number.isInteger(p) && p > 0 && killProbe(p) !== false); }
// Много номеров — одна выборка всей таблицы (длина командной строки), мало — по фильтру.
function psArgs(pids) {
  const filter = pids.length > 100 ? '' : ' -Filter "' + pids.map(p => 'ProcessId=' + p).join(' OR ') + '"';
  return ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process' + filter +
    ' | Select-Object ProcessId,@{n=\'Start\';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString(\'o\')}}} | ConvertTo-Json -Compress'];
}
// Разбор ответа PowerShell (Gemini а): пустой/пробельный вывод — пустой список; мусор — исключение (вызывающий повторит запрос,
// а при повторном сбое пометит снимок неполным — ни ложного «живого», ни ложного «мёртвого»).
function parsePs(out) {
  const text = String(out || '').trim() || '[]';
  const v = JSON.parse(text);
  const rows = [].concat(v == null ? [] : v);
  for (const r of rows) if (!r || typeof r !== 'object' || !Number.isInteger(r.ProcessId)) throw Error('неожиданная строка таблицы процессов');
  return rows;
}
// Ответ CIM → таблица. Запрос всегда включает собственный процесс: его нет в ответе — ответ неполон (исключение; вызывающий
// повторит, а при повторном сбое пометит снимок неполным). Номер, которого нет в полном ответе CIM, перепроверяется (Codex п.4):
// process.kill говорит «нет процесса» — исчез; иначе он уходит на повторный запрос (missing). Номер, которого нет и в повторном
// полном ответе, — не идущий процесс: Win32_Process перечисляет все запущенные процессы, а process.kill «видит» и завершённый
// процесс, чей объект ещё удерживает чужой дескриптор.
function fromPs(out, pids, self = process.pid) {
  const rows = parsePs(out), m = new Map(), missing = [];
  for (const r of rows) m.set(r.ProcessId, Date.parse(r.Start));
  if (!m.has(self)) throw Error('неполный ответ таблицы процессов (нет самого процесса проверки)');
  for (const p of pids) if (!m.has(p)) { if (killProbe(p) === false) continue; missing.push(p); }
  const wanted = new Set(pids);
  for (const p of [...m.keys()]) if (!wanted.has(p)) m.delete(p);
  return { map: m, missing };
}
const withSelf = pids => [...new Set([...pids, process.pid])];
function mark(map, incomplete) { if (incomplete) map.incomplete = incomplete; return map; }
// Какие номера входили в снимок: номер вне снимка (карточка появилась после сборки снимка) проверяется напрямую.
function checked(map, pids) { map.checked = new Set(pids.filter(Number.isInteger)); return map; }
function runPsSync(pids) {
  return require('child_process').execFileSync('powershell.exe', psArgs(pids), { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
}
function runPsAsync(pids) {
  return new Promise((resolve, reject) => {
    try { require('child_process').execFile('powershell.exe', psArgs(pids), { encoding: 'utf8', windowsHide: true, timeout: 60000 }, (e, out) => e ? reject(e) : resolve(out)); }
    catch (e) { reject(e); }
  });
}
// Две попытки; номера, которых не было в первом ответе, запрашиваются ещё раз. Второй сбой — снимок неполон.
function tableSync(pids, deps = {}) { return checked(tableSyncRaw(pids, deps), pids); }
function tableSyncRaw(pids, deps = {}) {
  const alive = existing(pids);
  if (!alive.length) return new Map();
  if (process.platform !== 'win32' && !deps.run) {
    try { const t = tableFrom(require('./fallback').processTable(true, { native: true })); return new Map(alive.filter(p => t.has(p) || killProbe(p) !== false).map(p => [p, t.has(p) ? t.get(p) : NaN])); }
    catch (e) { return mark(new Map(alive.map(p => [p, NaN])), 'таблица процессов не прочитана: ' + e.message); }
  }
  const run = deps.run || runPsSync;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = fromPs(run(withSelf(alive)), alive);
      if (r.missing.length) {
        let again;
        try { again = fromPs(run(withSelf(r.missing)), r.missing); } catch { again = fromPs(run(withSelf(r.missing)), r.missing); }
        for (const p of r.missing) if (again.map.has(p)) r.map.set(p, again.map.get(p));
      }
      return r.map;
    } catch (e) { last = e; }
  }
  return mark(new Map(alive.map(p => [p, NaN])), 'таблица процессов не прочитана: ' + (last && last.message || 'сбой'));
}
async function tableAsync(pids, deps = {}) { return checked(await tableAsyncRaw(pids, deps), pids); }
async function tableAsyncRaw(pids, deps = {}) {
  const alive = existing(pids);
  if (!alive.length) return new Map();
  if (process.platform !== 'win32' && !deps.runAsync) return tableSyncRaw(alive, deps);
  const run = deps.runAsync || runPsAsync;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = fromPs(await run(withSelf(alive)), alive);
      if (r.missing.length) {
        let again;
        try { again = fromPs(await run(withSelf(r.missing)), r.missing); } catch { again = fromPs(await run(withSelf(r.missing)), r.missing); }
        for (const p of r.missing) if (again.map.has(p)) r.map.set(p, again.map.get(p));
      }
      return r.map;
    } catch (e) { last = e; }
  }
  return mark(new Map(alive.map(p => [p, NaN])), 'таблица процессов не прочитана: ' + (last && last.message || 'сбой'));
}

// true — жив; false — нет; 'reused' — номер занят процессом, запущенным позже записи; null — не проверено (считается живым).
// bound — момент, к которому процесс с этим номером уже существовал (запись номера или последняя запись карточки).
function pidState(pid, bound, table) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!table) return killProbe(pid);
  if (table.checked && !table.checked.has(pid)) return killProbe(pid) === false ? false : null;
  if (!table.has(pid)) return false;
  const start = table.get(pid);
  if (!Number.isFinite(start) || !Number.isFinite(bound) || bound <= 0) return null;
  return start <= bound ? true : 'reused';
}
const isAlive = s => s === true || s === null;

// ---------- номера процессов карточки ----------
// Исполнители: все PID дочерних процессов, которые записывают адаптеры (Codex п.1: agyPid Antigravity тоже).
function childPids(j) {
  const out = [], push = v => { if (Number.isInteger(v) && v > 0) out.push(v); };
  push(j.pid); push(j.childPid); push(j.agyPid); push(j.stopUnconfirmed?.pid);
  if (Array.isArray(j.observedPids)) j.observedPids.forEach(push);
  return [...new Set(out)];
}
// Серверы-владельцы (их жизнь значит что-то только для идущих поручений и очереди).
function ownerPids(j) {
  const out = [], push = v => { if (Number.isInteger(v) && v > 0) out.push(v); };
  push(j.owner?.pid); push(j.apply?.owner?.pid);
  return [...new Set(out)];
}
function cardPids(j) { return [...new Set([...childPids(j), ...ownerPids(j)])]; }
function lastWriteOf(c) {
  if (Number.isFinite(c.mtimeMs) && c.mtimeMs > 0) return c.mtimeMs;
  const j = c.j || {};
  const t = [j.updatedAt, j.finishedAt, j.startedAt, j.createdAt].map(Date.parse).filter(Number.isFinite);
  return t.length ? Math.max(...t) : NaN;
}
// Момент, к которому процесс уже существовал: отметка записи номера (берётся после spawn), последняя запись карточки, а для
// исполнителя — ещё и завершение поручения (исполнитель запущен до finishedAt; карточку могли переписать много позже).
function boundOf(j, pid, lw) {
  const stamps = [lw];
  if (childPids(j).includes(pid) && !ownerPids(j).includes(pid)) { const t = Date.parse(j.finishedAt); if (Number.isFinite(t)) stamps.push(t); }
  const add = (p, at) => { if (p === pid) { const t = Date.parse(at); if (Number.isFinite(t)) stamps.push(t); } };
  add(j.childPid, j.childStartedAt); add(j.agyPid, j.agyStartedAt); add(j.owner?.pid, j.owner?.startedAt); add(j.apply?.owner?.pid, j.apply?.owner?.startedAt);
  const ok = stamps.filter(Number.isFinite);
  return ok.length ? Math.min(...ok) : NaN;
}
// Возраст поручения — по его собственным отметкам времени (перезапись карточки отметкой слова/установки его не молодит).
function jobTimeOf(c) {
  const j = c.j || {};
  const t = [j.updatedAt, j.finishedAt, j.startedAt, j.createdAt, j.childStartedAt, j.agyStartedAt].map(Date.parse).filter(Number.isFinite);
  return t.length ? Math.max(...t) : lastWriteOf(c);
}
const holdFlags = j => !!(j.stopUnconfirmed || j.treeWarning || j.holdsFolder === true);
function storeOf(file) {
  if (!file) return null;
  const dir = path.dirname(file);
  return path.basename(file) === 'card.json' ? path.basename(path.dirname(dir)) : path.basename(dir);
}

// Хранилища действующих участников (по реестру состояния). null — реестр не прочитан (тогда признак «удалён» не применяем).
function memberStores(state) {
  try {
    const reg = require('./members-store').create(state).read({ initialize: false });
    const adapters = require('./members').adapters, out = new Set();
    for (const m of reg.members || []) if (m.state !== 'removed' && adapters[m.adapter]) out.add(adapters[m.adapter].jobs);
    return out.size ? out : null;
  } catch { return null; }
}

// Оценка карточки: { kind: 'clean'|'live'|'dead'|'keep', reason, status, pids, exec }.
//  clean — завершена без флагов и без живого исполнителя; live — есть живой процесс (exec — живой исполнитель, а не только
//  сервер-владелец) или окно запуска; dead — мёртвая; keep — не живая, но закрывать рано или нельзя.
function assess(c, ctx = {}) {
  const j = c.j || {}, status = j.status, now = ctx.now || Date.now();
  const lw = lastWriteOf(c);
  const st = p => pidState(p, boundOf(j, p, lw), ctx.table);
  // 1) живой исполнитель — при любом статусе.
  const exec = childPids(j), execStates = exec.map(p => [p, st(p)]);
  const liveExec = execStates.filter(([, s]) => isAlive(s)).map(([p]) => p);
  if (liveExec.length) return { kind: 'live', exec: true, status, pids: liveExec, reason: 'жив процесс исполнителя ' + liveExec.join(', ') };
  const flags = holdFlags(j);
  // 2) завершённая без флагов.
  if (TERMINAL.includes(status) && !flags) return { kind: 'clean', status };
  // 3) сервер-владелец идущего поручения/очереди.
  const owners = (RUNNING_LIKE.includes(status) || QUEUE.includes(status) || status === 'migration_conflict') ? ownerPids(j) : [];
  const ownerStates = owners.map(p => [p, st(p)]);
  const liveOwner = ownerStates.filter(([, s]) => isAlive(s)).map(([p]) => p);
  if (liveOwner.length) return { kind: 'live', exec: false, status, pids: liveOwner, reason: 'жив сервер-владелец ' + liveOwner.join(', ') };
  // 4) неизвестный статус и конфликт переноса — не закрываются.
  const known = TERMINAL.includes(status) || UNFINISHED.includes(status);
  if (!known) return { kind: 'keep', status, reason: 'неизвестный статус' };
  if (status === 'migration_conflict') return { kind: 'keep', status, reason: 'конфликт переноса — разбирается вручную' };
  const removed = !!(ctx.stores && c.store && !ctx.stores.has(c.store));
  // 5) очередь действующего участника ждёт законно (ручная пауза, квота) — не закрывается независимо от возраста.
  if (QUEUE.includes(status) && !removed) return { kind: 'keep', status, reason: 'очередь ждёт запуска' };
  const pids = [...exec, ...owners];
  // 6) участник удалён из связки (живых номеров нет — проверено выше; запускать у него некому).
  if (removed) return { kind: 'dead', status, reason: 'участник удалён из связки (' + c.store + ')', pids };
  // 7) окно запуска: номер исполнителя ещё не записан (владелец мог упасть между spawn и записью номера).
  const age = now - jobTimeOf(c);
  if (['running', 'applying'].includes(status) && !exec.length && age < LAUNCH_WINDOW)
    return { kind: 'live', exec: true, launching: true, status, pids: [], reason: 'запуск: номер процесса ещё не записан' };
  // 8) моложе суток не закрываются.
  const young = !(age >= DAY);
  // Без номера исполнителя (владелец мог упасть между spawn и записью номера) — сутки не трогаем.
  if (young && (!exec.length || status === 'needs_decision' || (j.write && RUNNING_LIKE.includes(status))))
    return { kind: 'keep', status, reason: 'моложе суток' };
  if (!TERMINAL.includes(status) && !CLOSABLE.includes(status)) return { kind: 'keep', status, reason: 'статус не закрывается автоматически' };
  const reused = [...execStates, ...ownerStates].filter(([, s]) => s === 'reused').map(([p]) => p);
  const reason = !pids.length ? 'нет номеров процессов, запись старше суток'
    : 'процессы ' + pids.join(', ') + ' завершены' + (reused.length ? ' (номер ' + reused.join(', ') + ' занят процессом, запущенным позже записи карточки)' : '');
  return { kind: 'dead', status, reason, pids };
}

// ---------- чтение состояния (с повтором сбойных записей) ----------
function readJsonRetry(file, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const raw = fs.readFileSync(file).toString('utf8').replace(/^\uFEFF/, '');
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object') throw Error('неверная запись');
      let mtimeMs = 0; try { mtimeMs = fs.statSync(file).mtimeMs; } catch {}
      return { j, raw, mtimeMs };
    } catch (e) {
      if (e.code === 'ENOENT') throw e;
      last = e; if (i < tries - 1) sleepSync(60);
    }
  }
  throw last;
}
function readCards(state) {
  const cards = [], errors = [];
  let stores;
  try { stores = fs.readdirSync(state).filter(n => n === 'jobs' || n.endsWith('-jobs')); }
  catch (e) { if (e.code !== 'ENOENT') errors.push('состояние ' + state + ': ' + e.message); return { cards, errors }; }
  for (const sub of stores) {
    const who = sub === 'jobs' ? 'antigravity' : sub.slice(0, -5);
    const dir = path.join(state, sub);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { if (e.code !== 'ENOENT') errors.push('хранилище ' + dir + ': ' + e.message); continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.includes('.conflict-') || entry.name.endsWith('.tmp')) continue;
      if (!entry.isDirectory() && !entry.name.endsWith('.json')) continue;
      const file = path.join(dir, entry.name, ...(entry.isDirectory() ? ['card.json'] : []));
      let r;
      try { r = readJsonRetry(file); }
      catch (e) {
        if (e.code === 'ENOENT') continue; // рабочая папка без карточки / карточка удалена между перечислением и чтением
        errors.push('карточка ' + file + ': ' + e.message);
        continue;
      }
      cards.push({ who, j: r.j, raw: r.raw, entry: entry.name, file, store: sub, mtimeMs: r.mtimeMs });
    }
  }
  return { cards, errors };
}
// Замки записи (Codex п.4, Gemini д): одна нечитаемая запись не обнуляет остальные; сбойная перечитывается; нет каталога —
// замков нет. Неверная запись остаётся ошибкой (снимок неполон), а не молчаливым пропуском.
function readLocks(state) {
  const dir = require('./write-lock').dir(state), locks = [], errors = [];
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return { locks, errors }; errors.push('замки ' + dir + ': ' + e.message); return { locks, errors }; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(dir, n);
    let r;
    try { r = readJsonRetry(file); }
    catch (e) { if (e.code === 'ENOENT') continue; errors.push('замок ' + file + ': ' + e.message); continue; }
    const entry = r.j;
    if (typeof entry.folder !== 'string' || !path.isAbsolute(entry.folder) || typeof entry.instance !== 'string' || !entry.instance) { errors.push('замок ' + file + ': неверная запись'); continue; }
    locks.push({ file, entry, mtimeMs: r.mtimeMs || NaN });
  }
  return { locks, errors };
}
function load(state) {
  const { cards, errors } = readCards(state);
  const { locks, errors: lockErrors } = readLocks(state);
  return { cards, errors, locks, lockErrors, lockError: lockErrors.length ? lockErrors.join('; ') : null };
}
// Номера, которые понадобятся оценке: исполнители всех карточек (живой исполнитель важен при любом статусе), владельцы —
// только у незавершённых, плюс владельцы замков.
function pidsOf(data) {
  const out = [];
  for (const c of data.cards) { const j = c.j || {}; out.push(...childPids(j)); if (!TERMINAL.includes(j.status)) out.push(...ownerPids(j)); }
  for (const l of data.locks) out.push(l.entry.pid);
  return out;
}
function context(state, opts = {}, data) {
  return { now: opts.now || Date.now(), autoNow: !opts.now, table: opts.table !== undefined ? opts.table : tableSync(pidsOf(data || load(state))), stores: opts.stores !== undefined ? opts.stores : memberStores(state) };
}
// Один снимок процессов и реестра на запрос (Codex п.7): сводка (краткая и полная) и ворота пользуются одним и тем же.
async function contextAsync(state, jobs, opts = {}) {
  const out = [];
  for (const j of jobs) { out.push(...childPids(j)); if (!TERMINAL.includes(j.status)) out.push(...ownerPids(j)); }
  return { now: opts.now || Date.now(), autoNow: !opts.now, table: opts.table !== undefined ? opts.table : await tableAsync(out), stores: opts.stores !== undefined ? opts.stores : memberStores(state) };
}
// Снимок запроса для сводок: один на объект снимка карточек (job-snapshot) — краткая и полная сводка, сколько бы карточек ни
// оценивали, используют одну таблицу процессов и один реестр.
const reqCache = new WeakMap();
function requestContext(snapshot, state = require('./paths').stateDir) {
  if (snapshot && reqCache.has(snapshot)) return reqCache.get(snapshot);
  const p = (async () => {
    const jobs = [];
    for (const who of require('./members').scanIds) {
      try {
        const listed = snapshot ? snapshot.list(who, true) : require('./team-store').list(who, true);
        jobs.push(...listed.jobs.filter(j => !j.archived && (j.stopUnconfirmed || j.treeWarning || UNFINISHED.includes(j.status))));
      } catch {}
    }
    return contextAsync(state, jobs);
  })();
  if (snapshot) reqCache.set(snapshot, p);
  return p;
}
// Оценка карточки из сводки (j.cardFile) по общему снимку запроса.
function assessJob(j, ctx) {
  let mtimeMs = 0; try { mtimeMs = fs.statSync(j.cardFile).mtimeMs; } catch {}
  return assess({ j, mtimeMs, store: storeOf(j.cardFile) }, ctx);
}
// Состояние замка записи: живой владелец (тот же номер, запущен не позже записи замка) — 'live'; иначе 'dead'.
function lockState(l, ctx) {
  const lw = [l.mtimeMs, Date.parse(l.entry.since)].filter(t => Number.isFinite(t) && t > 0);
  return isAlive(pidState(l.entry.pid, lw.length ? Math.min(...lw) : NaN, ctx.table)) ? 'live' : 'dead';
}

// Обзор состояния: живые поручения/замки и мёртвые карточки/замки. Только чтение. incomplete — причины неполноты снимка.
function survey(state, opts = {}) {
  const data = opts.data || module.exports.load(state);
  const ctx = opts.ctx || context(state, opts, data);
  const { cards, errors } = data;
  const live = [], dead = [], kept = [];
  for (const c of cards) {
    const a = assess(c, ctx);
    if (a.kind === 'live') live.push({ c, a });
    else if (a.kind === 'dead') dead.push({ c, a });
    else if (a.kind === 'keep') kept.push({ c, a });
  }
  const liveIds = new Set(live.map(x => String(x.c.j.id || x.c.entry)));
  const liveLocks = [], deadLocks = [];
  for (const l of data.locks) {
    const s = lockState(l, ctx);
    if (s === 'live') liveLocks.push(l);
    // Замок мёртвого владельца снимается, только если его поручение не живо.
    else if (!(l.entry.jobId && liveIds.has(String(l.entry.jobId)))) deadLocks.push(l);
  }
  const incomplete = [...(errors || []), ...(data.lockErrors || (data.lockError ? [data.lockError] : []))];
  if (ctx.table && ctx.table.incomplete) incomplete.push(ctx.table.incomplete);
  return { ctx, data, live, dead, kept, liveLocks, deadLocks, errors, lockError: data.lockError || null, incomplete };
}

// ---------- финализация ----------
// Замок карточки — тот же, что у адаптера (servers/*/index.js mutate/updateJob; common/job-cancel.jobLock).
function cardLockKind(store) { return store === 'jobs' ? 'job' : store.replace(/-jobs$/, '_job'); }
// Antigravity (Codex п.6): та же процедура, что normalizeJob адаптера — сохранённый результат и его хеш совпали — done.
function agyRecover(c, next, at) {
  if (c.store !== 'jobs') return false;
  const meta = require('./agy-recover').committedMeta(path.dirname(c.file));
  if (!meta) return false;
  Object.assign(next, require('./agy-recover').recoveredFields(meta, next, 'результат был зафиксирован, но владелец задания завершился до обновления карточки; восстановлено уборкой'));
  next.closedDead = { label: 'восстановлено: результат сохранён', reason: 'готовый результат и его хеш совпали', at, prevStatus: c.j.status };
  return true;
}
function closedCard(c, a, at) {
  const j = c.j, next = { ...j };
  if (!TERMINAL.includes(j.status) && agyRecover(c, next, at)) { delete next.stopUnconfirmed; delete next.treeWarning; delete next.holdsFolder; return { next, recovered: true }; }
  next.closedDead = { label: LABEL, reason: a.reason, at, prevStatus: j.status,
    prevFlags: { stopUnconfirmed: j.stopUnconfirmed ?? null, treeWarning: j.treeWarning ?? null, holdsFolder: j.holdsFolder ?? null } };
  if (!TERMINAL.includes(j.status)) { next.status = 'lost'; if (!next.finishedAt) next.finishedAt = at; }
  delete next.stopUnconfirmed; delete next.treeWarning; delete next.holdsFolder;
  return { next, recovered: false };
}
// Закрытие одной карточки под замком карточки адаптера: перечитать под замком; изменилась с оценки — не трогать (Codex п.3).
async function closeOne(state, c, a, at, ctx, deps) {
  const id = String(c.j.id || c.entry.replace(/\.json$/, ''));
  const locks = deps.locks || require('./locks');
  const l = await locks.waitLock(cardLockKind(c.store), id, { jobId: id, by: 'dead-jobs' }, deps.lockWaitMs ?? 8000, state);
  if (!l.ok) return { error: 'карточка занята' };
  try {
    if (deps.hook) await deps.hook('locked', c);
    let cur;
    try { cur = readJsonRetry(c.file); } catch (e) { return { error: e.code === 'ENOENT' ? 'карточка удалена' : 'не прочитана: ' + e.message }; }
    if (cur.raw !== c.raw || (Number.isFinite(c.mtimeMs) && c.mtimeMs > 0 && cur.mtimeMs !== c.mtimeMs)) return { error: 'карточка изменилась' };
    // Повторная оценка под замком: явно заданное время (opts.now или ctx.now вызывающего) не затирается; время, взятое снимком по умолчанию, — текущее (ревью Gemini б).
    const again = assess({ ...c, j: cur.j, raw: cur.raw, mtimeMs: cur.mtimeMs }, { ...ctx, now: !ctx.autoNow && Number.isFinite(ctx.now) ? ctx.now : Date.now() });
    if (again.kind !== 'dead') return { error: 'по повторной оценке не мёртвая (' + again.kind + ')' };
    const { next, recovered } = closedCard(c, again, at);
    require('./team-git').atomic(c.file, JSON.stringify(next, null, 2) + '\n');
    return { recovered };
  } finally { try { await l.release(); } catch {} }
}
// Перед снятием замка записи — повторная проверка связи под мьютексом замков (Codex п.3): владелец по-прежнему мёртв, а
// поручение замка (если есть) по свежей карточке на диске не живое.
function lockStillDead(l, s) {
  return entry => {
    if (entry.pid !== l.entry.pid) return false;
    const fresh = { ...l, entry };
    if (lockState(fresh, s.ctx) !== 'dead') return false;
    if (!s.ctx.table && killProbe(entry.pid) !== false) return false;
    if (entry.jobId) {
      for (const c of s.data.cards) {
        if (String(c.j.id || c.entry) !== String(entry.jobId)) continue;
        let cur; try { cur = readJsonRetry(c.file); } catch (e) { if (e.code === 'ENOENT') continue; return false; }
        if (assess({ ...c, j: cur.j, mtimeMs: cur.mtimeMs }, s.ctx).kind === 'live') return false;
      }
    }
    return true;
  };
}
// apply=false — только показать, что будет закрыто (ничего не пишет и замков не берёт). Снимок неполон — ничего не закрываем.
async function finalize(state, opts = {}) {
  const apply = opts.apply !== false;
  const data = opts.data || load(state);
  const table = opts.table !== undefined ? opts.table : await tableAsync(pidsOf(data));
  const s = survey(state, { ...opts, data, table });
  const at = new Date(s.ctx.now).toISOString(), closed = [], recovered = [], locks = [], failed = [];
  const base = { apply, at, closed, recovered, locks, failed, live: s.live.length, liveLocks: s.liveLocks.length, incomplete: s.incomplete,
    kept: s.kept.map(({ c, a }) => ({ who: c.who, id: String(c.j.id || c.entry), status: c.j.status, reason: a.reason })), errors: s.errors };
  if (s.incomplete.length) return { ...base, skipped: 'снимок неполон — ничего не закрыто: ' + s.incomplete.join('; ') };
  for (const { c, a } of s.dead) {
    const j = c.j, id = String(j.id || c.entry);
    const item = { who: c.who, id, status: j.status, folder: j.folder || j.cwd || j.papka || null, reason: a.reason };
    if (!apply) { (c.store === 'jobs' && !TERMINAL.includes(j.status) && require('./agy-recover').committedMeta(path.dirname(c.file)) ? recovered : closed).push(item); continue; }
    try {
      const r = await closeOne(state, c, a, at, s.ctx, opts.deps || {});
      if (r.error) failed.push({ ...item, error: r.error });
      else (r.recovered ? recovered : closed).push(item);
    } catch (e) { failed.push({ ...item, error: e.message }); }
  }
  for (const l of s.deadLocks) {
    const item = { instance: l.entry.instance, jobId: l.entry.jobId || null, folder: l.entry.folder, pid: l.entry.pid };
    if (!apply) { locks.push(item); continue; }
    try {
      const r = require('./write-lock').releaseOrphan({ instance: l.entry.instance }, state, { verify: lockStillDead(l, s) });
      if (r.released || r.absent) locks.push(item); else failed.push({ lock: l.entry.instance, error: 'связь замка изменилась' });
    } catch (e) { failed.push({ lock: l.entry.instance, error: e.message }); }
  }
  return base;
}
const finalizeAsync = finalize;
// Сервер team: при запуске и раз в сутки. Пишет одну строку в журнал моста.
function schedule(state, opts = {}) {
  const run = () => finalize(state, opts).then(r => {
    try {
      fs.mkdirSync(path.join(state, 'team'), { recursive: true });
      fs.appendFileSync(path.join(state, 'team', 'cleanup-log.jsonl'), JSON.stringify({ at: r.at, kind: 'dead-jobs', closed: r.closed.length, recovered: r.recovered.length, locks: r.locks.length, failed: r.failed.length, ...(r.skipped ? { skipped: r.skipped } : {}) }) + '\n');
      console.error('team: мёртвые поручения — ' + (r.skipped || 'закрыто ' + r.closed.length + ', восстановлено ' + r.recovered.length + ', снято замков ' + r.locks.length));
    } catch {}
    return r;
  }).catch(() => null);
  const first = run();
  const t = setInterval(run, opts.everyMs || DAY); if (t.unref) t.unref();
  return first;
}

// ---------- ворота установки ----------
// Живое для ворот: одна строка на поручение. Очередь без живого исполнителя установку не ждёт (поднимается после запуска);
// живой исполнитель держит при любом статусе. Замок живого владельца без живой карточки — тоже строка.
// Снимок неполон — incomplete (вызывающий даёт технический отказ одной строкой).
function gateFrom(s) {
  const fmt = require('./format'), now = s.ctx.now;
  const rows = [];
  for (const { c, a } of s.live) {
    const j = c.j;
    if (!a.exec && QUEUE.includes(j.status)) continue;
    const started = Date.parse(j.startedAt || j.createdAt);
    rows.push({ who: c.who, id: String(j.id || c.entry), status: j.status, folder: j.folder || j.cwd || j.papka || 'не указана',
      duration: Number.isFinite(started) ? fmt.duration(now - started) : 'время неизвестно', from: j.from || j.sender || 'не указан',
      work: j.workName || (typeof j.work === 'string' && j.work) || 'не указана' });
  }
  const ids = new Set(rows.map(r => r.id)), locks = [];
  for (const l of s.liveLocks) if (!(l.entry.jobId && ids.has(String(l.entry.jobId))))
    locks.push('замок записи папки ' + l.entry.folder + (l.entry.jobId ? ' (поручение ' + l.entry.jobId + ')' : '') + ' — владелец жив, PID ' + l.entry.pid);
  return { running: rows, locks, incomplete: s.incomplete };
}
function liveForGate(state, opts = {}) { return gateFrom(survey(state, opts)); }
function incompleteLine(incomplete) {
  return INCOMPLETE_LINE + ' (' + incomplete.slice(0, 2).join('; ') + (incomplete.length > 2 ? '; ещё ' + (incomplete.length - 2) : '') + ') — повторите установку.';
}
function line(r) { return r.who + ' — папка ' + r.folder + ', идёт ' + r.duration + ', отправил ' + r.from; }

module.exports = { load, readLocks, readCards, pidsOf, assess, assessJob, survey, finalize, finalizeAsync, schedule, liveForGate, gateFrom, line, incompleteLine,
  tableFrom, tableSync, tableAsync, parsePs, fromPs, pidState, memberStores, context, contextAsync, requestContext, childPids, ownerPids, cardPids, storeOf, cardLockKind,
  DAY, LAUNCH_WINDOW, LABEL, UNFINISHED, TERMINAL, QUEUE, CLOSABLE, INCOMPLETE_LINE };
