'use strict';
// Регрессии пунктов 1–8 брифа 9c4962a9. Настоящие обработчики; подменены только внешние процессы/часы.
module.exports = ({ test, f, client, text }) => {
  const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process');
  const Module = require('module'), { EventEmitter } = require('events'), { PassThrough } = require('stream');
  const wl = require('../common/write-lock'), paths = require('../common/paths');
  const outside = fs.mkdtempSync(path.join(process.env.MOST_TEST_OUTSIDE, 'fix6-'));
  const save = (who, j) => f.json(path.join(f.stores.roots()[who], who === 'antigravity' ? j.id + '/card.json' : j.id + '.json'), j);
  function internals(who, names) {
    const file = path.resolve(__dirname, '../servers', who, 'index.js'), m = new Module(file, module);
    m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    const src = fs.readFileSync(file, 'utf8'), end = src.lastIndexOf('\n(async () => {');
    assert(end > 0); m._compile(src.slice(0, end) + (who === 'antigravity' ? "\nrestartServer = restartHold.server(STATE_DIR, 'antigravity');" : '') + '\nmodule.exports = { ' + names + ' };', file);
    return m.exports;
  }
  async function env(fn) {
    const old = { ...process.env };
    Object.assign(process.env, { MOST_CLIENT: 'claude', MOST_JOB_ID: '', CLAUDE_PATH: process.execPath,
      AGY_PATH: path.join(__dirname, 'fake-agy.js'), MOST_AGY_INPUT_FORMAT: 'legacy', MOST_JOURNAL: path.join(f.RUN, 'fix6-agy.log') });
    try { return await fn(); } finally {
      for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k];
      Object.assign(process.env, old);
    }
  }
  async function fakeClaude(fn) {
    const spawn = cp.spawn, exec = cp.execFileSync;
    let spawned = 0;
    cp.execFileSync = (bin, args, ...rest) => args[0] === '--help'
      ? require('../common/claude-args').REQUIRED_FLAGS.join(' ') : exec(bin, args, ...rest);
    cp.spawn = () => {
      spawned++;
      const child = new EventEmitter(); child.pid = 2147483646;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.stdin.once('finish', () => setImmediate(() => {
        child.stdout.write(JSON.stringify({ type: 'result', result: 'ПРИНЯТО' }) + '\n'); child.emit('close', 0);
      }));
      return child;
    };
    try { return await env(() => fn(internals('claude', 'send, load, execute, save, active, server'), () => spawned)); }
    finally { cp.spawn = spawn; cp.execFileSync = exec; }
  }
  test('fix6 #1: claude_send → служебные файлы → claude_status и team_status', async () => {
    await fakeClaude(async api => {
      const r = await api.send({ folder: outside, task: 'Ответь ПРИНЯТО', role: 'совет', write: false });
      const id = text(r).match(/Номер поручения: (\S+)/)?.[1]; assert(id, text(r));
      const end = Date.now() + 3000;
      while (api.active.has(id) && Date.now() < end) await new Promise(r => setTimeout(r, 20));
      assert.equal(api.load(id).status, 'done');
      const status = await api.server._registeredTools.claude_status.handler({});
      assert(!status.isError, text(status));
      const jobs = f.stores.list('claude', false).jobs;
      assert(jobs.every(j => typeof j.id === 'string'), 'служебные JSON не должны становиться карточками');
      for (const suffix of ['mcp-config.json', 'settings.json'])
        assert(fs.existsSync(path.join(f.stores.roots().claude, id, suffix)), suffix);
    });
    await client('team', 'claude', null, async c => {
      const status = await c.callTool({ name: 'team_status', arguments: {} });
      assert(!status.isError, text(status));
    });
  });
  for (const payload of ['{broken', '{}']) test('fix6 #2: повреждённый замок родителя сохраняется и запрещает вложенную запись: ' + payload, async () => {
    const folder = path.join(outside, 'corrupt-' + (payload === '{}' ? 'shape' : 'json'));
    fs.mkdirSync(path.join(folder, 'child'), { recursive: true });
    const lock = wl.acquire(folder, { jobId: 'fix6-corrupt' }); assert(lock.ok);
    const file = wl.entryFile(paths.canon(folder)), original = fs.readFileSync(file);
    fs.writeFileSync(file, payload);
    try {
      const result = wl.acquire(path.join(folder, 'child'), { jobId: 'fix6-next' });
      assert.equal(result.ok, false); assert.equal(result.needsDecision, true);
      assert.equal(fs.readFileSync(file, 'utf8'), payload);
    } finally { fs.writeFileSync(file, original); lock.release(); }
  });
  test('fix6 #2: отметка needsDecision пишется под общим мьютексом', () => {
    const folder = path.join(outside, 'mutex'); fs.mkdirSync(folder);
    const id = 'fix6-mutex', lock = wl.acquire(folder, { jobId: id }); assert(lock.ok);
    save('claude', { id, status: 'needs_decision', stopUnconfirmed: { pid: 2147483647 } });
    const file = wl.entryFile(paths.canon(folder)), write = fs.writeFileSync;
    let checked = false, held = false;
    fs.writeFileSync = (p, ...args) => {
      if (p === file) { checked = true; held = fs.existsSync(path.join(wl.dir(), '.mutex')); }
      return write(p, ...args);
    };
    try { lock.release(); assert(checked); assert(held, 'нет общего мьютекса'); }
    finally { fs.writeFileSync = write; save('claude', { id, status: 'done' }); lock.release(); }
  });
  for (const who of ['codex', 'deepseek', 'claude']) for (const action of ['stop-confirm', 'job-close'])
    test('fix6 #3: ' + action + ' освобождает замок ' + who + ' и повторный вызов безопасен', async () => env(async () => {
      const id = 'fix6-' + action + '-' + who, folder = path.join(outside, id); fs.mkdirSync(folder);
      const card = { id, status: action === 'stop-confirm' ? 'stop_unconfirmed' : 'needs_decision', write: true,
        owner: { pid: 2147483647, instance: 'dead-fix6', startedAt: '2020-01-01T00:00:00Z' },
        stopUnconfirmed: { pid: 2147483647 }, treeWarning: 'не подтверждено', folder };
      save(who, card);
      const lock = wl.acquire(folder, { jobId: id }); assert(lock.ok); lock.release();
      assert.equal(wl.acquire(folder).ok, false);
      const cleanup = require('../common/cleanup'), scan = cleanup.windowsProcesses;
      cleanup.windowsProcesses = () => [];
      try {
        const run = require('../common/' + action).run;
        const result = await run({ job_ids: [id], quote: 'Исполнитель остановлен, закрыть.' });
        assert.match(result, /снято|закрыто/);
        const next = wl.acquire(folder, { jobId: id + '-next' }); assert(next.ok, 'подтверждённая карточка держит замок');
        await run({ job_ids: [id], quote: 'Исполнитель остановлен, закрыть.' });
        assert.equal(wl.acquire(folder).ok, false, 'повтор не должен снять замок нового поручения'); next.release();
        // Повтор после прерывания между сохранением карточки и снятием замка.
        const retry = wl.acquire(folder, { jobId: id }); assert(retry.ok);
        await run({ job_ids: [id], quote: 'Исполнитель остановлен, закрыть.' });
        const after = wl.acquire(folder, { jobId: id + '-after' }); assert(after.ok); after.release();
      } finally { cleanup.windowsProcesses = scan; }
    }));
  test('fix6 #4: сбой отметки после переключения сохраняет новый конфиг и receives=true', async () => {
    const root = path.join(f.RUN, 'fix6-deploy'), state = path.join(root, 'state');
    const store = require('../common/members-store').create(state), before = store.read();
    const id = '6'.repeat(40), release = path.join(root, 'live', id), config = path.join(root, 'config.json');
    for (const n of [...require('../common/members').serversForInstall(before), 'claude']) f.write(path.join(release, 'servers', n, 'index.js'), '');
    f.write(path.join(release, 'common/access.js'), 'exports.guestTools = () => [];');
    f.write(path.join(release, 'common/members-v46.js'), '');
    f.json(path.join(release, 'probe-ok.json'), { root, commit: id, at: new Date().toISOString(), servers: require('../common/members').serversForInstall(require('../common/members-v46').forward(before)) });
    f.json(config, { mcpServers: {} });
    fs.mkdirSync(path.join(root, 'live/deployed.json')); // реальная ошибка публикации отметки
    await assert.rejects(require('../common/deploy').configure({ root, release, configs: [config] }), /отметка развёртывания/);
    assert(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.claude);
    assert.equal(store.read().members.find(m => m.id === 'claude').roles.receives, true);
  });
  for (const reason of ['timeout', 'parent', 'cancel', 'expired']) test('fix6 #5: Antigravity runJob сохраняет исход ' + reason, async () => env(async () => {
    const api = internals('antigravity', 'runJob, loadJob, cancelPath');
    const id = 'fix6-agy-' + reason, parentId = id + '-parent';
    if (reason === 'parent') save('codex', { id: parentId, status: 'running', childPid: process.pid });
    const job = { id, status: 'running', papka: outside, from: 'codex', rezhim: 'zamechaniya', poruchenie: 'Тест',
      startedAt: new Date().toISOString(), deadline: new Date(Date.now() + (reason === 'expired' ? -1000 : reason === 'timeout' ? 500 : 60000)).toISOString(),
      ...(reason === 'parent' ? { parentJob: parentId } : {}) };
    save('antigravity', job);
    const trigger = setTimeout(() => {
      if (reason === 'parent') save('codex', { id: parentId, status: 'done' });
      if (reason === 'cancel') f.write(api.cancelPath(id), 'отмена');
    }, 150);
    try { await api.runJob(job, ['--print-timeout', '15m', '--print', '[[FAKE:hang]]'], null, outside, null); }
    finally { clearTimeout(trigger); }
    const result = api.loadJob(id);
    assert.equal(result.status, ['parent', 'cancel'].includes(reason) ? 'cancelled' : 'failed', JSON.stringify(result));
    assert.match(result.problems.join('\n'), reason === 'parent' ? /родитель завершился/i : reason === 'expired' ? /срок истёк до запуска/i : reason === 'timeout' ? /не уложилось|предел времени|срок истёк/i : /отменено/);
  }));
  test('fix6 #6: antigravity_apply учитывает owner вызова и запрещает ссылку в папке цели', async () => env(async () => {
    const root = path.join(f.root, '.work/fix6-apply'); fs.mkdirSync(path.join(root, 'real'), { recursive: true });
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), 'junction');
    f.json(path.join(f.root, 'state/changes/fix6-apply.json'), { owner: 'fix6-owner', status: 'открыто' });
    const api = internals('antigravity', 'server');
    async function apply(id, to, storedOwner, callOwner) {
      save('antigravity', { id, status: 'done', papka: root, rezhim: 'tekst', from: 'claude', ownerLabel: storedOwner });
      const body = 'Результат'; f.write(path.join(f.stores.roots().antigravity, id, 'result.txt'), body);
      f.json(path.join(f.stores.roots().antigravity, id, 'meta.json'), { hash: f.sha(body) });
      return api.server._registeredTools.antigravity_apply.handler({ id, to, owner: callOwner });
    }
    const bad = path.join(root, 'alias/result.txt');
    const refused = await apply('fix6-apply-alias', bad, 'fix6-owner');
    assert(refused.isError, text(refused)); assert(!fs.existsSync(bad));
    const good = path.join(root, 'real/result.txt');
    const applied = await apply('fix6-apply-owner', good, 'old-owner', 'fix6-owner');
    assert(!applied.isError, text(applied)); assert.equal(fs.readFileSync(good, 'utf8'), 'Результат');
  }));
  test('fix6 #7: срок Claude истёк во время подготовки — spawn не вызывается', async () => {
    await fakeClaude(async (api, spawned) => {
      const id = 'fix6-claude-expired', job = { id, status: 'running', from: 'claude', folder: outside, write: false,
        role: 'совет', task: 'Тест', deadline: new Date(Date.now() + 60000).toISOString() };
      api.save(job);
      const ca = require('../common/claude-args'), build = ca.buildArgs, now = Date.now;
      ca.buildArgs = (...args) => { const result = build(...args); Date.now = () => Date.parse(job.deadline) + 1; return result; };
      try { await api.execute(job, null); assert.equal(spawned(), 0, 'нельзя запускать просроченного исполнителя'); }
      finally { ca.buildArgs = build; Date.now = now; }
      assert.equal(api.load(id).status, 'cancelled'); assert.match(api.load(id).error, /срок|времени/i);
    });
  });
  test('fix6 #8: runAgy передаёт timeout в целых минутах с округлением вверх', async () => env(async () => {
    const original = cp.spawn, seen = [];
    cp.spawn = (bin, args, opts) => { seen.push(args); return original(bin, args, opts); };
    try {
      const api = internals('antigravity', 'runAgy');
      const id = 'fix6-timeout-format'; save('antigravity', { id, status: 'running', deadline: new Date(Date.now() + 61000).toISOString() });
      await api.runAgy(['--print-timeout', '15m', '--print', '[[FAKE:ok]]'], id, null, outside);
      assert.equal(seen.length, 1); assert.equal(seen[0][seen[0].indexOf('--print-timeout') + 1], '2m');
    } finally { cp.spawn = original; }
  }));
};
