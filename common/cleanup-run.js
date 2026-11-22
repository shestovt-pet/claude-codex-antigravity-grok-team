'use strict';
// team-v58 (task5 пп.2–3): уборка после установки выполняется ОТДЕЛЬНЫМ процессом (tools/cleanup-worker.js вызывает run()),
// чтобы не останавливать сервер team и не держать замок репозитория всю уборку.
//  — замок репозитория берётся на удаление КАЖДОГО пути и сразу отпускается: team_change start не ждёт дольше одного удаления;
//  — предел времени: по его истечении уборка прекращается, состояние «прервана», повтор вручную (team_change cleanup);
//  — сбой удаления отдельного пути не оставляет замков (lock.release в finally) и не валит остальную уборку;
//  — временные папки тестов внутри клона поштучно не проверяются (это сделано в common/cleanup.js: клон удаляется целиком).
const fs = require('fs'), path = require('path');
function readCleanup(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')).cleanup || {}; } catch { return {}; } }

async function run({ root, id, limitMs = 1800000, owner = null, now = Date.now }, deps = {}) {
  const ops = deps.ops || require('./deploy-ops');
  const cleanup = deps.cleanup || require('./cleanup');
  const locks = deps.locks || require('./locks');
  const canon = (deps.canon || require('./paths').canon);
  const file = path.join(root, 'state', 'deploy-ops', id + '.json');
  const stateDir = path.join(root, 'state');
  const deadline = now() + limitMs;
  owner = owner || ('после установки ' + id);
  let plan, d;
  try { ({ plan, d } = cleanup.planFor({ root, apply: true }, deps.cleanupDeps || {})); }
  catch (e) { try { ops.update(file, { cleanup: { ...readCleanup(file), state: 'ошибка', reason: e.message } }); } catch {} return { state: 'ошибка', reason: e.message }; }
  const removed = [], failed = [];
  for (const x of plan.remove) {
    if (now() >= deadline) {
      const c = { ...readCleanup(file), state: 'прервана', reason: 'предел времени', removed: removed.length, failed: failed.length, finished: new Date(now()).toISOString() };
      try { ops.update(file, { cleanup: c }); } catch {}
      return c;
    }
    const lock = await locks.tryLock('team_repo', canon(root), {}, stateDir);
    if (!lock.ok) { failed.push({ path: x.path, reason: 'репозиторий занят' + (lock.state ? ' (' + lock.state + ')' : '') }); continue; }
    let r;
    try { r = cleanup.removeOne(x, { ...(deps.cleanupDeps || {}), afterRemove: d.afterRemove }); }
    finally { await lock.release(); }
    if (r.ok) removed.push(r); else failed.push(r);
  }
  // След «кто и что удалил» (как в cleanup).
  try { fs.mkdirSync(path.dirname(d.logFile), { recursive: true }); fs.appendFileSync(d.logFile, JSON.stringify({ at: new Date().toISOString(), owner, removed: removed.map(x => x.path), failed: failed.map(x => ({ path: x.path, reason: x.reason })) }) + '\n'); } catch {}
  const result = { state: 'готово', removed: removed.length, failed: failed.length, kept: plan.keep.length, blocked: plan.blocked, uncheckedHiddenProcesses: plan.uncheckedHiddenProcesses || 0, finished: new Date(now()).toISOString() };
  try { ops.update(file, { cleanup: result }); } catch {}
  return result;
}
module.exports = { run };
