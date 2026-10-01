'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), http = require('http'), crypto = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v14-bridges-'));
const root = path.join(RUN, 'repo'), project = path.join(RUN, 'project'), state = path.join(root, 'state');
fs.mkdirSync(root); fs.mkdirSync(project);
Object.assign(process.env, { MOST_REPO_ROOT: root, MOST_STATE_DIR: state, MOST_TEST_KEEP: '1', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off', MOST_PROBE_ONLY: '1', MOST_CLAUDE_CONFIGS: '[]',
  AGY_PATH: path.join(__dirname, 'fake-agy.js'), CODEX_PATH: path.join(__dirname, 'fake-codex.js'), MOST_CODEX_SESSIONS: path.join(RUN, 'sessions') });
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const json = (f, x) => write(f, JSON.stringify(x));
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const support = require('../common/brief-support');
const gate = require('../common/stage-gate');
const tests = [], test = (name, fn) => tests.push({ name, fn });
let hook;
async function server(who, guest = false, codeRoot = ROOT) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(codeRoot, 'servers', who, 'index.js')], env: { ...process.env, MOST_CLIENT: guest ? (who === 'codex' ? 'antigravity' : 'codex') : 'claude' }, stderr: 'pipe' });
  const client = new Client({ name: 'v14-test', version: '1.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}
async function call(b, name, args) {
  const r = await b.client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: (r.content || []).map(c => c.text || '').join('\n') };
}
const stages = () => [{ id: 'stage-permanent', rules_version: 14, title: 'Итог', weight: 100, state: 'план', accept_criteria: 'готово', level: 'обычный', author: { family: 'anthropic', model: 'claude' }, version: 'v14-version', gate: { files: [], reasons: [] } }];
function work(name = 'bridge-work') { const w = { name, folder: project, revision: 1, owner: 'test', goal: 'цель', done_criteria: 'готово', next_step: 'проверка', reminders: [], stages: stages() }; json(path.join(root, 'works', name + '.json'), w); return w; }
test('MCP: новые поля этапа проходят схему до team_work; id/version доступны в ответе', async () => {
  const b = await server('team');
  try {
    const schema = (await b.client.listTools()).tools.find(t => t.name === 'team_work').inputSchema.properties.stages.items.properties;
    for (const field of ['id', 'level', 'author', 'source_jobs', 'material', 'reviews', 'fresh_review_file', 'override', 'one_family', 'criterion_met']) assert(schema[field], field);
    const r = await call(b, 'team_work', { action: 'create', name: 'schema-work', owner: 'test', expected_revision: 0, folder: project, goal: 'цель', done_criteria: 'готово', next_step: 'проверить', stages: [{ ...stages()[0], id: undefined, level: 'обычный', author: { family: 'anthropic', model: 'claude' } }] });
    assert(!r.error, r.text); const w = read(path.join(root, 'works/schema-work.json')); assert.equal(w.stages[0].level, 'обычный'); assert.equal(w.folder, project); assert(w.stages[0].id);
    const out = await call(b, 'team_work', { action: 'get', name: w.name, owner: 'test' }); assert(out.text.includes(w.stages[0].id));
  } finally { await b.close(); }
});
for (const who of ['codex', 'antigravity', 'grok']) test('12д, MCP ' + who + ': role обязателен; stage привязан к id, опора в брифе', async () => {
  work(who + '-work'); write(path.join(project, 'canon.txt'), 'КАНОН-ДОСТАВЛЕН'); json(path.join(project, '.most/opora.json'), [{ path: 'canon.txt', section: 'канон', origin: 'источник' }]);
  const b = await server(who, true);
  try {
    const schema = (await b.client.listTools()).tools.find(t => t.name === who + '_send').inputSchema.properties;
    assert(schema.role && schema.replaces && schema.opora);
    const args = { folder: project, task: 'v14-version Проверка', work: who + '-work', owner: 'test', stage: 'Итог', ...(who === 'antigravity' ? { model: 'gemini-3.1-pro-high', mode: 'text' } : {}) };
    const bad = await call(b, who + '_send', args); assert(bad.error, bad.text); assert.match(bad.text, /role/);
    const good = await call(b, who + '_send', { ...args, role: 'проверка' }); assert(!good.error, good.text);
    const jobs = require('../common/team-store').list(who, false).jobs.filter(j => (j.workName || j.work) === args.work);
    assert.equal(jobs.length, 1); const j = jobs[0]; assert.equal(j.role, 'проверка'); assert.equal(j.stageId, 'stage-permanent'); assert.equal(j.stage, j.stageId); assert.equal(j.stageTitle, 'Итог');
    assert(Number.isInteger(j.gateOrder) && j.gateOrder > 0, 'порядок операции сохранён мостом');
    assert(require('../common/format').format(who, j, '').includes('Этап: Итог (работа '), 'в ответе название этапа, связь остаётся по id');
    const text = who === 'codex' ? fs.readFileSync(j.textFile, 'utf8') : who === 'grok' ? fs.readFileSync(path.join(state, 'grok/briefs', j.id + '.md'), 'utf8') : j.retry.stdin;
    assert(text.includes('КАНОН-ДОСТАВЛЕН'), 'опора дошла до сохранённого брифа');
    assert(read(path.join(root, 'works', args.work + '.json')).stages[0].gate.locked);
    json(path.join(project, '.most/opora.json'), [{ path: 'canon.txt', section: 'канон' }]);
    const noOrigin = await call(b, who + '_send', { ...args, role: 'совет', opora: true }); assert(noOrigin.error); assert.match(noOrigin.text, /origin/);
    const disabled = await call(b, who + '_send', { ...args, role: 'совет', opora: false }); assert(!disabled.error, disabled.text);
    json(path.join(project, '.most/opora.json'), []);
  } finally { await b.close(); }
});
for (const who of ['codex', 'antigravity', 'grok']) test('12е: оба after_job доставляются через ' + who + ' один раз', async () => {
  const w = work('replacement-' + who), s = w.stages[0]; s.author = [{ part: 'Альфа', family: 'anthropic', model: 'claude' }, { part: 'Бета', family: 'anthropic', model: 'claude' }]; json(path.join(root, 'works', w.name + '.json'), w);
  const replaced = who === 'codex' ? 'antigravity' : 'codex';
  const codex = path.join(state, replaced === 'codex' ? 'codex-jobs' : 'jobs');
  for (const [id, task, status, n] of [['negative-a', 'Альфа', 'done', 1], ['negative-b', 'Бета', 'done', 2], ['failed-a', '', 'failed', 3], ['failed-b', '', 'failed', 4]]) {
    const card = { id, work: w.name, workName: w.name, model: 'gemini-3.1-pro-high', stageId: s.id, stage: s.id, role: 'проверка', status, startedAt: new Date(Date.now() - 10000 + n * 10).toISOString(), task: s.version + ' ' + task, resultFile: id + '.result.txt' };
    const text = 'ЗАМЕЧАНИЕ-' + id + '\nНЕ ПРИНЯТО: 1 блокирующих';
    json(path.join(codex, replaced === 'codex' ? id + '.json' : id + '/card.json'), card);
    write(path.join(codex, replaced === 'codex' ? id + '.result.txt' : id + '/result.txt'), text);
    if (replaced === 'antigravity') json(path.join(codex, id, 'meta.json'), { hash: crypto.createHash('sha256').update(text).digest('hex') });
  }
  const b = await server(who, true);
  try {
    const args = { folder: project, model: 'gemini-3.1-pro-high', mode: 'text', task: s.version + ' Альфа Бета', work: w.name, stage: s.id, owner: 'test', role: 'проверка', replaces: { who: replaced, reason: 'авария', after_job: ['negative-a', 'negative-b'] } };
    const r = await call(b, who + '_send', args); assert(!r.error, r.text);
    const j = require('../common/team-store').list(who, false).jobs.find(j => (j.workName || j.work) === w.name && j.replaces);
    const brief = who === 'grok' ? fs.readFileSync(path.join(state, 'grok/briefs', j.id + '.md'), 'utf8') : who === 'antigravity' ? j.retry.stdin : j.task;
    for (const id of ['negative-a', 'negative-b']) assert.equal(brief.split('ЗАМЕЧАНИЕ-' + id).length, 2);
    const bad = await call(b, who + '_send', { ...args, replaces: { ...args.replaces, after_job: ['negative-a'] } }); assert(bad.error); assert.match(bad.text, /последние/);
  } finally { await b.close(); }
});
test('12н: after_file доставлен, регистрация не меняется при повторном запуске', async () => {
  const w = work('fresh-replace'), s = w.stages[0]; s.author = { family: 'google', model: 'gemini' };
  const p = path.join(project, '.most/reviews/rejected.txt'); write(p, s.version + '\nСВЕЖИЙ-ОТКАЗ\nНЕ ПРИНЯТО: 1 блокирующих'); gate.registerFile(w, s, p, s.version); json(path.join(root, 'works', w.name + '.json'), w);
  const before = JSON.stringify(s.gate.files);
  for (let i = 0; i < 2; i++) {
    const b = await server('grok', true);
    try {
      const r = await call(b, 'grok_send', { task: s.version, work: w.name, stage: s.id, owner: 'test', role: 'проверка', replaces: { who: 'fresh', reason: 'нет инструмента Agent', after_file: [p] } }); assert(!r.error, r.text);
    } finally { await b.close(); }
    assert.equal(JSON.stringify(read(path.join(root, 'works', w.name + '.json')).stages[0].gate.files), before);
  }
  const j = require('../common/team-store').list('grok', false).jobs.find(j => j.work === w.name); assert(j.task.includes('СВЕЖИЙ-ОТКАЗ'));
});
test('13: origin, realpath, 100/200 КБ, битый JSON, пустой список и отключение', () => {
  const file = path.join(project, '.most/opora.json');
  json(file, [{ path: 'canon.txt', section: 'канон' }]); assert.throws(() => support.support(project), /origin/);
  write(file, '{'); assert.throws(() => support.support(project), /JSON/); assert.deepEqual(support.support(project, false), []);
  json(file, []); assert.deepEqual(support.support(project), []);
  write(path.join(project, 'large'), Buffer.alloc(100 * 1024 + 1)); json(file, [{ path: 'large', section: 'канон', origin: 'x' }]); assert.throws(() => support.support(project), /100 КБ/);
  write(path.join(project, 'small'), Buffer.alloc(80 * 1024)); json(file, Array.from({ length: 3 }, () => ({ path: 'small', section: 'свобода', origin: 'x' }))); assert.throws(() => support.support(project), /200 КБ/);
  const outside = path.join(RUN, 'outside'); fs.mkdirSync(outside); write(path.join(outside, 'x'), 'outside'); fs.symlinkSync(outside, path.join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  json(file, [{ path: 'link/x', section: 'канон', origin: 'x' }]); assert.throws(() => support.support(project), /вне папки/); json(file, []);
});
for (const who of ['team', 'codex', 'antigravity', 'grok']) test('14: instructions ' + who + ' в обоих режимах и запуск без файла', async () => {
  for (const guest of [false, true]) {
    const b = await server(who, guest); try { const instructions = b.client.getInstructions(); assert.equal(!!instructions, !guest); if (!guest) assert([...instructions].length <= 1200); } finally { await b.close(); }
  }
  const copy = path.join(RUN, 'missing-' + who); fs.mkdirSync(copy);
  for (const dir of ['common', 'servers', 'rules']) fs.cpSync(path.join(ROOT, dir), path.join(copy, dir), { recursive: true, filter: f => path.basename(f) !== 'instructions.md' });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(copy, 'package.json'));
  const b = await server(who, false, copy); try {
    assert(!b.client.getInstructions());
    if (who === 'team') assert.match((await call(b, 'team_status', {})).text, /Нет rules\/instructions.md/);
  } finally { await b.close(); }
  assert.match(require('../common/server-instructions').read(copy).warning, /Нет rules/);
});
test('КР1 Н4: task Antigravity отделён от материала, материал доставлен', async () => {
  const w = work('author-material'), b = await server('antigravity', true);
  try {
    const result = await call(b, 'antigravity_send', { folder: project, task: 'Напиши Альфа', text: 'Бета — ВЛОЖЕННЫЙ-МАТЕРИАЛ', work: w.name, owner: 'test', stage: w.stages[0].id, role: 'текст', model: 'gemini-3.1-pro-high', mode: 'text' });
    assert(!result.error, result.text);
    const j = require('../common/team-store').list('antigravity', false).jobs.find(j => j.workName === w.name);
    assert.equal(j.task, 'Напиши Альфа'); assert.equal(j.scopeTask, 'Напиши Альфа');
    assert(j.retry.stdin.includes('ВЛОЖЕННЫЙ-МАТЕРИАЛ'));
  } finally { await b.close(); }
});
test('КР1 Н7: отказ Antigravity по папке не замораживает этап', async () => {
  const w = work('invalid-folder'), b = await server('antigravity', true);
  try {
    const result = await call(b, 'antigravity_send', { folder: path.join(project, 'absent-folder'), task: w.stages[0].version, work: w.name, owner: 'test', stage: w.stages[0].id, role: 'проверка', model: 'gemini-3.1-pro-high', mode: 'text' });
    assert(result.error); assert.match(result.text, /папки проекта нет/);
    assert.deepEqual(read(path.join(root, 'works', w.name + '.json')).stages[0], w.stages[0]);
  } finally { await b.close(); }
});
test('КР1 Н7: ненастроенный Grok не замораживает этап', async () => {
  const w = work('no-grok-config'), settings = path.join(state, 'grok-webhook.json'), original = fs.readFileSync(settings);
  json(settings, {});
  const b = await server('grok', true);
  try {
    const result = await call(b, 'grok_send', { task: w.stages[0].version, work: w.name, owner: 'test', stage: w.stages[0].id, role: 'проверка' });
    assert(result.error); assert.deepEqual(read(path.join(root, 'works', w.name + '.json')).stages[0], w.stages[0]);
  } finally { await b.close(); fs.writeFileSync(settings, original); }
});
test('15: источник квот недоступен — данные не предоставлены без выдуманной семьи', async () => {
  const aq = require('../common/agy-quota'), old = aq.agySnapshot; aq.agySnapshot = async () => ({ text: 'нет источника' });
  try { const line = await require('../common/quota-line').quotaLine({ state, codex: { source: 'данные не предоставлены' } }); assert.match(line, /данные не предоставлены/); assert(!line.includes('семья')); }
  finally { aq.agySnapshot = old; }
});
(async () => {
  hook = http.createServer((req, res) => { req.resume(); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, runUuid: 'test-run' })); });
  await new Promise(resolve => hook.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + hook.address().port + '/'; process.env.NODE_ENV = 'test'; process.env.MOST_GROK_TEST_URL = url; json(path.join(state, 'grok-webhook.json'), { url, key: 'test-only' });
  let passed = 0, failed = 0;
  try { for (const t of tests) try { await t.fn(); passed++; console.log('OK ' + t.name); } catch (e) { failed++; console.log('ПРОВАЛ ' + t.name + '\n' + e.stack); } }
  finally { await new Promise(resolve => hook.close(resolve)); }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0'); process.exitCode = failed ? 1 : 0;
})();
