'use strict';
const path = require('path'), fs = require('fs'), cp = require('child_process');
function environment(parent, temp) {
  const env = Object.fromEntries(Object.entries(parent).filter(([k]) => !/^MOST_/i.test(k)));
  Object.assign(env, { MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off', MOST_TEST_KEEP: '1',
    MOST_CODEX_JOBS_DIR: '', MOST_CODEX_ARCHIVE_DIR: '', TEMP: temp, TMP: temp, TMPDIR: temp,
    // team-v46 п.5а: папки записи тестов — вне любого репозитория связки (системный TEMP до подмены).
    MOST_TEST_OUTSIDE: path.join(parent.TEMP || parent.TMP || require('os').tmpdir(), 'most-tests-outside') });
  for (const [name, file] of Object.entries({ AGY_CLI_SETTINGS: 'settings.json', CODEX_RULES: 'codex.md', AGY_RULES: 'agy.md',
    AGY_QUOTA_FILE: 'quota.json', CODEX_CONFIG: 'codex.toml', AGY_MCP_CONFIG: 'agy-mcp.json',
    DSH_CONFIG: 'dsh.yml', DSH_RULES: 'dsh.md', AGY_CONFIG: 'permissions.json' })) env['MOST_' + name] = path.join(temp, 'missing-' + file);
  return env;
}
function outcome(text, code, signal, error) {
  const m = text.match(/^Итого(?: дополнительно)?: (?:проверок )?пройдено (\d+), провалено (\d+)(?:, пропущено (\d+))?\.?\s*$/m);
  const passed = m ? Number(m[1]) : 0, failures = m ? Number(m[2]) : 0, skipped = m ? Number(m[3] || 0) : 0;
  const failedSuites = !m || !!signal || (code !== 0 && failures === 0) ? 1 : 0;
  return { passed, failures, skipped, failedSuites, reason: error?.message || (!m ? 'не распознан итог' : signal ? 'сигнал завершения' : failedSuites ? 'ненулевой код без провалов проверок' : '') };
}
// team-v47: серверы (antigravity/claude/codex/deepseek) на подключении снимают дерево процессов асинхронно
// (restart-hold.serverAsync). Пока снимок не готов, server.pending=true и admit отвечает «сервер ещё готовится».
// Снимок снят ровно тогда, когда записан маркер state/restart-servers/<pid>.json конкретного процесса (saveServer).
// Тест после client.connect ждёт маркер своего transport.pid — только для негостевых серверов (у гостя маркера нет).
// Боевую защиту это не трогает: ожидание целиком в тестах, а admit отрабатывает полностью, когда pending снят.
async function serverReady(stateDir, pid, ms = 120000) {
  if (!pid) throw Error('serverReady: не передан pid транспорта сервера.');
  const file = path.join(stateDir, 'restart-servers', pid + '.json');
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (fs.existsSync(file)) return true; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error('Сервер моста не подготовился за ' + ms + ' мс: нет маркера ' + file);
}
function logPath(dir, name) {
  if (!name || name === '.' || name === '..' || /[\\/:]/.test(name) || path.basename(name) !== name) throw Error('MOST_TEST_OUTPUT: допустимо только имя файла внутри tests.');
  return path.join(dir, name);
}
function mainBranch(root, run = cp.spawnSync) {
  const version = run('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (version.error || version.status !== 0) throw Error('Подготовка тестов: Git недоступен.');
  if (!fs.existsSync(path.join(root, '.git'))) throw Error('Подготовка тестов: нет .git в ' + root);
  const result = run('git', ['-C', root, 'show-ref', '--verify', 'refs/heads/main'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw Error('Подготовка тестов: отсутствует локальная ветка main в ' + root + '; origin/main её не заменяет.');
}
async function runSuites(files, { dir, env, write, spawn = cp.spawn }) {
  const totals = { passed: 0, failures: 0, skipped: 0, failedSuites: 0 };
  if (!files.length) throw Error('Ошибка прогона: не выбран ни один набор.');
  for (const file of files) {
    let text = '', code = null, signal = null, error;
    try {
      const child = spawn(process.execPath, [path.join(dir, file)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', s => { text += s; write(s); }); child.stderr.on('data', write);
      await new Promise(resolve => {
        child.on('error', e => { error = e; resolve(); });
        child.on('close', (c, s) => { code = c; signal = s; resolve(); });
      });
    } catch (e) { error = e; }
    const result = outcome(text, code, signal, error);
    for (const k of Object.keys(totals)) totals[k] += result[k];
    if (result.failedSuites) write('Аварийный набор ' + file + ': code=' + code + ', signal=' + signal + ' · ' + result.reason + '\n');
  }
  const runnerError = totals.passed + totals.failures === 0;
  if (runnerError) write('Ошибка прогона: нет распознанных выполненных проверок.\n');
  return { ...totals, code: totals.failures || totals.failedSuites || runnerError ? 1 : 0 };
}
module.exports = { environment, outcome, logPath, mainBranch, runSuites, serverReady };
