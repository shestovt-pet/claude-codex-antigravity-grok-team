'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const fx = require('./team-v16-fixture');
const { fixture, job, fresh, accept, gate, stores, write, json, project, root, RUN, run } = fx;
const tests = [], test = (n, f) => tests.push([n, f]);
const members = require('../common/members'), cc = require('../common/client-configs'), deploy = require('../common/deploy');
const release = path.join(root, 'live', 'a'.repeat(40)), state = path.join(root, 'state');
const oldGrok = { command: 'node', args: [path.join(release, 'servers/grok/index.js')], env: { MOST_REPO_ROOT: root } };
test('О1: подключения, разрешения, сравнение и повтор установки', () => {
  assert.deepEqual(members.servers, ['team', 'codex', 'antigravity']);
  for (const kind of ['claude', 'agy']) {
    const base = { mcpServers: { grok: oldGrok } };
    const next = kind === 'claude' ? deploy.configFor(base, release, root) : cc.jsonConfig(base, kind, release, root, state, 'node');
    assert(!next.mcpServers.grok);
    assert.deepEqual(Object.keys(next.mcpServers).sort(), [...members.servers].sort());
    const foreign = { mcpServers: { grok: { command: 'foreign', args: [] } } };
    const preserved = kind === 'claude' ? deploy.configFor(foreign, release, root) : cc.jsonConfig(foreign, kind, release, root, state, 'node');
    assert.deepEqual(preserved.mcpServers.grok, foreign.mcpServers.grok);
  }
  const foreign = "[mcp_servers.grok]\ncommand = 'foreign'\n";
  const toml = cc.toml(foreign, release, root, state, 'node');
  assert(toml.startsWith(foreign)); assert.equal(cc.toml(toml, release, root, state, 'node'), toml);
  const managed = cc.toml('', release, root, state, 'node');
  const legacy = managed.replace('# most:end', "[mcp_servers.grok]\ncommand = 'node'\nargs = ['old-grok']\n# most:end");
  const plan = cc.plans([{ kind: 'codex', file: 'config.toml', text: legacy }], release, root, state, 'node');
  assert.equal(plan.length, 1); assert(!cc.block(plan[0].next).parsed.root.mcp_servers.grok);
  assert.equal(cc.restore({ text: plan[0].next }, { text: legacy }, 'codex'), legacy);
  const config = { userSettings: { globalPermissionGrants: { allow: ['mcp(grok/grok_send)', 'read_file(mine)'] } } };
  const p = cc.plans([{ kind: 'permissions', file: 'permissions.json', config }], release, root, state, 'node');
  const next = JSON.parse(p[0].next);
  assert(!next.userSettings.globalPermissionGrants.allow.some(x => x.startsWith('mcp(grok/')));
  assert(next.userSettings.globalPermissionGrants.allow.includes('read_file(mine)'));
  assert.equal(cc.plans([{ kind: 'permissions', file: 'permissions.json', config: next }], release, root, state, 'node').length, 0);
  const rollback = JSON.parse(cc.restore({ config: next }, { config }, 'permissions'));
  assert(rollback.userSettings.globalPermissionGrants.allow.includes('mcp(grok/grok_send)'));
  const foreignPlan = cc.plans([{ kind: 'agy', file: 'mcp.json', config: { mcpServers: { grok: { command: 'foreign' } } } },
    { kind: 'permissions', file: 'permissions.json', config }], release, root, state, 'node');
  assert(JSON.parse(foreignPlan.find(p => p.kind === 'permissions').next).userSettings.globalPermissionGrants.allow.includes('mcp(grok/grok_send)'));
  const agy = cc.jsonConfig({ mcpServers: { grok: oldGrok } }, 'agy', release, root, state, 'node');
  assert.deepEqual(JSON.parse(cc.restore({ config: agy }, { config: { mcpServers: { grok: oldGrok } } }, 'agy')).mcpServers.grok, oldGrok);
});
test('О2: рабочие читатели не обращаются к отсутствующему, повреждённому или большому хранилищу Grok', async () => {
  const list = stores.list, read = fs.readFileSync, readdir = fs.readdirSync;
  const deny = p => { if (String(p).includes(path.join('state', 'grok'))) throw Error('Чтение Grok запрещено тестом'); };
  fs.readFileSync = (p, ...a) => { deny(p); return read(p, ...a); };
  fs.readdirSync = (p, ...a) => { deny(p); return readdir(p, ...a); };
  stores.list = (who, ...a) => { if (who === 'grok') throw Error('Чтение Grok запрещено тестом'); return list(who, ...a); };
  try {
    assert(!require('../common/work-owner').hasLiveJobs('missing'));
    gate.allJobs(); assert.deepEqual(require('../common/cleanup').liveJobsInFolder(project), []);
    for (const contents of ['{ повреждённая карточка', JSON.stringify({ old: 'x'.repeat(1024 * 1024), status: 'running' })]) {
      write(path.join(stores.roots().grok, 'old.json'), contents);
      gate.allJobs(); assert(!require('../common/work-owner').hasLiveJobs('missing'));
      assert.deepEqual(require('../common/cleanup').liveJobsInFolder(project), []);
    }
    const { Team } = require('../common/team'), team = new Team(root);
    await team.work({ action: 'create', expected_revision: 0, name: 'claim-v23', owner: 'old', goal: 'Проверка', done_criteria: 'готово', next_step: 'проверка', stages: [{ title: 'Этап', weight: 100, state: 'план', accept_criteria: 'готово' }] });
    const w = JSON.parse(read(team.workFile('claim-v23'))); w.heartbeat_at = w.updated_at = '2000-01-01T00:00:00Z'; json(team.workFile('claim-v23'), w);
    await team.work({ action: 'claim', name: 'claim-v23', owner: 'new', expected_revision: w.revision });
    const f = fixture(); job(f); job(f, 'antigravity'); await accept(f);
    const text = require('../common/summary').loadLine(state, {}); assert(!text.includes('Grok'));
    assert.doesNotMatch(await team.status(undefined, undefined, false, true), /Чтение Grok запрещено тестом/);
  } finally { stores.list = list; fs.readFileSync = read; fs.readdirSync = readdir; }
});
test('О3: новые голоса и места Grok отклоняются до доступа к карточкам', async () => {
  const team = new (require('../common/team').Team)(root);
  for (const args of [{ action: 'design', who: 'grok' }, { action: 'verdict', who: 'grok' }, { action: 'grok_slot' }])
    await assert.rejects(team.change(args), /Grok выключен из связки \(13\.10\.2026\)/);
});
test('О4: старые голоса, замены и незавершённые места Grok — только история', () => {
  const seats = require('../common/team-seats');
  for (const decision of ['ПРИНЯТО', 'НЕ ПРИНЯТО']) for (const phase of ['design', 'verdict']) {
    const c = { base: 'a', candidate: 'b', designHash: 'd', grokSlots: [{ phase, seat: 'codex', job_id: 'old', base: 'a', candidate: 'b', designHash: 'd' }] };
    c[phase === 'design' ? 'designVotes' : 'verdicts'] = [{ who: 'grok', replaces: 'codex', job_id: 'old', decision, base: 'a', candidate: 'b', designHash: 'd' }];
    const s = seats.seat(c, 'codex', phase); assert(!s.closed && !s.blocked);
    assert.deepEqual(seats.slotPending(c, phase), []); assert.deepEqual(seats.slotRefusals(c, phase), []);
    c.designHash = 'new'; c.candidate = 'new'; assert(!seats.seat(c, 'codex', phase).closed);
  }
});
for (const level of ['мелочь', 'обычный']) for (const family of ['anthropic', 'openai', 'google']) test('О5: ' + level + ', автор ' + family, async () => {
  const f = fixture({ level, author: { family, model: family } });
  const who = { openai: 'codex', google: 'antigravity' }[family]; if (who) job(f, who, 0, { role: 'текст' });
  const reviewers = members.helpers.filter(w => members.seats[w] !== family);
  await assert.rejects(accept(f));
  for (const reviewer of reviewers) job(f, reviewer);
  await accept(f); assert.equal(f.s.state, 'принят');
});
test('О5: смешанное авторство и отсутствие внешних семей', async () => {
  for (const families of [['anthropic', 'openai'], ['openai', 'google']]) {
    const f = fixture({ author: [{ part: 'Общая часть', authors: families.map(family => ({ family, model: family })) }] });
    for (const who of members.helpers.filter(w => families.includes(members.seats[w]))) job(f, who, 0, { role: 'текст', task: 'Общая часть' });
    if (!families.includes('google')) { job(f, 'antigravity'); await accept(f); }
    else { fresh(f); await assert.rejects(accept(f)); await accept(f, { override: { by: 'user', quote: 'Выдать без принятия' } }); assert.equal(f.s.state, 'выдан без принятия'); }
  }
});
test('О5: единственный недоступный проверяющий заменяется помощником, высокий риск требует отдельного', async () => {
  const file = path.join(project, 'v23-high.txt'); write(file, 'материал');
  const f = fixture({ level: 'высокий', material: [file], author: { family: 'google', model: 'gemini' } });
  job(f, 'antigravity', 0, { role: 'текст' });
  const lost = job(f, 'codex', 0, { status: 'lost' }); fresh(f, 'замена: codex\nдоказательство: ' + lost);
  await assert.rejects(accept(f), /дополнительный/); fresh(f); await accept(f);
  fresh(f, '', 1); await assert.rejects(accept(f), /отказ дополнительного помощника/);
  await assert.rejects(accept(f, { state: 'выдан без принятия', override: { by: 'user', quote: 'Выдать' } }), /отказ дополнительного помощника останавливает выдачу/);
});
test('О4: старые reviews и замена помощником вместо Grok не создают отказа', async () => {
  const f = fixture(); job(f); job(f, 'antigravity'); fresh(f, 'замена: grok\nдоказательство: old', 1);
  f.s.gate.votes = [{ id: 'old-grok', who: 'grok', count: 1 }];
  f.s.decisions = [{ kind: 'dismiss', version: f.s.version, job_id: 'old-grok', reason: 'выключен', at: new Date().toISOString() }];
  await accept(f, { reviews: ['old-grok'] }); assert.equal(f.s.state, 'принят');
  assert(!f.s.gate.votes.some(v => v.who === 'grok'));
  const saved = JSON.parse(JSON.stringify(f.s));
  f.s = f.w.stages[0] = JSON.parse(JSON.stringify(saved));
  await accept(f, { reviews: ['old-grok'] }, saved); assert.equal(f.s.state, 'принят');
  assert.deepEqual(f.s.decisions, saved.decisions);
  assert(f.s.gate.historicGrokIds.includes('old-grok'));
});
test('О5: сохранённый отказ дополнительного помощника блокирует выдачу после перехода в запасной режим', async () => {
  const file = path.join(project, 'v23-fallback-refusal.txt'); write(file, 'материал');
  const f = fixture({ level: 'высокий', material: [file] });
  job(f); job(f, 'antigravity'); fresh(f, '', 1);
  f.s.state = 'идёт';
  await gate.evaluate(f.w, f.s);
  const saved = JSON.parse(JSON.stringify(f.s));
  assert(saved.gate.files.some(h => h.reviewText.includes('НЕ ПРИНЯТО')));
  await require('../common/request-context').context.run({ fallbackConductor: { client: 'codex', active: true } }, async () => {
    await assert.rejects(accept(f, { state: 'выдан без принятия', override: { by: 'user', quote: 'Выдать без принятия' } }, saved),
      /отказ дополнительного помощника останавливает выдачу/);
  });
});

test('О5, О16: запасной режим требует другую семью, помощник Claude не заменяет её', async () => {
  const context = require('../common/request-context').context;
  const f = fixture({ author: { family: 'openai', model: 'gpt-6' } }); job(f, 'codex', 0, { role: 'текст' });
  const lost = job(f, 'antigravity', 0, { status: 'lost' }); fresh(f, 'замена: antigravity\nдоказательство: ' + lost);
  await context.run({ fallbackConductor: { client: 'codex', active: true } }, async () => {
    await assert.rejects(accept(f), /ПРИНЯТО другой семьи/);
    await accept(f, { override: { by: 'user', quote: 'Выдать без принятия' }, state: 'выдан без принятия' });
    assert.equal(f.s.state, 'выдан без принятия');
    delete f.s.override; job(f, 'antigravity'); await accept(f); assert.equal(f.s.state, 'принят');
  });
});
test('О12: напоминания без владельца пусты, чужой владелец не попадает в ответ', () => {
  json(path.join(root, 'works', 'reminder-v23.json'), { owner: 'ours', created_at: '2000-01-01', stages: [{ state: 'идёт' }] });
  const reminder = require('../common/work-owner').reminder;
  assert(reminder(root, Date.now(), { owner: 'ours' }).includes('reminder-v23'));
  assert.equal(reminder(root, Date.now(), {}), ''); assert.equal(reminder(root, Date.now(), { owner: 'foreign' }), '');
});
test('О12: настоящие обработчики team_status и team_rules получают метку вызова', async () => {
  const git = require('../common/team-git').git;
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Test']); git(root, ['config', 'user.email', 'test@example.invalid']);
  write(path.join(root, '.gitignore'), '*\n'); git(root, ['add', '-f', '.gitignore']); git(root, ['commit', '-m', 'Isolated status fixture']);
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(__dirname, '../servers/team/index.js')], stderr: 'pipe',
    env: { ...process.env, MOST_CLIENT: 'claude', MOST_JOB_ID: '', MOST_CLAUDE_CONFIGS: '[]',
      CODEX_PATH: path.join(__dirname, 'fake-codex.js'), MOST_AGY_QUOTA_FILE: path.join(RUN, 'missing-quota.json') } });
  const client = new Client({ name: 'team-v23', version: '1' }); await client.connect(transport);
  try {
    assert((await client.listTools()).tools.find(t => t.name === 'team_change').inputSchema.properties.fast);
    for (const name of ['team_status', 'team_rules']) for (const owner of ['ours', 'foreign', undefined]) {
      const reply = await client.callTool({ name, arguments: { ...(owner ? { owner } : {}), ...(name === 'team_rules' ? { part: 'brief' } : {}) } });
      assert(!reply.isError, JSON.stringify(reply));
      const text = reply.content.map(c => c.text || '').join('\n');
      assert.equal(text.includes('⚠ Статус пользователю не отправлялся'), owner === 'ours');
    }
  } finally { await client.close(); await transport.close(); }
});
test('О13: краткая памятка, выключение Grok и обязательные участники', () => {
  const brief = fs.readFileSync(path.join(__dirname, '../rules/brief.md'), 'utf8');
  assert(brief.split(/\r?\n/).length <= 64); assert(brief.length <= 7587);
  assert.equal(fs.readFileSync(path.join(__dirname, '../rules/grok.md'), 'utf8').trim(), 'Grok выключен из связки 13.10.2026 словом пользователя');
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  for (const file of [...walk(path.join(__dirname, '../rules')), ...walk(path.join(__dirname, '../skill')), path.join(__dirname, '../AGENTS.md')]) {
    const text = fs.readFileSync(file, 'utf8');
    assert(!/Grok запрашивается|grok_send|Grok — поиск|Grok получает|только настоящий Grok|Grok на место выпавшего|два из трёх/.test(text), file);
  }
});
test('О15: допустим текст «Связка трёх ИИ»', () => assert.deepEqual(require('./interface-texts').violations('Связка трёх ИИ'), []));
test('О16: запасная роль не предлагает Grok', () => {
  const text = fs.readFileSync(path.join(__dirname, '../common/task-roles.js'), 'utf8');
  assert(!/orchestrator:.*'grok'/.test(text));
});
const cp = require('child_process'), crypto = require('crypto');
const gitB = (dir, args, env = {}) => cp.execFileSync('git', ['-c', 'core.hooksPath=NUL', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env } });
const NOTE = 'симптом: неверный итог; что меняется: вывод; затронутые места: src.js; тест: до правки падает, после проходит; откат: прежний релиз';
let seqB = 0;
async function fastFixture(fast = true) {
  const dir = path.join(RUN, 'fast-' + (++seqB)); fs.mkdirSync(dir);
  gitB(dir, ['init', '-b', 'main']); gitB(dir, ['config', 'user.name', 'Test']); gitB(dir, ['config', 'user.email', 'test@example.invalid']);
  write(path.join(dir, '.gitignore'), '.work/\nstate/\nworks/\ntests/.tmp-*\n');
  write(path.join(dir, 'src.js'), '// baseline\n'); write(path.join(dir, 'tests/original.js'), 'originalTest();\n'); write(path.join(dir, 'other.txt'), 'other contents\n');
  write(path.join(dir, 'lessons.md'), '# Уроки\n'); write(path.join(dir, 'common/members.js'), '// protected\n');
  gitB(dir, ['add', '-A']); gitB(dir, ['commit', '-m', 'base']);
  const team = new (require('../common/team').Team)(dir), name = 'fast-' + seqB;
  const design = path.join(RUN, name + '-design.md'); write(design, '# Замысел\n');
  const start = { action: 'start', name, request: 'Исправить неправильный результат малой обратимой правкой.', ...(fast ? { fast: true, note: NOTE } : { design_file: design }) };
  await team.change(start);
  const folder = team.clone(name); gitB(folder, ['config', 'user.name', 'Test']); gitB(folder, ['config', 'user.email', 'test@example.invalid']);
  return { team, name, dir, folder, start, card: () => JSON.parse(fs.readFileSync(team.changeFile(name))), call: a => team.change({ name, ...a }) };
}
async function fastReviews(f, text = '') {
  const c = f.card();
  for (const who of ['codex', 'antigravity', 'claude']) {
    let id;
    if (who !== 'claude') {
      id = crypto.randomUUID(); const response = text + '\nПРИНЯТО';
      const j = { id, status: 'done', role: 'проверка', mode: 'review', write: false,
        startedAt: new Date().toISOString(), task: c.requestMark + ' ' + c.base + ' ' + c.candidate + ' ' + c.cardHash + '\n' + c.note,
        model: who === 'codex' ? 'gpt-6' : 'gemini-4-argon-high' };
      if (who === 'codex') { j.resultFile = id + '.result.txt'; write(path.join(stores.roots().codex, j.resultFile), response); json(path.join(stores.roots().codex, id + '.json'), j); }
      else { const dir = path.join(stores.roots().antigravity, id); write(path.join(dir, 'result.txt'), response); json(path.join(dir, 'meta.json'), { hash: crypto.createHash('sha256').update(response).digest('hex') }); json(path.join(dir, 'card.json'), j); }
    }
    await f.call({ action: 'verdict', who, job_id: id, decision: 'ПРИНЯТО', base: c.base, candidate: c.candidate });
  }
}
const appendLines = (f, n, file = 'src.js') => fs.appendFileSync(path.join(f.folder, file), Array.from({ length: n }, (_, i) => '// addition ' + i + '\n').join(''));
test('О6: fast — карточка обязательна, start → commit → ревью → merge без design_file', async () => {
  assert.throws(() => require('../common/precheck').fastNote(''), /карточка/);
  const f = await fastFixture(); appendLines(f, 1); await f.call({ action: 'commit', message: 'fix' });
  await assert.rejects(f.team.change({ ...f.start, name: 'missing-card', note: undefined }), /карточка note/);
  assert(!fs.existsSync(path.join(f.dir, '.work', 'missing-card')));
  assert(!f.card().designFile && !f.card().candidateDesignHash);
  await fastReviews(f); await f.call({ action: 'merge' }); assert.equal(f.card().status, 'слито');
});
test('О7: 80/81 строк, lessons только текст, весь диапазон и staged/unstaged/untracked', async () => {
  const pc = require('../common/precheck');
  const f = await fastFixture(); appendLines(f, 80); fs.appendFileSync(path.join(f.folder, 'lessons.md'), 'Урок\n'.repeat(100));
  assert.equal(pc.checkFast(f.folder, f.card().base), 80); await f.call({ action: 'commit', message: '80 lines' });
  appendLines(f, 1); assert.throws(() => pc.checkFast(f.folder, f.card().base), /81 изменённых/);
  const g = await fastFixture(); appendLines(g, 40); await g.call({ action: 'commit', message: 'first' }); appendLines(g, 41);
  await assert.rejects(g.call({ action: 'commit', message: 'second' }), /81 изменённых/);
  const h = await fastFixture(); appendLines(h, 40); gitB(h.folder, ['add', 'src.js']); appendLines(h, 30); write(path.join(h.folder, 'tests/new.js'), 'test();\n'.repeat(11));
  assert.throws(() => pc.checkFast(h.folder, h.card().base), /81 изменённых/);
  const index = fs.readFileSync(path.join(h.folder, '.git/index')); assert.throws(() => pc.checkFast(h.folder, h.card().base)); assert.deepEqual(fs.readFileSync(path.join(h.folder, '.git/index')), index);
  const forced = await fastFixture(); write(path.join(forced.folder, 'tests/.tmp-force.js'), '// forced\n'.repeat(81));
  gitB(forced.folder, ['add', '-f', 'tests/.tmp-force.js']);
  assert.throws(() => pc.checkFast(forced.folder, forced.card().base), /81 изменённых/);
  const hidden = await fastFixture(); write(path.join(hidden.folder, '.git/info/exclude'), 'private.js\n');
  write(path.join(hidden.folder, 'private.js'), 'secret();\n'); gitB(hidden.folder, ['add', '-f', 'private.js']);
  assert.throws(() => pc.checkFast(hidden.folder, hidden.card().base), /новый файл вне tests/);
});
test('О8: новые файлы, копии, двоичные и регистр защищённого пути', async () => {
  for (const [file, data, why] of [['new.js', 'x\n', /новый файл/], ['tests/new.js', '// baseline\n', /копирование/], ['lessons.md', Buffer.from([0, 1]), /двоичный/], ['RuLeS/new.md', 'x\n', /защищённый/], ['COMMON/MEMBERS.JS', '// changed\n', /защищённый/]]) {
    const f = await fastFixture(); write(path.join(f.folder, file), data); await assert.rejects(f.call({ action: 'commit', message: 'invalid' }), why);
  }
  for (const file of ['tests/run.js', 'tests/fake-new.js', 'tests/myfixture.js', 'tests/team-worker.js', 'tests/fixtures/a', 'tests/live/a', 'tests/.tmp-v6-restart-parse.ps1', 'common/members.js', '.npmrc']) assert(require('../common/precheck').fastProtected(file), file);
});
test('О8: NUL-пути, переименование в обе стороны, удаление, тип, ссылка и подмодуль', async () => {
  const f = await fastFixture(), base = f.card().base, pc = require('../common/precheck');
  const tempIndex = path.join(RUN, 'fast-index'), env = { GIT_INDEX_FILE: tempIndex };
  const tree = entries => { gitB(f.folder, ['read-tree', base], env); for (const args of entries) gitB(f.folder, ['update-index', ...args], env); return gitB(f.folder, ['write-tree'], env).trim(); };
  const blob = gitB(f.folder, ['rev-parse', base + ':src.js']).trim();
  const other = gitB(f.folder, ['rev-parse', base + ':tests/original.js']).trim();
  const cases = [
    [['--force-remove', 'src.js']],
    [['--force-remove', 'src.js'], ['--add', '--cacheinfo', '100644', blob, 'tests/renamed.js']],
    [['--force-remove', 'tests/original.js'], ['--add', '--cacheinfo', '100644', other, 'common/renamed.js']],
    [['--add', '--cacheinfo', '120000', blob, 'src.js']],
    [['--add', '--cacheinfo', '160000', base, 'tests/sub.js']],
    [['--add', '--cacheinfo', '100755', blob, 'src.js']]
  ];
  for (const change of cases) assert.throws(() => pc.checkFast(f.folder, base, tree(change)), /не малая правка/);
  // Настоящая junction, даже если исходники за ней сами являются обычными файлами.
  const target = path.join(RUN, 'junction-target'); fs.mkdirSync(target); write(path.join(target, 'new.js'), 'unique junction data\n');
  fs.symlinkSync(target, path.join(f.folder, 'tests/link'), 'junction');
  assert.throws(() => pc.checkFast(f.folder, base), /junction|ссылка/);
  // Такие имена Windows не создаёт: проверяем NUL-разбор независимо от файловой системы.
  const fingerprint = require('../common/fingerprint'), original = fingerprint.fingerprint;
  fingerprint.fingerprint = (_folder, inspect) => { inspect(args => args[0] === 'cat-file' ? 'text\n' : args.includes('--raw') ? ':000000 100644 0000000 abcdef0 A\0tests/tab\tand\nnewline.js\0' : '1\t0\ttests/tab\tand\nnewline.js\0', 'tree'); return 'tree'; };
  try { assert.equal(pc.checkFast(f.folder, base), 1); } finally { fingerprint.fingerprint = original; }
});
test('О9: merge перепроверяет будущее дерево, карточку и замечание «не малая»', async () => {
  const f = await fastFixture(); appendLines(f, 1); await f.call({ action: 'commit', message: 'fix' }); await fastReviews(f);
  write(path.join(f.folder, 'servers/new.js'), 'bad\n'); await assert.rejects(f.call({ action: 'merge' }), /защищённый/);
  const g = await fastFixture(); appendLines(g, 1); await g.call({ action: 'commit', message: 'fix' }); await fastReviews(g);
  await g.team.change({ ...g.start, note: NOTE + '; уточнение: новая карточка' }); assert.equal(g.card().verdicts.length, 0);
  await assert.rejects(g.call({ action: 'merge' }), /Карточка изменена/);
  await g.call({ action: 'commit', message: 'new card' }); await fastReviews(g); await g.call({ action: 'merge' });
  const h = await fastFixture(); appendLines(h, 1); await h.call({ action: 'commit', message: 'fix' }); await fastReviews(h, '[блокирующее] не малая: меняется смысл доступа');
  await assert.rejects(h.call({ action: 'merge' }), /не малая правка — нужен замысел/);
});
test('О10: обычное изменение сохраняет ворота замысла', async () => {
  const f = await fastFixture(false); appendLines(f, 1); await assert.rejects(f.call({ action: 'commit', message: 'fix' }), /ворота замысла/);
});
test('О11: model/effort в новом запуске, продолжении, квоте; schema и unknown', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const jobs = path.join(RUN, 'model-jobs'), log = path.join(RUN, 'models.jsonl'); fs.mkdirSync(jobs);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../servers/codex/index.js')], stderr: 'pipe',
    env: { ...process.env, MOST_CLIENT: 'claude', MOST_JOB_ID: '', MOST_CODEX_JOBS_DIR: jobs, MOST_QUEUE_TICK_MS: '50', CODEX_PATH: path.join(__dirname, 'fake-codex.js'), FAKE_CODEX_LOG: log } });
  const client = new Client({ name: 'v23-models', version: '1' }); await client.connect(transport);
  const call = a => client.callTool({ name: 'codex_send', arguments: { folder: project, task: 'Проба', ...a } });
  const readJob = id => JSON.parse(fs.readFileSync(path.join(jobs, id + '.json')));
  const send = async a => { const r = await call(a); assert(!r.isError, JSON.stringify(r)); const text = r.content.map(c => c.text).join('\n'), id = text.match(/Номер поручения: (\S+)/)[1]; return { id, text }; };
  const wait = async (id, status) => { for (let i = 0; i < 200; i++) { if (readJob(id).status === status) return; await new Promise(r => setTimeout(r, 50)); } throw Error('Не дождались ' + status); };
  try {
    for (const args of [{ model: 'bad model' }, { model: 'bad;command' }, { model: '' }, { effort: 'ultra' }]) { const r = await call(args); assert(r.isError); }
    const a = await send({ model: 'gpt-6', effort: 'low' }); assert.match(a.text, /запрошено: модель gpt-6, уровень low/); assert.match(a.text, /подтверждено: модель unknown, уровень unknown/); await wait(a.id, 'done');
    const b = await send({ continue_id: a.id }); await wait(b.id, 'done'); assert.equal(readJob(b.id).effort, 'low'); assert.equal(readJob(b.id).model, 'gpt-6');
    const c = await send({ continue_id: b.id, model: 'gpt-6:test', effort: 'high' }); await wait(c.id, 'done');
    const d = await send({}); await wait(d.id, 'done');
    const q = await send({ task: 'QUOTA', model: 'gpt-6', effort: 'medium' }); await wait(q.id, 'waiting_quota');
    const card = readJob(q.id); card.nextAttemptAt = new Date(0).toISOString(); json(path.join(jobs, q.id + '.json'), card);
    for (let i = 0; i < 200 && fs.readFileSync(log, 'utf8').trim().split('\n').length < 6; i++) await new Promise(r => setTimeout(r, 50));
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); assert(rows.length >= 6);
    for (const [i, model, effort] of [[0, 'gpt-6', 'low'], [1, 'gpt-6', 'low'], [2, 'gpt-6:test', 'high'], [4, 'gpt-6', 'medium'], [5, 'gpt-6', 'medium']]) {
      assert.equal(rows[i].args[rows[i].args.indexOf('-m') + 1], model); assert(rows[i].args.includes('model_reasoning_effort="' + effort + '"'));
      assert.equal(rows[i].args[rows[i].args.indexOf('-s') + 1], 'read-only');
    }
    assert(rows[1].args.includes('resume')); assert(rows[5].args.includes('resume')); assert(!rows[3].args.includes('-m') && !rows[3].args.includes('-c'));
    assert.equal(readJob(a.id).provenance.provider_reported_text_model, 'unknown');
  } finally { await client.close(); await transport.close(); }
});
test('О14: рецепт, сохранение NODE_PATH, модели и самонапоминание', () => {
  const rule = fs.readFileSync(path.join(__dirname, '../rules/claude.md'), 'utf8');
  for (const part of ['git clone --no-hardlinks', 'git checkout --detach', 'junction', 'node tools/fingerprint.js', 'MOST_CLIENT=claude', 'MOST_JOB_ID', 'MOST_REPO_ROOT', 'send_later', '20–30', 'gemini-4-argon-high']) assert(rule.includes(part), part);
  assert(fs.readFileSync(path.join(__dirname, 'team-v22-full-access.js'), 'utf8').includes("[process.env.NODE_PATH, path.join(ROOT, 'node_modules')]"));
});
run(tests);
