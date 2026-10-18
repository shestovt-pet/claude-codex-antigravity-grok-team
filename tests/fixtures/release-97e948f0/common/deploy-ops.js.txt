'use strict';
// Состояние переживает ожидающий MCP-вызов и перезапуск Claude.
const fs = require('fs'), path = require('path'), { randomUUID } = require('crypto');
const { atomic } = require('./team-git');
const WAIT_MS = 300000, terminal = ['завершено', 'перезапуск не запущен', 'перезапуск не подтверждён', 'откат', 'отказ', 'прервана'];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function update(file, patch) {
  const value = { ...read(file), ...patch, updatedAt: new Date().toISOString() };
  atomic(file, JSON.stringify(value, null, 2)); return value;
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'ESRCH' ? false : null; }
}
function list(root, deps = {}) {
  const dir = path.join(root, 'state/deploy-ops');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => {
    const file = path.join(dir, n), op = read(file);
    if (!op.pid && fs.existsSync(file + '.pid')) op.pid = read(file + '.pid');
    if (deps.reconcile !== false && !terminal.includes(op.status)) {
      const live = (deps.alive || alive)(op.pid);
      if (live === false || (live === null && (deps.now || Date.now)() - Date.parse(op.updatedAt) > 1800000))
        return update(file, { status: 'прервана', reason: live === false ? 'Процесс исполнителя завершился без итога.' : 'Процесс проверить нельзя, записей нет более 30 минут.' });
    }
    return op;
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function assertIdle(root, resultFile, dryRun = false) {
  const pending = list(root, { reconcile: !dryRun }).find(op => !terminal.includes(op.status) &&
    (!resultFile || path.resolve(resultFile) !== path.resolve(root, 'state/deploy-ops', op.id + '.json')));
  if (pending) throw Error('Идёт установка ' + pending.id);
}
const quote = s => "'" + String(s).replace(/'/g, "''") + "'";
function launch(release, args) {
  const command = [process.execPath, path.join(release, 'tools/deploy.js'), ...args].map(s => {
    if (/["\r\n]/.test(s)) throw Error('Недопустимый символ в пути исполнителя.');
    return '"' + s + '"';
  }).join(' ');
  return new Promise((resolve, reject) => require('child_process').execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=' + quote(command) + '}; if ($r.ReturnValue -ne 0) { exit 1 }; $r.ProcessId'],
    { windowsHide: true, timeout: 10000 }, (e, out) => {
      const pid = Number(out?.trim());
      if (e || !Number.isInteger(pid) || pid <= 0) reject(Error('Не удалось запустить исполнителя вне пакета (CIM).'));
      else resolve(pid);
    }));
}
async function start({ root, release, configs, restartClaude, cleanup = true }, deps = {}) {
  const lock = await require('./locks').tryLock('deploy_operation', root, {}, path.join(root, 'state'));
  if (!lock.ok) throw Error('Идёт создание операции установки.');
  let file, id;
  try {
    const pending = list(root, deps).find(op => !terminal.includes(op.status));
    if (pending) throw Error('Идёт установка ' + pending.id);
    id = randomUUID(); file = path.join(root, 'state/deploy-ops', id + '.json');
    atomic(file, JSON.stringify({ id, root, release, status: 'запущена', ...(cleanup === false ? { noCleanup: true } : {}), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    const args = ['--config-only', '--release', release, '--result', file, ...configs.flatMap(f => ['--config', f]), ...(restartClaude ? ['--restart-claude'] : [])];
    try {
      const pid = await (deps.launch || launch)(release, args);
      // Отдельная квитанция PID не может затереть более поздний шаг исполнителя.
      atomic(file + '.pid', JSON.stringify(pid));
    } catch (e) { update(file, { status: 'отказ', reason: e.message }); throw e; }
  } finally { await lock.release(); }
  const now = deps.now || Date.now, sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const deadline = now() + WAIT_MS;
  do {
    const op = list(root, deps).find(op => op.id === id);
    if (terminal.includes(op.status)) {
      if (op.status !== 'завершено') throw Error('Установка ' + id + ': ' + op.status + ' · ' + (op.reason || ''));
      return 'Установка ' + id + ': завершено. ' + (op.message || '') + (op.restart ? '\n' + op.restart : '') + (op.cleanup ? '\n' + cleanupLine(op.cleanup) : '');
    }
    await sleep(250);
  } while (now() < deadline);
  return 'Результат установки не подтверждён, операция ' + id + ' идёт; итог сохранится в ' + file;
}
async function execute(options, action, deps = {}) {
  const file = options.result;
  update(file, { pid: process.pid, status: 'запущена' });
  try {
    update(file, { status: 'проба' });
    let message = await action({ ...options, restartClaude: false, method: 'из Claude через исполнителя вне пакета' });
    if (options.restartClaude) message = message.replace('нужен перезапуск Claude', 'перезапуск Claude выполнит исполнитель');
    update(file, { status: 'переключено', message, switchedAt: new Date().toISOString() });
    if (options.restartClaude) {
      const op = read(file);
      try {
        update(file, { status: 'перезапуск идёт' });
        const restart = await (deps.restart || require('./restart').restart)({ root: op.root, release: options.release, waitCompletion: true });
        update(file, { restart: typeof restart === 'string' ? restart : restart.message, restartEvidence: typeof restart === 'object' ? restart : null });
      }
      catch (e) {
        const reason = 'Настройки переключены, но ' + (e.restartStarted ? 'готовность нового Claude не подтверждена: ' : 'запуск перезапуска Claude не подтверждён: ') + e.message;
        update(file, { status: e.restartStarted ? 'перезапуск не подтверждён' : 'перезапуск не запущен', restart: reason, reason });
        throw Error(reason);
      }
    }
    update(file, { status: 'завершено' });
    return message;
  } catch (e) {
    if (!['перезапуск не запущен', 'перезапуск не подтверждён'].includes(read(file).status))
      update(file, { status: /Конфиги восстановлены/.test(e.message) ? 'откат' : 'отказ', reason: e.message });
    throw e;
  }
}
// Строка уборки после установки (team-v10 Р5); у старых операций поля нет — и строки нет.
function cleanupLine(c, now = Date.now()) {
  if (!c) return '';
  if (c.state === 'отключена') return 'уборка: отключена';
  if (c.state === 'идёт') return now - Date.parse(c.started) > 1800000 ? 'уборка: прервана' : 'уборка: идёт';
  if (c.state === 'ошибка') return 'уборка: ошибка: ' + c.reason;
  if (c.state === 'готово') return 'уборка: удалено ' + c.removed + ', не удалено ' + c.failed + (c.blocked?.length ? ' · релизы не удалялись: ' + c.blocked.join('; ') : '');
  return 'уборка: состояние неизвестно';
}
module.exports = { WAIT_MS, terminal, list, start, execute, update, launch, alive, assertIdle, cleanupLine };
