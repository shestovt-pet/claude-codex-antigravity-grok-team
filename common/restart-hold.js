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
  { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return JSON.parse(out.trim());
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
  // Один свежий снимок на вызов: только повтор capture или цели при оборванной цепочке.
  let processRows, targetTable;
  const processTable = () => processRows ??= (deps.processTable || (() => require('./fallback').processTable(true, { native: true })))();
  try {
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
    const retryDue = server.error && (deps.now || Date.now)() - server.captureAttemptAt >= 10000;
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
    const parent = processState(server.parent, deps);
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
async function begin(state, { runId, id = runId }, deps = {}) {
  return locked(state, () => {
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
  return locked(state, () => {
    try { cancel(state, h.runId); } catch { return false; }
    const d = decision(state, h);
    if (!d.error && d.value?.decision === 'отмена') { removeOwn(state, h); return true; }
    return false;
  }, deps);
}
function warnings(state, deps = {}) {
  const lines = [], r = hold(state);
  if (r.error) lines.push('Пауза перезапуска: проверить нельзя — файл паузы не читается; новые поручения не принимаются.');
  if (r.value && !r.error) {
    const d = decision(state, r.value), done = !d.error && d.value && (d.value.decision === 'отмена' || processState(d.value, deps) === 'dead');
    if (!done) {
      const owner = d.value?.decision === 'закрываю' ? d.value : r.value.executor, live = processState(owner, deps);
      const detail = d.error || live === 'unknown' ? 'проверить нельзя' : d.value ? 'сценарий закрывает Claude' : live === 'alive' ? 'исполнитель жив' : 'исполнитель мёртв, решение не опубликовано — снимет следующий участник';
      lines.push(`Пауза перезапуска: операция ${r.value.id}, с ${time(r.value)}, ${detail} — старые серверы не принимают новые поручения`);
    }
  }
  try {
    for (const f of claims(state).filter(f => !f.endsWith('.closed.json'))) {
      const c = read(f).value;
      if (validClosing(c) && processState(c, deps) === 'dead' && c.targets.some(t => processState(t, deps) === 'alive'))
        lines.push(`Claude должен был закрыться при перезапуске (операция ${c.id}), но работает: его серверы не принимают поручения — перезапустите Claude`);
    }
    const dir = path.join(state, 'restart-servers');
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
      const s = read(path.join(dir, f)).value;
      if (s?.error && processState(s.process, deps) !== 'dead') lines.push('Не удалось проверить цепочку предков сервера ' + s.name + ' — поручения не принимаются; подробности в журнале сервера.');
    }
  } catch { lines.push('Пауза перезапуска: не удалось прочитать отметки перезапуска.'); }
  return [...new Set(lines)];
}
function saveServer(state, s, deps) {
  const dir = path.join(state, 'restart-servers'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, process.pid + '.json'), Buffer.from(JSON.stringify({ ...s, process: (deps.fingerprint || fingerprint)(process.pid) })));
}
function server(state, name, deps = {}) {
  const s = { ...capture(deps), name };
  if (s.error) process.stderr.write('Пауза перезапуска: ' + s.error + '\n');
  try { saveServer(state, s, deps); }
  catch (e) { process.stderr.write('Не записана цепочка предков сервера: ' + e.message + '\n'); }
  return s;
}
module.exports = { RESTART_HOLD_PROTOCOL, same, fingerprint, processState, capture, server, publish, cancel, holdFile, claimFile, hold, decision,
  admit, assertAdmitted, locked, resolved, cleanup, begin, abort, warnings };
