'use strict';
// Уборка после установки (team-v10 Р5): выполняет сервер команды, не исполнитель установки.
// Один раз на операцию; только после «завершено»; её ошибка не меняет итог установки.
const fs = require('fs'),
  path = require('path');
const HOUR = 3600000;

async function afterDeploy(id, opts = {}) {
  const root = opts.root, now = opts.now || Date.now;
  const ops = require('./deploy-ops');
  const file = path.join(root, 'state', 'deploy-ops', id + '.json');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  let op;
  try { op = read(); } catch (e) { return 'уборка после установки: карточка операции не прочитана — ' + e.message; }
  if (op.status !== 'завершено') return 'уборка после установки: операция «' + op.status + '», уборки нет';
  if (op.cleanup) return ops.cleanupLine(op.cleanup, now()).startsWith('уборка: прервана')
    ? 'уборка после установки прервана — автоматически не повторяется, нужна ручная уборка (team_change cleanup)'
    : 'уборка после установки уже ' + (op.cleanup.state || 'записана');
  if (op.noCleanup) { ops.update(file, { cleanup: { state: 'отключена' } }); return 'уборка: отключена'; }
  if (now() - Date.parse(op.updatedAt || op.createdAt) > HOUR) return 'уборка после установки: операция старше часа, пропущена';
  const canon = require('./paths').canon;
  let bad = null;
  try {
    const store = opts.stateDir || require('./paths').stateDir;
    if (canon(fs.realpathSync(op.root)) !== canon(fs.realpathSync(root))) bad = 'корень операции ' + op.root + ' не совпадает с корнем сервера ' + root;
    // Уборка читает карточки и поручения из хранилища сервера — оно должно быть хранилищем операции (Codex 7d8230cc).
    else if (canon(fs.realpathSync(store)) !== canon(fs.realpathSync(path.join(root, 'state')))) bad = 'хранилище сервера ' + store + ' не совпадает с хранилищем операции ' + path.join(root, 'state');
    else if (!op.release || !fs.existsSync(op.release)) bad = 'релиз операции не найден: ' + op.release;
  } catch (e) { bad = 'контекст операции не проверен: ' + e.message; }
  if (bad) { ops.update(file, { cleanup: { state: 'ошибка', reason: bad } }); return 'уборка: ошибка: ' + bad; }
  // team-v58 (task5 пп.2–3): боевая уборка — ОТДЕЛЬНЫЙ процесс с пределом времени (сервер team не блокируется, замок берётся
  // на каждый путь). Тесты подставляют opts.cleanup/opts.locked — тогда синхронная уборка под замком, как прежде (team-v10).
  if (opts.cleanup || opts.inline) return inlineCleanup(file, id, opts, now, root, read, ops);
  return spawnCleanup(file, id, opts, now, root);
}

// Синхронная уборка под замком репозитория (путь тестов и совместимости).
async function inlineCleanup(file, id, opts, now, root, read, ops) {
  const locks = opts.locks || require('./locks');
  const mine = await locks.tryLock('after_deploy_cleanup', id, {}, path.join(root, 'state'));
  if (!mine.ok) return 'уборка после установки уже выполняется другим сервером';
  try {
    const locked = opts.locked || require('./deploy').locked;
    let text;
    try {
      text = await locked(root, async () => {
        if (read().cleanup) return 'уборка после установки уже записана';
        ops.update(file, { cleanup: { state: 'идёт', started: new Date(now()).toISOString(), pid: process.pid } });
        try {
          const r = (opts.cleanup || require('./cleanup').cleanup)({ root, apply: true, owner: 'после установки ' + id }, opts.cleanupDeps || {});
          const c = { state: 'готово', removed: r.removed.length, failed: r.failed.length, kept: r.plan.keep.length, blocked: r.plan.blocked, uncheckedHiddenProcesses: r.plan.uncheckedHiddenProcesses || 0, finished: new Date(now()).toISOString() };
          try { ops.update(file, { cleanup: c }); } catch (e) { return 'уборка выполнена, но итог не записан: ' + e.message; }
          return ops.cleanupLine(c);
        } catch (e) {
          try { ops.update(file, { cleanup: { state: 'ошибка', reason: e.message } }); } catch {}
          return 'уборка: ошибка: ' + e.message;
        }
      });
    } catch (e) {
      // Замок репозитория занят (например, ещё идёт вызов установки) — повтор при следующей сводке.
      return 'уборка после установки отложена: ' + e.message;
    }
    return text;
  } finally { await mine.release(); }
}

// Боевая уборка отдельным процессом: записывает «идёт» с PID и временем запуска процесса уборки и сразу возвращается.
// «идёт» действительно, только пока этот процесс жив (см. deploy-ops.cleanupLine). Сам процесс берёт замок на каждый путь и
// соблюдает предел времени (common/cleanup-run.js).
function spawnCleanup(file, id, opts, now, root) {
  const ops = require('./deploy-ops');
  const limitMs = opts.cleanupLimitMs || Number(process.env.MOST_CLEANUP_LIMIT_MS || 1800000);
  const started = new Date(now()).toISOString();
  let child;
  try { child = (opts.spawnCleanup || spawnCleanupWorker)({ root, id, limitMs, stateDir: opts.stateDir || require('./paths').stateDir }); }
  catch (e) { try { ops.update(file, { cleanup: { state: 'ошибка', reason: 'не удалось запустить процесс уборки: ' + e.message } }); } catch {} return 'уборка: ошибка: не удалось запустить процесс уборки: ' + e.message; }
  ops.update(file, { cleanup: { state: 'идёт', started, pid: child.pid, procStartedAt: child.startedAt || started } });
  return 'уборка запущена отдельным процессом (PID ' + child.pid + '); предел ' + Math.round(limitMs / 1000) + ' с; состояние — в team_status';
}
function spawnCleanupWorker({ root, id, limitMs, stateDir }) {
  const child = require('child_process').spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'cleanup-worker.js')], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, MOST_REPO_ROOT: root, MOST_STATE_DIR: stateDir, MOST_CLEANUP_ROOT: root, MOST_CLEANUP_ID: id, MOST_CLEANUP_LIMIT_MS: String(limitMs) },
  });
  child.unref();
  return { pid: child.pid, startedAt: new Date().toISOString() };
}

// Последняя операция установки этого корня. Если она ещё не в конечном состоянии (исполнитель пишет «завершено»
// только после готовности серверов), ждём до waitMs, опрашивая раз в 10 секунд (случай Codex 8ff3f313).
async function afterLatest(opts = {}) {
  const ops = require('./deploy-ops'), now = opts.now || Date.now, sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.waitMs || 0);
  for (;;) {
    const op = ops.list(opts.root, opts.listDeps || {}).at(-1);
    if (!op) return 'операций установки нет';
    if (ops.terminal.includes(op.status)) return afterDeploy(op.id, opts);
    // Давняя незавершённая операция не стоит ожидания (замечание Antigravity mukc7wn1).
    if (now() - Date.parse(op.updatedAt || op.createdAt) > HOUR) return 'уборка после установки: операция ' + op.id + ' старше часа и не завершена, пропущена';
    if (now() >= deadline) return 'уборка после установки: операция ' + op.id + ' ещё «' + op.status + '», повтор при следующей сводке';
    await sleep(opts.pollMs || 10000);
  }
}

module.exports = { afterDeploy, afterLatest };
