'use strict';
const RESTART_HOLD_PROTOCOL = 1;
const fs = require('fs'), path = require('path'), cp = require('child_process'), { randomUUID } = require('crypto');
const locks = require('./locks');
const stamp = value => { const n = Date.parse(value); return Number.isFinite(n) ? Math.floor(n / 1000) : NaN; };
const same = (a, b) => a?.pid === b?.pid && Number.isFinite(stamp(a?.startedAt)) && stamp(a.startedAt) === stamp(b?.startedAt);
const holdFile = state => path.join(state, 'restart-hold.json');
function claimFile(state, runId, closed = false) {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId || '')) throw Error('Неверный runId паузы.');
  return path.join(state, 'restart-claims', runId + (closed ? '.closed.json' : '.json'));
}
function read(file) {
  try { return { value: JSON.parse(fs.readFileSync(file).toString('utf8').replace(/^\uFEFF/, '')) }; }
  catch (e) { return e.code === 'ENOENT' ? { missing: true } : { error: e }; }
}
// Полная запись закрыта до публикации; link не заменяет победителя гонки.
function publish(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, Buffer.from(JSON.stringify(value)), { flag: 'wx' }); fs.linkSync(temp, file); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function cancel(state, runId) { return publish(claimFile(state, runId), { decision: 'отмена', by: process.pid, at: new Date().toISOString() }); }
function fingerprint(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw Error('Неизвестный pid.');
  if (process.platform !== 'win32') return require('./fallback').processTable(true, { native: true }).find(p => p.pid === pid) || null;
  const out = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; try { $p=Get-Process -Id " + pid + " -ErrorAction Stop } catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { 'null'; exit 0 }; throw }; @{pid=$p.Id;startedAt=$p.StartTime.ToUniversalTime().ToString('o');name=$p.ProcessName} | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  return JSON.parse(out.trim());
}
// team-v46: прямой родитель без PowerShell на каждое поручение. При старте сервера один раз запускается
// фоновый PowerShell-сторож: открывает дескрипторы родителя (process.ppid) и самого сервера ($p.Handle, $s.Handle —
// пока дескриптор открыт, Windows не переиспользует pid), печатает время запуска родителя и ждёт, пока выйдет
// родитель (exit 0) или сервер (exit 3) — так сторож не переживает принудительно убитый сервер.
// Решение принимается по текущему состоянию, а не по сохранённому флагу: сторож жив (t1) → родитель жив (t2) →
// сторож всё ещё жив (t3). Сторож жив на всём [t1, t3] (pid сторожа держит libuv), значит, дескриптор родителя
// открыт и pid родителя на [t1, t3] не переиспользован — живой процесс в t2 и есть исходный родитель.
// Время запуска не совпало с server.parent.startedAt, сторож не ответил или не работает — null → прежняя processState.
let parentWatch = null;
function watchParent(deps = {}, state = null) {
  // В тестах (NODE_ENV=test) настоящий сторож не запускается — только подменённый deps.spawnWatch.
  if (parentWatch || (!deps.spawnWatch && (process.platform !== 'win32' || process.env.NODE_ENV === 'test'))) return parentWatch;
  const pid = process.ppid;
  // Ответ сторожа дублируется в файл: вывод PowerShell в канал на ПК пользователя до сервера не доходил (29.10, сторожа живы, ответа нет).
  const markFile = state ? path.join(state, 'restart-servers', process.pid + '.watch') : null;
  const w = parentWatch = { pid, startedAt: null, child: null, exitCode: null, spawnedAt: Date.now(), markFile };
  try {
    w.child = (deps.spawnWatch || ((ppid, self) => cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $p=Get-Process -Id " + ppid + "; $h=$p.Handle; $s=Get-Process -Id " + self + "; $sh=$s.Handle; " +
      "$t=$p.StartTime.ToUniversalTime().ToString('o'); " +
      (markFile ? "[IO.File]::WriteAllText('" + markFile.replace(/'/g, "''") + "', $t); " : '') +
      "[Console]::Out.WriteLine($t); [Console]::Out.Flush(); " +
      "while (-not $p.HasExited -and -not $s.HasExited) { Start-Sleep -Milliseconds 500 }; if ($p.HasExited) { exit 0 } else { exit 3 }"],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })))(pid, process.pid);
  } catch { w.exitCode = -1; return w; }
  let buf = '';
  w.child.stdout?.on('data', d => { buf += d; if (buf.includes('\n') && !w.startedAt) w.startedAt = buf.split(/\r?\n/)[0].trim(); });
  w.child.on('error', () => { w.exitCode = -1; });
  w.child.on('exit', code => { w.exitCode = code; });
  w.child.unref?.(); w.child.stdout?.unref?.();
  process.once('exit', () => { try { w.child.kill(); } catch {} });
  return w;
}
function directParentState(parent, w = parentWatch, kill = process.kill.bind(process)) {
  if (!w || !w.child || !parent || parent.pid !== w.pid) return null;
  if (!w.startedAt && w.markFile) { try { const t = fs.readFileSync(w.markFile, 'utf8').trim(); if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(t)) w.startedAt = t; } catch {} }
  // Сторож ещё не ответил (PowerShell на ПК пользователя до 1 мин) — не ждать синхронный PowerShell внутри поручения.
  // Ждём ответа сторожа не дольше 3 мин; дальше — прежняя проверка.
  if (!w.startedAt) return w.exitCode === null && w.child.pid && Date.now() - (w.spawnedAt || 0) < 180000 ? 'pending' : null;
  if (!Number.isFinite(stamp(w.startedAt)) || stamp(w.startedAt) !== stamp(parent.startedAt)) return null;
  const alive = pid => { try { kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM' || e.code === 'EACCES' ? true : e.code === 'ESRCH' ? false : null; } };
  if (w.exitCode === 0) return 'dead';
  if (w.exitCode !== null || !w.child.pid) return null;
  if (alive(w.child.pid) !== true) return null;           // t1: сторож жив
  const p = alive(parent.pid);                              // t2: родитель
  if (alive(w.child.pid) !== true) return null;           // t3: сторож всё ещё жив
  return p === true ? 'alive' : null;
}
function processState(owner, deps = {}) {
  if (!owner?.pid || !Number.isFinite(stamp(owner.startedAt))) return 'unknown';
  try { const p = (deps.fingerprint || fingerprint)(owner.pid); return p === null ? 'dead' : !Number.isFinite(stamp(p?.startedAt)) ? 'unknown' : same(owner, p) ? 'alive' : 'dead'; }
  catch { return 'unknown'; }
}
function capture(deps = {}) {
  const server = { startedAt: deps.serverStartedAt || locks.STARTED_AT, ancestors: [], parent: null, closed: false, ended: 'broken', captureAttemptAt: (deps.now || Date.now)() };
  try {
    // Таблица сценариев запасного режима не является доказательством предков сервера.
    const rows = (deps.processTable || (() => require('./fallback').processTable(true, { native: true })))();
    const byPid = new Map(rows.map(r => [r.pid, r])); let p = byPid.get(process.pid);
    if (!p) throw Error('Нет процесса сервера в дереве процессов.');
    // team-v46: свой отпечаток — из того же снимка, без второго PowerShell при старте.
    if (Number.isFinite(stamp(p.startedAt))) server.self = { pid: p.pid, startedAt: p.startedAt, name: p.name };
    const seen = new Set([p.pid]);
    while (p.ppid && p.pid !== 4 && p.ppid !== 4 && !seen.has(p.ppid)) {
      const next = byPid.get(p.ppid);
      // Завершившийся предок и переиспользованный PID заканчивают достоверную цепочку.
      if (!next) break;
      if (!Number.isFinite(stamp(next.startedAt))) throw Error('Не прочитано время запуска в таблице процессов.');
      if (stamp(next.startedAt) > stamp(p.startedAt)) break;
      server.ancestors.push({ pid: next.pid, startedAt: next.startedAt, name: next.name }); seen.add(next.pid); p = next;
    }
    server.parent = server.ancestors[0] || null;
    server.ended = !p.ppid || p.pid === 4 || p.ppid === 4 || server.ancestors.some(a => /^claude(?:\.exe)?$/i.test(a.name || '')) ? 'root' : 'broken';
  } catch (e) { server.error = e.message; }
  return server;
}
function hold(state) {
  const r = read(holdFile(state));
  if (!r.missing && !r.error && (!r.value?.id || !/^[a-zA-Z0-9_-]+$/.test(r.value.runId || '') || !Number.isFinite(Date.parse(r.value.createdAt)) || !r.value.executor)) r.error = Error('Неверная пауза перезапуска.');
  return r;
}
function decision(state, h) {
  const r = read(claimFile(state, h.runId));
  if (!r.missing && !r.error && !validCancel(r.value) && !validClosing(r.value)) r.error = Error('Неверная отметка решения.');
  return r;
}
function validCancel(c) { return c?.decision === 'отмена' && c.by && Number.isFinite(Date.parse(c.at)); }
function validClosing(c) {
  return c?.decision === 'закрываю' && c.id && c.runId && c.pid && Number.isFinite(stamp(c.startedAt)) &&
    Number.isFinite(Date.parse(c.publishedAt)) && Array.isArray(c.targets) && c.targets.every(t => t.pid && Number.isFinite(stamp(t.startedAt)));
}
const time = h => new Date(h.createdAt).toTimeString().slice(0, 5);
function refusal(kind, h = {}) {
  const text = kind === 'old' ? 'Этот сервер моста остался от закрытого Claude: поручение не принято. Повторите через минуту — ответит новый сервер.' :
    kind === 'doomed' ? `Этот Claude должен был закрыться при перезапуске моста (операция ${h.id}): его серверы поручения не принимают. Перезапустите Claude — после этого поручения пойдут.` :
    kind === 'parent' ? 'Не удалось проверить, что Claude этого сервера работает: поручение не принято, чтобы не оборваться. Если повторяется — это сбой моста, сообщите.' :
    kind === 'starting' ? 'Сервер моста ещё готовится после запуска (проверка процессов Windows, до 1–2 мин): поручение не принято. Повторите через минуту.' :
    kind === 'unreadable' ? 'Не удалось прочитать состояние паузы перезапуска: поручение не принято, чтобы не оборваться. Если повторяется — это сбой моста, сообщите.' :
    `Идёт перезапуск Claude для установки моста (операция ${h.id}, с ${time(h)}): поручение не принято, чтобы не оборваться. Повторите через 2–3 минуты.`;
  return { ok: false, kind, reason: text };
}
function claims(state) {
  try { return fs.readdirSync(path.join(state, 'restart-claims')).filter(n => n.endsWith('.json')).map(n => path.join(state, 'restart-claims', n)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
// Вызывается под job_start. early — только чтение, никогда не публикует отмену.
function admit(state, server, { early = false, ...deps } = {}) {
  if (require('./members-kimi').pending(state)) return { ok: false, kind: 'kimi-recovery', reason: 'Миграция Kimi не завершена; запуски удерживаются до восстановления новым кодом.' };
  // Один свежий снимок на вызов: только повтор capture или цели при оборванной цепочке.
  let processRows, targetTable;
  const processTable = () => processRows ??= (deps.processTable || (() => require('./fallback').processTable(true, { native: true })))();
  try {
    try {
      const registry = require('./members-store').create(state).read();
      const members = require('./members');
      if (Object.values(members.adapters).some(a => a.server === server.name) && !members.receiver(server.name, registry.members))
        return { ok: false, kind: 'members', reason: 'Сервер ' + server.name + ' не имеет получателя поручений по реестру.' };
    } catch (e) { return { ok: false, kind: 'members', reason: e.message }; }
    if (server.pending) return refusal('starting');
    const r = hold(state);
    if (r.error) return refusal('unreadable');
    if (!r.missing) {
      const h = r.value; let d = decision(state, h);
      if (d.error) return refusal('unreadable');
      if (d.missing) {
        if (processState(h.executor, deps) !== 'dead') return refusal('pause', h);
        if (!early) {
          try { cancel(state, h.runId); } catch { return refusal('unreadable'); }
          d = decision(state, h);
        } // Проигрыш публикации тоже требует чтения победителя.
      }
      if (d.error || (d.missing && !early)) return refusal('unreadable');
      if (d.value?.decision === 'закрываю') {
        const closed = read(claimFile(state, h.runId, true));
        if (!closed.missing) {
          if (closed.error || !Number.isFinite(Date.parse(closed.value?.closedAt))) return refusal('unreadable');
          if (!(Date.parse(server.startedAt) > Date.parse(closed.value.closedAt))) return refusal('old');
        } else if (processState(d.value, deps) !== 'dead') return refusal('pause', h);
      }
    }
    // Повтор только при решающем допуске под job_start, до свежих проверок поколения и родителя.
    const retryDue = server.error && !server.async && (deps.now || Date.now)() - server.captureAttemptAt >= 10000;
    if (retryDue && !early) {
      const fresh = capture({ ...deps, processTable, serverStartedAt: server.startedAt });
      server.captureAttemptAt = fresh.captureAttemptAt;
      if (fresh.error) { server.error = fresh.error; return refusal('parent'); }
      const recovered = { ...fresh, name: server.name, closed: server.closed };
      try { saveServer(state, recovered, deps); }
      catch (e) { server.error = e.message; return refusal('parent'); }
      Object.assign(server, recovered); delete server.error;
    }
    // Только после 1–5: свежие отметки, вся цепочка обречённого поколения, родитель и канал.
    const files = claims(state);
    for (const f of files.filter(f => f.endsWith('.closed.json'))) {
      const c = read(f), at = c.error || !Number.isFinite(Date.parse(c.value?.closedAt)) ? fs.statSync(f).mtimeMs : Date.parse(c.value.closedAt);
      if (Date.parse(server.startedAt) <= at) return refusal('old');
    }
    for (const f of files.filter(f => !f.endsWith('.closed.json'))) {
      const c = read(f);
      if (!c.error && validCancel(c.value)) continue;
      // Ошибка capture остаётся в прежнем пути отказа/повтора под job_start.
      if (server.ended === 'broken' && !server.error) {
        const runId = path.basename(f, '.json'), closed = read(f.slice(0, -5) + '.closed.json');
        const finished = !closed.error && Number.isFinite(Date.parse(closed.value?.closedAt));
        if (!finished) {
          if (c.error || !validClosing(c.value) || c.value.runId !== runId) return refusal('parent');
          if (c.value.targets.length) {
            try {
              targetTable ??= new Map(processTable().map(p => [p.pid, p]));
              // Пустой/неполный ответ CIM не доказывает смерть целей: сам сервер ещё жив.
              if (!targetTable.has(process.pid)) return refusal('parent');
              if (c.value.targets.some(t => processState(t, { fingerprint: pid => targetTable.get(pid) || null }) !== 'dead')) return refusal('parent');
            } catch { return refusal('parent'); }
          }
        }
      }
      if (c.error || !validClosing(c.value)) {
        const at = fs.statSync(f).mtimeMs;
        if ((server.ancestors || []).some(p => /^claude(?:\.exe)?$/i.test(p.name || '') && Date.parse(p.startedAt) <= at)) return refusal('unreadable');
      } else if ((server.ancestors || []).some(p => c.value.targets.some(t => same(t, p)))) return refusal('doomed', c.value);
    }
    if (server.closed) return refusal('old');
    // Ранняя проверка не восстанавливает снимок: она лишь пропускает запрос к job_start.
    if (server.error) return early && retryDue ? { ok: true } : refusal('parent');
    if (!server.parent) return refusal('old');
    // team-v46: ответ фонового сторожа родителя (watchParent); без ответа — прежняя проверка (PowerShell 18–60 с на ПК пользователя).
    const watched = !deps.fingerprint && directParentState(server.parent);
    if (watched === 'pending') return refusal('starting');
    const parent = watched || processState(server.parent, deps);
    if (parent === 'dead') return refusal('old');
    if (parent !== 'alive') return refusal('parent');
    return { ok: true };
  } catch { return refusal('unreadable'); }
}
function assertAdmitted(state, server, options) {
  const r = admit(state, server, options);
  if (!r.ok) throw Object.assign(Error(r.reason), { restartHold: true, kind: r.kind });
}
async function locked(state, fn, deps = {}) {
  const l = await (deps.waitLock || locks.waitLock)('job_start', 'all', {}, deps.lockWaitMs ?? 30000, state);
  if (!l.ok) throw Object.assign(Error('Перезапуск не запущен: замок запуска поручений занят.'), { restartNotStarted: true, restartHold: true });
  try { return await fn(); } finally { await l.release(); }
}
// resolved не равно admit: живой сценарий после «закрыто» ещё запускает новый Claude.
function resolved(state, deps = {}) {
  if (require('./members-kimi').pending(state)) return false;
  const r = hold(state); if (r.missing) return true; if (r.error) return false;
  let d = decision(state, r.value); if (d.error) return false;
  if (d.missing && processState(r.value.executor, deps) === 'dead') {
    try { cancel(state, r.value.runId); } catch { return false; }
    d = decision(state, r.value);
  }
  return !d.error && !d.missing && (d.value.decision === 'отмена' || processState(d.value, deps) === 'dead');
}
function removeOwn(state, h) {
  const r = hold(state);
  if (!r.error && r.value?.id === h.id && r.value.runId === h.runId) fs.unlinkSync(holdFile(state));
}
async function cleanup(state, deps = {}) {
  return locked(state, () => { const r = hold(state); if (!r.missing && !r.error && resolved(state, deps)) { removeOwn(state, r.value); return true; } return false; }, deps);
}
async function begin(state, { runId, id = runId, beforeHold }, deps = {}) {
  return locked(state, async () => {
    await beforeHold?.(); // Под job_start, до чтения/разрешения прежней паузы и любых записей.
    const r = hold(state);
    if (!r.missing) {
      if (r.error || !resolved(state, deps)) throw Object.assign(Error('Перезапуск не запущен: идёт другой перезапуск (операция ' + (r.value?.id || 'не прочитана') + ').'), { restartNotStarted: true });
      removeOwn(state, r.value);
    }
    let executor;
    try { executor = (deps.fingerprint || fingerprint)(process.pid); }
    catch { throw Object.assign(Error('Перезапуск не запущен: не удалось проверить процесс исполнителя.'), { restartNotStarted: true }); }
    if (!executor || !Number.isFinite(stamp(executor.startedAt))) throw Object.assign(Error('Перезапуск не запущен: не удалось проверить процесс исполнителя.'), { restartNotStarted: true });
    const h = { id, runId, createdAt: new Date().toISOString(), executor: { pid: executor.pid, startedAt: executor.startedAt } };
    fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(holdFile(state), Buffer.from(JSON.stringify(h)), { flag: 'wx' }); return h;
  }, deps);
}
async function abort(state, h, deps = {}) {
  if (require('./members-kimi').pending(state)) return false;
  return locked(state, () => {
    try { cancel(state, h.runId); } catch { return false; }
    const d = decision(state, h);
    if (!d.error && d.value?.decision === 'отмена') { removeOwn(state, h); return true; }
    return false;
  }, deps);
}
// team-v60: предупреждения сводки не запускают powershell на каждый PID. Один кэшируемый снимок таблицы процессов на запрос
// (fallback.processTable, кэш в памяти процесса) — живость PID проверяется по карте, а не отдельным Get-Process на процесс.
// Переданный deps.fingerprint (тесты) не трогаем.
function snapshotFingerprint() {
  let map, snapError;
  return pid => {
    if (!map) {
      // team-v61 (п.2): сбой снимка (CIM/powershell бросил, либо пустая таблица — при успехе в ней всегда есть сам процесс)
      // НЕ превращается в пустую карту: иначе каждый PID выглядел бы мёртвым и предупреждения («Claude должен был закрыться…
      // но работает», «не удалось проверить цепочку предков…») молча пропадали бы. Ошибку запоминаем и бросаем на каждый
      // запрос — processState ловит её и возвращает 'unknown' («проверить нельзя»), как прежний per-PID путь. Таблица
      // запрашивается ровно один раз на вызов warnings (кэш в fallback), второго powershell на PID нет.
      try {
        const rows = require('./fallback').processTable(false);
        if (!Array.isArray(rows) || !rows.length) throw Error('Снимок процессов пуст.');
        map = new Map(rows.map(p => [p.pid, p]));
      } catch (e) { snapError = e; map = new Map(); }
    }
    if (snapError) throw snapError;
    return map.get(pid) || null;
  };
}
function warnings(state, deps = {}) {
  const lines = [], r = hold(state);
  const d2 = { ...deps, fingerprint: deps.fingerprint || snapshotFingerprint() };
  if (r.error) lines.push('Пауза перезапуска: проверить нельзя — файл паузы не читается; новые поручения не принимаются.');
  if (r.value && !r.error) {
    const d = decision(state, r.value), done = !d.error && d.value && (d.value.decision === 'отмена' || processState(d.value, d2) === 'dead');
    if (!done) {
      const owner = d.value?.decision === 'закрываю' ? d.value : r.value.executor, live = processState(owner, d2);
      const detail = d.error || live === 'unknown' ? 'проверить нельзя' : d.value ? 'сценарий закрывает Claude' : live === 'alive' ? 'исполнитель жив' : 'исполнитель мёртв, решение не опубликовано — снимет следующий участник';
      lines.push(`Пауза перезапуска: операция ${r.value.id}, с ${time(r.value)}, ${detail} — старые серверы не принимают новые поручения`);
    }
  }
  try {
    for (const f of claims(state).filter(f => !f.endsWith('.closed.json'))) {
      const c = read(f).value;
      if (validClosing(c) && processState(c, d2) === 'dead' && c.targets.some(t => processState(t, d2) === 'alive'))
        lines.push(`Claude должен был закрыться при перезапуске (операция ${c.id}), но работает: его серверы не принимают поручения — перезапустите Claude`);
    }
    const dir = path.join(state, 'restart-servers');
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
      const s = read(path.join(dir, f)).value;
      if (s?.error && processState(s.process, d2) !== 'dead') lines.push('Не удалось проверить цепочку предков сервера ' + s.name + ' — поручения не принимаются; подробности в журнале сервера.');
    }
  } catch { lines.push('Пауза перезапуска: не удалось прочитать отметки перезапуска.'); }
  return [...new Set(lines)];
}
function saveServer(state, s, deps) {
  const dir = path.join(state, 'restart-servers'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, process.pid + '.json'), Buffer.from(JSON.stringify({ ...s, process: (!deps.fingerprint && s.self) || (deps.fingerprint || fingerprint)(process.pid) })));
}
// team-v46: снимок процессов асинхронно — сервер подключается к Claude, не дожидаясь PowerShell (18–60 с на ПК пользователя;
// Claude Desktop ждёт ответа сервера ~60 с). Пока снимка нет, admit отвечает «сервер ещё готовится».
// Запасной снимок без WMI: Get-Process только своего процесса и родителя (CIM при одновременном старте серверов
// на ПК пользователя зависал дольше 5 мин). Даёт цепочку «сервер → прямой родитель» — достаточно для допуска.
function selfParentRowsAsync() {
  return new Promise((resolve, reject) => cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-Process -Id " + process.pid + "," + process.ppid + " | Select-Object Id,ProcessName,@{n='Start';e={$_.StartTime.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 120000 }, (e, out) => {
    if (e) return reject(e);
    try {
      resolve([].concat(JSON.parse(out || '[]')).map(r => ({ pid: r.Id, ppid: r.Id === process.pid ? process.ppid : null, name: r.ProcessName, startedAt: r.Start || null })));
    } catch (err) { reject(err); }
  }));
}
function processTableAsync(timeout = 90000) {
  return new Promise((resolve, reject) => cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n='Start';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}} | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64e6 }, (e, out) => {
    if (e) return reject(e);
    try { resolve([].concat(JSON.parse(out || '[]')).map(r => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, startedAt: r.Start || null }))); }
    catch (err) { reject(err); }
  }));
}
function serverAsync(state, name, deps = {}) {
  if (process.platform !== 'win32' && !deps.processTableAsync) return server(state, name, deps);
  const s = { startedAt: deps.serverStartedAt || locks.STARTED_AT, ancestors: [], parent: null, closed: false, ended: 'broken', captureAttemptAt: (deps.now || Date.now)(), name, pending: true, async: true };
  const tries = deps.captureTries || 20, pause = deps.captureRetryMs ?? 10000;
  let n = 0;
  // Снимок только асинхронно: при сбое (на ПК пользователя при одновременном старте серверов CIM бывает дольше 2 мин) —
  // повтор через паузу, без синхронного PowerShell внутри поручения; пока снимка нет — отказ «готовится».
  const table = deps.processTableAsync || (() => processTableAsync().catch(() => selfParentRowsAsync()));
  const attempt = () => table().then(rows => {
    const c = { ...capture({ ...deps, processTable: () => rows }), name };
    if (c.error) throw Error(c.error);
    const closed = s.closed; delete s.error; Object.assign(s, c, { closed: closed || c.closed, async: true }); delete s.pending;
    try { saveServer(state, s, deps); } catch (e) { process.stderr.write('Не записана цепочка предков сервера: ' + e.message + '\n'); }
    if (!deps.processTableAsync) watchParent({}, state);
    return s;
  }).catch(e => {
    s.error = e.message; s.captureAttemptAt = (deps.now || Date.now)();
    process.stderr.write('Пауза перезапуска: ' + e.message + '\n');
    if (++n >= tries) { delete s.pending; return s; }
    return new Promise(r => { const t = setTimeout(r, pause); if (!deps.processTableAsync) t.unref?.(); }).then(attempt);
  });
  s.ready = attempt();
  s.ready.catch(() => {});
  return s;
}
function server(state, name, deps = {}) {
  const s = { ...capture(deps), name };
  if (s.error) process.stderr.write('Пауза перезапуска: ' + s.error + '\n');
  try { saveServer(state, s, deps); }
  catch (e) { process.stderr.write('Не записана цепочка предков сервера: ' + e.message + '\n'); }
  // Сторож — только у настоящего сервера (вызов без подмен), после снимка: не соперничает с ним за запуск PowerShell.
  if (!Object.keys(deps).length) watchParent({}, state);
  return s;
}
module.exports = { RESTART_HOLD_PROTOCOL, same, fingerprint, watchParent, directParentState, resetParentWatch: () => { parentWatch = null; }, processState, capture, server, serverAsync, processTableAsync, selfParentRowsAsync, publish, cancel, holdFile, claimFile, hold, decision,
  admit, assertAdmitted, locked, resolved, cleanup, begin, abort, warnings };
