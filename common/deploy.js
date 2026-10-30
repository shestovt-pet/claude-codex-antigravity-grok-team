'use strict';
// team-v46: срок пробы установки — запуск серверов на Windows занимает до ~30 с (перечисление процессов PowerShell).
const probeDeployMs = () => Number(process.env.MOST_DEPLOY_PROBE_MS) || 60000;
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const { inside, repository, deployGit, hash, atomic } = require('./team-git');
const { samePath } = require('./paths');
const names = require('./members').installedServers;
// Ожидаемый список серверов для установки конкретного корня (его собственный реестр, в том числе
// мигрированный team-v46), а не окружения MOST_STATE_DIR, которое в тестах может быть другим.
function serversForRoot(root) {
  try {
    const roster = require('./members-store').create(path.join(root, 'state')).read({ initialize: false });
    return require('./members').serversForInstall(roster);
  } catch { return names; }
}
function activateMembers(release, root) {
  if (!fs.existsSync(path.join(release, 'common/members-store.js'))) return;
  const store = require('./members-store').create(path.join(root, 'state')), current = store.read();
  const phase = fs.existsSync(path.join(release, 'common/install-phase.js')) ? require(path.join(release, 'common/install-phase')).phase : 'A';
  // Фаза меняется только явной установкой: обычная правка состава сохраняет прежнюю (ревью DeepSeek, З-7).
  if (current.phase === phase) return;
  store.update(current.rev, next => {
    const d = next.members.find(m => m.id === 'deepseek');
    const agy = next.members.find(m => m.id === 'antigravity');
    if (phase === 'B') {
      // Фаза B (team-v31): DeepSeek включается исполнителем и голосующим; из чата поручает Codex и Antigravity (К1).
      if (d) d.roles = { ...d.roles, receives: true, sends: true, writer: true, voter: true };
      if (agy) agy.mcp_allow = [...new Set([...(agy.mcp_allow || []), 'deepseek/deepseek_send', 'deepseek/deepseek_result', 'deepseek/deepseek_status'])];
    } else {
      // Фаза A: сброс исполнительных и голосующих ролей DeepSeek и его масок у Antigravity.
      if (d) d.roles = { ...d.roles, receives: false, sends: false, writer: false, voter: false };
      if (agy) agy.mcp_allow = (agy.mcp_allow || []).filter(x => !/^deepseek\//.test(x));
    }
  }, { action: 'phase', who: 'deploy', quote: null, reason: 'Установлен релиз с фильтром фазы ' + phase }, { phase });
}
function configPaths() {
  if (process.env.MOST_CLAUDE_CONFIGS) return JSON.parse(process.env.MOST_CLAUDE_CONFIGS);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local');
  const store = (name) => path.join(local, 'Packages', name, 'LocalCache/Roaming/Claude/claude_desktop_config.json');
  // Claude из Microsoft Store: имя пакета ищется по шаблону Claude_*, известное имя остаётся кандидатом (team-v11 Р2).
  let found = [];
  try { found = fs.readdirSync(path.join(local, 'Packages')).filter((n) => /^Claude_[a-z0-9]+$/i.test(n)).sort(); } catch {}
  // К6а (21.10): Store-сборка Claude Desktop держит данные вне пакета в %LOCALAPPDATA%\Claude-Data\<пакет Claude_*>.
  const data = (name) => path.join(local, 'Claude-Data', name, 'claude_desktop_config.json');
  let dataDirs = [];
  try { dataDirs = fs.readdirSync(path.join(local, 'Claude-Data')).filter((n) => /^Claude_[a-z0-9]+$/i.test(n) && fs.statSync(path.join(local, 'Claude-Data', n)).isDirectory()).sort(); } catch {}
  return [...new Set([
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'Claude/claude_desktop_config.json'),
    store('Claude_pzs8sxrjxfjjc'),
    ...found.map(store),
    ...dataDirs.map(data),
  ])];
}

function nodeCommand() {
  const p = 'C:\\Program Files\\nodejs\\node.exe';
  return process.platform === 'win32' ? (fs.existsSync(p) ? p : 'node') : process.execPath;
}

function configFor(config, release, root, state = require('./paths').stateDir, file = 'конфиге Claude') {
  state = path.join(root, 'state');
  const out = structuredClone(config);
  out.mcpServers = { ...out.mcpServers };
  const { assertOwn, pointsInto } = require('./ownership');
  const servers = serversForRoot(root);
  assertOwn(out.mcpServers, servers, root, file);
  if (out.mcpServers.grok && require('./ownership').own(out.mcpServers.grok, 'grok', root)) delete out.mcpServers.grok;
  // Старые записи прежних версий удаляются, только если указывают на этот корень; чужое не трогаем.
  if (out.mcpServers.most && pointsInto(out.mcpServers.most, root)) delete out.mcpServers.most;
  for (const [key, value] of Object.entries(out.mcpServers))
    if (!servers.includes(key) && Array.isArray(value?.args) && value.args.some((a) => String(a).includes('mcp-server-google-antigravity')) && pointsInto(value, root))
      delete out.mcpServers[key];
  for (const n of servers)
    out.mcpServers[n] = {
      ...out.mcpServers[n],
      command: nodeCommand(),
      args: [path.join(release, 'servers', n, 'index.js')],
      env: { ...out.mcpServers[n]?.env, MOST_REPO_ROOT: root, MOST_STATE_DIR: state, MOST_CLIENT: 'claude' },
    };
  // Старые производные пути не должны уводить очереди из общего хранилища.
  for (const n of servers) for (const key of ['MOST_CODEX_JOBS_DIR', 'MOST_INPUT_DIR', 'MOST_JOURNAL']) delete out.mcpServers[n].env[key];
  return out;
}

function snapshot(file, optional = false) {
  let entry;
  try { entry = fs.lstatSync(file); }
  catch (e) { if (optional && e.code === 'ENOENT') return { file, text: '', mtime: null, config: {}, exists: false }; throw e; }
  if (entry.isSymbolicLink()) throw Error('Конфиг не должен быть ссылкой: ' + file);
  const stat = fs.statSync(file),
    text = fs.readFileSync(file, 'utf8');
  if (/\.(?:toml|md|ya?ml)(?:\.prev)?$/i.test(file)) return { file, text, mtime: stat.mtimeMs, config: null };
  let config; try { config = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw Error('Некорректный файл настроек: ' + file); }
  return { file, text, mtime: stat.mtimeMs, config, exists: true };
}

function unchanged(s) {
  const cur = snapshot(s.file, s.exists === false);
  if (cur.mtime !== s.mtime || cur.text !== s.text) throw Error('Конфиг изменён другим процессом: ' + s.file);
}
// Компенсация не затирает чужое изменение. В таком случае явно сообщаем о частичном обновлении.
async function switchConfigs(plans, hook = async () => {}) {
  const changed = [],
    previous = [];
  const identity = file => {
    let entry;
    try { entry = fs.lstatSync(file); }
    catch (e) { if (e.code === 'ENOENT') return { key: path.resolve(file), signature: 'absent' }; throw e; }
    if (entry.isSymbolicLink()) throw Error('Конфиг не должен быть ссылкой: ' + file);
    const s = fs.statSync(file, { bigint: true });
    if (s.nlink > 1n) throw Error('Жёсткие ссылки в настройках запрещены: ' + file);
    return { key: s.dev !== 0n && s.ino !== 0n && s.nlink === 1n ? s.dev + ':' + s.ino : file,
      signature: [s.dev, s.ino, s.nlink].join(':') };
  };
  const groups = new Map();
  const contents = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  for (const p of plans) {
    const id = identity(p.file); p.identity = id.signature;
    const group = groups.get(id.key) || []; group.push(p); groups.set(id.key, group);
  }
  const verify = (group, field) => {
    for (const p of group) if (contents(p.file) !== (field === 'text' && p.exists === false ? null : p[field]))
      throw Error('Проверка пути после записи не пройдена: ' + p.file);
  };
  try {
    let i = 0;
    for (const group of groups.values()) {
      const p = group[0];
      if (group.some(q => q.text !== p.text || q.next !== p.next)) throw Error('Разные планы одного физического файла.');
      await hook('config' + (++i), p);
      for (const q of group) {
        if (identity(q.file).signature !== q.identity) throw Error('Состав группы настроек изменён: ' + q.file);
        unchanged(q);
      }
      if (p.backupBefore) {
        const file = p.backupFile || p.file + '.prev';
        if (fs.existsSync(file)) { if (fs.lstatSync(file).isSymbolicLink()) throw Error('Резервный конфиг является ссылкой.'); identity(file); }
        previous.push({ file, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null });
        atomic(file, p.text);
      }
      if (p.next === null) fs.unlinkSync(p.file);
      else { fs.mkdirSync(path.dirname(p.file), { recursive: true }); atomic(p.file, p.next); }
      changed.push(group);
      verify(group, 'next');
    }
    for (const group of groups.values()) {
      const p = group[0]; if (p.backupBefore || !group.some(q => q.backup)) continue;
      const file = p.file + '.prev';
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('Резервный конфиг является ссылкой.');
      if (fs.existsSync(file)) identity(file);
      previous.push({ file, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null });
      atomic(file, p.text);
    }
  } catch (e) {
    const failures = [];
    for (const group of changed.reverse()) {
      const p = group[0];
      try {
        if (contents(p.file) !== p.next) throw Error('конфиг изменён извне');
        if (p.exists === false) { if (fs.existsSync(p.file)) fs.unlinkSync(p.file); }
        else atomic(p.file, p.text);
        verify(group, 'text');
      } catch (err) {
        failures.push(p.file + ': ' + err.message);
      }
    }
    for (const p of previous.reverse())
      try {
        if (p.text !== null) atomic(p.file, p.text);
        // Новую резервную копию оставляем для диагностики.
      } catch (err) {
        failures.push(p.file + ': ' + err.message);
      }
    throw Object.assign(Error(
      e.message + (failures.length ? '\nОбновлено частично: ' + failures.join('; ') : '\nКонфиги восстановлены.'),
    ), { configsUncertain: failures.length > 0 });
  }
}

function install(release, state) {
  const env = { ...process.env, npm_config_cache: path.join(state, 'npm-cache'), TEMP: state, TMP: state };
  const cli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (fs.existsSync(cli))
    execFileSync(process.execPath, [cli, 'ci', '--omit=dev', '--ignore-scripts'], {
      cwd: release,
      env,
      windowsHide: true,
      stdio: 'pipe',
      timeout: 180000,
    });
  else if (process.platform !== 'win32')
    execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: release, env, stdio: 'pipe', timeout: 180000 });
  else throw Error('Не найден npm-cli.js рядом с node.exe.');
}

function archive(root, commit, temp) {
  // Не извлекаем ссылки или подмодули: tar не должен записать через них вне релиза.
  if (
    deployGit(root, ['ls-tree', '-r', commit])
      .split('\n')
      .some((s) => /^(120000|160000) /.test(s))
  )
    throw Error('Ссылки и подмодули в релизе запрещены.');
  const tar = inside(root, 'live', '.archive-' + randomUUID() + '.tar');
  deployGit(root, ['archive', '--format=tar', '--output=' + tar, commit]);
  execFileSync(require('./paths').systemTar(), ['-xf', tar, '-C', temp], { windowsHide: true, stdio: 'pipe' });
  // Архив оставлен для диагностики; очистка не является частью транзакции.
}

async function locked(root, fn, state) {
  const l = await require('./locks').tryLock('team_repo', require('./paths').canon(root), {}, state);
  if (!l.ok) throw Error('Репозиторий занят другой операцией.');
  try {
    return await fn();
  } finally {
    await l.release();
  }
}

async function deploy({ root, commit = 'main', configs, dryRun = false, releaseOnly = false, stateDir, nodeModulesFrom, restartClaude = false, external = false, cleanup = true }, deps = {}) {
  root = fs.realpathSync(root);
  repository(root, deployGit);
  const id = hash(root, commit, deployGit),
    release = inside(root, 'live', id);
  if (restartClaude && external) {
    let source = '';
    try { source = deployGit(root, ['cat-file', 'blob', id + ':common/restart-hold.js']); } catch {}
    const declarations = source.match(/\bconst\s+RESTART_HOLD_PROTOCOL\s*=/g) || [];
    const version = source.match(/^const RESTART_HOLD_PROTOCOL = (\d+);\r?$/m);
    if (declarations.length !== 1 || !version || !Number.isSafeInteger(Number(version[1])) || Number(version[1]) < 1)
      throw Error('Релиз ' + id.slice(0, 8) + ' не умеет безопасный перезапуск (нет паузы перезапуска team-v29): установка с перезапуском запрещена. Можно установить без перезапуска и перезапустить Claude вручную, когда задания закончатся; после возврата на такой релиз защиты от обрыва поручений не будет.');
  }
  require('./deploy-ops').assertIdle(root, null, dryRun);
  const state = path.join(root, 'state');
  const deployState = path.resolve(stateDir || inside(root, 'live', '.deploy-state'));
  const clients = releaseOnly || external ? [] : require('./client-configs').paths().filter(p => fs.existsSync(p.file));
  const files = releaseOnly ? [] : [...new Set((configs || configPaths()).map((p) => path.resolve(p)))].filter((p) => fs.existsSync(p));
  const plan = [
    'Коммит: ' + id,
    'Релиз: ' + release,
    'Архив коммита → установка зависимостей → проверка четырёх серверов.',
    ...files.map((p) => 'Конфиг: ' + p),
    'Перезапуск Claude — при каждом обновлении серверного кода.',
  ].join('\n');
  // До этой точки нет mkdir, блокировок, временных файлов и запуска серверов.
  if (dryRun) {
    configPlans(files.map(snapshot), release, root, state);
    require('./client-configs').plans(clients.map(p => ({...snapshot(p.file), kind: p.kind, client: p.client})), release, root, state, nodeCommand());
    return 'Проверочный режим; изменений нет.\n' + plan;
  }
  const execute = deps.repoLocked ? async (_root, fn) => fn() : locked;
  const output = await execute(root, async () => {
    // team-v46: сначала целевой снимок реестра (полная матрица), по нему — проба и конфиги; при сбое — откат реестра.
    const registryBefore = require('./members-store').create(state).read({ initialize: false });
    const migrated = !releaseOnly && require('./members-v46').apply(state, 'forward');
    try {
    const snaps = external ? [] : files.map(snapshot);
    const clientPlans = require('./client-configs').plans(clients.map(p => ({...snapshot(p.file), kind: p.kind, client: p.client})), release, root, state, nodeCommand());
    if (!releaseOnly && !(external ? files : snaps).length) throw Error('Не найден ни один существующий конфиг Claude.');
    const hook = deps.hook || (async () => {});
    if (!fs.existsSync(release)) {
      const temp = inside(root, 'live', '.preparing-' + id + '-' + randomUUID());
      fs.mkdirSync(temp, { recursive: true });
      await hook('archive');
      await (deps.archive || archive)(root, id, temp);
      await hook('install');
      if (nodeModulesFrom) {
        const source = fs.realpathSync(nodeModulesFrom);
        if (!fs.statSync(source).isDirectory()) throw Error('Нужна папка node_modules.');
        fs.cpSync(source, path.join(temp, 'node_modules'), {
          recursive: true,
          filter: (file) => {
            if (fs.lstatSync(file).isSymbolicLink()) throw Error('Ссылки в node_modules запрещены: ' + file);
            return true;
          },
        });
      } else await (deps.install || install)(temp, deployState);
      await probeRelease(temp, root, id, deployState, deps, hook);
      await hook('publish');
      fs.renameSync(temp, release);
    } else {
      // Неизменяемый релиз повторно не устанавливается и не перезаписывается.
      for (const n of serversForRoot(root))
        if (!fs.existsSync(inside(root, 'live', id, 'servers', n, 'index.js')))
          throw Error('Существующий релиз неполон.');
    }
    const previous = verifiedRelease(release, true);
    expectedRoot(previous, root);
    if (previous.legacy) await probeRelease(release, root, id, deployState, deps, hook);
    expectedRoot(verifiedRelease(release), root);
    if (releaseOnly) return 'Релиз собран и прошёл пробный запуск.\n' + plan;
    if (external) return require('./deploy-ops').start({ root, release, configs: files, restartClaude, cleanup }, deps.operation || {});
    await switchConfigs([...configPlans(snaps, release, root, state), ...clientPlans, ...require('./agy-mcp-permissions').plans(release, root)], hook);
    activateMembers(release, root);
    const marker = inside(root, 'live', 'deployed.json');
    try {
      atomic(marker, JSON.stringify({ commit: id, release, at: new Date().toISOString(), method: 'внешним сценарием', configs: [...files, ...clients.map(p => p.file)] }, null, 2));
    } catch (e) {
      throw Error('Конфиги обновлены, но отметка релиза не записана: ' + e.message);
    }
    return 'Развёрнуто, нужен перезапуск Claude.\n' + plan;
    } catch (e) {
      if (migrated) require('./members-v46').restore(state, registryBefore);
      throw e;
    }
  }, deployState);
  if (restartClaude && !external && !releaseOnly) return 'Развёрнуто.\n' + plan + '\n' + await require('./restart').restart({ root, release, state, close: true }, deps.restart || {});
  return output;
}

// team-v28 Р1: строгое сравнение — тот же состав и без повторов (['a', 'a'] не равно ['a', 'b']).
const sameTools = (actual, expected) => actual.length === expected.length && new Set(actual).size === actual.length && expected.every(t => actual.includes(t));
function releaseGuestTools(releasePath, pairs, env) {
  const file = path.join(releasePath, 'common', 'access.js');
  if (!fs.existsSync(file)) throw Error('В релизе нет списка инструментов гостя (common/access.js).');
  const script = 'const [file, pairs] = process.argv.slice(1); const g = require(file).guestTools;' +
    "if (typeof g !== 'function') { process.stderr.write('нет функции guestTools'); process.exit(3); }" +
    "const out = {}; for (const [c, n] of JSON.parse(pairs)) out[c + ':' + n] = g(n, c); process.stdout.write(JSON.stringify(out));";
  const timeout = Number(process.env.MOST_GUEST_LIST_TIMEOUT_MS) || 20000;
  let out;
  try {
    out = execFileSync(process.execPath, ['-e', script, file, JSON.stringify(pairs)],
      { cwd: releasePath, env, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const why = e.code === 'ETIMEDOUT' || e.signal ? 'не ответил за ' + Math.round(timeout / 1000) + ' с' : String(e.stderr || e.message).trim().split(/\r?\n/)[0];
    throw Error('В релизе нет списка инструментов гостя (guestTools): ' + why);
  }
  let list;
  try { list = JSON.parse(out); } catch { throw Error('В релизе нет списка инструментов гостя (guestTools): неверный ответ.'); }
  for (const [c, n] of pairs) {
    const v = list?.[c + ':' + n];
    if (!Array.isArray(v) || v.some(t => typeof t !== 'string' || !t) || new Set(v).size !== v.length)
      throw Error('В релизе неверный список инструментов гостя: ' + c + ' → ' + n + '.');
  }
  return list;
}

async function probeRelease(releasePath, root, id, deployState, deps, hook) {
  await hook('probe');
  const isolated = path.join(deployState, '.probe-' + randomUUID());
  fs.mkdirSync(isolated, { recursive: true });
  try {
    return await probeWithSnapshot(isolated, releasePath, root, id, deps);
  } finally {
    // Копия реестра и журналов пробы не остаётся ни после успеха, ни после сбоя (ревью DeepSeek, З-8).
    try { fs.rmSync(isolated, { recursive: true, force: true }); } catch {}
  }
}

async function probeWithSnapshot(isolated, releasePath, root, id, deps) {
  const roster = { ...require('./members-store').create(path.join(root, 'state')).read({ initialize: false }) };
  delete roster.warning; // Служебное поле чтения не входит в снимок реестра.
  const text = JSON.stringify(roster), registry = path.join(isolated, 'members.json');
  atomic(registry, text);
  atomic(registry + '.last-good', text);
  // Журнал реестра копируется целиком: без него проверенный снимок не считается покрытым.
  const isolatedLog = path.join(isolated, 'members-log.jsonl');
  try { fs.copyFileSync(path.join(root, 'state', 'members-log.jsonl'), isolatedLog); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!fs.existsSync(isolatedLog)) {
    // Чистое состояние: снимок rev 0 получает свою init-запись, иначе журнал не покрывает снимок.
    if (roster.rev !== 0) throw Error('Реестр без журнала изменений: проба релиза невозможна.');
    fs.writeFileSync(isolatedLog, JSON.stringify({ action: 'init', rev: 0, at: new Date().toISOString(), who: 'system', reason: 'Первая инициализация (проба)', quote: null, before: null, after: roster }) + '\n');
  }
  const logText = fs.readFileSync(isolatedLog, 'utf8');
  const checkSnapshot = () => {
    for (const file of [registry, registry + '.last-good'])
      if (fs.readFileSync(file, 'utf8') !== text) throw Error('Снимок реестра изменён во время пробы релиза.');
    const logNow = fs.existsSync(path.join(isolated, 'members-log.jsonl')) ? fs.readFileSync(path.join(isolated, 'members-log.jsonl'), 'utf8') : null;
    if (logNow !== logText) throw Error('Журнал реестра изменён во время пробы релиза.');
  };
  const members = require('./members');
  const probeNames = members.serversForInstall(roster);
  const env = {
      ...process.env,
      TEMP: isolated,
      TMP: isolated,
      MOST_REPO_ROOT: root,
      MOST_STATE_DIR: isolated,
      MOST_JOURNAL: path.join(isolated, 'antigravity.log'),
      MOST_INPUT_DIR: path.join(isolated, 'input'),
      MOST_CODEX_JOBS_DIR: path.join(isolated, 'codex-jobs'),
      MOST_CODEX_ARCHIVE_DIR: path.join(isolated, 'archive'),
      MOST_CLAUDE_CONFIGS: '[]',
      MOST_PROBE_ONLY: '1',
      MOST_CLIENT: 'claude',
      MOST_JOB_ID: '',
    };
  for (const n of probeNames) {
    await (deps.probe || require('./probe').probe)(path.join(releasePath, 'servers', n, 'index.js'), env, probeDeployMs());
    checkSnapshot();
  }
  // team-v28 Р1: ожидаемый список гостя считает отдельный процесс из common/access.js самого релиза — не работающий код
  // и не проверяемый сервер; сбой, зависание или неверный ответ модуля — отказ установки без возврата к своему списку.
  const pairs = require('./member-clients').all(roster.members).flatMap(c => probeNames.map(n => [c.id, n]));
  const expectedAll = releaseGuestTools(releasePath, pairs, env);
  checkSnapshot();
  for (const [client, n] of pairs) {
    const result = await (deps.probe || require('./probe').probe)(path.join(releasePath, 'servers', n, 'index.js'), { ...env, MOST_CLIENT: client, MOST_PROBE_GUEST: 'full' }, probeDeployMs(), { allowEmpty: true });
    checkSnapshot();
    if (!deps.probe || result?.tools) {
      const actual = result?.tools?.map(t => t.name) || [];
      if (!sameTools(actual, expectedAll[client + ':' + n])) throw Error('Гостевой сервер предоставил неверный список инструментов.');
    }
  }
  atomic(path.join(releasePath, 'probe-ok.json'), JSON.stringify({ commit: id, root, servers: probeNames, at: new Date().toISOString() }));
}

function verifiedRelease(release, allowLegacy = false) {
  release = fs.realpathSync(release);
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(release, 'probe-ok.json'), 'utf8')); }
  catch { throw Error('Релиз не имеет метки успешного пробного запуска: ' + release); }
  const expected = serversForRoot(marker.root);
  if (!/^[a-f0-9]{40}$/.test(marker.commit) || path.basename(release) !== marker.commit ||
      !path.isAbsolute(marker.root || '') || !Number.isFinite(Date.parse(marker.at)) ||
      !(JSON.stringify(marker.servers) === JSON.stringify(expected) ||
        (allowLegacy && Array.isArray(marker.servers))))
    throw Error('Некорректная метка пробного запуска: ' + release);
  for (const n of expected)
    if (!fs.existsSync(inside(release, 'servers', n, 'index.js')) || !fs.statSync(inside(release, 'servers', n, 'index.js')).isFile()) throw Error('Релиз неполон, соберите заново через team_change deploy.');
  return { release, root: require('./path-compat').realOrGiven(marker.root), legacy: JSON.stringify(marker.servers) !== JSON.stringify(expected) };
}

function configPlans(snaps, release, root, state) {
  const servers = serversForRoot(root);
  return snaps.flatMap((s) => {
    const next = configFor(s.config, release, root, state, s.file);
    const { equal, entries } = require('./client-configs');
    const managed = [...new Set([...servers, 'grok', 'most', ...Object.keys(s.config.mcpServers || {}).filter(n => s.config.mcpServers[n]?.args?.some(a => String(a).includes('mcp-server-google-antigravity')))])];
    return equal(entries(next, managed), entries(s.config, managed)) ? [] : [{
      ...s, next: JSON.stringify(next, null, 2) + '\n',
      backup: !servers.every((n) => s.config.mcpServers?.[n]?.args?.[0] && samePath(s.config.mcpServers[n].args[0], path.join(release, 'servers', n, 'index.js'))),
    }];
  });
}

function expectedRoot(verified, root) {
  if (root && !require('../tools/deploy-bootstrap').equal(fs.realpathSync.native(root), fs.realpathSync.native(verified.root)))
    throw Error('Метка пробного запуска относится к другому корню.');
}
async function prepare(release, stateDir, dryRun, deps, result, root) {
  let verified = verifiedRelease(release, true);
  expectedRoot(verified, root);
  require('./deploy-ops').assertIdle(verified.root, result, dryRun);
  if (verified.legacy && !dryRun) {
    await probeRelease(verified.release, verified.root, path.basename(verified.release),
      stateDir || path.join(verified.root, 'live/.deploy-state'), deps, deps.hook || (async () => {}));
    verified = verifiedRelease(release);
    expectedRoot(verified, root);
  }
  return verified;
}
function deployed(verified, files, method = 'внешним сценарием') {
  activateMembers(verified.release, verified.root);
  try {
    atomic(path.join(verified.root, 'live/deployed.json'), JSON.stringify({
      commit: path.basename(verified.release), release: verified.release, at: new Date().toISOString(), method, configs: files,
    }, null, 2));
  } catch (e) { throw Error('Конфиги обновлены, но отметка развёртывания не записана: ' + e.message); }
}
async function configure(options, deps = {}) {
  const { root, release, configs, dryRun } = options;
  if (!release || !configs?.length) throw Error('--config-only требует --release и --config.');
  const verified = verifiedRelease(release, true);
  expectedRoot(verified, root);
  const migration = require('./members-v46'), state = path.join(verified.root, 'state');
  const before = require('./members-store').create(state).read({ initialize: false });
  const changed = !dryRun && fs.existsSync(path.join(release, 'common/members-v46.js')) && migration.apply(state, 'forward');
  const progress = { configsSwitched: false };
  try { return await configurePrepared(options, deps, progress); }
  catch (e) {
    if (changed && !progress.configsSwitched && !e.configsUncertain) migration.restore(state, before);
    throw e;
  }
}
async function configurePrepared({ root, release, configs, stateDir, dryRun = false, restartClaude = false, method, result }, deps = {}, progress = {}) {
  if (!release || !configs?.length) throw Error('--config-only требует --release и --config.');
  const verified = await prepare(release, stateDir, dryRun, deps, result, root);
  const files = [...new Set(configs.map((p) => path.resolve(p)))];
  const clients = method === 'из Claude через исполнителя вне пакета' ? require('./client-configs').paths().filter(p => fs.existsSync(p.file)) : [];
  const plan = 'Релиз: ' + verified.release + '\n' + files.map((p) => 'Конфиг: ' + p).join('\n');
  if (dryRun) {
    files.forEach(snapshot);
    return 'Проверочный режим; изменений нет.\n' + plan;
  }
  // Замки и резервные копии рядом с конфигами; проба и отметка выпуска уже проверены отдельно.
  const run = async () => {
    const rules = require('./client-rules');
    const rulePlans = method === 'из Claude через исполнителя вне пакета' ? rules.plans(deps.rules?.files) : [];
    await switchConfigs([...rulePlans.filter(p => p.next !== p.text), ...configPlans(files.map(snapshot), verified.release, verified.root, stateDir),
      ...require('./client-configs').plans(clients.map(p => ({ ...snapshot(p.file), kind: p.kind, client: p.client })), verified.release, verified.root, path.join(verified.root, 'state'), nodeCommand()), ...require('./agy-mcp-permissions').plans(verified.release, verified.root)], deps.hook);
    progress.configsSwitched = true;
    const rulesDelivery = rules.evidence(rulePlans, result ? path.basename(result, '.json') : null);
    if (result) require('./deploy-ops').update(result, { rulesDelivery });
    deployed(verified, [...files, ...clients.map(p => p.file)], method);
    if (rulesDelivery.length) {
      const mark = path.join(verified.root, 'live/deployed.json');
      atomic(mark, JSON.stringify({ ...JSON.parse(fs.readFileSync(mark, 'utf8')), rulesDelivery }, null, 2));
    }
    return 'Конфиги обновлены, нужен перезапуск Claude.\n' + plan;
  };
  // Один замок на каталог, даже если в нём несколько конфигов.
  const folders = [...new Set([...files, ...clients.map(p => p.file), ...(method === 'из Claude через исполнителя вне пакета' ? (deps.rules?.files || require('./client-rules').paths()) : [])].map((f) => fs.realpathSync(path.dirname(typeof f === 'string' ? f : f.file))))].sort();
  const lockFolders = async (i) => i === folders.length
    ? run()
    : locked(folders[i], () => lockFolders(i + 1), path.resolve(stateDir || path.join(folders[i], '.deploy-state')));
  const output = await lockFolders(0);
  if (restartClaude) return 'Конфиги обновлены.\n' + plan + '\n' + await require('./restart').restart({ root: verified.root, release: verified.release, state: path.join(verified.root, 'state'), close: true }, deps.restart || {});
  return output;
}

async function configureClients({ root, release, stateDir, dryRun = false, restartClaude = false }, deps = {}) {
  if (!release) throw Error('--clients-only требует --release.');
  const verified = await prepare(release, stateDir, dryRun, deps, undefined, root), clients = require('./client-configs');
  const files = clients.paths().filter(p => fs.existsSync(p.file));
  if (!files.length) throw Error('Не найдены файлы подключений Codex и Antigravity.');
  const state = path.join(verified.root, 'state');
  const plan = 'Релиз: ' + verified.release + '\n' + files.map(p => 'Подключения: ' + p.file).join('\n');
  const plans = () => [...clients.plans(files.map(p => ({ ...snapshot(p.file), kind: p.kind, client: p.client })), verified.release, verified.root, state, nodeCommand()), ...require('./agy-mcp-permissions').plans(verified.release, verified.root)];
  if (dryRun) { plans(); return 'Проверочный режим; изменений нет.\n' + plan; }
  const run = async () => {
    await switchConfigs(plans(), deps.hook);
    const ruleText = '\n' + (await require('./client-rules').configure(deps.rules || {})).join('\n');
    deployed(verified, files.map(p => p.file));
    return 'Подключения Codex и Antigravity обновлены.\n' + plan + ruleText;
  };
  const folders = [...new Set(files.map(p => fs.realpathSync(path.dirname(p.file))))].sort();
  const lockFolders = i => i === folders.length ? run() : locked(folders[i], () => lockFolders(i + 1), path.resolve(stateDir || path.join(folders[i], '.deploy-state')));
  const output = await lockFolders(0);
  if (restartClaude) return output + '\n' + await require('./restart').restart({ root: verified.root, release: verified.release, state, close: true }, deps.restart || {});
  return output;
}

function checkPreviousServers(config, keys, configFile) {
  for (const key of keys) {
    const server = config.mcpServers?.[key];
    if (!server) continue;
    const base = path.resolve(path.dirname(configFile), server.cwd || '.');
    // Команда без пути (node, node.exe, npx) разрешается через PATH.
    const command = typeof server.command === 'string' && /[\\/]/.test(server.command) ? [server.command] : [];
    const paths = [...command, ...(server.args || [])].filter((p) =>
      typeof p === 'string' && !p.startsWith('-') && !/^\/[ck]$/i.test(p) && !p.includes('://') &&
      // path.isAbsolute('/c') на Windows тоже true, хотя это ключ cmd.
      (/\.[cm]?js$/i.test(p) || /^[a-z]:[\\/]/i.test(p) ||
        /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(p) ||
        (process.platform !== 'win32' && path.posix.isAbsolute(p))));
    for (const p of paths) {
      const file = path.resolve(base, p);
      if (!fs.existsSync(file))
        throw Error('прежний сервер ' + file + ' больше не существует — откат невозможен, восстановите файл или выберите существующий релиз');
    }
  }
}

async function rollback({ root, configs, configOnly = false, stateDir }, deps = {}) {
  if (configOnly && !configs?.length) throw Error('--config-only --rollback требует --config.');
  configs = configs || [...configPaths(), ...require('./client-configs').paths().filter(p => fs.existsSync(p.file)).map(p => p.file)];
  const run = async (files = configs) => {
    // Проверка всей операции до первой записи любого клиента.
    // --state-dir задаёт только блокировки установщика, а не формат данных установки.
    const registryState = path.join(root || require('./paths').repoRoot, 'state');
    // §7 (ред. 3): откат невозможен, если есть записи новых ворот, которые релиз А не прочитает.
    const newGates = require('./rollback-guard').blockers(registryState, root || require('./paths').repoRoot);
    if (newGates.length) throw Error('Откат невозможен: релиз А не прочитает записи новых ворот — ' + newGates.join('; ') + '.');
    const changes = require('./members-rollback').changes(registryState);
    const targets = [];
    let unknownTarget = false;
    for (const file of files) {
      if (!fs.existsSync(file + '.prev')) continue;
      try {
      const prev = snapshot(file + '.prev');
      const config = /\.ya?ml$/i.test(file) ? require('./dsh-config').connections(prev.text) :
        /\.toml$/i.test(file) ? { mcpServers: require('./toml-records').document(prev.text).root.mcp_servers } : prev.config;
      for (const [n, c] of Object.entries(config?.mcpServers || {})) {
        if (!names.includes(n) && !(n === 'most' && require('./ownership').pointsInto(c, root || require('./paths').repoRoot))) continue;
        const script = [...(c.args || []), c.command].find(a => typeof a === 'string' && /\.[cm]?js$/i.test(a) && !a.startsWith('-'));
        if (!script) { unknownTarget = true; continue; }
        const resolved = path.resolve(path.dirname(file), c.cwd || '.', script);
        // Современные servers/<server>/index.js и прежний единый most/index.js.
        targets.push(/[\\/]servers[\\/][^\\/]+[\\/]index\.[cm]?js$/i.test(resolved) ? path.resolve(path.dirname(resolved), '../..') : path.dirname(resolved));
      }
      } catch (e) { if (changes.length) throw e; } // До появления реестра сохраняем независимый откат остальных конфигов.
    }
    // Пустой .prev отключает подключение, а файл разрешений вообще не выбирает релиз.
    // Проверяем границу только при переходе к конкретному серверному релизу.
    if (changes.length && (targets.length || unknownTarget)) require('./members-rollback').assert(registryState, unknownTarget ? [] : targets);
    const supportsV46 = release => fs.existsSync(path.join(release, 'common/members-v46.js'));
    if (new Set(targets.map(supportsV46)).size > 1) throw Error('Целевые релизы расходятся по поддержке team-v46; откат не выполнен.');
    const mcp = require('./agy-mcp-permissions');
    if (new Set(targets.map(mcp.supports)).size > 1) throw Error('Целевые релизы расходятся по поддержке MCP 3.8; общий settings.json не изменён.');
    // План разрешений применяется один раз до цикла: после записи у файла новый mtime,
    // и повторная передача того же плана в switchConfigs сорвала бы откат остальных конфигов.
    // Откат к отсутствию подключений — это и первый откат установки в пустой конфиг.
    // Файл, где подключений не было ни до, ни после, разрешений не касается.
    const hasServers = file => {
      try {
        const s = snapshot(file);
        if (/\.ya?ml$/i.test(file)) return Object.keys(require('./dsh-config').connections(s.text).mcpServers || {}).length > 0;
        if (/\.toml$/i.test(file)) return Object.keys(require('./toml-records').document(s.text).root.mcp_servers || {}).length > 0;
        return !!(s.config && typeof s.config === 'object' && Object.hasOwn(s.config, 'mcpServers'));
      } catch { return false; }
    };
    const uninstall = files.some(file => hasServers(file) || hasServers(file + '.prev'));
    const permissions = unknownTarget || (!targets.length && !uninstall) ? [] : mcp.plans(targets.length ? targets[0] : null, root || require('./paths').repoRoot, { rollback: true });
    if (permissions.length) await switchConfigs(permissions, deps.hook);
    const results = [];
    for (const file of [...new Set(files.map((p) => path.resolve(p)))]) {
      try {
        if (!fs.existsSync(file + '.prev')) throw Error('нет резервного конфига ' + file + '.prev');
        const s = snapshot(file),
          prev = snapshot(file + '.prev');
        const clientKind = require('./client-configs').paths().find(p => samePath(p.file, file))?.kind;
        if (clientKind) {
          const next = require('./client-configs').restore(s, prev, clientKind);
          await switchConfigs([{ ...s, next, backup: clientKind === 'dsh', backupBefore: clientKind === 'dsh', backupFile: file + '.rollback-backup' }], deps.hook);
          results.push(file + ': возвращён на предыдущую версию.');
          continue;
        }
        // Восстанавливаются записи серверов, посторонние поля текущего конфига сохраняются.
        const next = { ...s.config, mcpServers: { ...s.config.mcpServers } };
        const keys = new Set([
          ...names, 'grok',
          'most',
          ...Object.entries(prev.config.mcpServers || {})
            .filter(([, v]) => v.args?.some((a) => String(a).includes('mcp-server-google-antigravity')))
            .map(([k]) => k),
        ]);
        for (const key of keys) {
          if (Object.hasOwn(prev.config.mcpServers || {}, key)) next.mcpServers[key] = prev.config.mcpServers[key];
          else delete next.mcpServers[key];
        }
        checkPreviousServers(prev.config, keys, file);
        await switchConfigs([{ ...s, next: JSON.stringify(next, null, 2) + '\n', backup: false }], async (...args) => {
          if (deps.hook) await deps.hook(...args);
          checkPreviousServers(prev.config, keys, file);
        });
        results.push(file + ': возвращён на предыдущую версию; нужен перезапуск Claude.');
      } catch (e) { results.push(file + ': отказ в откате: ' + e.message); }
    }
    // team-v46: явная миграция отката — Claude не получает поручения, маски claude/* снимаются.
    try { if (!unknownTarget && uninstall && !targets.some(supportsV46) && !results.some(r => r.includes('отказ в откате:')) && require('./members-v46').apply(registryState, 'rollback')) results.push('Реестр: team-v46 откачен.'); }
    catch (e) { results.push('Реестр: отказ в откате team-v46: ' + e.message); }
    return results.join('\n') || 'Конфиги для отката не найдены.';
  };
  if (configOnly) {
    // Все конфиги одной операции, иначе первый успешный файл откатывал реестр до отказа второго.
    const folders = [...new Set(configs.map(f => fs.realpathSync(path.dirname(path.resolve(f)))))].sort();
    const acquire = i => i === folders.length ? run(configs) : locked(folders[i], () => acquire(i + 1), path.resolve(stateDir || path.join(folders[i], '.deploy-state')));
    return acquire(0);
  }
  root = fs.realpathSync(root);
  repository(root, deployGit);
  return locked(root, run);
}
module.exports = { deploy, configure, configureClients, rollback, configPaths, configFor, snapshot, switchConfigs, locked };
