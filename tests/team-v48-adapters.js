'use strict';
// team-v48 Г2b-1/Г2b-2: адаптерные интеграционные тесты «нет срока» через настоящий spawn
// fake-codex/fake-agy (Г2b-1) и fake-dsh/fake-claude (Г2b-2).
// Проверяется ровно поведение, заложенное в Г2a (три случая остатка + страховочный опрос):
//   null   — таймер-убийца не создаётся; процесс идёт до отмены/смерти родителя (остановка не по сроку);
//   >0     — таймер на остаток останавливает процесс;
//   <=0    — срок истёк между предпусковой проверкой и установкой таймера -> немедленная остановка
//            (настоящим запуском: withZeroBudget — для codex, deepseek, claude);
// и страховка 200-мс опроса: deadlinePassed останавливает уже бегущий процесс, получивший истёкший
// конечный срок на ходу (у codex/deepseek/claude). Antigravity по замыслу §B.4 страхует отменой/смертью
// родителя (его опрос deadlinePassed не проверяет) — проверяются три случая runAgy.
// Г2b-2: deepseek — тот же execute, что у codex (предпусковой throw -> finish со stopReason 'timeout');
// подменяется бинарём fake-dsh.cmd через DSH_PATH (dsh — .cmd, сервер зовёт его из оболочки).
// claude — тот же трёхслучайный таймер и опрос, но истёкший срок ловится РАНЬШЕ (отдельная проверка
// очереди -> status 'cancelled', не 'timeout'); бинарь без оболочки с фиксированными флагами, поэтому
// cp.spawn перенаправляется на настоящий `node fake-claude.js` (подмена бинаря, как CODEX_PATH у codex).
module.exports = ({ test, f }) => {
  const assert = require('assert'), fs = require('fs'), path = require('path'), Module = require('module');
  const cp = require('child_process');
  const outside = fs.mkdtempSync(path.join(process.env.MOST_TEST_OUTSIDE || require('os').tmpdir(), 'g2b-'));
  const TIMER_ENV = ['MOST_CODEX_TIMEOUT_MS', 'MOST_CLAUDE_TIMEOUT_MS', 'MOST_DEEPSEEK_TIMEOUT_MS', 'MOST_PRINT_TIMEOUT', 'MOST_WATCHDOG_MS'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const past = () => new Date(Date.now() - 1000).toISOString();
  function internals(who, names) {
    const file = path.resolve(__dirname, '../servers', who, 'index.js'), m = new Module(file, module);
    m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    const src = fs.readFileSync(file, 'utf8'), end = src.lastIndexOf('\n(async () => {');
    assert(end > 0); m._compile(src.slice(0, end) + '\nmodule.exports = { ' + names + ' };', file);
    return m.exports;
  }
  // Запуск с чистыми MOST_*-сроками (умолчание «нет срока») и настоящими fake-исполнителями.
  async function withEnv(extra, fn) {
    const old = { ...process.env };
    for (const k of TIMER_ENV) delete process.env[k];
    Object.assign(process.env, { MOST_CLIENT: 'claude', MOST_JOB_ID: '' }, extra);
    try { return await fn(); } finally {
      for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k];
      Object.assign(process.env, old);
    }
  }
  async function settledFalse(api, id, ms = 5000) {
    const end = Date.now() + ms;
    while (api.active.has(id) && Date.now() < end) await sleep(40);
  }


  // Случай <=0 настоящим запуском (замечание Codex af652d0a): предпусковые проверки проходят (срока у карточки нет),
  // процесс запущен, а на установке таймера остаток уже <=0 — эмулируется подменой runtimeBudget только для этой
  // карточки. Срока в карточке нет, поэтому страховочный опрос deadlinePassed сработать не может: остановка
  // 'timeout' — именно из ветки budget<=0.
  async function withZeroBudget(id, fn) {
    const cd = require('../common/chain-deadline'), orig = cd.runtimeBudget;
    cd.runtimeBudget = (job, who) => (job && job.id === id ? 0 : orig(job, who));
    try { return await fn(); } finally { cd.runtimeBudget = orig; }
  }
  function zeroBudgetChecks(api, id) {
    assert.equal(api.active.has(id), false, 'остаток <=0 на установке таймера -> немедленная остановка');
    const j = api.load(id);
    assert.ok(j.childPid, 'процесс был запущен (предпусковые проверки пройдены): ' + JSON.stringify(j));
    assert.equal(j.stopReason, 'timeout');
    assert.equal(require('../common/chain-deadline').deadlinePassed(j), false, 'срока нет — опрос не мог остановить');
  }

  // ---------- codex (адаптер с набором active + stop) ----------
  function codexCard(id, deadline) {
    const card = { id, status: 'running', from: 'claude', folder: outside, write: false, task: 'HANG',
      role: 'совет', startedAt: new Date().toISOString() };
    if (deadline !== undefined) card.deadline = deadline;
    return card;
  }
  async function codexRun(id, deadline, body) {
    const api = internals('codex', 'execute, save, load, stop, active');
    const card = codexCard(id, deadline); api.save(card);
    try { await api.execute(card, null); await body(api); }
    finally { if (api.active.has(id)) { await api.stop(id, 'cancel'); await settledFalse(api, id, 3000); } }
  }

  test('Г2b codex: без срока таймер-убийца не создаётся — процесс идёт до отмены', () =>
    withEnv({ CODEX_PATH: path.join(__dirname, 'fake-codex.js') }, async () => {
      const id = 'g2b-codex-null';
      await codexRun(id, undefined, async api => {
        await sleep(700); // дольше, чем взял бы любой короткий таймер
        assert.equal(api.active.has(id), true, 'без срока процесс не остановлен таймером');
        await api.stop(id, 'cancel'); await settledFalse(api, id, 4000);
        assert.equal(api.active.has(id), false, 'отмена останавливает бессрочный процесс');
        assert.equal(api.load(id).stopReason, 'cancel');
      });
    }));

  test('Г2b codex: конечный будущий срок — таймер останавливает процесс по остатку', () =>
    withEnv({ CODEX_PATH: path.join(__dirname, 'fake-codex.js') }, async () => {
      const id = 'g2b-codex-future';
      await codexRun(id, new Date(Date.now() + 700).toISOString(), async api => {
        await settledFalse(api, id, 6000);
        assert.equal(api.active.has(id), false, 'таймер на остаток остановил процесс');
        assert.equal(api.load(id).stopReason, 'timeout');
      });
    }));

  test('Г2b codex: истёкший конечный срок — немедленная остановка (не пропуск)', () =>
    withEnv({ CODEX_PATH: path.join(__dirname, 'fake-codex.js') }, async () => {
      const id = 'g2b-codex-expired';
      await codexRun(id, past(), async api => {
        await settledFalse(api, id, 4000);
        assert.equal(api.active.has(id), false, 'истёкший срок -> немедленная остановка');
        assert.equal(api.load(id).stopReason, 'timeout');
      });
    }));

  test('Г2b codex: остаток <=0 после запуска процесса (между проверкой и таймером) — немедленная остановка', () =>
    withEnv({ CODEX_PATH: path.join(__dirname, 'fake-codex.js') }, () => withZeroBudget('g2b-codex-zero', async () => {
      const id = 'g2b-codex-zero';
      await codexRun(id, undefined, async api => { await settledFalse(api, id, 4000); zeroBudgetChecks(api, id); });
    })));

  test('Г2b codex: страховочный опрос deadlinePassed останавливает бегущий процесс с истёкшим сроком', () =>
    withEnv({ CODEX_PATH: path.join(__dirname, 'fake-codex.js') }, async () => {
      const id = 'g2b-codex-poll';
      await codexRun(id, undefined, async api => {
        // без срока таймер не создан; дождёмся фиксации запуска и зададим истёкший конечный срок на ходу
        const end = Date.now() + 3000;
        while ((!api.active.has(id) || !api.load(id).childPid) && Date.now() < end) await sleep(40);
        assert.equal(api.active.has(id), true, 'процесс идёт, таймер не создавался');
        const j = api.load(id); j.deadline = past(); api.save(j);
        await settledFalse(api, id, 4000);
        assert.equal(api.active.has(id), false, 'опрос остановил процесс с истёкшим сроком');
        assert.equal(api.load(id).stopReason, 'timeout');
      });
    }));

  // ---------- antigravity (runAgy возвращает промис) ----------
  const saveAgy = card => f.json(path.join(f.stores.roots().antigravity, card.id + '/card.json'), card);
  function agyEnv(extra) {
    return Object.assign({ AGY_PATH: path.join(__dirname, 'fake-agy.js'), MOST_AGY_INPUT_FORMAT: 'legacy',
      MOST_JOURNAL: path.join(f.RUN, 'g2b-agy.log') }, extra || {});
  }

  test('Г2b antigravity: без срока runAgy не завершается таймером — остановка отменой', () =>
    withEnv(agyEnv(), async () => {
      const api = internals('antigravity', 'runAgy, requestStop'), id = 'g2b-agy-null';
      saveAgy({ id, status: 'running', rezhim: 'tekst', from: 'claude', papka: outside, startedAt: new Date().toISOString() });
      const work = api.runAgy(['--print', '[[FAKE:hang]]'], id, () => {}, outside);
      let settled = false; work.then(() => { settled = true; }, () => { settled = true; });
      await sleep(900);
      assert.equal(settled, false, 'без срока таймер-убийца не завершает задание');
      await api.requestStop(id, 'отмена');
      const result = await Promise.race([work, sleep(5000).then(() => { throw Error('antigravity не остановлен отменой'); })]);
      assert.equal(result.cancelled, true, JSON.stringify(result));
    }));

  test('Г2b antigravity: конечный будущий срок — runAgy завершается по таймеру (timedOut)', () =>
    withEnv(agyEnv(), async () => {
      const api = internals('antigravity', 'runAgy, requestStop'), id = 'g2b-agy-future';
      saveAgy({ id, status: 'running', rezhim: 'tekst', from: 'claude', papka: outside,
        startedAt: new Date().toISOString(), deadline: new Date(Date.now() + 700).toISOString() });
      const work = api.runAgy(['--print', '[[FAKE:hang]]'], id, () => {}, outside);
      let kill;
      const guard = new Promise((_, reject) => { kill = setTimeout(async () => { await api.requestStop(id, 'отмена'); reject(Error('antigravity не остановлен по сроку')); }, 6000); });
      try { const result = await Promise.race([work, guard]); assert.equal(result.timedOut, true, JSON.stringify(result)); }
      finally { clearTimeout(kill); }
    }));

  test('Г2b antigravity: истёкший конечный срок — немедленный отказ до запуска (timedOut)', () =>
    withEnv(agyEnv(), async () => {
      const api = internals('antigravity', 'runAgy'), id = 'g2b-agy-expired';
      saveAgy({ id, status: 'running', rezhim: 'tekst', from: 'claude', papka: outside,
        startedAt: new Date().toISOString(), deadline: past() });
      const result = await api.runAgy(['--print', '[[FAKE:hang]]'], id, () => {}, outside);
      assert.equal(result.timedOut, true, JSON.stringify(result));
      assert.match(result.error || '', /Срок истёк до запуска/);
    }));

  // ---------- deepseek (адаптер с набором active + stop, как codex; бинарь — fake-dsh.cmd) ----------
  function dsCard(id, deadline) {
    const card = { id, status: 'running', from: 'claude', folder: outside, write: false, task: 'HANG',
      role: 'совет', startedAt: new Date().toISOString() };
    if (deadline !== undefined) card.deadline = deadline;
    return card;
  }
  async function deepseekRun(id, deadline, body) {
    const api = internals('deepseek', 'execute, save, load, stop, active');
    const card = dsCard(id, deadline); api.save(card);
    try { await api.execute(card, null); await body(api); }
    finally { if (api.active.has(id)) { await api.stop(id, 'cancel'); await settledFalse(api, id, 3000); } }
  }
  const dsEnv = extra => Object.assign({ DSH_PATH: path.join(__dirname, 'fake-dsh.cmd'), MOST_DSH_NO_PROFILES: '1' }, extra || {});

  test('Г2b deepseek: без срока таймер-убийца не создаётся — процесс идёт до отмены', () =>
    withEnv(dsEnv(), async () => {
      const id = 'g2b-dsh-null';
      await deepseekRun(id, undefined, async api => {
        await sleep(700);
        assert.equal(api.active.has(id), true, 'без срока процесс не остановлен таймером');
        await api.stop(id, 'cancel'); await settledFalse(api, id, 4000);
        assert.equal(api.active.has(id), false, 'отмена останавливает бессрочный процесс');
        assert.equal(api.load(id).stopReason, 'cancel');
      });
    }));

  test('Г2b deepseek: конечный будущий срок — таймер останавливает процесс по остатку', () =>
    withEnv(dsEnv(), async () => {
      const id = 'g2b-dsh-future';
      await deepseekRun(id, new Date(Date.now() + 700).toISOString(), async api => {
        await settledFalse(api, id, 6000);
        assert.equal(api.active.has(id), false, 'таймер на остаток остановил процесс');
        assert.equal(api.load(id).stopReason, 'timeout');
      });
    }));

  test('Г2b deepseek: истёкший конечный срок — немедленная остановка (не пропуск)', () =>
    withEnv(dsEnv(), async () => {
      const id = 'g2b-dsh-expired';
      await deepseekRun(id, past(), async api => {
        await settledFalse(api, id, 4000);
        assert.equal(api.active.has(id), false, 'истёкший срок -> немедленная остановка');
        assert.equal(api.load(id).stopReason, 'timeout');
      });
    }));

  test('Г2b deepseek: остаток <=0 после запуска процесса (между проверкой и таймером) — немедленная остановка', () =>
    withEnv(dsEnv(), () => withZeroBudget('g2b-dsh-zero', async () => {
      const id = 'g2b-dsh-zero';
      await deepseekRun(id, undefined, async api => { await settledFalse(api, id, 4000); zeroBudgetChecks(api, id); });
    })));

  test('Г2b deepseek: страховочный опрос deadlinePassed останавливает бегущий процесс с истёкшим сроком', () =>
    withEnv(dsEnv(), async () => {
      const id = 'g2b-dsh-poll';
      await deepseekRun(id, undefined, async api => {
        const end = Date.now() + 3000;
        while ((!api.active.has(id) || !api.load(id).childPid) && Date.now() < end) await sleep(40);
        assert.equal(api.active.has(id), true, 'процесс идёт, таймер не создавался');
        const j = api.load(id); j.deadline = past(); api.save(j);
        await settledFalse(api, id, 4000);
        assert.equal(api.active.has(id), false, 'опрос остановил процесс с истёкшим сроком');
        assert.equal(api.load(id).stopReason, 'timeout');
      });
    }));

  // ---------- claude (бинарь без оболочки — cp.spawn перенаправляется на node fake-claude.js) ----------
  function clCard(id, deadline) {
    const card = { id, status: 'running', member: 'claude', from: 'claude', folder: outside, write: false,
      task: 'HANG', role: 'совет', startedAt: new Date().toISOString() };
    if (deadline !== undefined) card.deadline = deadline;
    return card;
  }
  async function claudeRun(id, deadline, body) {
    const realSpawn = cp.spawn, realExec = cp.execFileSync;
    cp.execFileSync = (bin, a, ...rest) => Array.isArray(a) && a[0] === '--help'
      ? require('../common/claude-args').REQUIRED_FLAGS.join(' ') : realExec(bin, a, ...rest);
    cp.spawn = (bin, a, opts) => realSpawn(process.execPath, [path.join(__dirname, 'fake-claude.js')], opts);
    let api;
    try {
      api = internals('claude', 'execute, save, load, stop, active');
      const card = clCard(id, deadline); api.save(card);
      await api.execute(card, null); await body(api);
    } finally {
      try { if (api && api.active.has(id)) { await api.stop(id, 'cancel'); await settledFalse(api, id, 3000); } }
      finally { cp.spawn = realSpawn; cp.execFileSync = realExec; }
    }
  }

  test('Г2b claude: без срока таймер-убийца не создаётся — процесс идёт до отмены', () =>
    withEnv({ CLAUDE_PATH: process.execPath }, async () => {
      const id = 'g2b-claude-null';
      await claudeRun(id, undefined, async api => {
        await sleep(700);
        assert.equal(api.active.has(id), true, 'без срока процесс не остановлен таймером');
        await api.stop(id, 'cancel'); await settledFalse(api, id, 4000);
        assert.equal(api.active.has(id), false, 'отмена останавливает бессрочный процесс');
        assert.equal(api.load(id).stopReason, 'cancel');
      });
    }));

  test('Г2b claude: конечный будущий срок — таймер останавливает процесс по остатку', () =>
    withEnv({ CLAUDE_PATH: process.execPath }, async () => {
      const id = 'g2b-claude-future';
      await claudeRun(id, new Date(Date.now() + 700).toISOString(), async api => {
        await settledFalse(api, id, 6000);
        assert.equal(api.active.has(id), false, 'таймер на остаток остановил процесс');
        assert.equal(api.load(id).stopReason, 'timeout');
      });
    }));

  test('Г2b claude: истёкший срок ловится в очереди — status cancelled (не пропуск, не таймаут)', () =>
    withEnv({ CLAUDE_PATH: process.execPath }, async () => {
      const id = 'g2b-claude-expired';
      await claudeRun(id, past(), async api => {
        assert.equal(api.active.has(id), false, 'истёкший срок -> запуск не начат');
        const j = api.load(id);
        assert.equal(j.status, 'cancelled', JSON.stringify(j));
        assert.match(j.error || '', /Срок/);
      });
    }));

  test('Г2b claude: остаток <=0 после запуска процесса (между проверкой и таймером) — немедленная остановка', () =>
    withEnv({ CLAUDE_PATH: process.execPath }, () => withZeroBudget('g2b-claude-zero', async () => {
      const id = 'g2b-claude-zero';
      await claudeRun(id, undefined, async api => { await settledFalse(api, id, 4000); zeroBudgetChecks(api, id); });
    })));

  test('Г2b claude: страховочный опрос deadlinePassed останавливает бегущий процесс с истёкшим сроком', () =>
    withEnv({ CLAUDE_PATH: process.execPath }, async () => {
      const id = 'g2b-claude-poll';
      await claudeRun(id, undefined, async api => {
        const end = Date.now() + 3000;
        while ((!api.active.has(id) || !api.load(id).childPid) && Date.now() < end) await sleep(40);
        assert.equal(api.active.has(id), true, 'процесс идёт, таймер не создавался');
        const j = api.load(id); j.deadline = past(); api.save(j);
        await settledFalse(api, id, 4000);
        assert.equal(api.active.has(id), false, 'опрос остановил процесс с истёкшим сроком');
        assert.equal(api.load(id).stopReason, 'timeout');
      });
    }));

  test('team-v48e (ревью п.1) claude: правило Edit и cwd — канонический путь замка, не строка-ссылка', () =>
    withEnv({ CLAUDE_PATH: process.execPath }, async () => {
      const ca = require('../common/claude-args'), paths = require('../common/paths');
      const realDir = fs.mkdtempSync(path.join(outside, 'proj-'));
      const link = path.join(outside, 'link-' + process.pid + '-' + Date.now());
      try { fs.symlinkSync(realDir, link, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (e) { throw Object.assign(new Error('junction нельзя создать: ' + e.code), { __skip: true }); }
      const want = paths.canon(link); // канонический realpath(realDir)
      const realSpawn = cp.spawn, realExec = cp.execFileSync; let captured = null;
      cp.execFileSync = (bin, a, ...rest) => Array.isArray(a) && a[0] === '--help' ? ca.REQUIRED_FLAGS.join(' ') : realExec(bin, a, ...rest);
      cp.spawn = (bin, a, opts) => { captured = { args: a, cwd: opts.cwd }; return realSpawn(process.execPath, [path.join(__dirname, 'fake-claude.js')], opts); };
      const id = 'p1-claude-edit'; let api;
      try {
        api = internals('claude', 'execute, save, load, stop, active');
        const card = { id, status: 'running', member: 'claude', from: 'claude', folder: link, write: true, task: 'HANG', role: 'текст', startedAt: new Date().toISOString() };
        api.save(card);
        await api.execute(card, null);
        const end = Date.now() + 4000;
        while (!captured && Date.now() < end) await sleep(40);
        assert(captured, 'spawn вызван');
        assert(captured.args.includes(ca.editRule(want)), 'правило Edit канонично: ' + captured.args.filter(x => /^Edit\(/.test(x)).join(','));
        assert(!captured.args.includes(ca.editRule(link)), 'правило Edit — не строка-ссылка');
        assert.equal(paths.canon(captured.cwd), want, 'cwd — канонический путь: ' + captured.cwd);
      } finally {
        try { if (api && api.active.has(id)) { await api.stop(id, 'cancel'); await settledFalse(api, id, 3000); } }
        finally { cp.spawn = realSpawn; cp.execFileSync = realExec; }
      }
    }));
};
