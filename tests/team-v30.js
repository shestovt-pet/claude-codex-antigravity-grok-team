'use strict';
process.env.MOST_AGY_CLI_SETTINGS = require('path').join(__dirname, '.tmp-agy-cli-settings-'+process.pid, 'settings.json');
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process');
const f = require('./team-v16-fixture'), { run } = f;
const members = require('../common/members'), stores = require('../common/members-store');
let seq = 0;
const isolated = () => stores.create(path.join(f.RUN, 'members-' + (++seq)));
const meta = { action: 'pause', who: 'claude', reason: 'проверка', quote: 'проверяю' };
const zzz = () => ({ ...structuredClone(members.get('codex')), id: 'zzz', title: 'Проверочный участник', specialization: 'проверка расширения', roles: { ...members.get('codex').roles, voter: false } });
const client = (id, fn) => { const old = process.env.MOST_CLIENT; process.env.MOST_CLIENT = id; try { return fn(); } finally { process.env.MOST_CLIENT = old; } };
run([
  ['А1: инициализация один раз, rev и phase, журнал и last-good', () => {
    const s = isolated(), a = s.read(); assert.equal(a.rev, 0); assert.equal(a.phase, 'A'); assert.equal(s.read().rev, 0);
    assert.equal(s.history().length, 1); assert.equal(s.history()[0].action, 'init'); assert.deepEqual(JSON.parse(fs.readFileSync(s.good)), s.history()[0].after);
  }],
  ['А2: битый основной снимок восстанавливает последний проверенный состав', () => {
    const s = isolated(); s.read(); s.update(0, n => n.members[0].specialization = 'новая специализация', meta);
    fs.writeFileSync(s.file, '{'); const r = s.read(); assert.equal(r.rev, 1); assert.equal(r.members[0].specialization, 'новая специализация'); assert.match(r.warning, /last-good/);
  }],
  ['А3: оба снимка битые — отказ, defaults не возвращаются', () => {
    const s = isolated(); s.read(); fs.writeFileSync(s.file, '{'); fs.writeFileSync(s.good, '{');
    assert.throws(() => s.read(), /новые запуски и принятие остановлены/); assert.equal(s.history().length, 1);
    assert.throws(() => s.update(0, () => {}, meta), /остановлены/);
  }],
  ['А4: журнал без снимков не считается первой инициализацией', () => {
    const s = isolated(); fs.mkdirSync(path.dirname(s.log), { recursive: true }); fs.writeFileSync(s.log, '{"action":"init","rev":0}\n'); assert.throws(() => s.read(), /остановлены/);
  }],
  ['А5: устаревшая rev отвергается без изменения журнала', () => {
    const s = isolated(); s.read(); s.update(0, n => n.members[0].title = 'новое имя', meta);
    assert.throws(() => s.update(0, () => {}, meta), /конфликт rev/); assert.equal(s.read().rev, 1); assert.equal(s.history().length, 2);
  }],
  ['А6: две конкурентные записи — ровно один победитель', async () => {
    const s = isolated(); s.read();
    const go = path.join(path.dirname(s.file), 'go');
    // Оба процесса готовы до общей отмашки: проверяется настоящее столкновение, а не два подряд.
    const code = `const fs=require('fs');const dir=${JSON.stringify(path.dirname(s.file))};const s=require(${JSON.stringify(path.resolve(__dirname, '../common/members-store'))}).create(dir);while(!fs.existsSync(${JSON.stringify(path.join(path.dirname(s.file), 'go'))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);try{s.update(0,n=>n.members[0].title='changed',{action:'pause',who:'test',reason:'конкурентная запись'});process.exitCode=0}catch(e){if(e.code!=='MEMBERS_REV_CONFLICT')throw e;process.exitCode=2}`;
    const start = () => new Promise((resolve, reject) => { const p = cp.spawn(process.execPath, ['-e', code], { windowsHide: true, stdio: 'pipe' }); let err = ''; p.stderr.on('data', b => { err += b; }); p.on('error', reject); p.on('close', code => resolve({ code, err })); });
    const runs = [start(), start()];
    await new Promise(r => setTimeout(r, 300)); fs.writeFileSync(go, 'go');
    const outcomes = await Promise.all(runs);
    assert.deepEqual(outcomes.map(r => r.code).sort(), [0, 2], outcomes.map(r => r.err).join('\n')); assert.equal(s.read().rev, 1); assert.equal(s.history().length, 2);
  }],
  ['А7: zzz без правки кода появляется в доступе, сводке и правилах', async () => {
    const s = members.store(); s.update(s.read().rev, n => n.members.push(zzz()), { ...meta, action: 'add' });
    try {
      assert(members.ids.includes('zzz')); assert(!members.seatIds.includes('zzz')); assert(!require('../common/consilium-workflow').QUORUM.includes('zzz')); assert(require('../common/access').guestTools('team', 'zzz').includes('team_status'));
      assert.match(members.describe(), /zzz/); assert.match(members.rules(), /Проверочный участник: проверка расширения/);
      assert.match(require('../common/client-rules').body('zzz'), /Проверочный участник/);
      const summary = await require('../common/summary').compact({ root: f.root, state: path.join(f.root, 'state/team'), works: () => [] }, 'Квоты: тест', undefined, { budget: 10000 });
      assert.match(summary, /zzz/); assert(members.canSend('zzz', 'codex')); assert(members.canWrite('zzz'));
      const jobs = require('../common/team-store'), dir = jobs.roots().zzz; fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'write-review.json'), JSON.stringify({ id: 'write-review', status: 'done', write: true }));
      assert.throws(() => jobs.review('zzz', 'write-review', 'a'.repeat(40), 'b'.repeat(40)), /новым сеансом только для чтения/);
    } finally { s.update(s.read().rev, n => n.members.find(m => m.id === 'zzz').state = 'removed', { ...meta, action: 'remove' }); }
  }],
  ['А8: пауза отображается, но не меняет голоса и разрешения А', async () => {
    const s = members.store(), before = Object.entries(members.seats);
    s.update(s.read().rev, n => { const m = n.members.find(m => m.id === 'codex'); m.state = 'paused'; m.pause = { kind: 'manual', scope: 'participant', since: new Date().toISOString(), until: null, next_probe: null }; }, meta);
    try { assert.deepEqual(Object.entries(members.seats), before); assert(members.canSend('codex', 'antigravity')); assert.match(members.describe(), /пауза manual/);
      const summary = await require('../common/summary').compact({ root: f.root, state: path.join(f.root, 'state/team'), works: () => [] }, 'Квоты: тест', undefined, { budget: 1000 });
      assert.match(summary, /Пауза участника Codex/); }
    finally { s.update(s.read().rev, n => { const m = n.members.find(m => m.id === 'codex'); m.state = 'active'; m.pause = null; }, { ...meta, action: 'resume' }); }
  }],
  ['А9: в фазе A DeepSeek не действует, в фазе B — действует после пробы', () => {
    const s = members.store();
    s.update(s.read().rev, n => { const m = n.members.find(m => m.id === 'deepseek'); m.roles.receives = m.roles.sends = m.roles.voter = m.roles.writer = true; }, meta);
    try {
      // Фаза A: dsh-headless известен, но DeepSeek не действует до установки фазы B.
      assert(!members.canSend('deepseek', 'codex')); assert(!members.canWrite('deepseek')); assert(!members.voters().some(m => m.id === 'deepseek'));
    } finally { s.update(s.read().rev, n => { const m = n.members.find(m => m.id === 'deepseek'); m.roles.receives = m.roles.sends = m.roles.voter = m.roles.writer = false; }, meta); }
    require('../common/dsh-probe').record({ version: '0.2.1-rc.2', writeDenied: true });
    process.env.MOST_DSH_VERSION = '0.2.1-rc.2';
    s.update(s.read().rev, n => { const m = n.members.find(m => m.id === 'deepseek'); m.roles.receives = m.roles.sends = m.roles.voter = m.roles.writer = true; }, meta, { phase: 'B' });
    try {
      // Фаза B + проба: права DeepSeek действуют.
      assert(members.canSend('deepseek', 'codex')); assert(members.canWrite('deepseek')); assert(members.voters().some(m => m.id === 'deepseek'));
    } finally { delete process.env.MOST_DSH_VERSION; s.update(s.read().rev, n => { const m = n.members.find(m => m.id === 'deepseek'); m.roles.receives = m.roles.sends = m.roles.voter = m.roles.writer = false; }, meta, { phase: 'A' }); }
  }],
  ['А10: team_members требует дирижёра, цитату и rev, пишет аудит', () => {
    const command = require('../common/team-members').run, old = process.env.MOST_JOB_ID; delete process.env.MOST_JOB_ID;
    try {
      client('deepseek', () => assert.throws(() => command({ action: 'add', member: zzz() }), /дирижёр/));
      assert.throws(() => command({ action: 'add', member: zzz(), reason: 'тест' }), /цитата/);
      assert.throws(() => members.store().update(members.rev(), () => {}, { action: 'add', who: 'test' }), /для журнала/);
      const rev = members.rev(); command({ action: 'add', member: zzz(), reason: 'тест', quote: 'Добавь проверочного', expected_rev: rev });
      try {
        assert.equal(members.store().history().at(-1).quote, 'Добавь проверочного');
        assert.throws(() => command({ action: 'remove', id: 'zzz', reason: 'тест', quote: 'Убери', expected_rev: rev }), /rev/);
        command({ action: 'remove', id: 'zzz', reason: 'тест', quote: 'Убери', expected_rev: members.rev() });
      } finally {
        if (members.get('zzz')) command({ action: 'remove', id: 'zzz', reason: 'уборка после падения', quote: 'Убери', expected_rev: members.rev() });
      }
    } finally { if (old !== undefined) process.env.MOST_JOB_ID = old; }
  }],
  ['А11: Grok и некорректные роли в реестре запрещены', () => {
    const s = isolated(); s.read(); assert.throws(() => s.update(0, n => n.members.push({ ...zzz(), id: 'grok' }), meta), /неверная запись/);
    assert.equal(s.read().rev, 0); assert.equal(s.history().length, 1);
  }],
  ['А12: реестр с phase запрещает откат ниже А уже после инициализации', () => {
    const s = isolated(), r = require('../common/members-rollback');
    assert.deepEqual(r.blockers(path.dirname(s.file), []), []);
    s.read(); assert.throws(() => r.assert(path.dirname(s.file), []), /phase A, rev 0/);
    s.update(0, n => n.members[0].title = 'Изменение', meta);
    assert.throws(() => r.assert(path.dirname(s.file), []), /rev 1/); assert.doesNotThrow(() => r.assert(path.dirname(s.file), [path.resolve(__dirname, '..')]));
  }],
  ['А13: DSH deploy/rollback сохраняют чужой YAML и пути live', () => {
    const d = require('../common/dsh-config'), before = '- id: personal\n  config: !!js someUserExpression\n';
    const one = d.render(before, path.join(f.root, 'live', 'a'.repeat(40)), f.root, process.execPath);
    const two = d.render(one, path.join(f.root, 'live', 'b'.repeat(40)), f.root, process.execPath);
    assert(two.startsWith(before)); assert.equal(d.connections(two).mcpServers.team.env.MOST_CLIENT, 'deepseek');
    assert.equal(d.restore(two, one), one); assert(d.connections(one).mcpServers.codex.args[0].includes('a'.repeat(40)));
    assert.throws(() => d.render('- id: mcp-most-team\n', f.root, f.root, 'node'), /дубликатов/);
  }],
  ['А14: DSH резервная копия существует ДО изменения конфига', async () => {
    const file = path.join(f.RUN, 'cordis.patch.yml'), before = '- id: personal\n'; fs.writeFileSync(file, before);
    const deploy = require('../common/deploy'), plans = require('../common/client-configs').plans([{ ...deploy.snapshot(file), kind: 'dsh', client: 'deepseek' }], f.root, f.root, '', process.execPath);
    assert(plans[0].backupBefore); const rename = fs.renameSync; let observed = false;
    fs.renameSync = (a, b) => { if (b === file) { assert.equal(fs.readFileSync(file + '.prev', 'utf8'), before); observed = true; } return rename(a, b); };
    try { await deploy.switchConfigs(plans); } finally { fs.renameSync = rename; } assert(observed);
  }],
  ['А15: линтер не ловит модели и историю, ловит список действующих мест', () => {
    const lint = require('../common/members-lint');
    assert.equal(lint.checkText('common/new.js', "const voters = ['codex', 'antigravity'];").length, 1);
    assert.equal(lint.checkText('common/model-family.js', "const families = ['openai', 'google'];").length, 0);
    assert.equal(lint.checkText('docs/design/old.md', 'Codex Antigravity').length, 0);
    assert.deepEqual(lint.scan(path.resolve(__dirname, '..')), []);
  }],
  ['А16: при повреждении реестра новые поручения и принятие запрещены', async () => {
    const s = members.store(), main = fs.readFileSync(s.file), good = fs.readFileSync(s.good), stage = f.fixture();
    fs.writeFileSync(s.file, '{'); fs.writeFileSync(s.good, '{');
    try {
      assert.throws(() => require('../common/access').guard('codex', 'codex_send', {}), /остановлены/);
      await assert.rejects(() => f.gate.evaluate(stage.w, stage.s), /остановлены/);
      assert.match(members.describe(), /остановлены/);
    } finally { fs.writeFileSync(s.file, main); fs.writeFileSync(s.good, good); }
  }],
  ['А17: чтение чистого реестра не пишет на диск, первая запись инициализирует', () => {
    const s = isolated(); assert.equal(s.read({ initialize: false }).rev, 0); assert(!fs.existsSync(s.file)); assert(!fs.existsSync(s.log));
    s.update(0, () => {}, meta); assert.equal(s.read().rev, 1); assert.equal(s.history().length, 2);
  }],
  ['А18: новый клиент известного адаптера получает собственную метку', () => {
    const s = members.store(), m = zzz(); m.adapter_params = { client_config: path.join(f.RUN, 'zzz.toml'), client_rules: path.join(f.RUN, 'zzz.md') };
    s.update(s.read().rev, n => n.members.push({ ...m, id: 'client-test' }), { ...meta, action: 'add' });
    try {
      const c = require('../common/member-clients').all().find(c => c.id === 'client-test'); assert(c);
      const config = require('../common/client-configs').jsonConfig({}, 'permissions', f.root, f.root, '', process.execPath, 'test', false, 'client-test');
      assert.deepEqual(config.userSettings.globalPermissionGrants.allow, require('../common/client-configs').grantsFor('client-test'));
      assert(!config.userSettings.globalPermissionGrants.allow.includes('mcp(antigravity/antigravity_cancel)'));
      const p = require('../common/client-configs').plans([{ file: c.file, text: '', config: null, kind: c.kind, client: c.id }], f.root, f.root, '', process.execPath);
      assert.match(p[0].next, /MOST_CLIENT = 'client-test'/); assert.match(require('../common/client-rules').body('client-test'), /Проверочный участник/);
    } finally { s.update(s.read().rev, n => n.members.find(m => m.id === 'client-test').state = 'removed', { ...meta, action: 'remove' }); }
  }],
  ['А19: повторный rollback DSH сохраняет цель; реестр блокирует откат ниже А', async () => {
    const d = require('../common/deploy'), yaml = require('../common/dsh-config'), file = path.join(f.RUN, 'rollback-dsh.yml');
    const root = path.join(f.RUN, 'rollback-root'); fs.mkdirSync(root);
    const one = yaml.render('- id: personal\n', path.join(root, 'live', 'a'.repeat(40)), root, process.execPath);
    const two = yaml.render(one, path.join(root, 'live', 'b'.repeat(40)), root, process.execPath);
    fs.writeFileSync(file, two); fs.writeFileSync(file + '.prev', one);
    const old = process.env.MOST_DSH_CONFIG; process.env.MOST_DSH_CONFIG = file;
    try {
      const state = path.join(root, 'state');
      assert.match(await d.rollback({ root, configs: [file], configOnly: true, stateDir: state }), /возвращён/);
      assert.equal(fs.readFileSync(file, 'utf8'), one); assert.equal(fs.readFileSync(file + '.prev', 'utf8'), one);
      assert.equal(fs.readFileSync(file + '.rollback-backup', 'utf8'), two);
      assert.match(await d.rollback({ root, configs: [file], configOnly: true, stateDir: state }), /возвращён/);
      assert.equal(fs.readFileSync(file, 'utf8'), one); assert.equal(fs.readFileSync(file + '.prev', 'utf8'), one);
      const store = stores.create(state); store.read();
      // Решение пользователя: fail-fast — rollback бросает (замысел team-v47, разд. 13.4).
      await assert.rejects(() => d.rollback({ root, configs: [file], configOnly: true, stateDir: path.join(f.RUN, 'unrelated-locks') }), /Откат ниже кандидата А запрещён/);
      assert.equal(fs.readFileSync(file, 'utf8'), one);
    } finally { if (old === undefined) delete process.env.MOST_DSH_CONFIG; else process.env.MOST_DSH_CONFIG = old; }
  }],
  ['А20: пустой состав не превращается в принятие без голосов', async () => {
    const store = members.store(), before = store.read().members;
    store.update(members.rev(), n => { for (const m of n.members) if (m.roles.voter) m.state = 'removed'; }, { ...meta, action: 'remove' });
    try {
      assert.throws(() => [...require('../common/team-seats').SEATS], /Нет обязательных голосующих/);
      const stage = f.fixture(); stage.s.rules_version = 14; stage.s.criterion_met = true;
      await assert.rejects(() => f.gate.evaluate(stage.w, stage.s, null, []), /Нет обязательных голосующих.*ждёт восстановления состава/);
    } finally { store.update(members.rev(), n => { n.members = before; }, { ...meta, action: 'add' }); }
  }],
  ['А21: DSH обновляет унаследованные подключения вместо повторной вставки', () => {
    const profile = path.join(f.RUN, 'dsh-profile'), bundle = path.join(profile, 'node_modules/@local/mcp-integrations');
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@local/mcp-integrations'] } } }));
    fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
    fs.writeFileSync(path.join(bundle, 'cordis.patch.yml'), '- insert:\n    - id: mcp-most-team\n      name: "@deepseek-ai/dsh-mcp-client"\n');
    const file = path.join(profile, 'cordis.patch.yml'), before = '- id: personal\n'; fs.writeFileSync(file, before);
    const d = require('../common/dsh-config'), plans = require('../common/client-configs').plans([{ ...require('../common/deploy').snapshot(file), kind: 'dsh', client: 'deepseek' }], f.root, f.root, '', process.execPath);
    const next = plans[0].next, rows = next.slice(next.indexOf('# most:begin')).split(/\r?\n/).filter(l => l.startsWith('- {')).map(l => JSON.parse(l.slice(2)));
    assert(rows.some(r => r.id === 'mcp-most-team')); assert(!rows.flatMap(r => r.insert || []).some(r => r.id === 'mcp-most-team'));
    assert.equal(d.connections(next).mcpServers.team.env.MOST_CLIENT, 'deepseek'); assert(next.startsWith(before));
    assert.equal(d.render(next, f.root, f.root, process.execPath, 'deepseek', file), next);
    assert.equal(d.restore(next, before), before);
  }],
  ['А22: временная блокировка last-good в Windows не теряет запись и журнал', () => {
    if (process.platform !== 'win32') return;
    const store = isolated(); store.read(); const rename = fs.renameSync; let conflicts = 0;
    fs.renameSync = (from, to) => { if (to === store.good && conflicts++ < 2) throw Object.assign(Error('файл открыт читателем'), { code: 'EPERM' }); return rename(from, to); };
    try { store.update(0, n => { n.members[0].title = 'после конфликта'; }, meta); }
    finally { fs.renameSync = rename; }
    assert.equal(conflicts, 3); assert.equal(store.read().rev, 1); assert.equal(store.history().length, 2);
    assert.equal(JSON.parse(fs.readFileSync(store.good)).members[0].title, 'после конфликта');
  }],
  ['А23: оставленный захват реестра снимается только по доказанной смерти владельца', () => {
    const s = isolated(); s.read(); const acquire = s.lock + '.acquire';
    fs.writeFileSync(acquire, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
    assert.equal(s.update(0, () => {}, meta).rev, 1); assert(!fs.existsSync(acquire), 'мёртвый захват снят');
    fs.writeFileSync(acquire, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    try {
      assert.throws(() => s.update(1, () => {}, meta), /members\.lock занят.*members\.lock/);
      assert(fs.existsSync(acquire), 'живой захват не удалён');
    } finally { fs.unlinkSync(acquire); }
    const empty = isolated(); empty.read(); const file = empty.lock + '.acquire'; fs.writeFileSync(file, '');
    const old = new Date(Date.now() - 300000); fs.utimesSync(file, old, old);
    assert.equal(empty.update(0, () => {}, meta).rev, 1);
  }],
  ['А24: недописанная последняя строка журнала отбрасывается, повреждение в середине — остановка', () => {
    const s = isolated(); s.read(); s.update(0, () => {}, meta);
    fs.appendFileSync(s.log, '{"action":"update","rev":2,"at":"2026-');
    const read = s.read(); assert.equal(read.rev, 1); assert.match(read.warning, /недописанная последняя строка отброшена/);
    assert.equal(s.update(1, () => {}, meta).rev, 2);
    const lines = fs.readFileSync(s.log, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) JSON.parse(line); assert.equal(lines.length, 3);
    const broken = isolated(); broken.read(); broken.update(0, () => {}, meta); broken.update(1, () => {}, meta);
    const raw = fs.readFileSync(broken.log, 'utf8').split(/\r?\n/); raw[1] = '{битая';
    fs.writeFileSync(broken.log, raw.join('\n'));
    assert.throws(() => broken.read(), e => /журнал изменений повреждён/.test(e.message) && e.message.includes(broken.log));
  }],
  ['А25: правка состава сохраняет фазу; меняет её только явная установка', () => {
    const s = isolated(); s.read();
    s.update(0, () => {}, meta, { phase: 'B' });
    s.update(1, n => { n.members[0].title = 'Claude после правки'; }, { ...meta, action: 'update' });
    assert.equal(s.read().phase, 'B'); assert.equal(s.read().members[0].title, 'Claude после правки');
    s.update(2, () => {}, { ...meta, action: 'phase' }, { phase: 'A' });
    assert.equal(s.read().phase, 'A');
  }],
  ['А26: удалённый голосующий не мешает созданию этапа, но принятие ждёт состав', async () => {
    const store = members.store(), before = store.read().members;
    store.update(members.rev(), n => { n.members.find(m => m.id === 'antigravity').state = 'removed'; }, { ...meta, action: 'remove' });
    try {
      const stage = f.fixture();
      await f.gate.evaluate(stage.w, stage.s, null, []);
      f.job(stage, 'codex');
      await assert.rejects(() => f.accept(stage), /Нет обязательных голосующих.*ждёт восстановления состава/);
    } finally { store.update(members.rev(), n => { n.members = before; }, { ...meta, action: 'add' }); }
  }],
  ['А27: журнал, отставший от снимка или разошедшийся с ним, останавливает чтение и запись', () => {
    const s = isolated(); s.read(); s.update(0, n => { n.members[0].title = 'Claude 2'; }, meta);
    const full = fs.readFileSync(s.log, 'utf8');
    fs.writeFileSync(s.log, full.split(/\r?\n/).slice(0, 1).join('\n') + '\n');
    assert.throws(() => s.read(), /журнал изменений (отстаёт|не покрывает)/);
    assert.throws(() => s.update(1, () => {}, meta), /журнал изменений (отстаёт|не покрывает)/);
    fs.writeFileSync(s.log, full);
    const lines = full.split(/\r?\n/).filter(Boolean);
    const rec = JSON.parse(lines.at(-1)); rec.after.members[0].title = 'подмена';
    fs.writeFileSync(s.log, lines.slice(0, -1).join('\n') + '\n' + JSON.stringify(rec) + '\n');
    assert.throws(() => s.read(), /снимок расходится с журналом/);
  }],
  ['А28: утрата снимков при непустом журнале не подменяется начальным составом', () => {
    const s = isolated(); s.read(); s.update(0, () => {}, meta);
    fs.unlinkSync(s.file); fs.unlinkSync(s.good);
    fs.writeFileSync(s.log, '{"action":"update","rev":2,"at":"2026-');
    assert.throws(() => s.read(), /снимки реестра утрачены/);
    assert.throws(() => s.update(0, () => {}, meta), /снимки реестра утрачены/);
  }],
  ['А29: завершённая последняя строка журнала без перевода строки не теряется', () => {
    const s = isolated(); s.read(); s.update(0, () => {}, meta);
    const full = fs.readFileSync(s.log, 'utf8').replace(/\n$/, '');
    fs.writeFileSync(s.log, full);
    assert.equal(s.read().rev, 1);
    assert.equal(s.update(1, () => {}, meta).rev, 2);
    const lines = fs.readFileSync(s.log, 'utf8').split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 3); for (const line of lines) JSON.parse(line);
  }],
  ['А30: снимок rev 0 сверяется с init, журнал без init останавливает чтение', () => {
    const s = isolated(); s.read();
    const lines = fs.readFileSync(s.log, 'utf8').split(/\r?\n/).filter(Boolean);
    const init = JSON.parse(lines[0]); init.after.members[0].title = 'подмена rev 0';
    fs.writeFileSync(s.log, JSON.stringify(init) + '\n');
    assert.throws(() => s.read(), /снимок расходится с журналом на rev 0/);
    // Журнал сразу с rev 1: init нет, новая ревизия не накатывается молча.
    const t = isolated(); t.read(); t.update(0, n => { n.members[0].title = 'rev1'; }, meta);
    const full = fs.readFileSync(t.log, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    fs.writeFileSync(t.file, JSON.stringify(full[0].after, null, 2) + '\n');
    fs.writeFileSync(t.good, JSON.stringify(full[0].after, null, 2) + '\n');
    fs.writeFileSync(t.log, JSON.stringify(full[1]) + '\n');
    assert.throws(() => t.read(), /должен начинаться с init rev 0/);
    assert.throws(() => t.update(0, () => {}, meta), /должен начинаться с init rev 0/);
  }],
  ['А31: дубликат, перестановка и запись после новой ревизии останавливают чтение', () => {
    const s = isolated(); s.read();
    s.update(0, n => { n.members[0].title = 'A'; }, { ...meta, action: 'update' });
    s.update(1, n => { n.members[0].title = 'B'; }, { ...meta, action: 'update' });
    const lines = fs.readFileSync(s.log, 'utf8').split(/\r?\n/).filter(Boolean);
    fs.writeFileSync(s.log, lines.concat(lines[1]).join('\n') + '\n');
    assert.throws(() => s.read(), /разрыв, дубликат или перестановка ревизий/);
    fs.writeFileSync(s.log, [lines[0], lines[2], lines[1]].join('\n') + '\n');
    assert.throws(() => s.read(), /разрыв, дубликат или перестановка ревизий|цепочка журнала расходится/);
    fs.writeFileSync(s.log, lines.join('\n') + '\n');
    assert.equal(s.read().rev, 2);
  }],
  ['А32: замок определённого, но непроверяемого владельца не снимается по возрасту', () => {
    const s = isolated();
    const lockWith = (text, ageMs) => {
      fs.mkdirSync(path.dirname(s.lock), { recursive: true });
      fs.writeFileSync(s.lock, text);
      const at = new Date(Date.now() - ageMs);
      fs.utimesSync(s.lock, at, at);
    };
    // Живой владелец, процесс проверить нельзя: возраст не снимает замок.
    for (const code of ['EPERM', 'EACCES']) {
      lockWith(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 120000);
      const kill = process.kill;
      process.kill = () => { const e = Error('нет доступа'); e.code = code; throw e; };
      try { assert.throws(() => s.read(), /занят/); } finally { process.kill = kill; }
      assert(fs.existsSync(s.lock), 'замок сохранён при ' + code);
    }
    // Владелец не читается: решает возраст записи.
    lockWith('', 120000);
    assert.equal(s.read().rev, 0);
    assert(!fs.existsSync(s.lock));
    // Доказанно мёртвый PID снимается и без возраста.
    lockWith(JSON.stringify({ pid: 99999999 }), 0);
    assert.equal(s.read().rev, 0);
  }],
  ['А33: отказ записи members.lock виден сразу, гонка .acquire повторяется', () => {
    const s = isolated();
    const write = fs.writeFileSync; let ownerWrites = 0, lockWrites = 0;
    fs.writeFileSync = function (target, data, ...rest) {
      const owner = typeof target === 'number' && typeof data === 'string' && data.includes('"pid"');
      if (owner) {
        ownerWrites++;
        if (ownerWrites % 2 === 0) { lockWrites++; const e = Error('нет доступа к members.lock'); e.code = 'EACCES'; throw e; }
      }
      return write.call(fs, target, data, ...rest);
    };
    try { assert.throws(() => s.read(), e => e.code === 'EACCES' && !/занят/.test(e.message)); }
    finally { fs.writeFileSync = write; }
    assert.equal(lockWrites, 1, 'запись members.lock — ровно одна попытка');
    assert(ownerWrites <= 2, 'без повторов записи владельца: ' + ownerWrites);
    // EPERM на захвате .acquire — та же гонка: повторяем и завершаем успехом.
    const open = fs.openSync; let failures = 2;
    fs.openSync = function (file, flags, ...rest) {
      if (typeof file === 'string' && file.endsWith('.acquire') && flags === 'wx' && failures > 0) {
        failures--; const e = Error('нет доступа к .acquire'); e.code = 'EPERM'; throw e;
      }
      return open.call(fs, file, flags, ...rest);
    };
    try { assert.equal(s.read().rev, 0); } finally { fs.openSync = open; }
    assert.equal(failures, 0, 'захват повторён после EPERM');
  }],
]);
