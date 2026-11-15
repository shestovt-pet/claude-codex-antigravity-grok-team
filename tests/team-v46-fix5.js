'use strict';
// Регрессии сводного брифа c5c0820a. Вызывается из team-v46.js.
module.exports = ({ test, f, client, text }) => {
  const assert = require('assert'), fs = require('fs'), path = require('path');
  const { serverReady } = require('./runner-support');
  const access = require('../common/access'), members = require('../common/members');
  const fallback = require('../common/fallback'), chain = require('../common/job-chain');
  const outside = fs.mkdtempSync(path.join(process.env.MOST_TEST_OUTSIDE || require('os').tmpdir(), 'fix5-'));
  let seq = 0;
  const save = (who, card) => f.json(path.join(f.stores.roots()[who], who === 'antigravity' ? card.id + '/card.json' : card.id + '.json'), card);
  function internals(who, names) {
    const Module = require('module'), file = path.resolve(__dirname, '../servers', who, 'index.js');
    const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    const source = fs.readFileSync(file, 'utf8'), end = source.lastIndexOf('\n(async () => {');
    assert(end > 0); m._compile(source.slice(0, end) + '\nmodule.exports = { ' + names + ' };', file);
    return m.exports;
  }
  function parent(who, extra = {}) {
    const card = { id: 'fix5-' + who + '-' + (++seq), status: 'running', write: true, role: 'совет',
      startedAt: new Date().toISOString(), deadline: new Date(Date.now() + 20 * 60000).toISOString(), childPid: 4100, ...extra };
    save(who, card); return card;
  }
  async function asJob(who, fn, extra) {
    const old = { ...process.env }, p = parent(who, extra);
    Object.assign(process.env, fallback.jobEnv(p.id));
    try { return await fn(p); } finally { save(who, { ...p, status: 'done' }); for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
  }
  test('fix5 #1: jobEnv Claude предоставляет инструменты гостя без прав дирижёра', async () => {
    await asJob('claude', async p => {
      assert.equal(access.client(), 'claude-print');
      assert.equal(access.guest(), true);
      assert.equal(access.allowed('team', 'team_ask'), true);
      assert.equal(access.allowed('team', 'team_change'), false);
      await client('team', 'job', p, async c => {
        const names = (await c.listTools()).tools.map(t => t.name);
        assert(names.includes('team_ask'), names.join(','));
        assert(!names.includes('team_change'));
      });
    });
  });
  test('fix5 #2: jobEnv каждого писателя разрешает подпоручение и сохраняет срок', async () => {
    for (const who of ['codex', 'deepseek', 'claude']) await asJob(who, async p => {
      assert.equal(members.memberForClient(access.client()).id, who);
      assert.equal(members.canWrite(access.client()), true);
      assert.equal(require('../common/chain-deadline').normalTimeoutMs(access.client()), require('../common/chain-deadline').normalTimeoutMs(who));
      const to = who === 'deepseek' ? 'claude' : 'deepseek';
      const a = { write: true, folder: outside, task: 'Проверка jobEnv', role: 'совет' };
      access.guard(to, to + '_send', a);
      assert.equal(chain.fields(a).parentJob, p.id);
      const dl = require('../common/chain-deadline').applyDeadline(chain.fields(a), access.client(), to);
      assert.equal(dl.error, null);
      assert(Date.parse(dl.deadline) <= Date.parse(p.deadline) - 3 * 60000);
      await client(to, 'job', p, async c => {
        const r = await c.callTool({ name: to + '_send', arguments: a });
        assert(!r.isError, text(r));
      });
    });
  });
  test('fix5 #3: инструменты Claude включены в --tools и разрешены без пустого флага', () => {
    const ca = require('../common/claude-args');
    const files = { mcpConfig: path.join(f.RUN, 'fix5-mcp.json'), settings: 'settings' };
    f.json(files.mcpConfig, { mcpServers: { team: {}, codex: {} } });
    for (const j of [{}, { write: true, folder: outside }, { write: true, folder: outside, fullAccessApplied: true }]) {
      const args = ca.buildArgs(files, {}, j), builtins = args[args.indexOf('--tools') + 1].split(',');
      assert.equal(builtins.includes('Edit'), !!j.write);
      assert.equal(builtins.includes('Bash'), !!j.fullAccessApplied);
      const i = args.indexOf('--allowedTools');
      assert(i < 0 || args[i + 1] && !args[i + 1].startsWith('--'));
      assert(args.includes('mcp__team__*'));
      assert(args.includes('mcp__codex__*'));
    }
  });
  test('fix5 #4: автор входящего из jobEnv подтверждается карточкой и предками', async () => {
    await asJob('codex', async p => {
      const auth = require('../common/inbox').author({ ancestors: [{ pid: 4100, startedAt: p.startedAt }] });
      assert.equal(auth.error, undefined);
      assert.equal(auth.kind, 'job'); assert.equal(auth.id, p.id);
      assert(require('../common/inbox').author({ ancestors: [{ pid: 9999, startedAt: p.startedAt }] }).error);
    });
  });
  test('fix5 #5: пишущее подпоручение jobEnv проходит send, очередь и исполнение Codex', async () => {
    await asJob('deepseek', async p => {
      process.env.CODEX_PATH = path.join(__dirname, 'fake-codex.js');
      const api = internals('codex', 'send, queue, load');
      const r = await api.send({ folder: outside, task: 'ЗАПИШИ ФАЙЛ fix5-child.txt', write: true, role: 'совет' });
      const id = text(r).match(/Номер поручения: (\S+)/)?.[1]; assert(id, text(r));
      assert.equal(api.load(id).parentJob, p.id);
      process.env.MOST_CLIENT = 'claude'; process.env.MOST_JOB_ID = '';
      await api.queue();
      const end = Date.now() + 8000;
      while (api.load(id).status === 'running' && Date.now() < end) await new Promise(r => setTimeout(r, 40));
      assert.equal(api.load(id).status, 'done', JSON.stringify(api.load(id)));
      assert(fs.readFileSync(path.join(outside, 'fix5-child.txt'), 'utf8').includes('Codex написал'));
    });
  });
  test('fix5 #6: старый установщик вызывает configure нового релиза с миграцией до пробы', async () => {
    const root = path.join(f.RUN, 'config-only-root'), state = path.join(root, 'state');
    const store = require('../common/members-store').create(state); const before = store.read();
    const id = '6'.repeat(40), release = path.join(root, 'live', id), file = path.join(root, 'config.json');
    const oldServers = members.serversForInstall(before);
    for (const n of [...oldServers, 'claude']) f.write(path.join(release, 'servers', n, 'index.js'), '');
    f.write(path.join(release, 'common/access.js'), 'exports.guestTools = () => [];');
    f.write(path.join(release, 'common/members-v46.js'), '');
    f.json(path.join(release, 'probe-ok.json'), { root, commit: id, at: new Date().toISOString(), servers: oldServers });
    f.json(file, { mcpServers: {} });
    let probed = false;
    await require('../common/deploy').configure({ root, release, configs: [file] }, {
      probe: async () => { probed = true; assert.equal(store.read().members.find(m => m.id === 'claude').roles.receives, true); }
    });
    assert(probed, 'новый состав должен пройти пробу');
    assert.equal(store.read().members.find(m => m.id === 'claude').roles.receives, true);
    assert(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.claude);
  });
  test('team-v48e Г4a: forbiddenRoots по-прежнему считает каталог клонов, но refusal папочный запрет не применяет (тумблер MOST_PROTECT_BRIDGE удалён)', () => {
    const wf = require('../common/write-folder');
    // Хелпер forbiddenRoots сохранён (расчёт каталога клонов), но refusal папочную защиту больше не применяет.
    assert(wf.forbiddenRoots('E:/most').some(p => path.resolve(p).toLowerCase() === path.resolve('E:/test-most').toLowerCase()));
    const custom = path.join(outside, 'custom-clones'); fs.mkdirSync(custom);
    // Папочный запрет снят безусловно — существующая абсолютная папка-клон допускается (refusal null) даже при выставленной прежней переменной.
    process.env.MOST_PROTECT_BRIDGE = '1';
    try { assert.equal(wf.refusal(custom, { fullAccess: true }), null, 'MOST_PROTECT_BRIDGE не возвращает папочный запрет'); }
    finally { delete process.env.MOST_PROTECT_BRIDGE; }
  });
  test('team-v48e Г4a: папочный запрет .work/переадресации снят (refusal держит только абсолютную существующую папку)', () => {
    const wf = require('../common/write-folder'), root = path.join(f.RUN, 'junction-root');
    const real = path.join(root, '.work', 'actual'), alias = path.join(root, '.work', 'alias');
    fs.mkdirSync(real, { recursive: true }); fs.symlinkSync(real, alias, 'junction');
    const stateDir = path.join(root, 'state');
    for (const name of ['actual', 'alias']) f.json(path.join(stateDir, 'changes', name + '.json'), { name, owner: 'owner', status: 'открыто' });
    const opts = { root, stateDir, client: 'claude', guest: false, owner: 'owner' };
    // Папочный запрет снят безусловно: и реальная, и алиас-копия, и выход-симлинк допускаются (refusal null для существующих абсолютных папок).
    assert.equal(wf.refusal(real, opts), null);
    assert.equal(wf.refusal(alias, opts), null);
    const escape = path.join(real, 'live-link'); fs.mkdirSync(path.join(root, 'live')); fs.symlinkSync(path.join(root, 'live'), escape, 'junction');
    assert.equal(wf.refusal(escape, opts), null);
    // Подлинность пути сохранена: несуществующая папка — отказ.
    assert(wf.refusal(path.join(root, 'no-such-folder'), opts));
  });
  test('fix5 #9: Antigravity-перенос проверяет папку и общий замок писателя', async () => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    // team-v48e Г4a: папочный запрет переноса снят безусловно — перенос в f.project проходит; замок писателя (lockedFolder) — всегда держит.
    const env = { ...process.env, MOST_CLIENT: 'claude', MOST_JOB_ID: '', MOST_PROBE_ONLY: '1', AGY_PATH: path.join(__dirname, 'fake-agy.js'),
      MOST_AGY_INPUT_FORMAT: 'legacy', MOST_JOURNAL: path.join(f.RUN, 'fix5-agy.log'), MOST_INPUT_DIR: path.join(f.RUN, 'input') };
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../servers/antigravity/index.js')], env, stderr: 'pipe' });
    const c = new Client({ name: 'fix5', version: '1' });
    const lockedFolder = path.join(outside, 'apply'); fs.mkdirSync(lockedFolder);
    const lock = await require('../common/write-lock').acquire(lockedFolder, { jobId: 'other-writer' });
    try {
      await c.connect(transport);
      await serverReady(path.join(f.root, 'state'), transport.pid);
      // f.project: папочный запрет снят → перенос проходит, файл записан.
      {
        const id = 'fix5-apply-ok', folder = f.project;
        save('antigravity', { id, status: 'done', papka: folder, rezhim: 'tekst', from: 'claude', startedAt: new Date().toISOString() });
        const body = 'Готовый текст';
        f.write(path.join(f.stores.roots().antigravity, id, 'result.txt'), body);
        f.json(path.join(f.stores.roots().antigravity, id, 'meta.json'), { hash: f.sha(body) });
        const target = path.join(folder, id + '.txt');
        const r = await c.callTool({ name: 'antigravity_apply', arguments: { id, to: target } });
        assert(!r.isError, text(r)); assert(fs.existsSync(target), 'перенос в f.project выполнен (папочный запрет снят)');
      }
      // lockedFolder: общий замок писателя (другой владелец) держит перенос — защита класса «в», сохранена.
      {
        const id = 'fix5-apply-locked', folder = lockedFolder;
        save('antigravity', { id, status: 'done', papka: folder, rezhim: 'tekst', from: 'claude', startedAt: new Date().toISOString() });
        const body = 'Готовый текст';
        f.write(path.join(f.stores.roots().antigravity, id, 'result.txt'), body);
        f.json(path.join(f.stores.roots().antigravity, id, 'meta.json'), { hash: f.sha(body) });
        const target = path.join(folder, id + '.txt');
        const r = await c.callTool({ name: 'antigravity_apply', arguments: { id, to: target } });
        assert(r.isError, text(r)); assert(!fs.existsSync(target));
        assert.match(text(r), /поручение с записью/);
      }
    } finally { await c.close(); await lock.release(); }
  });
  test('fix5 #10: смерть сервера и неподтверждённая остановка не освобождают писателя', async () => {
    const wl = require('../common/write-lock'), dir = path.join(outside, 'dead-owner'); fs.mkdirSync(dir);
    const lock = await wl.acquire(dir, { jobId: 'fix5-unconfirmed' }); assert(lock.ok);
    const file = wl.entryFile(require('../common/paths').canon(dir));
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    f.json(file, { ...entry, pid: 2147483647, childPid: process.pid });
    const second = await wl.acquire(dir, { jobId: 'new-owner' });
    assert.equal(second.ok, false, 'живое дерево исполнителя сохраняет замок');
    f.json(file, entry);
    save('claude', { id: 'fix5-unconfirmed', status: 'needs_decision', treeWarning: 'остановка не подтверждена', stopUnconfirmed: { pid: process.pid } });
    await lock.release();
    assert(fs.existsSync(file), 'release в finally не должен снимать неопределённый замок');
    assert.equal((await wl.acquire(dir)).needsDecision, true);
  });
  test('fix5 #11: своего срока исполнителя нет даже при заданных прежних переменных; корневые карточки и запрос — без срока', async () => {
    const dl = require('../common/chain-deadline');
    // team-v48e «нет срока» (§2.6/§3): сроковые тумблеры MOST_*_TIMEOUT_MS/MOST_PRINT_TIMEOUT/MOST_WATCHDOG_MS удалены —
    // normalTimeoutMs всегда null даже при выставленных прежних переменных; корневая карточка (без родителя) создаётся без срока.
    const savedEnv = ['MOST_CODEX_TIMEOUT_MS', 'MOST_DEEPSEEK_TIMEOUT_MS', 'MOST_CLAUDE_TIMEOUT_MS', 'MOST_PRINT_TIMEOUT', 'MOST_WATCHDOG_MS'].map(k => [k, process.env[k]]);
    Object.assign(process.env, { MOST_CODEX_TIMEOUT_MS: '3600000', MOST_DEEPSEEK_TIMEOUT_MS: '3600000', MOST_CLAUDE_TIMEOUT_MS: '3600000', MOST_PRINT_TIMEOUT: '15m', MOST_WATCHDOG_MS: String(16 * 60 * 1000) });
    try {
      assert.equal(dl.normalTimeoutMs('claude'), null);
      for (const who of ['codex', 'deepseek', 'claude', 'antigravity']) {
        const now = Date.now(), root = dl.applyDeadline({}, 'claude', who, now);
        assert.equal(root.deadline, null); assert.equal(root.error, null);
        await client(who, 'codex', null, async c => {
          const task = 'Срок корневого ' + who;
          const r = await c.callTool({ name: who + '_send', arguments: { folder: outside, task, role: 'совет',
            ...(who === 'antigravity' ? { mode: 'review', text: 'Материал.' } : {}) } });
          assert(!r.isError, text(r));
          const card = f.stores.list(who, false).jobs.find(j => (j.task || j.poruchenie) === task);
          assert(card, JSON.stringify(card)); assert(!Number.isFinite(Date.parse(card.deadline)), 'корневая карточка без срока: ' + JSON.stringify(card));
        });
      }
      await asJob('codex', async p => {
        const root = { ...p, deadline: dl.applyDeadline({}, 'claude', 'codex').deadline }; save('codex', root);
        const auth = require('../common/inbox').author({ ancestors: [{ pid: 4100, startedAt: p.startedAt }] });
        assert.equal(require('../common/inbox').askDeadline({}, auth), null);
      });
      assert(dl.parentTerminal({ parentJob: 'gone-parent' }, [{ id: 'gone-parent', status: 'running', childPid: 2147483647 }]));
    } finally {
      for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
  test('fix5 #11: Codex завершает процесс по абсолютному deadline, а не через час', async () => {
    const old = { ...process.env };
    Object.assign(process.env, { CODEX_PATH: path.join(__dirname, 'fake-codex.js'), MOST_CLIENT: 'claude', MOST_JOB_ID: '' });
    const api = internals('codex', 'execute, save, load, stop, active');
    const id = 'fix5-timed', card = { id, status: 'running', from: 'claude', folder: outside, write: false, task: 'HANG', role: 'совет',
      startedAt: new Date().toISOString(), deadline: new Date(Date.now() + 700).toISOString() };
    api.save(card);
    try {
      await api.execute(card, null);
      const end = Date.now() + 5000;
      while (api.active.has(id) && Date.now() < end) await new Promise(r => setTimeout(r, 40));
      assert.equal(api.active.has(id), false, 'исполнитель не остановлен по deadline');
      assert.equal(api.load(id).stopReason, 'timeout');
    } finally {
      if (api.active.has(id)) { await api.stop(id, 'cancel'); await new Promise(r => setTimeout(r, 300)); }
      Object.assign(process.env, old);
    }
  });
  test('fix5 #11: Antigravity останавливается по deadline и завершению родителя', async () => {
    const old = { ...process.env };
    Object.assign(process.env, { AGY_PATH: path.join(__dirname, 'fake-agy.js'), MOST_AGY_INPUT_FORMAT: 'legacy', MOST_CLIENT: 'claude', MOST_JOB_ID: '', MOST_JOURNAL: path.join(f.RUN, 'fix5-agy-runtime.log') });
    const api = internals('antigravity', 'runAgy, requestStop');
    try {
      for (const reason of ['deadline', 'parent']) {
        const p = parent('codex'), id = 'fix5-agy-' + reason;
        save('antigravity', { id, status: 'running', parentJob: p.id, deadline: new Date(Date.now() + (reason === 'deadline' ? 700 : 60000)).toISOString() });
        let kill;
        const work = api.runAgy(['--print', '[[FAKE:hang]]'], id, () => {
          if (reason === 'parent') setTimeout(() => save('codex', { ...p, status: 'done' }), 150);
        }, outside);
        const emergency = new Promise((_, reject) => { kill = setTimeout(async () => { await api.requestStop(id, 'отмена'); reject(Error('Antigravity не остановлен: ' + reason)); }, 7000); });
        try {
          const result = await Promise.race([work, emergency]);
          assert(reason === 'deadline' ? result.timedOut : result.cancelled, JSON.stringify(result));
        } finally { clearTimeout(kill); save('codex', { ...p, status: 'done' }); }
      }
    } finally { for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
  });
  test('fix5 #12: миграция и откат восстанавливают исходный limit_5h и весь снимок участников', () => {
    const state = path.join(f.RUN, 'migration-roundtrip'), store = require('../common/members-store').create(state);
    store.update(store.read().rev, n => { n.members.find(m => m.id === 'claude').adapter_params.limit_5h = 7; },
      { action: 'fixture', who: 'test', reason: 'исходный снимок' });
    const before = store.read();
    const migration = require('../common/members-v46');
    migration.apply(state, 'forward'); migration.apply(state, 'rollback');
    assert.deepEqual(store.read().members, before.members);
    assert.equal(store.read().phase, before.phase);
  });
  test('fix5 #12: отказ отката конфига оставляет реестр мигрированным', async () => {
    const root = path.join(f.RUN, 'rollback-failure'), state = path.join(root, 'state');
    const store = require('../common/members-store').create(state); store.read();
    require('../common/members-v46').apply(state, 'forward');
    const before = store.read(), file = path.join(root, 'config.json'); f.json(file, { mcpServers: {} });
    const result = await require('../common/deploy').rollback({ root, configs: [file], configOnly: true });
    assert.match(result, /отказ/); assert.deepEqual(store.read().members, before.members);
  });
  test('fix5 #12: откат на другой v46-релиз сохраняет receives Claude', async () => {
    const root = path.join(f.RUN, 'rollback-modern'), state = path.join(root, 'state'), release = path.join(root, 'live', 'a'.repeat(40));
    const store = require('../common/members-store').create(state); store.read(); require('../common/members-v46').apply(state, 'forward');
    for (const n of ['members-store', 'members-v46']) f.write(path.join(release, 'common', n + '.js'), '');
    const server = path.join(release, 'servers/team/index.js'); f.write(server, '');
    const file = path.join(root, 'config.json'); f.json(file, { mcpServers: {} });
    f.json(file + '.prev', { mcpServers: { team: { command: process.execPath, args: [server], env: { MOST_REPO_ROOT: root } } } });
    const result = await require('../common/deploy').rollback({ root, configs: [file], configOnly: true });
    assert(!result.includes('отказ'), result);
    assert.equal(store.read().members.find(m => m.id === 'claude').roles.receives, true);
  });
  test('fix5 #12: ошибка configure возвращает снимок с исходными receives и лимитом', async () => {
    const root = path.join(f.RUN, 'configure-fail-snapshot'), state = path.join(root, 'state');
    const store = require('../common/members-store').create(state);
    store.update(store.read().rev, n => { const c = n.members.find(m => m.id === 'claude'); c.roles.receives = true; c.adapter_params.limit_5h = 11; }, { action: 'fixture', who: 'test', reason: 'исходный снимок' });
    const before = store.read(), release = path.join(root, 'live', 'b'.repeat(40)), config = path.join(root, 'config.json');
    for (const n of members.serversForInstall(before)) f.write(path.join(release, 'servers', n, 'index.js'), '');
    f.write(path.join(release, 'common/members-v46.js'), '');
    f.write(path.join(release, 'common/access.js'), 'exports.guestTools = () => [];');
    f.json(config, { mcpServers: {} });
    f.json(path.join(release, 'probe-ok.json'), { root, commit: 'b'.repeat(40), at: new Date().toISOString(), servers: members.serversForInstall(before).filter(n => n !== 'claude') });
    await assert.rejects(require('../common/deploy').configure({ root, release, configs: [config] }, { probe: async () => { throw Error('fix5 probe failure'); } }), /fix5 probe failure/);
    assert.deepEqual(store.read().members, before.members);
    assert.equal(store.read().phase, before.phase);
  });
  test('fix5 #13: PATH и кэш одинаково проверяют раскладку Codex; внешние пути допустимы', () => {
    const cb = require('../common/codex-binary'), local = path.join(outside, 'local-appdata');
    const broken = path.join(local, 'OpenAI/Codex/bin/old/codex.exe'), good = path.join(local, 'OpenAI/Codex/bin/new/codex.exe');
    f.write(broken, 'x'); f.write(good, 'x'); f.write(path.join(path.dirname(good), 'codex-code-mode-host.exe'), 'x');
    const env = { ...process.env, LOCALAPPDATA: local, CODEX_PATH: '' };
    const previousPath = process.env.Path, previousPATH = process.env.PATH;
    env.Path = [path.dirname(broken), path.dirname(good), path.join(process.env.SystemRoot, 'System32')].join(path.delimiter); delete env.PATH;
    // where.exe действительно получает обе папки; первая неполная.
    const oldLocal = process.env.LOCALAPPDATA, oldCodex = process.env.CODEX_PATH;
    Object.assign(process.env, { LOCALAPPDATA: local, CODEX_PATH: '', Path: env.Path });
    try {
      assert.equal(cb.findCli(env), good);
      assert.equal(cb.findCli({ ...env, CODEX_PATH: broken }), null);
      const external = path.join(outside, 'standalone/codex.exe'); f.write(external, 'x');
      assert.equal(cb.findCli({ ...env, CODEX_PATH: external }), external);
      process.env.CODEX_PATH = external;
      const api = internals('codex', 'currentBinary'); assert.equal(api.currentBinary(), external);
    } finally {
      for (const [k, v] of Object.entries({ LOCALAPPDATA: oldLocal, CODEX_PATH: oldCodex, Path: previousPath, PATH: previousPATH })) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
  test('fix5 #14: номер только из своей строки; все права и отрицательные обязательны', () => {
    const Module = require('module'), file = path.resolve(__dirname, '../tools/matrix-probe.js');
    const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    const source = fs.readFileSync(file, 'utf8'), start = source.lastIndexOf('\n(async () => {');
    m._compile((start >= 0 ? source.slice(0, start) + '\nmodule.exports = {};' : source), file);
    const probe = m.exports;
    assert.equal(typeof probe.idOf, 'function');
    assert.equal(probe.idOf('Claude · поручение 12345678\nНомер поручения: 12345678-aaaa\n'), '12345678-aaaa');
    assert.equal(probe.idOf('DeepSeek 12345678'), null);
    const all = probe.requiredRows.map(name => [name, true, 'доказательство']);
    assert.equal(probe.ready(all), true);
    for (let i = 0; i < all.length; i++) {
      assert.equal(probe.ready(all.map((r, n) => n === i ? [r[0], false, 'провал'] : r)), false, all[i][0]);
      assert.equal(probe.ready(all.filter((_, n) => n !== i)), false, 'пропуск ' + all[i][0]);
    }
    assert.equal(probe.ready(all.slice(0, 15)), false);
  });
  test('fix5 #14: журнал пробы связывает настоящий MCP-вызов с jobEnv автора', async () => {
    await asJob('codex', async p => {
      process.env.MOST_MATRIX_PROBE = '1';
      await client('claude', 'job', p, async c => {
        const r = await c.callTool({ name: 'claude_status', arguments: {} }); assert(!r.isError, text(r));
      });
      const rows = fs.readFileSync(path.join(require('../common/paths').stateDir, 'server-log-claude.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
      assert(rows.some(r => r.parentJob === p.id && r.tool === 'claude_status' && !r.isError));
    });
  });
  test('fix5 #15: Claude явно отказывает continue_id, не создавая нового поручения', async () => {
    await client('claude', 'codex', null, async c => {
      const before = f.stores.list('claude', false).jobs.length;
      const r = await c.callTool({ name: 'claude_send', arguments: { folder: outside, task: 'Продолжи', continue_id: 'previous', role: 'совет' } });
      assert(r.isError, text(r)); assert.match(text(r), /продолжение|continue_id/i);
      assert.equal(f.stores.list('claude', false).jobs.length, before);
    });
  });
  test('fix5 #16: проверка отсутствующего источника ловит также выдуманную anthropic', async () => {
    const Module = require('module'), file = path.join(__dirname, 'team-v14-bridges.js'), oldEnv = { ...process.env };
    const quota = require('../common/quota-line'), old = quota.quotaLine;
    try {
      const source = fs.readFileSync(file, 'utf8'), end = source.lastIndexOf('\n(async () => {');
      const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
      m._compile(source.slice(0, end) + '\nmodule.exports = tests.find(t => t.name.startsWith("15:")).fn;', file);
      quota.quotaLine = async () => 'данные не предоставлены; семья anthropic';
      await assert.rejects(m.exports, /assert|false|truthy/i);
    } finally {
      quota.quotaLine = old;
      for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete process.env[k]; Object.assign(process.env, oldEnv);
    }
  });
};
