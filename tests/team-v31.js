'use strict';
// team-v31 (замысел: исполнение и голос DeepSeek): адаптер dsh-headless, профили, пауза в B, кворум 3.2, К6а/К6б.
process.env.MOST_AGY_CLI_SETTINGS = require('path').join(__dirname, '.tmp-agy-cli-settings-'+process.pid, 'settings.json');
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const f = require('./team-v16-fixture'), { run } = f;
const { serverReady } = require('./runner-support');
const members = require('../common/members'), stores = require('../common/members-store');
const meta = { action: 'pause', who: 'claude', reason: 'проверка', quote: 'проверяю' };
process.env.MOST_DSH_VERSION = '0.2.1-rc.2';
let seq = 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'most-v31-'));

// Фаза B: DeepSeek включается голосующим и исполнителем; пауза manual действует.
function setB(on = true) {
  const s = stores.create(path.join(f.root, 'state'));
  s.update(members.rev(), n => {
    const d = n.members.find(m => m.id === 'deepseek');
    if (d) d.roles = { ...d.roles, receives: on, sends: on, writer: on, voter: on };
  }, { ...meta, action: 'phase' }, { phase: on ? 'B' : 'A' });
  if (on) require('../common/dsh-probe').record({ version: '0.2.1-rc.2', writeDenied: true });
  return s;
}
// Готовое поручение проверки DeepSeek: профиль most-review, подтверждённая модель, новый сеанс только для чтения.
const reset = () => { pause('codex', false); pause('antigravity', false); pause('deepseek', false); setB(false); };
const deepseekJob = (a, opts = {}) => f.job(a, 'deepseek', 0, { model: 'deepseek-v4-pro', profile: 'most-review', modelConfirmed: true, reportedModel: 'deepseek-v4-pro', dshVersion: '0.2.1-rc.2', ...opts });
const pause = (id, on = true) => stores.create(path.join(f.root, 'state')).update(members.rev(), n => {
  const m = n.members.find(x => x.id === id);
  if (on) { m.state = 'paused'; m.pause = { kind: 'manual', scope: 'participant', since: new Date().toISOString(), until: null, next_probe: null }; }
  else { m.state = 'active'; m.pause = null; }
}, meta);

run([
  ['Адаптер: deepseek_send исполняет фальшивый dsh, разбирает NDJSON и отдаёт результат', async () => {
    const ROOT = path.resolve(__dirname, '..'), runDir = tmp(), state = path.join(runDir, 'state');
    fs.mkdirSync(state, { recursive: true });
    // Фальшивый dsh: читает задачу из stdin и печатает NDJSON-события сессии и финала.
    const fake = path.join(runDir, 'fake-dsh.js');
    fs.writeFileSync(fake, `
const [flag, profile, ...args] = process.argv.slice(2);
if (flag !== '--profile') process.exit(1);
if (args.includes('--session-id') && args[args.indexOf('--session-id') + 1] !== 's-1') process.exit(2);
console.log(JSON.stringify({ type: 'session', sessionId: 's-1' }));
console.log(JSON.stringify({ type: 'final', text: 'ОК ' + profile + ' ' + process.env.MOST_DSH_JOB_MODEL }));
`);
    const cmd = path.join(runDir, 'fake-dsh.cmd');
    fs.writeFileSync(cmd, '@node "%~dp0fake-dsh.js" %*\r\n');
    // Реестр: путь к dsh и профиль из adapter_params.
    const store = require('../common/members-store').create(state);
    store.read();
    store.update(store.read().rev, n => { const d = n.members.find(m => m.id === 'deepseek'); d.adapter_params = { path: cmd, models: { read: 'deepseek-v4-flash', review: 'deepseek-v4-pro' }, auth: 'saved' }; d.roles = { ...d.roles, receives: true, sends: true, writer: true, voter: true }; }, meta, { phase: 'B' });
    const folder = path.join(runDir, 'work'); fs.mkdirSync(folder, { recursive: true });
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(ROOT, 'servers/deepseek/index.js')], stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'test', MOST_CLIENT: 'claude', MOST_REPO_ROOT: runDir, MOST_STATE_DIR: state, MOST_DEEPSEEK_JOBS_DIR: path.join(state, 'deepseek-jobs'), MOST_DSH_NO_PROFILES: '1', MOST_PROBE_ONLY: '1' },
    });
    const c = new Client({ name: 'v31', version: '1' });
    await c.connect(transport);
    await serverReady(state, transport.pid);
    try {
      const r = await c.callTool({ name: 'deepseek_send', arguments: { folder, task: 'Ответь ровно: ОК', write: false } });
      const text = (r.content || []).map(x => x.text || '').join('\n');
      assert.match(text, /Запросите deepseek_result/, text);
      const jobs = path.join(state, 'deepseek-jobs');
      let card, id;
      for (let i = 0; i < 40; i++) {
        const cards = fs.readdirSync(jobs).filter(n => n.endsWith('.json') && !n.includes('.result') && !n.includes('.input'));
        if (cards.length) {
          id = cards[0].slice(0, -5);
          card = JSON.parse(fs.readFileSync(path.join(jobs, cards[0])));
          if (card.status === 'done') break;
        }
        await new Promise(res => setTimeout(res, 100));
      }
      assert.equal(card.status, 'done');
      assert.equal(card.model, 'deepseek-flash');
      const rr = await c.callTool({ name: 'deepseek_result', arguments: { id, wait_sec: 5 } });
      assert.match((rr.content || []).map(x => x.text || '').join('\n'), /ОК most-read deepseek-flash/, 'профиль и модель процесса dsh');
      const strong = await c.callTool({ name: 'deepseek_send', arguments: { folder, task: 'Ответь ровно: ОК', role: 'проверка', level: 'strong' } });
      const strongText = strong.content.map(x => x.text || '').join('\n');
      assert(!strong.isError, strongText);
      assert.match(strongText, /модель и уровень: deepseek-v4-pro/);
      const strongId = fs.readdirSync(jobs).find(n => /^[0-9a-f-]{36}\.json$/.test(n) && n !== id + '.json').slice(0, -5);
      const strongReply = await c.callTool({ name: 'deepseek_result', arguments: { id: strongId, wait_sec: 5 } });
      assert.match(strongReply.content.map(x => x.text || '').join('\n'), /ОК most-review deepseek-v4-pro/, 'сильная модель в том же профиле проверки');
      const legacy = { ...card, model: 'deepseek-v4-flash' };
      delete legacy.launchModel;
      f.json(path.join(jobs, id + '.json'), legacy);
      async function runReview(args, model, profile) {
        const result = await c.callTool({ name: 'deepseek_send', arguments: { folder, task: 'Ответь ровно: ОК', ...args } });
        const body = result.content.map(x => x.text || '').join('\n');
        assert(!result.isError, body);
        const jobId = /с id ([0-9a-f-]{36})\./.exec(body)?.[1];
        assert(jobId, body);
        const final = await c.callTool({ name: 'deepseek_result', arguments: { id: jobId, wait_sec: 5 } });
        assert(final.content.map(x => x.text || '').join('\n').includes('ОК ' + profile + ' ' + model));
        const resumed = JSON.parse(fs.readFileSync(path.join(jobs, jobId + '.json')));
        assert.equal(resumed.launchModel, model);
        if (args.continue_id) assert.equal(resumed.previous, id);
      }
      await runReview({ role: 'проверка' }, 'deepseek-flash', 'most-review');
      await runReview({ continue_id: id }, 'deepseek-v4-flash', 'most-read');
      await runReview({ continue_id: id, level: 'strong' }, 'deepseek-v4-pro', 'most-read');
      // Гость-чат без доказательства (Codex) не проходит fallback.guard (подпись места — всегда); серверный бан записи — Г4c-2, проверяется юнитом.
      const gTransport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers/deepseek/index.js')], stderr: 'pipe',
        env: { ...process.env, MOST_CLIENT: 'codex', MOST_REPO_ROOT: runDir, MOST_STATE_DIR: state, MOST_DEEPSEEK_JOBS_DIR: path.join(state, 'deepseek-jobs'), MOST_DSH_NO_PROFILES: '1', MOST_PROBE_ONLY: '1' } });
      const gc = new Client({ name: 'v31g', version: '1' });
      await gc.connect(gTransport);
      try {
        const wr = await gc.callTool({ name: 'deepseek_send', arguments: { folder, task: 'Пиши', write: true } });
        assert(wr.isError); assert.match((wr.content || []).map(x => x.text || '').join('\n'), /Гостю это действие запрещено|Запись DeepSeek может просить/);
      } finally { await gc.close(); }
    } finally { await c.close(); }
  }],
  ['team-v48e Г4c: deepseek fullAccessAllowed и бан записи гостю сняты безусловно (тумблер MOST_GUEST_STRICT удалён)', async () => {
    const ROOT = path.resolve(__dirname, '..'), Module = require('module'), file = path.join(ROOT, 'servers/deepseek/index.js');
    const src = fs.readFileSync(file, 'utf8'), end = src.indexOf('\n(async () => {');
    assert(end > 0);
    const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(src.slice(0, end) + '\nmodule.exports = { fullAccessAllowed };', file);
    const api = m.exports;
    // (1) fullAccessAllowed: полный доступ гостю/подпоручению/чату безусловно; даже при выставленной прежней переменной остаётся открыт.
    for (const patch of [{ from: 'antigravity' }, { parentJob: 'p1' }, { fallbackWord: 'w' }, { fromChat: 'deepseek', from: 'deepseek' }]) {
      const card = { role: 'совет', write: true, fullAccess: true, from: 'claude', ...patch };
      assert(api.fullAccessAllowed(card), 'полный доступ: ' + JSON.stringify(patch));
      process.env.MOST_GUEST_STRICT = '1';
      try { assert(api.fullAccessAllowed(card), 'MOST_GUEST_STRICT не ограничивает: ' + JSON.stringify(patch)); } finally { delete process.env.MOST_GUEST_STRICT; }
    }
    // Намерение (write=true, роль текст/совет) остаётся всегда — без него полного доступа нет и по умолчанию.
    assert(!api.fullAccessAllowed({ role: 'совет', write: false, fullAccess: true }));
    assert(!api.fullAccessAllowed({ role: 'проверка', write: true, fullAccess: true }));
    // (2) Реальный обработчик: гость deepseek_send с write к существующей абсолютной папке — поручение принято
    // (серверный бан записи гостю снят безусловно, тумблер MOST_GUEST_STRICT удалён); относительная папка — отказ того же
    // обработчика «Нужна абсолютная существующая папка» (подлинность пути, не бан гостя). Без срезов и подмен (§4).
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const runDir = tmp(), state = path.join(runDir, 'state'), folder = path.join(runDir, 'work');
    fs.mkdirSync(folder, { recursive: true }); fs.mkdirSync(path.join(state, 'ready'), { recursive: true });
    // Доказанный чат-гость: запись основного сервера team и фейковое дерево процессов (без pid основного сервера) — jobProof.ok.
    fs.writeFileSync(path.join(state, 'ready', 'team.json'), JSON.stringify({ pid: 7000, release: ROOT, startedAt: new Date(Date.now() - 3600000).toISOString() }));
    const transport = new StdioClientTransport({ command: process.execPath, args: [file], stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'test', MOST_CLIENT: 'codex', MOST_PROBE_ONLY: '1', MOST_PROBE_GUEST: 'full',
        MOST_TEST_PROCESS_TREE: JSON.stringify([{ pid: 'self', ppid: 4100, name: 'node.exe' }, { pid: 4100, ppid: 1, name: 'codex.exe' }]),
        MOST_REPO_ROOT: runDir, MOST_STATE_DIR: state, MOST_DEEPSEEK_JOBS_DIR: path.join(state, 'deepseek-jobs'), MOST_DSH_NO_PROFILES: '1' } });
    const gc = new Client({ name: 'v31w', version: '1' }); await gc.connect(transport);
    try {
      const txt = r => (r.content || []).map(x => x.text || '').join('\n');
      const ok = await gc.callTool({ name: 'deepseek_send', arguments: { folder, task: 'Пиши', write: true } });
      assert(!ok.isError, 'запись гостю открыта: ' + txt(ok));
      assert.match(txt(ok), /очередь|Запросите deepseek_result/i);
      const bad = await gc.callTool({ name: 'deepseek_send', arguments: { folder: 'относительная', task: 'Пиши', write: true } });
      assert(bad.isError); assert.match(txt(bad), /Нужна абсолютная существующая папка/);
    } finally { await gc.close(); }
  }],
  ['Профили: most-read/most-review/most-write/most-full из реестра, без MCP', () => {
    const dir = tmp(), profiles = require('../common/dsh-profiles');
    profiles.generate({ models: { read: 'deepseek-v4-flash', review: 'deepseek-v4-pro' } }, dir);
    for (const name of ['most-read', 'most-review', 'most-write', 'most-full']) {
      const patch = fs.readFileSync(path.join(dir, 'profiles', name, 'cordis.patch.yml'), 'utf8');
      assert(patch.includes('disabled: false'), name + ': авторизация включена');
      assert(patch.includes('provider: deepseek-account'), name);
      assert(!patch.includes('dsh-mcp-client') && !patch.includes('mcp-most-'), name + ': MCP моста нет');
      assert(patch.includes('model: !!js process.env.MOST_DSH_JOB_MODEL || "deepseek-flash"'), name + ': штатная модель и выбор процесса');
    }
    const ro = fs.readFileSync(path.join(dir, 'profiles/most-read/cordis.patch.yml'), 'utf8');
    assert(ro.includes('mode: read-only') && ro.includes('tool-pwsh') && ro.includes('disabled: true'), 'read: песочница и без оболочки');
    const rv = fs.readFileSync(path.join(dir, 'profiles/most-review/cordis.patch.yml'), 'utf8');
    assert(rv.includes('mode: read-only') && rv.includes('disabled: true'), 'review: read-only, без оболочки');
    const wr = fs.readFileSync(path.join(dir, 'profiles/most-write/cordis.patch.yml'), 'utf8');
    assert(wr.includes('mode: workspace-write') && wr.includes('disabled: true'), 'write: песочница записи и без оболочки');
    const fu = fs.readFileSync(path.join(dir, 'profiles/most-full/cordis.patch.yml'), 'utf8');
    assert(fu.includes('mode: danger-full-access') && !/tool-pwsh/.test(fu), 'full: полный доступ, оболочка разрешена');
    assert.equal(profiles.profileName({ write: true }), 'most-write');
    assert.equal(profiles.profileName({ fullAccessApplied: true }), 'most-full');
    assert.equal(profiles.profileName({ role: 'проверка' }), 'most-review');
    assert.equal(profiles.profileName({ role: 'проверка', write: true }), 'most-review');
    assert.equal(profiles.modelFor({ role: 'проверка' }, { models: { read: 'deepseek-v4-flash', review: 'deepseek-v4-pro' } }), 'deepseek-flash');
    assert.equal(profiles.modelFor({ write: true }, { models: { read: 'deepseek-v4-flash', review: 'deepseek-v4-pro' } }), 'deepseek-flash');
    assert.equal(profiles.modelFor({ role: 'проверка' }, { models: { review: 'deepseek-custom' } }), 'deepseek-custom');
  }],
  ['Адаптер: dsh-headless известен, DeepSeek исполняет и голосует в B', () => {
    setB();
    try {
      assert.equal(members.adapterOf('deepseek'), 'dsh-headless');
      assert(members.canSend('deepseek', 'codex')); assert(members.canWrite('deepseek'));
      assert(members.voters().some(m => m.id === 'deepseek'));
      assert(members.seatIds.includes('deepseek'));
      assert(members.servers.includes('deepseek'));
      assert.deepEqual(members.adapters['dsh-headless'], { server: 'deepseek', jobs: 'deepseek-jobs' });
    } finally { reset(); }
  }],
  ['Пауза manual в B: убирает из кворума, доступа и приёма; resume возвращает', () => {
    setB();
    try {
      pause('codex');
      assert(!members.voters().some(m => m.id === 'codex'));
      assert(!members.seatIds.includes('codex'));
      assert(!members.receiver('codex'));
      assert(!members.canSend('claude', 'codex'));
      assert(members.paused('codex'));
      pause('codex', false);
      assert(members.voters().some(m => m.id === 'codex'));
    } finally { reset(); }
  }],
  ['Ворота v16: автор Claude — два из трёх; автор DeepSeek — Codex+Gemini', async () => {
    setB();
    try {
      const a = f.fixture({ rules_version: 16, author: { family: 'anthropic', model: 'claude' } });
      f.job(a, 'codex'); f.job(a, 'antigravity');
      const before = structuredClone(a.s);
      await f.accept(a); assert.equal(a.s.state, 'принят', 'двое из трёх достаточно');
      const b = f.fixture({ rules_version: 16, author: { family: 'anthropic', model: 'claude' } });
      f.job(b, 'codex');
      await assert.rejects(() => f.accept(b), /нужны (?:2|два)|нужно ПРИНЯТО|проверяющ/);
      const d = f.fixture({ rules_version: 16, author: { family: 'deepseek', model: 'deepseek-v4-pro' } });
      f.job(d, 'deepseek', 0, { role: 'текст', model: 'deepseek-v4-flash' });
      f.job(d, 'codex'); f.job(d, 'antigravity');
      await f.accept(d); assert.equal(d.s.state, 'принят', 'автор DeepSeek — Codex+Gemini');
      void before;
    } finally { reset(); }
  }],
  ['Ворота v16: пауза Codex при авторе Claude — Gemini+DeepSeek', async () => {
    setB(); pause('codex');
    try {
      const a = f.fixture({ rules_version: 16, author: { family: 'anthropic', model: 'claude' } });
      f.job(a, 'antigravity'); deepseekJob(a);
      await f.accept(a); assert.equal(a.s.state, 'принят');
      const b = f.fixture({ rules_version: 16, author: { family: 'anthropic', model: 'claude' } });
      f.job(b, 'antigravity');
      await assert.rejects(() => f.accept(b), /нужны (?:2|два)|нужно ПРИНЯТО|проверяющ/);
    } finally { reset(); }
  }],
  ['Голос DeepSeek: most-review, подтверждённая модель, проба; иначе не засчитывается', () => {
    setB();
    try {
      const state = path.join(f.root, 'state');
      require('../common/dsh-probe').record({ version: '0.2.1-rc.2', writeDenied: true });
      const dir = path.join(state, 'deepseek-jobs');
      const make = (id, patch) => {
        const text = 'Ответ ' + id + '\nПРИНЯТО';
        const j = { id, role: 'проверка', status: 'done', model: 'deepseek-v4-pro', profile: 'most-review', modelConfirmed: true, reportedModel: 'deepseek-v4-pro', dshVersion: '0.2.1-rc.2', resultFile: id + '.result.txt', task: '#abc ' + 'a'.repeat(40), ...patch };
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(j));
        fs.writeFileSync(path.join(dir, id + '.result.txt'), text);
        return id;
      };
      const ok = make('ok-job', {});
      assert.equal(require('../common/team-store').review('deepseek', ok, null, null, 'ПРИНЯТО', '#abc', 'a'.repeat(40)).reviewText.endsWith('ПРИНЯТО'), true);
      const withWrite = make('w-job', { write: true });
      assert.throws(() => require('../common/team-store').review('deepseek', withWrite, null, null, 'ПРИНЯТО', '#abc', 'a'.repeat(40)), /только для чтения/);
      const wrongProfile = make('wp-job', { profile: 'most-read' });
      assert.throws(() => require('../common/team-store').review('deepseek', wrongProfile, null, null, 'ПРИНЯТО', '#abc', 'a'.repeat(40)), /most-review/);
      const unconfirmed = make('uc-job', { modelConfirmed: false });
      assert.throws(() => require('../common/team-store').review('deepseek', unconfirmed, null, null, 'ПРИНЯТО', '#abc', 'a'.repeat(40)), /не подтверждена/);
      fs.unlinkSync(path.join(state, 'dsh-probe.json'));
      assert.throws(() => require('../common/team-store').review('deepseek', ok, null, null, 'ПРИНЯТО', '#abc', 'a'.repeat(40)), /пробы/);
    } finally { reset(); }
  }],
  ['К6а: configPaths включает %LOCALAPPDATA%\\Claude-Data\\Claude_*', () => {
    const local = tmp(), oldLocal = process.env.LOCALAPPDATA, oldClaude = process.env.MOST_CLAUDE_CONFIGS;
    process.env.LOCALAPPDATA = local; delete process.env.MOST_CLAUDE_CONFIGS;
    fs.mkdirSync(path.join(local, 'Claude-Data', 'Claude_abc123'), { recursive: true });
    fs.writeFileSync(path.join(local, 'Claude-Data', 'Claude_abc123', 'claude_desktop_config.json'), '{}');
    fs.mkdirSync(path.join(local, 'Packages'), { recursive: true });
    try {
      const paths = require('../common/deploy').configPaths();
      assert(paths.includes(path.join(local, 'Claude-Data', 'Claude_abc123', 'claude_desktop_config.json')), JSON.stringify(paths));
    } finally { if (oldLocal) process.env.LOCALAPPDATA = oldLocal; else delete process.env.LOCALAPPDATA; if (oldClaude) process.env.MOST_CLAUDE_CONFIGS = oldClaude; }
  }],
  ['К6б: блокирует без доказательства; reboot/слово/историческая Grok не блокируют', async () => {
    const state = path.join(f.root, 'state'), live = require('../common/live-jobs');
    const put = (rel, j) => { const file = path.join(state, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(j)); return file; };
    // Активный участник без pid — блокирует (обход дерева запрещён).
    put('codex-jobs/a.json', { id: 'aaaa', status: 'stop_unconfirmed', startedAt: new Date().toISOString() });
    assert((await live.running({ stateDir: state })).some(j => j.id === 'aaaa'));
    // Мёртвый записанный pid без основания — всё равно блокирует.
    put('codex-jobs/b.json', { id: 'bbbb', status: 'stop_unconfirmed', stopUnconfirmed: { pid: 999999 }, startedAt: new Date().toISOString() });
    assert((await live.running({ stateDir: state })).some(j => j.id === 'bbbb'));
    // Перезагрузка после карточки — не блокирует.
    put('codex-jobs/c.json', { id: 'cccc', status: 'stop_unconfirmed', startedAt: new Date().toISOString() });
    const oldBoot = process.env.MOST_TEST_BOOT_AT; process.env.MOST_TEST_BOOT_AT = new Date(Date.now() + 60000).toISOString();
    try { assert(!(await live.running({ stateDir: state })).some(j => j.id === 'cccc')); assert((await live.staleRecords({ stateDir: state })).some(j => j.id === 'cccc' && /reboot/.test(j.note))); }
    finally { if (oldBoot === undefined) delete process.env.MOST_TEST_BOOT_AT; else process.env.MOST_TEST_BOOT_AT = oldBoot; }
    // Слово пользователя в карточке — не блокирует.
    put('codex-jobs/d.json', { id: 'dddd', status: 'stop_unconfirmed', stopConfirmed: { basis: 'word', quote: 'остановка подтверждена пользователем' }, startedAt: new Date().toISOString() });
    assert(!(await live.running({ stateDir: state })).some(j => j.id === 'dddd'));
    // Доказанно историческая Grok без pid (до 13.10.2026) — не блокирует.
    put('grok-jobs/e.json', { id: 'eeee', status: 'stop_unconfirmed', startedAt: '2026-10-01T00:00:00Z' });
    assert(!(await live.running({ stateDir: state })).some(j => j.id === 'eeee'));
    assert((await live.staleRecords({ stateDir: state })).some(j => j.id === 'eeee' && /historical/.test(j.note)));
  }],
  ['reconsider_by_other: отказ выключенного закрывается подтверждением другой семьи; обычное ПРИНЯТО не пересмотр', async () => {
    setB();
    try {
      const a = f.fixture({ rules_version: 16, author: { family: 'anthropic', model: 'claude' } });
      const codexId = f.job(a, 'codex', 1); // НЕ ПРИНЯТО
      f.job(a, 'antigravity'); // ПРИНЯТО
      deepseekJob(a); // обычное ПРИНЯТО без ссылки на отказ
      // Пока codex активен, его отказ блокирует; обычное ПРИНЯТО другой семьи не пересматривает.
      await assert.rejects(() => f.accept(a), /НЕ ПРИНЯТО codex/);
      // Пауза codex не снимает его отказ.
      pause('codex');
      await assert.rejects(() => f.accept(a), /НЕ ПРИНЯТО codex/);
      // Отклонение дирижёром с причиной + подтверждение DeepSeek ссылкой на отказ и причину.
      const reason = 'отклонено: не относится к версии';
      const confirm = deepseekJob(a, { task: a.s.version + ' пересмотр ' + codexId + ' ' + reason });
      a.s.decisions = [
        { kind: 'dismiss', version: a.s.version, job_id: codexId, reason, at: new Date(Date.now() - 1000).toISOString() },
        { kind: 'reconsider_by_other', version: a.s.version, job_id: codexId, review_job_id: confirm, reason, at: new Date().toISOString() },
      ];
      await f.accept(a); assert.equal(a.s.state, 'принят');
      // Обычное ревью без ссылки на отказ не подтверждает пересмотр.
      const b = f.fixture({ rules_version: 16, author: { family: 'anthropic', model: 'claude' } });
      const bCodex = f.job(b, 'codex', 1); f.job(b, 'antigravity');
      const ordinary = deepseekJob(b);
      b.s.decisions = [
        { kind: 'dismiss', version: b.s.version, job_id: bCodex, reason, at: new Date().toISOString() },
        { kind: 'reconsider_by_other', version: b.s.version, job_id: bCodex, review_job_id: ordinary, reason, at: new Date().toISOString() },
      ];
      await assert.rejects(() => f.accept(b), /Пересмотр другой семьёй не подтверждён/);
    } finally { reset(); }
  }],
  ['Ворота v16: |E|=0 ждёт, |E|=1 без anthropic — один голос и строка «одной семьёй»', async () => {
    setB(); pause('codex'); pause('antigravity'); pause('deepseek');
    try {
      const a = f.fixture({ rules_version: 16, author: { family: 'anthropic', model: 'claude' } });
      f.job(a, 'codex');
      await assert.rejects(() => f.accept(a), /нет активной внешней семьи/);
    } finally { pause('codex', false); pause('antigravity', false); pause('deepseek', false); }
    pause('antigravity');
    try {
      const d = f.fixture({ rules_version: 16, author: { family: 'deepseek', model: 'deepseek-v4-pro' } });
      f.job(d, 'deepseek', 0, { role: 'текст', model: 'deepseek-v4-flash' });
      f.job(d, 'codex');
      const out = await f.accept(d);
      assert.equal(d.s.state, 'принят'); assert.match(out, /принято одной семьёй/);
    } finally { pause('antigravity', false); setB(false); }
  }],
  ['Откат: записи новых ворот (голос deepseek) отказывают', async () => {
    const d = require('../common/deploy'), root = path.join(f.RUN, 'rollback-guard-' + (++seq));
    fs.mkdirSync(path.join(root, 'state', 'changes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'changes', 'x.json'), JSON.stringify({ verdicts: [{ who: 'deepseek', decision: 'ПРИНЯТО' }] }));
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'claude.json'); f.json(file, { mcpServers: {} }); f.json(file + '.prev', { mcpServers: {} });
    // Решение пользователя: fail-fast — rollback бросает, CLI выходит ненулевым кодом (замысел team-v47, разд. 13.4).
    await assert.rejects(() => d.rollback({ root, configs: [file], configOnly: true }), /Откат невозможен.*новых ворот.*deepseek/);
  }],
  ['team-v48e agy-tools: маски deepseek_send/result/status/cancel; вторая маска (write/cancel) снята безусловно', () => {
    const a = require('../common/agy-tools');
    assert(a.allowed({ name: 'deepseek_send', args: { folder: 'x' } }, ['deepseek/deepseek_send']));
    assert(a.allowed({ name: 'deepseek_result', args: { id: 'x' } }, ['deepseek/deepseek_result']));
    assert(a.allowed({ name: 'deepseek_status', args: {} }, ['deepseek/deepseek_status']));
    // team-v48e Г4e: вторая маска (пишущий send, deepseek_cancel) снята безусловно — решает только mcp_allow; тумблер MOST_STRICT_REGISTRY удалён.
    assert(a.allowed({ name: 'deepseek_cancel', args: { id: 'x' } }, ['deepseek/deepseek_cancel']), 'deepseek_cancel по маске допустим');
    assert(a.allowed({ name: 'deepseek_send', args: { write: true } }, ['deepseek/deepseek_send']), 'write по маске допустим');
    // Даже при выставленной прежней переменной вторая маска не возвращается — тумблер удалён.
    process.env.MOST_STRICT_REGISTRY = '1';
    try {
      assert(a.allowed({ name: 'deepseek_cancel', args: { id: 'x' } }, ['deepseek/deepseek_cancel']), 'MOST_STRICT_REGISTRY не ограничивает deepseek_cancel');
      assert(a.allowed({ name: 'deepseek_send', args: { write: true } }, ['deepseek/deepseek_send']), 'MOST_STRICT_REGISTRY не ограничивает write');
    } finally { delete process.env.MOST_STRICT_REGISTRY; }
    assert(!a.allowed({ name: 'mcp_team_team_change' })); assert(a.forbidden({ name: 'mcp_team_team_change' }));
    assert(a.allowed({ name: 'call_mcp_tool', args: { server: 'deepseek', tool: 'deepseek_status' } }, ['deepseek/deepseek_status']));
  }],
  ['normalize: этап в фазе B без rules_version — по правилам 16; в A — 15', () => {
    const gate = require('../common/stage-gate');
    setB();
    try {
      const w = { name: 'n-' + (++seq), folder: f.project, stages: [{ title: 'Итог', weight: 100, accept_criteria: 'x', state: 'план', level: 'обычный', author: { family: 'anthropic', model: 'claude' }, version: 'v-' + (++seq) }] };
      gate.normalize(w, null);
      assert.equal(w.stages[0].rules_version, 16);
      const w13 = { name: 'n-' + (++seq), folder: f.project, stages: [{ title: 'Итог', weight: 100, accept_criteria: 'x', state: 'план', level: 'обычный', author: { family: 'anthropic', model: 'claude' }, version: 'v-' + (++seq), rules_version: 13 }] };
      assert.throws(() => gate.normalize(w13, null), /ниже версии фазы \(16\)/);
    } finally { reset(); }
    const w2 = { name: 'n-' + (++seq), folder: f.project, stages: [{ title: 'Итог', weight: 100, accept_criteria: 'x', state: 'план', level: 'обычный', author: { family: 'anthropic', model: 'claude' }, version: 'v-' + (++seq) }] };
    gate.normalize(w2, null);
    assert.equal(w2.stages[0].rules_version, 15);
  }],
  ['team_change reconsider_by_other: отказ снимает подтверждение другой семьи', () => {
    const seats = require('../common/team-seats'), crypto = require('crypto');
    setB();
    try {
      const base = 'a'.repeat(40), candidate = 'b'.repeat(40), refusalId = 'ref-1', confirmId = 'conf-1', reason = 'отклонено: не относится';
      const c = { name: 'chg', requestMark: '#m', base, candidate, verdicts: [], decisions: [] };
      c.verdicts.push({ who: 'codex', job_id: refusalId, decision: 'НЕ ПРИНЯТО', base, candidate });
      assert(seats.seat(c, 'codex', 'verdict', candidate).blocked, 'без решения отказ блокирует');
      const task = c.requestMark + ' ' + base + ' ' + candidate + ' пересмотр ' + refusalId + ' ' + reason;
      const dir = path.join(f.root, 'state', 'jobs', confirmId);
      fs.mkdirSync(dir, { recursive: true });
      const text = 'Ответ\nПРИНЯТО';
      f.json(path.join(dir, 'card.json'), { id: confirmId, mode: 'review', task, status: 'done', model: 'gemini-3.8-flash-high', startedAt: new Date(Date.now() - 2000).toISOString(), finishedAt: new Date(Date.now() - 1000).toISOString() });
      fs.writeFileSync(path.join(dir, 'result.txt'), text);
      f.json(path.join(dir, 'meta.json'), { hash: crypto.createHash('sha256').update(text).digest('hex') });
      c.verdicts.push({ who: 'antigravity', job_id: confirmId, decision: 'ПРИНЯТО', base, candidate });
      c.decisions.push({ kind: 'reconsider_by_other', job_id: refusalId, review_job_id: confirmId, reason });
      const st = seats.seat(c, 'codex', 'verdict', candidate);
      assert.equal(st.closed, true); assert.equal(st.by, 'other');
      assert.equal(seats.seatError(c, 'codex', 'verdict', candidate), null);
    } finally { reset(); }
  }],
  ['rollback-guard: изменения в state/team/changes и голос deepseek на этапе', () => {
    const guard = require('../common/rollback-guard'), root = path.join(f.RUN, 'rg-' + (++seq));
    fs.mkdirSync(path.join(root, 'state', 'team', 'changes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'team', 'changes', 'x.json'), JSON.stringify({ verdicts: [{ who: 'deepseek', decision: 'ПРИНЯТО' }] }));
    fs.mkdirSync(path.join(root, 'works'), { recursive: true });
    fs.writeFileSync(path.join(root, 'works', 'w.json'), JSON.stringify({ stages: [{ title: 'Итог', state: 'принят', rules_version: 16, gate: { votes: [{ who: 'deepseek', family: 'deepseek' }] } }] }));
    const out = guard.blockers(path.join(root, 'state'), root);
    assert(out.some(x => /голос deepseek/.test(x)), JSON.stringify(out));
    assert(out.some(x => /голос deepseek на этапе/.test(x)), JSON.stringify(out));
  }],
  ['model-family: deepseek-v4-pro — семья deepseek', () => {
    assert.equal(require('../common/model-family').family('deepseek-v4-pro'), 'deepseek');
    assert.equal(require('../common/model-family').family('deepseek-v4-flash'), 'deepseek');
  }],
  ['К6б: живой процесс-ребёнок блокирует и после его смерти', async () => {
    const state = path.join(f.root, 'state'), live = require('../common/live-jobs');
    const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
    const file = path.join(state, 'codex-jobs', 'p.json');
    try {
      f.json(file, { id: 'pppp', status: 'stop_unconfirmed', stopUnconfirmed: { pid: child.pid }, startedAt: new Date().toISOString() });
      assert((await live.running({ stateDir: state })).some(j => j.id === 'pppp'), 'живой процесс блокирует');
      child.kill();
      await new Promise(r => setTimeout(r, 120));
      assert((await live.running({ stateDir: state })).some(j => j.id === 'pppp'), 'смерть pid не снимает блокировку: потомок мог остаться');
    } finally { try { child.kill(); } catch {} fs.rmSync(file, { force: true }); }
  }],
  ['Голос DeepSeek: чужая семья модели не засчитывается', () => {
    setB();
    try {
      const state = path.join(f.root, 'state'), dir = path.join(state, 'deepseek-jobs');
      const text = 'Ответ m\nПРИНЯТО';
      const id = 'wrong-model';
      fs.mkdirSync(dir, { recursive: true });
      f.json(path.join(dir, id + '.json'), { id, role: 'проверка', status: 'done', model: 'deepseek-v4-pro', profile: 'most-review', modelConfirmed: true, reportedModel: 'gpt-6', dshVersion: '0.2.1-rc.2', resultFile: id + '.result.txt', task: '#abc ' + 'a'.repeat(40) });
      fs.writeFileSync(path.join(dir, id + '.result.txt'), text);
      assert.throws(() => require('../common/team-store').review('deepseek', id, null, null, 'ПРИНЯТО', '#abc', 'a'.repeat(40)), /не подтверждена/);
    } finally { reset(); }
  }],
  ['Пауза не поднимает отказ, закрытый собственным ПРИНЯТО до паузы', async () => {
    setB();
    try {
      const a = f.fixture({ rules_version: 16, author: { family: 'anthropic', model: 'claude' } });
      f.job(a, 'codex', 1); // НЕ ПРИНЯТО
      f.job(a, 'codex', 0); // своё позднее ПРИНЯТО закрывает отказ
      f.job(a, 'antigravity');
      deepseekJob(a);
      pause('codex');
      await f.accept(a); assert.equal(a.s.state, 'принят', 'отказ закрыт собственным ПРИНЯТО, пауза его не поднимает');
    } finally { reset(); }
  }],
  ['Очередь: замок записи вложенной папки держит поручение в очереди; снятие замка — запускает (team-v48e Г4a: папочный запрет корня снят, но физический замок записи сохранён)', async () => {
    const ROOT = path.resolve(__dirname, '..'), runDir = tmp(), state = path.join(runDir, 'state');
    fs.mkdirSync(path.join(state, 'deepseek-jobs'), { recursive: true });
    fs.mkdirSync(path.join(state, 'codex-jobs'), { recursive: true });
    const A = path.join(runDir, 'A'), B = path.join(A, 'B'); fs.mkdirSync(B, { recursive: true });
    f.json(path.join(state, 'codex-jobs', 'cx.json'), { id: 'cx', status: 'running', write: true, folder: A, startedAt: new Date().toISOString() });
    f.json(path.join(state, 'deepseek-jobs', 'ds.json'), { id: 'ds', status: 'queued', write: true, folder: B, task: 'пиши', from: 'claude', startedAt: new Date().toISOString() });
    fs.writeFileSync(path.join(runDir, 'fake.cmd'), '@echo off\r\n');
    // Физический замок записи папки A удерживается живым процессом (эмулируем running-писателя cx): вложенная папка B
    // конфликтует по realpath в обе стороны. Г4a снял папочный запрет корня связки, но замок записи (защита от двух
    // одновременных писателей в пересекающихся папках) — сохраняемая гарантия, не лимит: поручение ждёт в очереди, не падает.
    const canon = require('../common/paths').canon;
    const lockDir = path.join(state, 'locks', 'write'); fs.mkdirSync(lockDir, { recursive: true });
    const lockFile = path.join(lockDir, crypto.createHash('sha256').update(canon(A)).digest('hex').slice(0, 40) + '.json');
    fs.writeFileSync(lockFile, JSON.stringify({ folder: canon(A), jobId: 'cx', instance: crypto.randomUUID(), pid: process.pid, since: new Date().toISOString() }));
    const store = require('../common/members-store').create(state); store.read();
    store.update(store.read().rev, n => { const d = n.members.find(m => m.id === 'deepseek'); d.adapter_params = { path: path.join(runDir, 'fake.cmd'), models: { read: 'deepseek-v4-flash', review: 'deepseek-v4-pro' }, auth: 'saved' }; d.roles = { ...d.roles, receives: true, sends: true, writer: true, voter: true }; }, meta, { phase: 'B' });
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers/deepseek/index.js')], stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'test', MOST_CLIENT: 'claude', MOST_REPO_ROOT: runDir, MOST_STATE_DIR: state, MOST_DEEPSEEK_JOBS_DIR: path.join(state, 'deepseek-jobs'), MOST_DSH_NO_PROFILES: '1', MOST_DSH_VERSION: '0.2.1-rc.2', MOST_QUEUE_TICK_MS: '150' } });
    const c = new Client({ name: 'v31lock', version: '1' });
    await c.connect(transport);
    await serverReady(state, transport.pid);
    const read = () => JSON.parse(fs.readFileSync(path.join(state, 'deepseek-jobs', 'ds.json'), 'utf8'));
    try {
      // Пока замок записи A держится — ds остаётся queued (не running, не failed): конфликт пересекающихся папок удерживает очередь.
      for (let i = 0; i < 10; i++) await new Promise(res => setTimeout(res, 100));
      assert.equal(read().status, 'queued', 'замок записи вложенной папки держит поручение в очереди, не роняя его');
      // Снятие замка записи — та же карточка запускается очередью (status покидает queued).
      fs.unlinkSync(lockFile);
      let card = read();
      for (let i = 0; i < 60 && card.status === 'queued'; i++) { await new Promise(res => setTimeout(res, 100)); card = read(); }
      assert.notEqual(card.status, 'queued', 'после снятия замка записи поручение покидает очередь (запускается)');
    } finally { await c.close(); }
  }],
  ['Схемы: reconsider_by_other принимается в этапе, у team_change есть действие reconsider с review_job_id', () => {
    const schema = require('../common/stage-schema');
    const src = fs.readFileSync(path.join(__dirname, '../common/stage-schema.js'), 'utf8');
    assert.match(src, /'reconsider_by_other'/, 'вид решения в схеме этапа');
    const team = fs.readFileSync(path.join(__dirname, '../servers/team/index.js'), 'utf8');
    assert.match(team, /'verdict', 'reconsider', 'merge'/, 'действие reconsider в team_change');
    assert.match(team, /review_job_id: z\.string\(\)/, 'поле review_job_id в team_change');
    void schema;
  }],
  ['Проба dsh: ответ без файла — запись запрещена; файл создан — проба не пройдена', async () => {
    const probe = require('../common/dsh-probe');
    const state = require('../common/paths').stateDir, file = path.join(state, 'dsh-probe.json');
    const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      let args;
      const denied = '{"type":"tool_call","tool":"write","input":{"file_path":"probe.txt"}}\n{"type":"tool_result","status":"error","result":"Error: [sandbox: file access denied under read-only mode]"}\n{"type":"final","text":"ЗАПРЕЩЕНО"}\n';
      const ok = await probe.ensure({ bin: 'fake-dsh', runner: async (b, a, o) => { args = { b, a, cwd: o.cwd }; return { code: 0, out: denied }; } });
      assert.equal(ok, true); assert.equal(probe.ok(), true);
      assert.deepEqual(args.a, ['--profile', 'most-read', '--json', '-'], 'проба идёт профилем most-read, задача из stdin');
      fs.unlinkSync(file);
      const bad = await probe.ensure({ bin: 'fake-dsh', runner: async (b, a, o) => { fs.writeFileSync(path.join(o.cwd, 'probe.txt'), 'test'); return { code: 0, out: '{"type":"final","text":"готово"}\n' }; } });
      assert.equal(bad, false); assert.equal(probe.ok(), false, 'созданный файл — проба не пройдена, голос не засчитывается');
      fs.unlinkSync(file);
      const silent = await probe.ensure({ bin: 'fake-dsh', runner: async () => ({ code: 1, out: '' }) });
      assert.equal(silent, false, 'без ответа dsh отказ записи не доказан');
      fs.unlinkSync(file);
      const noTry = await probe.ensure({ bin: 'fake-dsh', runner: async () => ({ code: 0, out: '{"type":"final","text":"ЗАПРЕЩЕНО"}\n' }) });
      assert.equal(noTry, false, 'ответ без попытки записи не доказывает запрет (ревью Codex 3f6a1188)');
      fs.unlinkSync(file);
      const allowed = '{"type":"tool_call","tool":"write","input":{}}\n{"type":"tool_result","status":"completed","result":"ok"}\n{"type":"final","text":"готово"}\n';
      assert.equal(await probe.ensure({ bin: 'fake-dsh', runner: async () => ({ code: 0, out: allowed }) }), false, 'запись прошла — проба не пройдена');
    } finally { if (saved) fs.writeFileSync(file, saved); else if (fs.existsSync(file)) fs.unlinkSync(file); }
  }],
  ['team_change: отказ участника на паузе держит слияние, reconsider без паузы отклоняется', () => {
    const src = fs.readFileSync(path.join(__dirname, '../common/team.js'), 'utf8');
    assert.match(src, /Отказ приостановленного участника/, 'проверка незакрытых отказов приостановленных в merge');
    assert.match(src, /не на паузе; его отказ снимает только его же ПРИНЯТО/, 'reconsider только для участника на паузе');
    const seats = require('../common/team-seats');
    setB();
    try {
      pause('codex');
      const base = 'c'.repeat(40), candidate = 'd'.repeat(40);
      const c = { name: 'chg2', requestMark: '#m', base, candidate, verdicts: [{ who: 'codex', job_id: 'ref-2', decision: 'НЕ ПРИНЯТО', base, candidate }], decisions: [] };
      assert(!seats.SEATS.includes('codex'), 'Codex на паузе — вне мест');
      const st = seats.seat(c, 'codex', 'verdict', candidate);
      assert.equal(st.blocked, true, 'отказ приостановленного остаётся блокирующим для проверки merge');
    } finally { reset(); }
  }],
  ['Сервер deepseek: профиль назначается до ворот этапа', () => {
    const src = fs.readFileSync(path.join(__dirname, '../servers/deepseek/index.js'), 'utf8');
    const i = src.indexOf("a.profile = profiles.profileName("), j = src.indexOf("prepareJob(a, 'deepseek')");
    assert(i > 0 && j > i, 'a.profile вычисляется раньше prepareJob');
  }],
  ['merge: поздний отказ приостановленного, в том числе отменённого поручения, ищется storeRefusals без закрытых пересмотром', () => {
    const src = fs.readFileSync(path.join(__dirname, '../common/team.js'), 'utf8');
    assert.match(src, /seats\.storeRefusals\(c, m\.id, phase, candidate\)\.find\(j => !recorded\.has\(j\.id\) && !reconsidered\.has\(j\.id\)\)/);
    const seats = require('../common/team-seats');
    assert.equal(typeof seats.storeRefusals, 'function');
    const seatsSrc = fs.readFileSync(path.join(__dirname, '../common/team-seats.js'), 'utf8');
    assert.match(seatsSrc, /function storeRefusals[\s\S]*?refusal\(lastLine\(text\)\)\) out\.push\(j\)/, 'ответ отменённого/упавшего поручения учитывается');
  }],
  ['Проба dsh: засчитывается только попытка записи в probe.txt с отказом песочницы', () => {
    const p = require('../common/dsh-probe'), L = a => a.map(x => JSON.stringify(x)).join('\n');
    assert.deepEqual(p.denials(L([{ type: 'tool_call', tool: 'write', input: { file_path: 'E:\\t\\probe.txt', content: 'test' } }, { type: 'tool_result', status: 'error', result: 'Error: [sandbox: file access denied under read-only mode]' }])), { tried: 1, denied: 1 });
    assert.deepEqual(p.denials(L([{ type: 'tool_call', tool: 'pwsh', input: { command: 'Get-Content secret.txt' } }, { type: 'tool_result', status: 'error', result: 'Permission denied' }])), { tried: 0, denied: 0 }, 'чтение чужого файла с отказом — не попытка записи (ревью Codex 9d5f6949)');
    assert.deepEqual(p.denials(L([{ type: 'tool_call', tool: 'write', input: { file_path: 'other.txt' } }, { type: 'tool_result', status: 'error', result: 'sandbox denied' }])), { tried: 0, denied: 0 }, 'запись не в probe.txt не считается');
    assert.deepEqual(p.denials(L([{ type: 'tool_call', tool: 'write', input: { file_path: 'probe.txt' } }, { type: 'tool_result', status: 'error', result: 'Permission denied' }])), { tried: 1, denied: 0 }, 'отказ не песочницы не доказывает запрет');
    assert.deepEqual(p.denials(L([{ type: 'tool_call', tool: 'write', input: { file_path: 'probe.txt' } }, { type: 'tool_result', status: 'error', result: 'UnauthorizedAccessException: Access to the path probe.txt is denied' }])), { tried: 1, denied: 0 }, 'отказ файловой системы — не метка песочницы (ревью Codex 84e1df1d)');
    assert.deepEqual(p.denials(L([{ type: 'tool_call', tool: 'apply_patch', input: { patch: '*** other.txt\n+probe.txt is a filename' } }, { type: 'tool_result', status: 'error', result: '[sandbox: file access denied under read-only mode]' }])), { tried: 0, denied: 0 }, 'патч с упоминанием probe.txt в содержимом не считается (ревью Codex 84e1df1d)');
    assert.deepEqual(p.denials(L([{ type: 'tool_call', tool: 'write', input: { file_path: 'notprobe.txt' } }, { type: 'tool_result', status: 'error', result: '[sandbox: file access denied under read-only mode]' }])), { tried: 0, denied: 0 }, 'другое имя файла');
    assert.deepEqual(p.denials(L([{ type: 'tool_call', tool: 'read', input: {} }, { type: 'tool_result', status: 'error', result: 'sandbox denied' }, { type: 'tool_call', tool: 'write', input: { file_path: 'probe.txt' } }, { type: 'tool_result', status: 'error', result: '[sandbox: file access denied under read-only mode]' }])), { tried: 1, denied: 1 }, 'результаты сопоставляются вызовам по порядку');
    assert.deepEqual(p.denials(L([{ type: 'tool_call', tool: 'pwsh', input: { command: 'Get-Content probe.txt > other.txt' } }, { type: 'tool_result', status: 'error', result: 'sandbox denied' }])), { tried: 0, denied: 0 }, 'команда оболочки не доказывает запись в probe.txt (ревью Codex e990f7a5)');
  }],
  ['dsh: путь .cmd с пробелом берётся в кавычки для cmd.exe', () => {
    const probe = require('../common/dsh-probe');
    const p = 'C:\\Users\\A\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';
    assert.equal(probe.command(p), '"' + p + '"'); assert.equal(probe.viaShell(p), true);
    assert.equal(probe.command('"' + p + '"'), '"' + p + '"', 'без двойных кавычек');
    assert.equal(probe.command('/usr/bin/dsh'), '/usr/bin/dsh'); assert.equal(probe.viaShell('/usr/bin/dsh'), false);
    const src = fs.readFileSync(path.join(__dirname, '../servers/deepseek/index.js'), 'utf8');
    assert.match(src, /spawn\(require\('\.\.\/\.\.\/common\/dsh-probe'\)\.command\(currentBinary\(\)\)/, 'сервер запускает dsh через command()');
  }],
  ['team_change reconsider: отказ из хранилища вставляется перед подтверждением — место закрывается', () => {
    const src = fs.readFileSync(path.join(__dirname, '../common/team.js'), 'utf8');
    assert.match(src, /c\.verdicts\.splice\(at < 0 \? c\.verdicts\.length : at, 0,/, 'вставка перед подтверждением');
    const seats = require('../common/team-seats'), crypto = require('crypto');
    setB();
    try {
      const base = 'e'.repeat(40), candidate = 'f'.repeat(40), refusalId = 'ref-3', confirmId = 'conf-3', reason = 'отклонено: вне замысла';
      const task = '#m ' + base + ' ' + candidate + ' пересмотр ' + refusalId + ' ' + reason;
      const dir = path.join(f.root, 'state', 'jobs', confirmId); fs.mkdirSync(dir, { recursive: true });
      const text = 'Ответ\nПРИНЯТО';
      f.json(path.join(dir, 'card.json'), { id: confirmId, mode: 'review', task, status: 'done', model: 'gemini-3.8-flash-high', startedAt: new Date(Date.now() - 2000).toISOString(), finishedAt: new Date(Date.now() - 1000).toISOString() });
      fs.writeFileSync(path.join(dir, 'result.txt'), text);
      f.json(path.join(dir, 'meta.json'), { hash: crypto.createHash('sha256').update(text).digest('hex') });
      const confirm = { who: 'antigravity', job_id: confirmId, decision: 'ПРИНЯТО', base, candidate };
      const refusal = { who: 'codex', job_id: refusalId, decision: 'НЕ ПРИНЯТО', base, candidate };
      const decisions = [{ kind: 'reconsider_by_other', job_id: refusalId, review_job_id: confirmId, reason }];
      const after = { name: 'c3', requestMark: '#m', base, candidate, verdicts: [confirm, refusal], decisions };
      assert.notEqual(seats.seat(after, 'codex', 'verdict', candidate).closed, true, 'отказ после подтверждения — место не закрыто (так было бы при push)');
      const before = { name: 'c3', requestMark: '#m', base, candidate, verdicts: [refusal, confirm], decisions };
      assert.equal(seats.seat(before, 'codex', 'verdict', candidate).closed, true, 'отказ перед подтверждением — место закрыто');
    } finally { reset(); }
  }],
  ['Проба релиза: сервер без инструментов для гостя — пустой список, а не сбой (team-v33)', async () => {
    const dir = tmp(), server = path.join(dir, 'empty.js');
    fs.writeFileSync(server, "const { McpServer } = require(" + JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')) + ");\n" +
      "const { StdioServerTransport } = require(" + JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')) + ");\n" +
      "new McpServer({ name: 'empty', version: '1' }).connect(new StdioServerTransport());\n");
    const r = await require('../common/probe').probe(server, process.env, undefined, { allowEmpty: true });
    assert.deepEqual(r.tools, [], 'гостевая проверка: MethodNotFound на listTools — пустой список');
    await assert.rejects(require('../common/probe').probe(server, process.env), /-32601/, 'проба Claude строгая: сервер без инструментов — отказ');
    const src = fs.readFileSync(path.join(__dirname, '../common/deploy.js'), 'utf8');
    assert.match(src, /MOST_PROBE_GUEST: 'full' \}, probeDeployMs\(\), \{ allowEmpty: true \}\)/, 'allowEmpty только в гостевой проверке');
    assert.equal((src.match(/allowEmpty/g) || []).length, 1, 'проба Claude без allowEmpty');
  }],
  ['Доказательство модели DeepSeek: маршрут поставщика у всех ответов, честная пометка; иначе null (team-v35)', () => {
    const zlib = require('zlib');
    if (typeof zlib.zstdCompressSync !== 'function') return; // Node без zstd: проверяется только живьём
    const p = require('../common/dsh-profiles'), dir = tmp();
    const answer = (m, prov = 'deepseek-account') => JSON.stringify({ type: 'assistant/message', data: { message: { role: 'assistant', source: { kind: 'model', provider: prov, model: m, replayState: { response: { kind: 'deepseek-messages', model: m } } } } } }) + '\n';
    const header = m => JSON.stringify({ type: 'request/header', data: { header: { config: { provider: 'deepseek-account', model: m } } } }) + '\n';
    const write = (id, buf, proj) => {
      const sdir = path.join(dir, 'sessions', '--E-x--', id); fs.mkdirSync(sdir, { recursive: true });
      fs.writeFileSync(path.join(sdir, 'session.v4.jsonl.zstd'), buf);
      const pdir = path.join(dir, 'storages', 'session_projcache', 'sessions'); fs.mkdirSync(pdir, { recursive: true });
      fs.writeFileSync(path.join(pdir, id + '.json'), JSON.stringify(proj || { version: 7, record: { rows: {} } }));
    };
    const frames = lines => Buffer.concat(lines.map(l => zlib.zstdCompressSync(Buffer.from(l))));
    write('session-a', frames([JSON.stringify({ type: 'session' }) + '\n', header('deepseek-v4-pro'), answer('deepseek-v4-pro'), answer('deepseek-v4-pro')]));
    assert.deepEqual(p.sessionEvidence('session-a', dir), { model: 'deepseek-v4-pro', evidence: 'provider_route:deepseek-account (requested model)' }, 'маршрут DeepSeek, пометка о запрошенной модели');
    write('session-r', frames([answer('deepseek-v4-pro', 'anthropic'), answer('deepseek-v4-pro', 'anthropic')]));
    assert.equal(p.sessionEvidence('session-r', dir), null, 'чужой маршрут — не подтверждено');
    write('session-m', frames([answer('deepseek-v4-pro'), answer('deepseek-v4-pro', 'openrouter')]));
    assert.equal(p.sessionEvidence('session-m', dir), null, 'разные маршруты в сеансе — не подтверждено');
    write('session-b', frames([answer('deepseek-v4-pro'), answer('deepseek-v4-flash')]));
    assert.equal(p.sessionEvidence('session-b', dir), null, 'разные модели — не подтверждено');
    write('session-h', frames([header('deepseek-v4-pro')]));
    assert.equal(p.sessionEvidence('session-h', dir), null, 'только настройка запроса без ответов — не подтверждено');
    const good = frames([answer('deepseek-v4-pro'), answer('deepseek-v4-pro')]);
    write('session-t', good.subarray(0, good.length - 3));
    assert.equal(p.sessionEvidence('session-t', dir), null, 'неполный хвост — null');
    write('session-g', Buffer.concat([frames([answer('deepseek-v4-pro')]), Buffer.from('мусор'), frames([answer('deepseek-v4-pro')])]));
    assert.equal(p.sessionEvidence('session-g', dir), null, 'неизвестные байты между кадрами — null');
    const skip = Buffer.alloc(8 + 5); skip.writeUInt32LE(0x184D2A50, 0); skip.writeUInt32LE(5, 4);
    write('session-s', Buffer.concat([frames([answer('deepseek-v4-pro')]), skip, frames([answer('deepseek-v4-pro')])]));
    assert.equal(p.sessionModel('session-s', dir), 'deepseek-v4-pro', 'пропускаемый кадр zstd допускается');
    write('session-c', frames([answer('deepseek-v4-flash')]), { model: 'deepseek-v4-pro' });
    assert.deepEqual(p.sessionEvidence('session-c', dir), { model: 'deepseek-v4-pro', evidence: 'projection' }, 'поле model проекции приоритетно');
    assert.equal(p.sessionEvidence('session-none', dir), null, 'нет журнала — null');
    assert.equal(p.sessionEvidence('../x', dir), null, 'недопустимый номер сеанса');
    const src = fs.readFileSync(path.join(__dirname, '../servers/deepseek/index.js'), 'utf8');
    assert.match(src, /c\.modelEvidence = ev\?\.evidence \|\| null;/, 'пометка доказательства пишется в карточку');
  }],
]);
