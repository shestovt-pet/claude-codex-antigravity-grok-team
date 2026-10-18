'use strict';
// C:/E: моделируются как ссылка/цель в изолированной папке на E:, буквы дисков не подменяются.
// Junction обязательна: невозможность mklink /J означает провал, а не пропуск.
const fs = require('fs'), path = require('path'), cp = require('child_process'), assert = require('assert');
if (process.argv[2] === '--worker') {
  const locks = require('../common/locks');
  (async () => {
    const [mode, kind, key, state] = process.argv.slice(3);
    const info = { instance: key, pid: process.pid, startedAt: 'worker', version: 'old' };
    const result = mode === 'old' ? await locks.listenPipe(locks.pipeName(kind, key, state), () => info) : await locks.tryLock(kind, key, info, state);
    process.send({ ok: result.ok, ...info });
    process.on('message', async () => { if (result.release) await result.release(); else if (result.srv) await new Promise(r => result.srv.close(r)); process.exit(0); });
  })().catch(e => { process.send({ error: e.stack }); process.exit(1); });
} else {
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v21-'));
const real = path.join(RUN, 'physical'), link = path.join(RUN, 'junction');
const write = (f, text = '') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const json = (f, obj) => write(f, JSON.stringify(obj));
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const at = p => path.join(real, p), alias = p => path.join(link, p);
fs.mkdirSync(real);
Object.assign(process.env, { MOST_REPO_ROOT: real, MOST_STATE_DIR: at('state'), MOST_CLAUDE_CONFIGS: JSON.stringify([at('claude.json')]),
  MOST_CODEX_CONFIG: at('missing.toml'), MOST_AGY_MCP_CONFIG: at('missing.json'), MOST_AGY_CONFIG: at('permissions.json'),
  MOST_CODEX_RULES: at('codex-rules.md'), MOST_AGY_RULES: at('agy-rules.md'), MOST_NOTIFY: 'off', MOST_CLIENT: 'claude', MOST_AFTER_DEPLOY: 'off',
  TEMP: RUN, TMP: RUN, TMPDIR: RUN });
json(at('claude.json'), { mcpServers: { team: { env: { MOST_REPO_ROOT: link, MOST_STATE_DIR: alias('state') } } } });
fs.mkdirSync(at('state'), { recursive: true });
const tests = [], test = (name, fn) => tests.push({ name, fn });
let compat, locks, cleanup, deploy, ops, paths;
const hashes = ['a', 'b', 'c', 'd'].map(c => c.repeat(40));
function release(hash, root = link, modern = false) {
  const dir = at('live/' + hash);
  for (const name of ['team', 'codex', 'antigravity', 'grok']) write(path.join(dir, 'servers', name, 'index.js'));
  json(path.join(dir, 'probe-ok.json'), { commit: hash, root, servers: require('../common/members').servers, at: new Date().toISOString() });
  if (modern) write(path.join(dir, 'common/path-compat.js'), '// compatibility contract');
  return dir;
}
function oldModule(name, overrides = {}, current = false) {
  const Module = require('module'), filename = path.join(ROOT, 'common', name + '.js');
  const m = new Module(filename, module); m.filename = filename; m.paths = module.paths;
  const req = Module.createRequire(filename); m.require = id => overrides[id] || req(id);
  m._compile(current ? fs.readFileSync(filename, 'utf8') : cp.execFileSync('git', ['show', '97e948f0:common/' + name + '.js'], { cwd: ROOT, encoding: 'utf8' }), filename);
  return m.exports;
}
async function patched(obj, key, value, fn) { const old = obj[key]; obj[key] = value; try { return await fn(); } finally { obj[key] = old; } }
function cleanDeps(extra = {}) {
  fs.mkdirSync(at('.work'), { recursive: true }); fs.mkdirSync(at('temp'), { recursive: true }); fs.mkdirSync(at('state/team/changes'), { recursive: true });
  json(at('live/deployed.json'), { commit: hashes[0], release: at('live/' + hashes[0]) });
  return { configFiles: () => [], processes: () => [], pendingDeploy: () => null, hasLiveJobs: () => false, folderJobs: () => [],
    selfRelease: null, tempDir: at('temp'), changesDir: at('state/team/changes'), git: (_p, args) => args[0] === 'rev-parse' ? hashes[0] : '', ...extra };
}
const keep = (r, p) => r.plan.keep.find(x => paths.samePath(x.path, p));
const removal = (r, p) => r.plan.remove.find(x => paths.samePath(x.path, p));
async function worker(mode, kind, key, state) {
  const child = cp.fork(__filename, ['--worker', mode, kind, key, state], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const value = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => { if (code) reject(Error('worker ' + code)); }); });
  assert(!value.error, value.error);
  return { ...value, stop: () => new Promise(resolve => { child.once('exit', resolve); child.send('stop'); }) };
}
test('К7: настоящая junction обязательна', () => {
  assert.equal(process.platform, 'win32', 'Этот набор требует Windows и mklink /J');
  cp.execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, real], { windowsHide: true });
  assert(fs.lstatSync(link).isSymbolicLink()); assert.equal(fs.realpathSync(link), fs.realpathSync(real));
  compat = require('../common/path-compat'); paths = require('../common/paths'); locks = require('../common/locks');
  cleanup = require('../common/cleanup'); deploy = require('../common/deploy'); ops = require('../common/deploy-ops');
  hashes.forEach((h, i) => release(h, link, i === 3));
});
test('О1, О3: старые deploy/start → новый configure, повтор существующего релиза', async () => {
  const oldOps = oldModule('deploy-ops'), git = require('../common/team-git');
  const freshHash = 'e'.repeat(40);
  const fakeGit = { ...git, repository: () => {}, hash: () => freshHash };
  const oldDeploy = oldModule('deploy', { './deploy-ops': oldOps, './team-git': fakeGit });
  const config = at('install.json'); json(config, {});
  const oldEnv = { MOST_REPO_ROOT: process.env.MOST_REPO_ROOT, MOST_STATE_DIR: process.env.MOST_STATE_DIR };
  process.env.MOST_REPO_ROOT = link; process.env.MOST_STATE_DIR = alias('state');
  try {
  for (let i = 0; i < 2; i++) {
    const result = await oldDeploy.deploy({ root: link, external: true, configs: [config], cleanup: false }, {
      repoLocked: true, archive: async (_root, _id, temp) => {
        for (const n of ['team', 'codex', 'antigravity', 'grok']) write(path.join(temp, 'servers', n, 'index.js'));
        write(path.join(temp, 'common/path-compat.js'), '// new code');
        write(path.join(temp, 'common/access.js'), fs.readFileSync(path.join(ROOT, 'common/access.js'))); // team-v28 Р1: есть в каждом релизе
      }, install: async () => {}, probe: async () => ({}), operation: { launch: async (rel, args) => {
        const file = args[args.indexOf('--result') + 1];
        assert(file.startsWith(real));
        await ops.execute({ release: rel, configs: [config], result: file }, options => deploy.configure({ ...options, method: 'test' }, { probe: async () => ({}) }));
        return process.pid;
      } },
    });
    assert.match(result, /завершено/);
    const env = read(config).mcpServers.team.env;
    assert.equal(env.MOST_REPO_ROOT, fs.realpathSync(real)); assert.equal(env.MOST_STATE_DIR, at('state'));
  }
  } finally { Object.assign(process.env, oldEnv); }
});
test('О2: старый релиз — точный marker.root, noCleanup, старый assertIdle/afterDeploy', async () => {
  const oldOps = oldModule('deploy-ops'), oldAfter = oldModule('after-deploy');
  let file;
  const out = await ops.start({ root: real, release: at('live/' + hashes[1]), configs: [] }, { launch: async (_r, args) => {
    file = args[args.indexOf('--result') + 1]; assert(file.startsWith(link + path.sep));
    const op = read(file); assert.equal(op.root, link); assert.equal(op.noCleanup, true);
    oldOps.assertIdle(link, file); assert(paths.samePath(file, at('state/deploy-ops/' + op.id + '.json')));
    ops.update(file, { status: 'завершено' }); return process.pid;
  } });
  assert.match(out, /уборка отключена: релиз старого кода \(до team-v21\)/);
  const op = read(file);
  await oldAfter.afterDeploy(op.id, { root: real, cleanup: () => { throw Error('Старая уборка запущена'); } });
  assert.equal(read(file).cleanup.state, 'отключена');
  for (const markerRoot of [at('absent-root'), RUN]) {
    release(hashes[2], markerRoot); const before = fs.readdirSync(at('state/deploy-ops'));
    await assert.rejects(ops.start({ root: real, release: at('live/' + hashes[2]), configs: [] }, { launch: () => { throw Error('не должен запускаться'); } }), /нужен релиз/);
    assert.deepEqual(fs.readdirSync(at('state/deploy-ops')), before);
  }
  release(hashes[2], real);
  await patched(fs.realpathSync, 'native', () => { throw Object.assign(Error('нет доступа'), { code: 'EACCES' }); }, async () => {
    assert.equal(compat.strictSamePath(real, real), 'unknown');
    await assert.rejects(ops.start({ root: real, release: at('live/' + hashes[2]), configs: [] }), /нужен релиз/);
  });
  // Новая метка, записанная новым установщиком, не меняет содержимое старого релиза.
  assert.equal(compat.releasePolicy(real, at('live/' + hashes[2])).oldCode, true);
});
test('О2: новый установщик впервые собирает и перепроверяет старый код, признак не в метке', async () => {
  const h = 'f'.repeat(40), git = require('../common/team-git');
  const builder = oldModule('deploy', { './team-git': { ...git, repository: () => {}, hash: () => h } }, true);
  const deps = { repoLocked: true, archive: async (_root, _id, temp) => {
    for (const n of ['team', 'codex', 'antigravity', 'grok']) write(path.join(temp, 'servers', n, 'index.js'));
    write(path.join(temp, 'common/access.js'), fs.readFileSync(path.join(ROOT, 'common/access.js'))); // team-v28 Р1: есть в каждом релизе
  }, install: async () => {}, probe: async () => ({}) };
  await builder.deploy({ root: link, releaseOnly: true }, deps);
  const rel = at('live/' + h), marker = read(path.join(rel, 'probe-ok.json'));
  assert.equal(marker.root, real); assert.equal(compat.releasePolicy(real, rel).oldCode, true);
  json(path.join(rel, 'probe-ok.json'), { ...marker, servers: [] });
  await builder.deploy({ root: link, releaseOnly: true }, deps);
  assert.equal(read(path.join(rel, 'probe-ok.json')).servers.length, 3);
  await ops.start({ root: link, release: rel, configs: [] }, { launch: async (_r, args) => {
    const f = args[args.indexOf('--result') + 1]; assert.equal(read(f).noCleanup, true);
    assert.equal(read(f).root, real); oldModule('deploy-ops').assertIdle(real, f);
    ops.update(f, { status: 'завершено' }); return process.pid;
  } });
  const original = fs.readFileSync;
  await patched(fs, 'readFileSync', (f, ...args) => {
    if (f === at('live/' + hashes[3] + '/common/path-compat.js')) throw Object.assign(Error('unreadable'), { code: 'EACCES' });
    return original(f, ...args);
  }, () => assert.equal(compat.releasePolicy(real, at('live/' + hashes[3])).oldCode, true));
});
test('О4, О5б: настройки, .prev, полный хеш и собственный релиз защищены в обе стороны', () => {
  write(at('live/.stale-linked/servers/team/index.js'));
  for (const base of [real, link]) {
    const cfg = at('cleanup.json'); json(cfg, { args: [path.join(base, 'live', hashes[1], 'servers/team/index.js')] });
    json(cfg + '.prev', { args: [path.join(base, 'live', hashes[2], 'servers/team/index.js')] });
    const deps = cleanDeps({ configFiles: () => [cfg, cfg + '.prev'], selfRelease: path.join(base, 'live', hashes[3]) });
    const r = cleanup.cleanup({ root: base === real ? link : real }, deps);
    for (const h of hashes) assert(keep(r, at('live/' + h)), h);
    json(cfg, { unrelatedText: 'rollback hash ' + hashes[1] });
    assert(keep(cleanup.cleanup({ root: real }, deps), at('live/' + hashes[1])));
    json(cfg, { args: [path.join(base, 'live/.stale-linked/servers/team/index.js')] });
    assert(keep(cleanup.cleanup({ root: base === real ? link : real }, deps), at('live/.stale-linked')), 'защита по пути без хеша');
  }
});
test('О5: живые поручения в корне/подпапке, процессы не node.exe, обе ветки tmp', async () => {
  const clone = at('.work/merged'), tmp = path.join(clone, 'tests/.tmp-old'), child = path.join(tmp, 'script.ps1');
  write(child); fs.utimesSync(tmp, new Date(0), new Date(0)); json(at('state/team/changes/merged.json'), { status: 'слито' });
  const stores = require('../common/team-store');
  for (const base of [real, link]) {
    for (const folder of [path.join(base, '.work/merged'), path.join(base, '.work/merged/tests/.tmp-old')]) {
      await patched(stores, 'list', who => ({ jobs: who === 'codex' ? [{ id: 'job', status: 'running', folder }] : [], errors: [] }), () => {
        assert.deepEqual(cleanup.liveJobsInFolder(clone), ['codex job']);
        const deps = cleanDeps({ folderJobs: cleanup.liveJobsInFolder });
        assert(keep(cleanup.cleanup({ root: real }, deps), clone));
        assert(cleanup.tmpWhy(deps, clone, '.tmp-old'));
      });
    }
    const process = { pid: 87, exe: null, cmd: 'powershell.exe -File "' + path.join(base, '.work/merged/tests/.tmp-old/script.ps1') + '"' };
    for (const dirty of ['', ' M notes.md']) {
      const deps = cleanDeps({ processes: () => [process], git: (_p, args) => args[0] === 'status' ? dirty : args[0] === 'rev-parse' ? hashes[0] : '' });
      const r = cleanup.cleanup({ root: real }, deps);
      assert.equal(keep(r, clone).code, 'process_busy'); assert(!removal(r, tmp));
      assert.match(cleanup.tmpWhy(deps, clone, '.tmp-old'), /PID 87/);
    }
    // Клон сохранён из-за правки; процесс появился только перед повторной проверкой подпапки.
    let rows = [];
    const deps = cleanDeps({ processes: () => rows, git: (_p, a) => a[0] === 'status' ? ' M notes.md' : a[0] === 'rev-parse' ? hashes[0] : '' });
    const r = cleanup.cleanup({ root: real }, deps), candidate = removal(r, tmp); assert(candidate);
    rows = [process]; assert.match(candidate.recheck(), /PID 87/);
  }
  for (const processes of [() => { throw Error('нет доступа'); }, () => [{ pid: 1, cmd: 'ok' }, { pid: 2, cmd: null, exe: process.execPath }]]) {
    const r = cleanup.cleanup({ root: real }, cleanDeps({ processes }));
    assert.equal(keep(r, clone).code, 'processes_unread'); assert(!r.plan.remove.some(x => x.path.startsWith(clone)));
  }
  const exec = cp.execFileSync; let command;
  await patched(cp, 'execFileSync', (file, args, opts) => { if (file !== 'powershell.exe') return exec(file, args, opts); command = args.at(-1); return JSON.stringify({ ProcessId: 87, SessionId: 2, CommandLine: 'powershell.exe a.ps1' }); }, () => {
    assert.equal(cleanup.windowsProcesses()[0].pid, 87); assert.equal(cleanup.windowsProcesses()[0].sessionId, 2); assert(command.includes('SessionId')); assert(!command.includes('-Filter'));
  });
});

test('Ревью-1: предупреждение переживает старый execute, restart и старый team.js', async () => {
  const oldOps = oldModule('deploy-ops');
  const oldAfter = oldModule('after-deploy', { './deploy-ops': oldOps });
  let file, restarted = false;
  await ops.start({ root: real, release: at('live/' + hashes[1]), configs: [], restartClaude: true }, { launch: async (_r, args) => {
    assert(args.includes('--restart-claude')); file = args[args.indexOf('--result') + 1];
    await oldOps.execute({ result: file, release: at('live/' + hashes[1]), restartClaude: true }, async options => {
      assert.equal(options.restartClaude, false); return 'Настройки переключены, нужен перезапуск Claude';
    }, { restart: async () => { restarted = true; return { message: 'Перезапуск подтверждён' }; } });
    return process.pid;
  } });
  await oldAfter.afterDeploy(read(file).id, { root: real, cleanup: () => { throw Error('Старая уборка запущена'); } });
  assert(restarted); assert.equal(read(file).status, 'завершено'); assert.equal(read(file).cleanup.state, 'отключена');
  assert.equal(read(file).reason, ops.oldCodeLine);
  const { Team } = oldModule('team', { './deploy-ops': { ...oldOps, list: () => [read(file)] },
    './quota-line': { quotaLine: async () => 'Квоты: тест' }, './release-drift': { lines: () => [] },
    './client-configs': { status: () => 'Настройки: тест' },
    './team-git': { ...require('../common/team-git'), git: () => '', hash: () => hashes[0] } });
  const text = await new Team(real).status(undefined, undefined, false, true);
  const line = text.split('\n').find(x => x.includes('Установка ' + read(file).id + ': завершено'));
  assert(line, text); assert(line.includes(ops.oldCodeLine), line); assert(line.includes('Перезапуск подтверждён'), line);
});
test('Ревью-7: пути без диска, ключи Windows, URL и file:///', () => {
  const clone = at('.work/merged'), free = at('live/' + hashes[2]);
  const rootless = p => p.replace(/^[a-z]:/i, '');
  const checkProcess = (cmd, busy) => {
    const r = cleanup.cleanup({ root: real }, cleanDeps({ processes: () => [{ pid: 91, cmd }] }));
    if (busy) assert.equal(keep(r, clone)?.code, 'process_busy', cmd);
    else assert(removal(r, clone), cmd);
  };
  for (const name of [clone, path.join(clone, 'common/team.js')]) {
    for (const ref of [rootless(name), rootless(name).replace(/\\/g, '/').toUpperCase()]) {
      checkProcess('node.exe ' + ref, true);
      assert.deepEqual(cleanup.configPaths(JSON.stringify({ args: [ref] })), { abs: [ref], relative: [] });
    }
  }
  // Кандидат через junction: проверяются исходное и раскрытые написания без диска.
  for (const name of compat.spellings(alias('.work/merged'))) {
    assert(cleanup.refersTo(rootless(name) + '/common/team.js', alias('.work/merged')));
  }
  assert(!cleanup.refersTo(rootless(clone) + '-other/common/team.js', clone));
  for (const cmd of ['cmd.exe /c echo', 'browser.exe /prefetch:1 /factory,abc /S',
    'browser.exe https://example.org/live/page', 'browser.exe http://example.org/servers/team',
    'browser.exe custom+app://example.org/live/page']) checkProcess(cmd, false);
  const { pathToFileURL } = require('url');
  checkProcess('node.exe ' + pathToFileURL(path.join(clone, 'common/team.js')).href, true);
  const cfg = at('rootless-reference.json');
  for (const value of [rootless(free) + '/servers/team/index.js', pathToFileURL(path.join(free, 'servers/team/index.js')).href]) {
    json(cfg, { args: [value] });
    const r = cleanup.cleanup({ root: real }, cleanDeps({ configFiles: () => [cfg] }));
    assert.match(keep(r, free)?.reason || '', /настройки/);
  }
  for (const value of ['/c', '/prefetch:1', '/factory,abc', '/S', 'https://example.org/live/page', 'http://example.org/servers/team']) {
    json(cfg, { args: [value] });
    const r = cleanup.cleanup({ root: real }, cleanDeps({ configFiles: () => [cfg] }));
    assert(removal(r, free), value);
  }
});

test('Ревью-2–5: реалистичные процессы, свободные клон/подпапка/релиз, два снимка', async () => {
  const clone = at('.work/merged'), tmp = path.join(clone, 'tests/.tmp-old'), free = at('live/' + hashes[2]);
  const outside = at('outside/node.exe'); write(outside);
  const rows = [
    { pid: 0, sessionId: 0, exe: null, cmd: null }, { pid: 4, sessionId: 0, exe: null, cmd: null },
    { pid: 70, sessionId: 0, exe: outside, cmd: null },
    { pid: process.pid, sessionId: 2, exe: outside, cmd: 'node.exe "' + outside + '"' },
    { pid: 71, sessionId: 2, exe: outside, cmd: 'cmd.exe /d /s /c "' + alias('missing/file.txt') + '" /prefetch:1 /factory,abc' },
    { pid: 72, sessionId: 2, exe: null, cmd: String.raw`electron.exe --pipe=\\.\pipe\crashpad --device=\\?\C:\missing --share=\\server\share\absent` },
  ];
  assert.deepEqual(cleanup.cmdPaths('cmd.exe /c /prefetch:1 /factory,abc /S'), { abs: [], relative: [] });
  const stores = require('../common/team-store');
  const deps = cleanDeps({ processes: () => rows, folderJobs: cleanup.liveJobsInFolder });
  const cfg = at('missing-reference.json'); json(cfg, { args: [alias('missing/config.js')] }); deps.configFiles = () => [cfg];
  let calls = 0; deps.processes = () => { calls++; return rows; };
  const native = fs.realpathSync.native, js = fs.realpathSync;
  const check = fn => p => { assert(!/^[\\/]{2}/.test(String(p)), 'Недопустимый realpath: ' + p); return fn(p); };
  const guarded = check(js); guarded.native = check(native);
  await patched(stores, 'list', who => ({ jobs: who === 'codex' ? [{ id: 'missing', status: 'running', folder: alias('missing/job') }] : [], errors: [] }), async () => {
    await patched(fs, 'realpathSync', guarded, async () => {
      const prefix = String.fromCharCode(92).repeat(2) + '?' + String.fromCharCode(92);
      assert(cleanup.refersTo(prefix + clone + '/uncreated', clone));
      const r = cleanup.cleanup({ root: real }, deps);
      assert(removal(r, clone)); assert(removal(r, free)); assert.equal(calls, 1);
      assert.equal(r.plan.uncheckedHiddenProcesses, 3);
      assert.equal(cleanup.cleanupText(r).split('не проверено процессов со скрытыми сведениями: 3').length, 2);
      const dirty = { ...deps, git: (_p, a) => a[0] === 'status' ? ' M notes.md' : a[0] === 'rev-parse' ? hashes[0] : '' };
      calls = 0; const r2 = cleanup.cleanup({ root: real }, dirty);
      assert(keep(r2, clone)); assert(removal(r2, tmp)); assert(removal(r2, free)); assert.equal(calls, 1);
      // Удаление только перехватывается: файлов теста не удаляем.
      calls = 0; const deleted = [];
      await patched(fs, 'rmSync', p => deleted.push(p), () => {
        const applied = cleanup.cleanup({ root: real, apply: true }, { ...dirty, logFile: at('test-cleanup-log.jsonl') });
        assert.equal(calls, 2); assert(deleted.includes(tmp)); assert(deleted.includes(free));
        assert.equal(applied.plan.uncheckedHiddenProcesses, 3);
        assert.match(ops.cleanupLine({ state: 'готово', removed: 0, failed: 0, uncheckedHiddenProcesses: 3 }), /не проверено процессов со скрытыми сведениями: 3/);
      });
    });
  });
  for (const extra of [
    { pid: 80, sessionId: 2, cmd: null, exe: outside },
    { pid: 81, sessionId: 0, cmd: null, exe: alias('.work/merged/tests/.tmp-old/script.ps1') },
  ]) {
    const r = cleanup.cleanup({ root: real }, cleanDeps({ processes: () => [...rows, extra] }));
    assert.equal(keep(r, clone).code, extra.pid === 80 ? 'processes_unread' : 'process_busy');
    assert(!removal(r, tmp));
    if (extra.pid === 80) assert(keep(r, free));
  }
  const held = cleanup.cleanup({ root: real }, cleanDeps({ processes: () => [...rows, { pid: 82, sessionId: 0, cmd: null, exe: path.join(free, 'servers/team/index.js') }] }));
  assert.match(keep(held, free).reason, /занят процессом PID 82/);
  assert(keep(cleanup.cleanup({ root: real }, cleanDeps({ processes: () => rows.filter(r => r.pid !== process.pid) })), clone), 'неизвестный свой сеанс блокирует');
  // Новый процесс во втором снимке защищает и релиз, и клон.
  calls = 0;
  await patched(fs, 'rmSync', p => { assert(p !== clone && p !== free); }, () => {
    const r = cleanup.cleanup({ root: real, apply: true }, cleanDeps({ logFile: at('test-recheck-log.jsonl'), processes: () => {
      calls++; return calls === 1 ? rows : [...rows, { pid: 83, sessionId: 2, cmd: null, exe: outside }];
    } }));
    assert.equal(calls, 2); assert(r.failed.some(x => x.path === clone)); assert(r.failed.some(x => x.path === free));
  });
  assert(cleanup.refersTo(alias('.work/merged/not-created/script.js'), clone));
  assert(!cleanup.refersTo(alias('missing/script.js'), clone));
});

test('Grok 8959ded1: скрытые сведения в своём сеансе не останавливают уборку', () => {
  const clone = at('.work/merged'), free = at('live/' + hashes[2]), outside = at('outside/node.exe');
  const hiddenNames = [
    [1604, 'csrss.exe'], [1768, 'winlogon.exe'], [1840, 'dwm.exe'], [1956, 'fontdrvhost.exe'],
    [3864, 'NVDisplay.Container.exe'], [9020, 'ArmouryCrate.UserSessionHelper.exe'], [9052, 'conhost.exe'],
    [10440, 'nvcontainer.exe'], [12364, 'nvsphelper64.exe'], [14072, 'logioptionsplus_appbroker.exe'],
    [19680, 'GameInputSvc.exe'], [19848, 'ctfmon.exe'], [22804, 'taskhostw.exe'],
  ];
  const rows = [
    ...Array.from({ length: 132 }, (_, i) => ({ pid: i === 0 ? 0 : i === 1 ? 4 : 300000 + i, sessionId: 0, cmd: null, exe: null })),
    ...hiddenNames.map(([pid, name]) => ({ pid, name, sessionId: 1, cmd: null, exe: null })),
    { pid: process.pid, sessionId: 1, cmd: 'node.exe', exe: outside },
    ...Array.from({ length: 223 }, (_, i) => ({ pid: 400000 + i, sessionId: 1, cmd: 'node.exe', exe: outside })),
  ];
  assert.equal(rows.filter(r => r.sessionId === 1).length, 237);
  assert.equal(rows.filter(r => r.sessionId === 0).length, 132);
  const result = extra => cleanup.cleanup({ root: real }, cleanDeps({ processes: () => [...rows, ...extra] }));
  const r = result([]);
  assert(removal(r, clone)); assert(removal(r, free)); assert.equal(r.plan.uncheckedHiddenProcesses, 145);
  assert.equal(cleanup.cleanupText(r).split('не проверено процессов со скрытыми сведениями: 145').length, 2);
  const knownInside = result([{ pid: 500001, sessionId: 1, cmd: null, exe: path.join(clone, 'tests/.tmp-old/script.ps1') }]);
  assert.equal(keep(knownInside, clone).code, 'process_busy');
  for (const sessionId of [1, undefined]) {
    const knownOutside = result([{ pid: 500002, sessionId, cmd: null, exe: outside }]);
    assert.equal(keep(knownOutside, clone).code, 'processes_unread'); assert(keep(knownOutside, free));
  }
  const hiddenUnknown = result([{ pid: 500003, cmd: null, exe: null }]);
  assert(removal(hiddenUnknown, clone)); assert(removal(hiddenUnknown, free)); assert.equal(hiddenUnknown.plan.uncheckedHiddenProcesses, 146);
  const otherKnown = result([{ pid: 500004, sessionId: 0, cmd: null, exe: outside }]);
  assert(removal(otherKnown, clone)); assert(removal(otherKnown, free)); assert.equal(otherKnown.plan.uncheckedHiddenProcesses, 146);
});

test('Ревью-5: исчезнувшие релиз и карточка в recheck дают raceReason', async () => {
  const free = at('live/' + hashes[2]), native = fs.realpathSync.native;
  await patched(fs.realpathSync, 'native', p => {
    if (String(p) === free) throw Object.assign(Error('raw ENOENT release'), { code: 'ENOENT' });
    return native(p);
  }, () => {
    const r = cleanup.cleanup({ root: real }, cleanDeps());
    assert.match(keep(r, free).reason, /изменилось во время проверки/);
    assert(!keep(r, free).reason.includes('raw ENOENT'));
  });
  const r = cleanup.cleanup({ root: real }, cleanDeps()), clone = removal(r, at('.work/merged')); assert(clone);
  const readFile = fs.readFileSync;
  await patched(fs, 'readFileSync', (p, ...args) => {
    if (String(p) === at('state/team/changes/merged.json')) throw Object.assign(Error('raw ENOENT card'), { code: 'ENOENT' });
    return readFile(p, ...args);
  }, () => { assert.match(clone.recheck(), /изменилось во время проверки/); assert(!clone.recheck().includes('raw ENOENT')); });
});

test('Ревью-6: снимок lockNames ленивый, один на процесс; явные sources у тестов', () => {
  let reads = 0;
  const isolated = oldModule('path-compat', { './deploy': { configPaths: () => { reads++; return []; } },
    './client-configs': { paths: () => { reads++; return []; } } }, true);
  assert.equal(reads, 0);
  isolated.createLockNames({ root: real, previousRoot: link, sources: { roots: [], states: [] } })('job', 'explicit', at('state'));
  assert.equal(reads, 0);
  isolated.lockNames('job', 'one', at('state')); assert.equal(reads, 2);
  isolated.lockNames('job', 'two', at('state')); assert.equal(reads, 2);
});

test('О6: PowerShell получает физический релиз, JS узнаёт ready через junction', async () => {
  const restart = require('../common/restart');
  const out = await restart.restart({ root: link, release: alias('live/' + hashes[3]), waitCompletion: true }, { launch: async (file, info) => {
    assert(fs.readFileSync(file, 'utf8').includes("$release = '" + at('live/' + hashes[3]) + "'"));
    write(info.log, 'итог ' + info.runId + ' True\n');
    json(info.result, { runId: info.runId, release: alias('live/' + hashes[3]), success: true, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:02Z' });
    for (const name of ['team', 'codex', 'antigravity', 'grok']) json(at('state/ready/' + name + '.json'), { release: alias('live/' + hashes[3]), startedAt: '2026-01-01T00:00:01Z', pid: process.pid });
  }, alive: () => true });
  assert.equal(out.ready.length, 3);
});
test('О7–О9: равенство/сводка, реальные отличия, ошибки раскрытия', async () => {
  const drift = require('../common/release-drift');
  json(at('live/deployed.json'), { commit: hashes[3], release: alias('live/' + hashes[3]) });
  await patched(cp, 'spawnSync', (_file, args) => ({ status: 0, stdout: args.includes('status') ? '' : hashes[3] }), () => {
    assert(!drift.lines(link, alias('state')).some(x => /Серверы запущены/.test(x)));
    json(at('state/ready/team.json'), { release: at('live/' + hashes[2]) });
    assert(drift.lines(real, at('state')).some(x => /Серверы запущены/.test(x)));
  });
  assert(!paths.samePath(real, RUN)); assert.equal(compat.strictSamePath(real, RUN), 'different');
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ELOOP']) {
    const err = () => { throw Object.assign(Error(code), { code }); };
    await patched(fs.realpathSync, 'native', err, () => {
      assert(paths.samePath(real, real));
      assert.equal(compat.strictSamePath(real, real), 'unknown');
      const names = compat.createLockNames({ root: real, previousRoot: link, sources: { roots: [], states: [] } });
      if (code !== 'ENOENT') assert(names('migration', at('state'), at('state')).some(n => n.name === locks.pipeName('migration', alias('state'), alias('state'))));
      assert(keep(cleanup.cleanup({ root: real }, cleanDeps()), at('live/' + hashes[1])));
    });
  }
  for (const previousRoot of [at('missing-old'), RUN]) {
    const names = compat.createLockNames({ root: real, previousRoot, sources: { roots: [], states: [] } });
    assert(!names('job', 'x', at('state')).some(n => n.name === locks.pipeName('job', 'x', path.join(previousRoot, 'state'))));
  }
  const native = fs.realpathSync.native;
  await patched(fs.realpathSync, 'native', p => {
    if (p === alias('live')) throw Object.assign(Error('no access'), { code: 'EACCES' });
    return native(p);
  }, () => {
    const r = cleanup.cleanup({ root: real }, cleanDeps({ selfRelease: alias('live/' + hashes[1]) }));
    assert(keep(r, at('live/' + hashes[1]))); assert(r.plan.blocked.some(x => /собственный релиз/.test(x)));
  });
});
test('О10: другой регистр/ссылка сохраняют .prev; read_file и гости', async () => {
  const clients = require('../common/client-configs'), rel = at('live/' + hashes[3]), cfg = at('case.json');
  const before = deploy.configFor({}, alias('live/' + hashes[3]).toUpperCase(), link, alias('state'));
  json(cfg, before); write(cfg + '.prev', 'rollback-point');
  await deploy.configure({ release: rel, configs: [cfg] });
  assert.equal(fs.readFileSync(cfg + '.prev', 'utf8'), 'rollback-point');
  assert.equal(clients.plans([{ file: cfg, kind: 'agy', config: before }], rel, real, at('state'), process.execPath)[0].backup, false);
  const toml = clients.toml('', alias('live/' + hashes[3]), link, alias('state'), process.execPath);
  assert.equal(clients.plans([{ file: at('case.toml'), kind: 'codex', text: toml }], rel, real, at('state'), process.execPath)[0].backup, false);
  assert.deepEqual(clients.relinkAgents(['read_file(' + alias('live/' + hashes[1] + '/AGENTS.md') + ')'], real, rel), ['read_file(' + path.join(rel, 'AGENTS.md') + ')']);
  assert.match(clients.staleGuests({ root: real, release: hashes[3] }, { processes: () => [{ pid: 1, name: 'Codex.exe' }, { pid: 2, ppid: 1, commandLine: 'node "' + alias('live/' + hashes[1] + '/servers/team/index.js') + '"' }] }), /Codex/);
});
test('О12а,б,г,д,е,и: старые/новые процессы, оба направления, весь набор или ничего', async () => {
  for (const kind of ['team_words', 'migration', 'job']) {
    const key = kind === 'job' ? 'job-id' : at('state/not-created.json'), oldKey = kind === 'job' ? key : alias('state/not-created.json');
    const old = await worker('old', kind, oldKey, alias('state')); assert(old.ok);
    assert.equal((await locks.tryLock(kind, key, {}, at('state'))).ok, false); await old.stop();
    const fresh = await locks.tryLock(kind, key, {}, at('state')); assert(fresh.ok);
    const blocked = await worker('old', kind, oldKey, alias('state')); assert(!blocked.ok); await blocked.stop(); await fresh.release();
  }
  const pair = await Promise.all([worker('new', 'job', 'race', alias('state')), worker('new', 'job', 'race', at('state'))]);
  assert.equal(pair.filter(x => x.ok).length, 1); await Promise.all(pair.map(x => x.stop()));
  const names = locks.lockNames('job', 'partial', at('state')), last = await locks.listenPipe(names.at(-1).name, () => ({})); assert(last.ok);
  assert.equal((await locks.tryLock('job', 'partial', {}, at('state'))).ok, false);
  for (const entry of names.slice(0, -1)) assert.equal((await locks.probe(entry.name)).state, 'none');
  await new Promise(r => last.srv.close(r));
  const saved = process.env.MOST_TEST_KEEP; delete process.env.MOST_TEST_KEEP;
  try {
    const lease = await locks.tryLock('job', 'info', {}, at('state')); assert(lease.ok);
    const info = locks.lockNames('job', 'info', at('state')); info.forEach(n => assert(fs.existsSync(n.infoPath)));
    await lease.release(); info.forEach(n => assert(!fs.existsSync(n.infoPath)));
  } finally { if (saved !== undefined) process.env.MOST_TEST_KEEP = saved; }
  assert.equal(locks.lockNames('team_repo', paths.canon(real), at('state')).length, 1);
});
test('О12в: ownerState в обе стороны, смешанные ответы, зависший канал', async () => {
  const owner = await locks.startOwner({}, at('state')); assert(owner.ok);
  assert.equal((await locks.probe(locks.pipeName('instance', locks.INSTANCE, alias('state')))).info.instance, locks.INSTANCE);
  await owner.release();
  const old = await worker('old', 'instance', 'old-owner', alias('state')); assert(old.ok);
  assert.equal(await locks.ownerState(old, at('state')), 'alive'); await old.stop();
  const entries = locks.lockNames('instance', 'mixed', at('state'));
  const wrong = await locks.listenPipe(entries[0].name, () => ({ instance: 'mixed', pid: 11, startedAt: 'bad' }));
  const good = await locks.listenPipe(entries[1].name, () => ({ instance: 'mixed', pid: 12, startedAt: 'yes' }));
  assert.equal(await locks.ownerState({ instance: 'mixed', pid: 12, startedAt: 'yes' }, at('state')), 'alive');
  await new Promise(r => good.srv.close(r));
  const unknown = await locks.listenPipe(entries[1].name, () => ({ instance: 'mixed', pid: 12 }));
  assert.equal(await locks.ownerState({ instance: 'mixed', pid: 12, startedAt: 'yes' }, at('state')), 'unknown');
  await new Promise(r => unknown.srv.close(r)); await new Promise(r => wrong.srv.close(r));
  const net = require('net'), sockets = [], hung = net.createServer(s => sockets.push(s));
  await new Promise(r => hung.listen(entries[0].name, r));
  assert.equal(await locks.ownerState({ instance: 'mixed', pid: 12 }, at('state')), 'unknown');
  sockets.forEach(s => s.destroy()); await new Promise(r => hung.close(r));
});
test('О12ж,з,к,л: снимок Claude/.prev, три написания, отсутствие/чужой прежний корень', () => {
  const upper = alias('state').toUpperCase();
  const build = compat.createLockNames({ root: real, previousRoot: link, sources: { roots: [link.toUpperCase()], states: [upper] } });
  assert(build('job', 'x', at('state')).some(n => n.name === locks.pipeName('job', 'x', upper)));
  assert(compat.spellings(link).includes(fs.realpathSync(link))); assert(compat.spellings(link).includes(fs.realpathSync.native(link)));
  const cfg = at('prev-only.json'); json(cfg + '.prev', { mcpServers: { team: { env: { MOST_REPO_ROOT: link.toUpperCase(), MOST_STATE_DIR: upper } } } });
  const source = "const p=require('./common/path-compat');console.log(JSON.stringify(p.lockNames('job','prev',process.env.MOST_STATE_DIR).map(x=>x.name)))";
  const result = JSON.parse(cp.execFileSync(process.execPath, ['-e', source], { cwd: ROOT, env: { ...process.env, MOST_CLAUDE_CONFIGS: JSON.stringify([cfg]) }, encoding: 'utf8' }));
  assert(result.includes(locks.pipeName('job', 'prev', upper)));
  const unrelated = compat.createLockNames({ root: real, previousRoot: at('absent-old'), sources: { roots: [RUN], states: [at('state')] } });
  assert(!unrelated('job', 'new-state', at('not-created-state')).some(n => n.state === at('state')), 'несуществующее хранилище не связывается с чужим подключением');
});
test('О12л, О8: JS/native написания и временная ошибка после снимка; освобождение сохранённого набора', async () => {
  const saved = fs.realpathSync;
  const js = p => saved(p).toUpperCase(); js.native = saved.native;
  await patched(fs, 'realpathSync', js, async () => {
    const build = compat.createLockNames({ root: real, previousRoot: link, sources: { roots: [], states: [] } });
    const names = build('migration', at('state/absent'), at('state'));
    assert(names.some(n => n.name === locks.pipeName('migration', path.join(at('state').toUpperCase(), 'absent'), at('state').toUpperCase())));
    assert(names.some(n => n.name === locks.pipeName('migration', alias('state/absent'), alias('state'))));
  });
  const build = compat.createLockNames({ root: real, previousRoot: link, sources: { roots: [], states: [] } });
  const failing = () => { throw Object.assign(Error('access denied'), { code: 'EACCES' }); }; failing.native = failing;
  await patched(fs, 'realpathSync', failing, () => {
    assert(build('migration', at('state/uncreated'), at('state')).some(n => n.name === locks.pipeName('migration', alias('state/uncreated'), alias('state'))));
  });
  const lease = await locks.tryLock('job', 'saved-set', {}, at('state')); assert(lease.ok);
  await patched(fs, 'realpathSync', failing, () => lease.release());
  for (const name of lease.names) assert.equal((await locks.probe(name)).state, 'none');
});
test('О13: весь Team.cleanup сухой — ноль попыток записи; гонки не падают', async () => {
  const { Team } = require('../common/team'), team = new Team(link);
  const { pendingDeploy, ...deps } = cleanDeps(); team.cleanupDeps = deps;
  write(at('.work/merged/.git/index'), 'unchanged index');
  const snapshot = () => {
    const rows = [];
    const walk = dir => { for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name); if (ent.isDirectory()) walk(p); else rows.push([p, fs.readFileSync(p).toString('base64')]);
    } };
    walk(at('state')); rows.push([at('.work/merged/.git/index'), fs.readFileSync(at('.work/merged/.git/index')).toString('base64')]); return rows;
  };
  const before = snapshot();
  const methods = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'copyFileSync', 'cpSync', 'truncateSync', 'openSync',
    'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'cp', 'truncate', 'createWriteStream', 'write', 'writeSync', 'link', 'linkSync', 'symlink', 'symlinkSync', 'mkdtemp', 'mkdtempSync', 'utimes', 'utimesSync', 'chmod', 'chmodSync'];
  const originals = Object.fromEntries(methods.map(k => [k, fs[k]])), attempts = [];
  const originalList = ops.list, reconciles = [];
  const promiseKeys = ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'cp', 'truncate', 'link', 'symlink', 'mkdtemp', 'utimes', 'chmod', 'open'];
  const promiseOriginals = Object.fromEntries(promiseKeys.map(k => [k, fs.promises[k]]));
  try {
    ops.list = (root, options) => { reconciles.push(options?.reconcile); return originalList(root, options); };
    for (const key of methods) fs[key] = (...args) => {
      if (key === 'openSync' && (args[1] === 'r' || args[1] === 'rs' || args[1] === 0)) return originals[key](...args);
      attempts.push(key + ':' + args[0]); throw Error('Запись при сухой уборке');
    };
    for (const key of promiseKeys) fs.promises[key] = (...args) => {
      if (key === 'open' && ['r', 'rs', 0].includes(args[1])) return promiseOriginals[key](...args);
      attempts.push('promises.' + key); throw Error('Запись при сухой уборке');
    };
    await team.change({ action: 'cleanup', owner: 'test' });
    assert.deepEqual(attempts, []);
    assert(reconciles.length >= 2); assert(reconciles.every(value => value === false));
  } finally { Object.assign(fs, originals); Object.assign(fs.promises, promiseOriginals); ops.list = originalList; }
  assert.deepEqual(snapshot(), before);
  const old = new Date(0);
  for (const p of [at('live/.archive-race.tar'), at('temp/most-part2-race/a')]) write(p);
  fs.utimesSync(at('live/.archive-race.tar'), old, old); fs.utimesSync(at('temp/most-part2-race'), old, old);
  const cases = [['readdirSync', at('live')], ['readdirSync', at('.work')], ['readdirSync', at('.work/merged/tests')], ['readdirSync', at('temp')],
    ['lstatSync', at('live/.archive-race.tar')], ['lstatSync', at('.work/merged')], ['lstatSync', at('.work/merged/tests/.tmp-old')], ['lstatSync', at('temp/most-part2-race')],
    ['readFileSync', at('state/team/changes/merged.json')]];
  for (const [method, target] of cases) {
    const original = fs[method]; let hit = false;
    await patched(fs, method, (p, ...args) => { if (!hit && String(p) === target) { hit = true; throw Object.assign(Error('gone'), { code: 'ENOENT' }); } return original(p, ...args); }, () => {
      const r = cleanup.cleanup({ root: real }, cleanDeps({ git: (_p, a) => a[0] === 'status' ? ' M x' : a[0] === 'rev-parse' ? hashes[0] : '' }));
      assert(hit, target); assert(r.plan.keep.some(x => /изменилось во время проверки/.test(x.reason)) || r.plan.blocked.some(x => /изменилось во время проверки/.test(x)), target);
    });
  }
});
test('О14, О15: миграция и хранилище через другое написание', async () => {
  const d = cleanup.defaults(link, false);
  assert(paths.samePath(d.changesDir, alias('state/team/changes'))); assert(paths.samePath(d.logFile, alias('state/team/cleanup-log.jsonl')));
  const source = fs.readFileSync(path.join(ROOT, 'common/state-migration.js'), 'utf8'); assert(source.includes("samePath(state, path.join(root, 'state'))"));
  const migration = require('../common/state-migration');
  let called = false;
  await patched(locks, 'tryLock', async kind => { assert.equal(kind, 'migration'); called = true; return { ok: false, error: 'test' }; }, async () => {
    await assert.rejects(migration.migrate({ root: real, state: alias('state'), env: { MOST_CLIENT: 'claude' } }), /блокировку/);
  }); assert(called);
});
test('О9, К6б: без переадресации корни различны; правила и вложенное владение через ссылку', async () => {
  const a = at('returned-to-old'), b = at('other-physical');
  for (const root of [a, b]) write(path.join(root, 'live', hashes[0], 'index.js'));
  assert(!paths.samePath(path.join(a, 'live', hashes[0]), path.join(b, 'live', hashes[0])));
  const names = compat.createLockNames({ root: b, previousRoot: a, sources: { roots: [], states: [] } });
  assert(!names('job', 'x', path.join(b, 'state')).some(n => n.name === locks.pipeName('job', 'x', path.join(a, 'state'))));
  assert.equal(require('../common/client-rules').target(alias('codex-rules.md')).role, 'codex');
  json(at('works/path-work.json'), { owner: 'tester' });
  const work = require('../common/work-owner'); let count = 0;
  await patched(deploy, 'locked', async (_root, fn) => { count++; return fn(); }, () =>
    work.withWork({ work: 'path-work', owner: 'tester' }, () => work.withWork({ work: 'path-work', owner: 'tester' }, () => 'ok', link), real));
  assert.equal(count, 1);
});
test('Р5, О11, контракт: правило, урок, файл в дереве кандидата общего прогона', () => {
  const rules = fs.readFileSync(path.join(ROOT, 'rules/claude.md'), 'utf8'), lessons = fs.readFileSync(path.join(ROOT, 'lessons.md'), 'utf8');
  assert(rules.includes('Любое перемещение, переименование или замена ссылкой папки, на которую указывают настройки подключений или пути связки (корень, state, live, .work, test-most и рабочие папки поручений), — только как изменение связки: до действия — проверка Codex по коду (сравнения путей в установке, перезапуске, уборке, сводке, замках, гостях) и репетиция на тестовой копии; после — сухие прогоны установки и уборки и сводка без «⚠»'));
  assert(rules.includes('common/path-compat.js нельзя удалять или переименовывать без смены признака нового кода'));
  assert(fs.statSync(path.join(ROOT, 'common/path-compat.js')).isFile());
  const agy = fs.readFileSync(path.join(ROOT, 'servers/antigravity/index.js'), 'utf8');
  assert(agy.includes('await startOwner(')); assert(!agy.includes('listenPipe(pipeName("instance"'));
  for (const id of ['eb3fb5da', '0b119a52', 'da263378', '472fb2c4', 'de0a9345', 'f13bcceb', 'mv6tg6nl_47b4ba', '93f89b44']) assert(lessons.includes(id));
  assert(lessons.includes('Где закрыто:')); assert(lessons.includes('Проверка:'));
  console.log('О11: перенос team-v20 на новую main и запрет установки/уборки до team-v21 — организационные, не моделируются кодом.');
});
(async () => {
  console.log('team-v21: ' + process.platform + ' ' + process.version + '; ' + RUN);
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log('OK ' + name); }
    catch (e) { failed++; console.error('ПРОВАЛ ' + name + '\n' + e.stack); if (!compat) break; }
  }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0'); process.exitCode = failed ? 1 : 0;
})();
}
