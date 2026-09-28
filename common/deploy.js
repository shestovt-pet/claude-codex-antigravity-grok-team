'use strict';
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const { inside, repository, deployGit, hash, atomic } = require('./team-git');
const names = ['antigravity', 'codex', 'team', 'grok'];
function configPaths() {
  if (process.env.MOST_CLAUDE_CONFIGS) return JSON.parse(process.env.MOST_CLAUDE_CONFIGS);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local');
  const store = (name) => path.join(local, 'Packages', name, 'LocalCache/Roaming/Claude/claude_desktop_config.json');
  // Claude из Microsoft Store: имя пакета ищется по шаблону Claude_*, известное имя остаётся кандидатом (team-v11 Р2).
  let found = [];
  try { found = fs.readdirSync(path.join(local, 'Packages')).filter((n) => /^Claude_[a-z0-9]+$/i.test(n)).sort(); } catch {}
  return [...new Set([
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'Claude/claude_desktop_config.json'),
    store('Claude_pzs8sxrjxfjjc'),
    ...found.map(store),
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
  assertOwn(out.mcpServers, names, root, file);
  // Старые записи прежних версий удаляются, только если указывают на этот корень; чужое не трогаем.
  if (out.mcpServers.most && pointsInto(out.mcpServers.most, root)) delete out.mcpServers.most;
  for (const [key, value] of Object.entries(out.mcpServers))
    if (!names.includes(key) && Array.isArray(value?.args) && value.args.some((a) => String(a).includes('mcp-server-google-antigravity')) && pointsInto(value, root))
      delete out.mcpServers[key];
  for (const n of names)
    out.mcpServers[n] = {
      ...out.mcpServers[n],
      command: nodeCommand(),
      args: [path.join(release, 'servers', n, 'index.js')],
      env: { ...out.mcpServers[n]?.env, MOST_REPO_ROOT: root, MOST_STATE_DIR: state, MOST_CLIENT: 'claude' },
    };
  // Старые производные пути не должны уводить очереди из общего хранилища.
  for (const n of names) for (const key of ['MOST_CODEX_JOBS_DIR', 'MOST_INPUT_DIR', 'MOST_JOURNAL']) delete out.mcpServers[n].env[key];
  return out;
}

function snapshot(file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw Error('Конфиг не должен быть ссылкой: ' + file);
  const stat = fs.statSync(file),
    text = fs.readFileSync(file, 'utf8');
  if (/\.(?:toml|md)(?:\.prev)?$/i.test(file)) return { file, text, mtime: stat.mtimeMs, config: null };
  let config; try { config = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw Error('Некорректный файл настроек: ' + file); }
  return { file, text, mtime: stat.mtimeMs, config };
}

function unchanged(s) {
  const cur = snapshot(s.file);
  if (cur.mtime !== s.mtime || cur.text !== s.text) throw Error('Конфиг изменён другим процессом: ' + s.file);
}
// Компенсация не затирает чужое изменение. В таком случае явно сообщаем о частичном обновлении.
async function switchConfigs(plans, hook = async () => {}) {
  const changed = [],
    previous = [];
  const identity = file => {
    const s = fs.statSync(file, { bigint: true });
    if (s.nlink > 1n) throw Error('Жёсткие ссылки в настройках запрещены: ' + file);
    return { key: s.dev !== 0n && s.ino !== 0n && s.nlink === 1n ? s.dev + ':' + s.ino : file,
      signature: [s.dev, s.ino, s.nlink].join(':') };
  };
  const groups = new Map();
  for (const p of plans) {
    const id = identity(p.file); p.identity = id.signature;
    const group = groups.get(id.key) || []; group.push(p); groups.set(id.key, group);
  }
  const verify = (group, field) => {
    for (const p of group) if (fs.readFileSync(p.file, 'utf8') !== p[field])
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
      atomic(p.file, p.next);
      changed.push(group);
      verify(group, 'next');
    }
    for (const group of groups.values()) {
      const p = group[0]; if (!group.some(q => q.backup)) continue;
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
        if (fs.readFileSync(p.file, 'utf8') !== p.next) throw Error('конфиг изменён извне');
        atomic(p.file, p.text);
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
    throw Error(
      e.message + (failures.length ? '\nОбновлено частично: ' + failures.join('; ') : '\nКонфиги восстановлены.'),
    );
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
  execFileSync('tar', ['-xf', tar, '-C', temp], { windowsHide: true, stdio: 'pipe' });
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
  require('./deploy-ops').assertIdle(root, null, dryRun);
  repository(root, deployGit);
  const id = hash(root, commit, deployGit),
    release = inside(root, 'live', id);
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
    require('./client-configs').plans(clients.map(p => ({...snapshot(p.file), kind: p.kind})), release, root, state, nodeCommand());
    return 'Проверочный режим; изменений нет.\n' + plan;
  }
  const execute = deps.repoLocked ? async (_root, fn) => fn() : locked;
  return execute(root, async () => {
    const snaps = external ? [] : files.map(snapshot);
    const clientPlans = require('./client-configs').plans(clients.map(p => ({...snapshot(p.file), kind: p.kind})), release, root, state, nodeCommand());
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
      for (const n of names)
        if (!fs.existsSync(inside(root, 'live', id, 'servers', n, 'index.js')))
          throw Error('Существующий релиз неполон.');
    }
    const previous = verifiedRelease(release, true);
    if (previous.legacy) await probeRelease(release, root, id, deployState, deps, hook);
    verifiedRelease(release);
    if (releaseOnly) return 'Релиз собран и прошёл пробный запуск.\n' + plan;
    if (external) return require('./deploy-ops').start({ root, release, configs: files, restartClaude, cleanup }, deps.operation || {});
    await switchConfigs([...configPlans(snaps, release, root, state), ...clientPlans], hook);
    const marker = inside(root, 'live', 'deployed.json');
    try {
      atomic(marker, JSON.stringify({ commit: id, release, at: new Date().toISOString(), method: 'внешним сценарием', configs: [...files, ...clients.map(p => p.file)] }, null, 2));
    } catch (e) {
      throw Error('Конфиги обновлены, но отметка релиза не записана: ' + e.message);
    }
    if (restartClaude) return 'Развёрнуто.\n' + plan + '\n' + await require('./restart').restart({ root, release, state }, deps.restart || {});
    return 'Развёрнуто, нужен перезапуск Claude.\n' + plan;
  }, deployState);
}

async function probeRelease(releasePath, root, id, deployState, deps, hook) {
  await hook('probe');
  const isolated = path.join(deployState, '.probe-' + randomUUID());
  fs.mkdirSync(isolated, { recursive: true });
  for (const n of names)
    await (deps.probe || require('./probe').probe)(path.join(releasePath, 'servers', n, 'index.js'), {
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
    });
  for (const client of ['codex', 'antigravity']) for (const n of ['team', client === 'codex' ? 'antigravity' : 'codex', 'grok']) {
    const result = await (deps.probe || require('./probe').probe)(path.join(releasePath, 'servers', n, 'index.js'), { ...process.env, MOST_CLIENT: client, MOST_PROBE_ONLY: '1', MOST_REPO_ROOT: root, MOST_STATE_DIR: isolated, MOST_CODEX_JOBS_DIR: path.join(isolated, 'codex-jobs'), MOST_INPUT_DIR: path.join(isolated, 'input'), MOST_JOURNAL: path.join(isolated, 'antigravity.log') });
    if (!deps.probe || result?.tools) {
      const expected = n === 'team' ? ['team_status', 'team_rules', 'team_work'] : [n + '_status', n + '_send', n + '_result'];
      const actual = result?.tools?.map(t => t.name) || [];
      if (actual.length !== expected.length || actual.some(t => !expected.includes(t))) throw Error('Гостевой сервер предоставил неверный список инструментов.');
    }
  }
  atomic(path.join(releasePath, 'probe-ok.json'), JSON.stringify({ commit: id, root, servers: names, at: new Date().toISOString() }));
}

function verifiedRelease(release, allowLegacy = false) {
  release = fs.realpathSync(release);
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(release, 'probe-ok.json'), 'utf8')); }
  catch { throw Error('Релиз не имеет метки успешного пробного запуска: ' + release); }
  if (!/^[a-f0-9]{40}$/.test(marker.commit) || path.basename(release) !== marker.commit ||
      !path.isAbsolute(marker.root || '') || !Number.isFinite(Date.parse(marker.at)) ||
      !(JSON.stringify(marker.servers) === JSON.stringify(names) ||
        (allowLegacy && Array.isArray(marker.servers))))
    throw Error('Некорректная метка пробного запуска: ' + release);
  for (const n of names)
    if (!fs.existsSync(inside(release, 'servers', n, 'index.js')) || !fs.statSync(inside(release, 'servers', n, 'index.js')).isFile()) throw Error('Релиз неполон, соберите заново через team_change deploy.');
  return { release, root: marker.root, legacy: JSON.stringify(marker.servers) !== JSON.stringify(names) };
}

function configPlans(snaps, release, root, state) {
  return snaps.flatMap((s) => {
    const next = configFor(s.config, release, root, state, s.file);
    const { equal, entries } = require('./client-configs');
    const managed = [...new Set([...names, 'most', ...Object.keys(s.config.mcpServers || {}).filter(n => s.config.mcpServers[n]?.args?.some(a => String(a).includes('mcp-server-google-antigravity')))])];
    return equal(entries(next, managed), entries(s.config, managed)) ? [] : [{
      ...s, next: JSON.stringify(next, null, 2) + '\n',
      backup: !names.every((n) => s.config.mcpServers?.[n]?.args?.[0] === path.join(release, 'servers', n, 'index.js')),
    }];
  });
}

async function prepare(release, stateDir, dryRun, deps, result) {
  let verified = verifiedRelease(release, true);
  require('./deploy-ops').assertIdle(verified.root, result, dryRun);
  if (verified.legacy && !dryRun) {
    await probeRelease(verified.release, verified.root, path.basename(verified.release),
      stateDir || path.join(verified.root, 'live/.deploy-state'), deps, deps.hook || (async () => {}));
    verified = verifiedRelease(release);
  }
  return verified;
}
function deployed(verified, files, method = 'внешним сценарием') {
  try {
    atomic(path.join(verified.root, 'live/deployed.json'), JSON.stringify({
      commit: path.basename(verified.release), release: verified.release, at: new Date().toISOString(), method, configs: files,
    }, null, 2));
  } catch (e) { throw Error('Конфиги обновлены, но отметка развёртывания не записана: ' + e.message); }
}
async function configure({ release, configs, stateDir, dryRun = false, restartClaude = false, method, result }, deps = {}) {
  if (!release || !configs?.length) throw Error('--config-only требует --release и --config.');
  const verified = await prepare(release, stateDir, dryRun, deps, result);
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
      ...require('./client-configs').plans(clients.map(p => ({ ...snapshot(p.file), kind: p.kind })), verified.release, verified.root, path.join(verified.root, 'state'), nodeCommand())], deps.hook);
    const rulesDelivery = rules.evidence(rulePlans, result ? path.basename(result, '.json') : null);
    if (result) require('./deploy-ops').update(result, { rulesDelivery });
    deployed(verified, [...files, ...clients.map(p => p.file)], method);
    if (rulesDelivery.length) {
      const mark = path.join(verified.root, 'live/deployed.json');
      atomic(mark, JSON.stringify({ ...JSON.parse(fs.readFileSync(mark, 'utf8')), rulesDelivery }, null, 2));
    }
    if (restartClaude) return 'Конфиги обновлены.\n' + plan + '\n' + await require('./restart').restart({ root: verified.root, release: verified.release, state: path.join(verified.root, 'state') }, deps.restart || {});
    return 'Конфиги обновлены, нужен перезапуск Claude.\n' + plan;
  };
  // Один замок на каталог, даже если в нём несколько конфигов.
  const folders = [...new Set([...files, ...clients.map(p => p.file), ...(method === 'из Claude через исполнителя вне пакета' ? (deps.rules?.files || require('./client-rules').paths()) : [])].map((f) => fs.realpathSync(path.dirname(typeof f === 'string' ? f : f.file))))].sort();
  const lockFolders = async (i) => i === folders.length
    ? run()
    : locked(folders[i], () => lockFolders(i + 1), path.resolve(stateDir || path.join(folders[i], '.deploy-state')));
  return lockFolders(0);
}

async function configureClients({ release, stateDir, dryRun = false, restartClaude = false }, deps = {}) {
  if (!release) throw Error('--clients-only требует --release.');
  const verified = await prepare(release, stateDir, dryRun, deps), clients = require('./client-configs');
  const files = clients.paths().filter(p => fs.existsSync(p.file));
  if (!files.length) throw Error('Не найдены файлы подключений Codex и Antigravity.');
  const state = path.join(verified.root, 'state');
  const plan = 'Релиз: ' + verified.release + '\n' + files.map(p => 'Подключения: ' + p.file).join('\n');
  const plans = () => clients.plans(files.map(p => ({ ...snapshot(p.file), kind: p.kind })), verified.release, verified.root, state, nodeCommand());
  if (dryRun) { plans(); return 'Проверочный режим; изменений нет.\n' + plan; }
  const run = async () => {
    await switchConfigs(plans(), deps.hook);
    const ruleText = '\n' + (await require('./client-rules').configure(deps.rules || {})).join('\n');
    deployed(verified, files.map(p => p.file));
    if (restartClaude) return 'Подключения Codex и Antigravity обновлены.\n' + plan + ruleText + '\n' + await require('./restart').restart({ root: verified.root, release: verified.release, state }, deps.restart || {});
    return 'Подключения Codex и Antigravity обновлены.\n' + plan + ruleText;
  };
  const folders = [...new Set(files.map(p => fs.realpathSync(path.dirname(p.file))))].sort();
  const lockFolders = i => i === folders.length ? run() : locked(folders[i], () => lockFolders(i + 1), path.resolve(stateDir || path.join(folders[i], '.deploy-state')));
  return lockFolders(0);
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
    const results = [];
    for (const file of [...new Set(files.map((p) => path.resolve(p)))]) {
      try {
        if (!fs.existsSync(file + '.prev')) throw Error('нет резервного конфига ' + file + '.prev');
        const s = snapshot(file),
          prev = snapshot(file + '.prev');
        const clientKind = require('./client-configs').paths().find(p => path.resolve(p.file) === path.resolve(file))?.kind;
        if (clientKind) {
          const next = require('./client-configs').restore(s, prev, clientKind);
          await switchConfigs([{ ...s, next, backup: false }], deps.hook);
          results.push(file + ': возвращён на предыдущую версию.');
          continue;
        }
        // Восстанавливаются записи серверов, посторонние поля текущего конфига сохраняются.
        const next = { ...s.config, mcpServers: { ...s.config.mcpServers } };
        const keys = new Set([
          ...names,
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
    return results.join('\n') || 'Конфиги для отката не найдены.';
  };
  if (configOnly) {
    const results = [];
    for (const file of [...new Set(configs.map((f) => path.resolve(f)))]) {
      try {
        const folder = fs.realpathSync(path.dirname(file));
        results.push(await locked(folder, () => run([file]), path.resolve(stateDir || path.join(folder, '.deploy-state'))));
      } catch (e) { results.push(file + ': отказ в откате: ' + e.message); }
    }
    return results.join('\n');
  }
  root = fs.realpathSync(root);
  repository(root, deployGit);
  return locked(root, run);
}
module.exports = { deploy, configure, configureClients, rollback, configPaths, configFor, snapshot, switchConfigs, locked };
