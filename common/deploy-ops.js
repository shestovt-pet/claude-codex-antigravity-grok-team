'use strict';
// Состояние переживает ожидающий MCP-вызов и перезапуск Claude.
const fs = require('fs'), path = require('path'), { randomUUID } = require('crypto');
const { samePath } = require('./paths');
const { realOrGiven, releasePolicy } = require('./path-compat');
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
  root = realOrGiven(root);
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
  root = realOrGiven(root);
  const pending = list(root, { reconcile: !dryRun }).find(op => !terminal.includes(op.status) &&
    (!resultFile || !samePath(resultFile, path.join(root, 'state/deploy-ops', op.id + '.json'))));
  if (pending) throw Error('Идёт установка ' + pending.id);
}
const quote = s => "'" + String(s).replace(/'/g, "''") + "'";
function commandLine(release, args, root, node = process.execPath) {
  const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const check = s => {
    if (typeof s !== 'string' || /["%!^\x00-\x1f\x7f]/.test(s)) throw Error('Недопустимый символ в команде исполнителя.');
    return s;
  };
  for (const p of [cmd, node, root, release]) {
    check(p);
    if (!path.isAbsolute(p) || !fs.existsSync(p)) throw Error('Не найден абсолютный путь исполнителя: ' + p);
  }
  // Конечный слеш в SET перед закрывающей кавычкой не допускается.
  if (/[\\/]$/.test(root)) throw Error('Корень исполнителя не должен оканчиваться разделителем.');
  const argv = [node, path.join(release, 'tools/deploy.js'), ...args].map(s => '"' + check(s).replace(/\\+$/, m => m + m) + '"').join(' ');
  const command = '"' + cmd + '" /d /v:off /s /c "set "MOST_REPO_ROOT=' + root + '"&& ' + argv + '"';
  if (command.length >= 8191) throw Error('Команда исполнителя слишком длинная (8191 символ или больше).');
  return command;
}
function launch(release, args, root) {
  const command = commandLine(release, args, root);
  return new Promise((resolve, reject) => require('child_process').execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=' + quote(command) + '}; if ($r.ReturnValue -ne 0) { exit 1 }; $r.ProcessId'],
    { windowsHide: true, timeout: 10000 }, (e, out) => {
      const pid = Number(out?.trim());
      if (e || !Number.isInteger(pid) || pid <= 0) reject(Error('Не удалось запустить исполнителя вне пакета (CIM).'));
      else resolve(pid);
    }));
}
async function start({ root, release, configs, restartClaude, cleanup = true, word, channel, listHash }, deps = {}) {
  root = realOrGiven(root);
  release = realOrGiven(release);
  require('../tools/deploy-bootstrap').stateRoot(root);
  const policy = releasePolicy(root, release);
  const lock = await require('./locks').tryLock('deploy_operation', root, {}, path.join(root, 'state'));
  if (!lock.ok) throw Error('Идёт создание операции установки.');
  let file, id;
  try {
    const pending = list(root, deps).find(op => !terminal.includes(op.status));
    if (pending) throw Error('Идёт установка ' + pending.id);
    id = randomUUID(); file = path.join(policy.root, 'state/deploy-ops', id + '.json');
    // reason успешный старый execute сохраняет; старый team.js показывает его и после restart.
    // team-v57 (ред.5): проверенное слово пользователя и канал кладутся в запись операции; исполнитель вне пакета читает их
    // и передаёт барьеру install (overriddenByWord пишется туда же ДО первого изменяющего шага). Слова нет в аргументах CLI.
    // team-v57 (task9 п.1): рядом со словом кладётся утверждённый отпечаток показанного списка (installListHash) — барьер
    // install и перезапуск сверяют его перед изменяющим шагом, чтобы слово перекрывало только то, что видел пользователь.
    // §5.1 (team-v58): рядом с отпечатком кладётся и сам утверждённый список (installList) — перезапуск сверяет свежий
    // список НЕ по полному равенству отпечатка, а по НОВЫМ записям относительно этого утверждённого списка.
    let installList = null;
    if (word) { try { installList = require('./members-kimi').installationBlockers(path.join(policy.root, 'state'), {}); } catch {} }
    atomic(file, JSON.stringify({ id, root: policy.root, release, status: 'запущена', ...(cleanup === false || policy.oldCode ? { noCleanup: true } : {}), ...(policy.oldCode ? { oldCode: true, reason: oldCodeLine } : {}), ...(word ? { installWord: word, installChannel: channel || 'console', ...(listHash ? { installListHash: listHash } : {}), ...(installList ? { installList } : {}) } : {}), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    const args = ['--root', root, '--config-only', '--release', release, '--result', file, ...configs.flatMap(f => ['--config', f]), ...(restartClaude ? ['--restart-claude'] : [])];
    try {
      const pid = await (deps.launch || launch)(release, args, root);
      // Отдельная квитанция PID не может затереть более поздний шаг исполнителя.
      atomic(file + '.pid', JSON.stringify(pid));
    } catch (e) { update(file, { status: 'отказ', reason: e.message }); throw e; }
  } finally { await lock.release(); }
  const now = deps.now || Date.now, sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const deadline = now() + WAIT_MS;
  do {
    const op = list(root, deps).find(op => op.id === id);
    if (terminal.includes(op.status)) {
      // team-v57 (task9 п.5, ревью Kimi 4): слово и полный перекрытый список входят и в сообщение об УСПЕХЕ, и в сообщение
      // об ОТКАЗЕ — барьер мог записать overriddenByWord/gatePassed до того, как последующий шаг завершился сбоем.
      if (op.status !== 'завершено') throw Error('Установка ' + id + ': ' + op.status + ' · ' + (op.reason || '') + wordSummary(op));
      return 'Установка ' + id + ': завершено. ' + (op.message || '') + wordSummary(op) + (op.oldCode ? '\n' + oldCodeLine : '') + (op.restart ? '\n' + op.restart : '') + (op.cleanup ? '\n' + cleanupLine(op.cleanup) : '');
    }
    await sleep(250);
  } while (now() < deadline);
  return 'Результат установки не подтверждён, операция ' + id + ' идёт; итог сохранится в ' + file;
}
async function execute(options, action, deps = {}) {
  const file = options.result;
  // Отказ до первой записи, вне catch, чтобы не затереть чужой/завершённый результат.
  if (deps.validateResult) deps.validateResult();
  update(file, { pid: process.pid, status: 'запущена' });
  try {
    update(file, { status: 'проба' });
    let message = await action({ ...options, restartClaude: false, method: 'из Claude через исполнителя вне пакета' });
    if (options.restartClaude) message = message.replace('нужен перезапуск Claude', 'перезапуск Claude выполнит исполнитель');
    update(file, { status: 'переключено', message, switchedAt: new Date().toISOString() });
    // §5.4 (team-v58): после установки по слову карточки перекрытых поручений (overriddenByWord) получают отметку остановки
    // с основанием — словом установки (тот же вид, что stop_confirm; источник — канал установки), чтобы не числиться «идёт»/
    // «отменяется». Делается один раз после переключения; сбой разметки установку не валит.
    try { const cur = read(file), w = cur.overriddenByWord; if (w && w.quote) update(file, { overriddenMarked: require('./members-kimi').markOverriddenStopped(path.join(cur.root, 'state'), w).marked }); } catch {}
    if (options.restartClaude) {
      const op = read(file);
      try {
        update(file, { status: 'перезапуск идёт' });
        // team-v57 (ред.7, task9 п.1): слово пользователя из записи операции перекрывает защиту restart от обрыва поручений, а
        // утверждённый отпечаток (installListHash) связывает это перекрытие с показанным списком (сверка перед закрытием Claude).
        const restart = await (deps.restart || require('./restart').restart)({ root: op.root, release: options.release, state: path.join(op.root, 'state'), id: op.id, waitCompletion: true, close: true, word: op.installWord, wordListHash: op.installListHash, wordList: op.installList }, deps.restartDeps || {});
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
// team-v57 (ред.6/7, task9 п.5): оба поля барьера установки печатаются в итоговом сообщении — пропущенное по слову на
// карточке/перезагрузке (gatePassed) и перекрытое общим словом пользователя с полным списком перекрытого (overriddenByWord).
// Печать идёт тем же форматтером, что показанный список (members-kimi.listText): с причинами, папками, статусом, отправителем.
function wordSummary(op) {
  const g = op.gatePassed, w = op.overriddenByWord, parts = [];
  if (w && w.quote) parts.push('Проверка перекрыта словом пользователя (канал ' + (w.channel || '?') + '): «' + w.quote + '». Перекрыто (будет оборвано):');
  const b = { running: (w && w.running) || [], blockers: (w && w.blockers) || [], passedByCardWord: (g && g.passedByCardWord) || [], passedByReboot: (g && g.passedByReboot) || [] };
  if (b.running.length || b.blockers.length || b.passedByCardWord.length || b.passedByReboot.length)
    parts.push(require('./members-kimi').listText(b));
  else if (w && w.quote) parts.push('ничего');
  return parts.length ? '\n' + parts.join('\n') : '';
}
const oldCodeLine = 'уборка отключена: релиз старого кода (до team-v21). После возврата на любой релиз старого кода (без common/path-compat.js) не запускать team_change cleanup.';
// Строка уборки после установки (team-v10 Р5); у старых операций поля нет — и строки нет.
// team-v58 (task5 пп.2–3): уборку выполняет отдельный процесс; его PID и время запуска лежат в записи. «идёт» действительно,
// ТОЛЬКО пока этот процесс жив (и, если проверяется, с тем же временем запуска); иначе — «прервана» (повтор вручную
// team_change cleanup). Так запись 38b0578e (cleanup «идёт» с 18.11 08:00, процесс мёртв) распознаётся как прерванная.
function cleanupLine(c, now = Date.now(), deps = {}) {
  if (!c) return '';
  if (c.state === 'отключена') return 'уборка: отключена';
  if (c.state === 'прервана') return 'уборка: прервана' + (c.reason ? ': ' + c.reason : '');
  if (c.state === 'идёт') {
    const aliveFn = deps.alive || alive;
    const dead = Number.isInteger(c.pid) && aliveFn(c.pid) === false;
    if (dead || now - Date.parse(c.started) > 1800000) return 'уборка: прервана';
    return 'уборка: идёт с ' + c.started;
  }
  if (c.state === 'ошибка') return 'уборка: ошибка: ' + c.reason;
  if (c.state === 'готово') return 'уборка: удалено ' + c.removed + ', не удалено ' + c.failed + (c.blocked?.length ? ' · релизы не удалялись: ' + c.blocked.join('; ') : '') + (c.uncheckedHiddenProcesses ? ' · не проверено процессов со скрытыми сведениями: ' + c.uncheckedHiddenProcesses : '');
  return 'уборка: состояние неизвестно';
}
module.exports = { WAIT_MS, terminal, list, start, execute, update, launch, commandLine, alive, assertIdle, cleanupLine, oldCodeLine };
