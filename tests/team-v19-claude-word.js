'use strict';
// team-v19 «Claude отвалился» (К1–К12, Т1–Т9): запасной режим по слову пользователя в чате Codex или Antigravity.
// Номера в названиях — «Опасные случаи» замысла team-v19 ред. 5. Каждый случай — отдельный процесс со своей временной папкой.
// Предки процесса, проба Antigravity, запуск Claude Desktop и список процессов — только подменой (NODE_ENV=test).
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const CASE = process.env.MOST_V19_CASE, ROOT = path.resolve(__dirname, '..');
const HOUR = 3600000, iso = ms => new Date(ms).toISOString();
const READY_AT = iso(Date.now() - HOUR), APP_AT = iso(Date.now() - 2 * HOUR);
const OWNER = 'fallback-codex-ab12', AGY_OWNER = 'fallback-antigravity-cd34';
let RUN, REPO, STATE, PROJECT;
if (CASE !== undefined) {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'most-v19-'));
  REPO = path.join(RUN, 'repo'); STATE = path.join(REPO, 'state'); PROJECT = path.join(RUN, 'project');
  fs.mkdirSync(REPO, { recursive: true }); fs.mkdirSync(PROJECT, { recursive: true });
  for (const k of ['MOST_AUTHORITY', 'MOST_JOB_ID', 'MOST_FALLBACK_DIR', 'MOST_PROBE_ONLY', 'MOST_PROBE_GUEST', 'MOST_TEST_PROCESS_TREE', 'MOST_TEST_AGY_PROBE']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', MOST_REPO_ROOT: REPO, MOST_STATE_DIR: STATE, MOST_CODEX_JOBS_DIR: path.join(STATE, 'codex-jobs'), MOST_CODEX_ARCHIVE_DIR: '',
    MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off', MOST_TEST_KEEP: '1', MOST_CLAUDE_CONFIGS: '[]',
    MOST_JOURNAL: path.join(STATE, 'agy.log'), MOST_INPUT_DIR: path.join(STATE, 'input'), MOST_CODEX_SESSIONS: path.join(RUN, 'sessions') });
}
const lib = name => require('../common/' + name);
const tests = [], test = (name, fn) => tests.push([name, fn]);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const json = (f, x) => write(f, JSON.stringify(x, null, 2));
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (fn()) return; } catch {} await sleep(100); }
  throw Error('Не дождались: ' + what);
}

// Запись основного сервера team того же релиза; сам процесс 7000 жив, но гостю не предок.
function ready(patch = {}) { json(path.join(STATE, 'ready', 'team.json'), { release: ROOT, pid: 7000, startedAt: READY_AT, ...patch }); }
function tree(parent = 4100, self = process.pid, main = true) {
  return JSON.stringify([{ pid: self, ppid: parent, name: 'node.exe', startedAt: iso(Date.now() - 1000) },
    { pid: parent, ppid: 1, name: 'codex.exe', startedAt: APP_AT }, ...(main ? [{ pid: 7000, ppid: 1, name: 'node.exe', startedAt: READY_AT }] : [])]);
}
// Клиент вызова: чат или поручение (MOST_JOB_ID), дерево процессов, проба Antigravity.
function as(client, opts = {}) {
  process.env.MOST_CLIENT = client;
  if (opts.job) process.env.MOST_JOB_ID = opts.job; else delete process.env.MOST_JOB_ID;
  process.env.MOST_TEST_PROCESS_TREE = opts.tree || tree(opts.parent, process.pid, opts.main !== false);
  const f = lib('fallback'); f.reset(); f.probe.agy = !!opts.agy;
}
// Team с подменой запуска Claude Desktop: настоящий перезапуск в тестах запрещён.
function team(deps) {
  const { Team } = lib('team'), t = new Team(REPO);
  t.fallbackDeps = deps || { evaluate: () => ({ desktopAlive: true }), restart: async () => { throw Error('запуск не ожидался'); } };
  return t;
}
async function word(client = 'codex', quote = 'Claude отвалился', owner = OWNER, opts = {}) {
  as(client, opts);
  return team().word({ action: 'record', who_down: 'claude', quote, owner });
}
const workArgs = { folder: undefined, goal: 'цель', done_criteria: 'готово', next_step: 'дальше' };
async function claudeWork(name = 'w', stages) {
  as('claude');
  const t = team();
  await t.work({ action: 'create', name, owner: 'claude-sess', expected_revision: 0, ...workArgs, folder: PROJECT,
    stages: stages || [{ title: 'Итог', weight: 100, state: 'идёт', accept_criteria: 'готово', level: 'обычный', author: { family: 'anthropic', model: 'claude-opus-4.6' }, version: 'v1' }] });
  return read(t.workFile(name));
}
let seq = 0;
function job(who, patch = {}, verdict = 'ПРИНЯТО') {
  const id = who + '-' + (++seq) + '-' + crypto.randomBytes(3).toString('hex'), dir = lib('team-store').roots()[who];
  const body = 'Ответ ' + id + '\n' + verdict + (who === 'grok' ? '\nКОНТРОЛЬ ' + 'a'.repeat(64) + '\nКОНЕЦ ОТВЕТА' : '');
  const j = { id, role: 'проверка', status: 'done', startedAt: iso(Date.now() + seq * 1000), finishedAt: iso(Date.now() + seq * 1000 + 1), task: 'проверка',
    model: who === 'antigravity' ? 'gemini-3.8-flash-high' : who === 'grok' ? 'grok-4' : 'gpt-6', ...patch };
  if (who === 'antigravity') {
    j.workName = j.work; json(path.join(dir, id, 'card.json'), j);
    write(path.join(dir, id, 'result.txt'), body); json(path.join(dir, id, 'meta.json'), { hash: sha(body) });
  } else {
    j.resultFile = id + '.result.txt'; if (who === 'grok') j.resultHash = sha(body);
    json(path.join(dir, id + '.json'), j); write(path.join(dir, j.resultFile), body);
  }
  return id;
}
const bind = (w, s) => ({ work: w.name, stage: s.id, stageId: s.id });
async function mcp(server, client, env = {}) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const e = { ...process.env, MOST_CLIENT: client, ...env };
  if (!env.MOST_JOB_ID) delete e.MOST_JOB_ID;
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers', server, 'index.js')], stderr: 'pipe', env: e });
  const c = new Client({ name: 'v19', version: '1' });
  await c.connect(transport);
  const call = async (name, args) => {
    try { const r = await c.callTool({ name, arguments: args }); return { error: !!r.isError, text: (r.content || []).map(x => x.text || '').join('\n') }; }
    catch (err) { return { error: true, text: err.message }; }
  };
  return { c, call, tools: async () => (await c.listTools()).tools.map(t => t.name).sort(), close: () => c.close() };
}
const guestEnv = (extra = {}) => ({ MOST_TEST_PROCESS_TREE: tree(4100, 'self'), ...extra });
const idOf = text => (text.match(/Номер поручения: (\S+)/) || [])[1];
const RD = /Запасной режим: пользователь сказал в чате Codex „Claude отвалился“ \(\d\d:\d\d\); дирижёр — Codex\. Ничего не меняй\. Режим снимается только по новой реплике пользователя тебе: team_word return quote=<дословно>$/;

test('1, К1: слово о Claude из чата Claude — отказ', async () => {
  ready(); as('claude');
  await assert.rejects(team().word({ action: 'record', who_down: 'claude', quote: 'Claude отвалился', owner: OWNER }), /О себе Claude слово не записывает/);
  assert(!fs.existsSync(lib('user-word').file()));
});

test('2, К1, Р-ж: первое слово — чат Codex дирижёр (отпечаток и метка в записи, снимок работ); Antigravity после — участник; Antigravity без пробы — «скажи это в чате Codex»', async () => {
  ready();
  const out = await word('codex', 'Claude отвалился');
  assert.match(out, /^Записал: „Claude отвалился“ — Claude недоступен; дирижёр — Codex, пока Claude не вернётся\.$/);
  const W = lib('user-word'), m = W.mode();
  assert(m.active && m.conductor === 'codex' && m.owner === OWNER);
  assert.deepEqual(m.fingerprint, { pid: 4100, startedAt: APP_AT });
  assert.equal(m.word.source, 'chat-codex'); assert.equal(m.word.parent_name, 'codex.exe');
  assert(fs.existsSync(path.join(STATE, 'fallback', 'snapshot-' + m.word.id + '.json')), 'снимок открытых работ');
  await assert.rejects(word('antigravity', 'Claude упал', AGY_OWNER, { agy: false }),
    /Гостю это действие запрещено: не могу подтвердить, что это чат \(способ отличить чат Antigravity от поручения не подтверждён пробой\), — скажи это в чате Codex\./);
  const second = await word('antigravity', 'Claude упал', AGY_OWNER, { agy: true });
  assert.match(second, /^Дирижёр уже Codex \(слово в \d\d:\d\d\); я — участник\.$/);
  const entries = W.claudeEntries();
  assert.equal(entries.length, 2); assert(entries[1].participant); assert.equal(entries[1].quote, 'Claude упал');
  assert.equal(W.mode().conductor, 'codex'); assert.equal(W.mode().word.id, m.word.id);
  // Первое слово без метки сеанса не записывается.
  const fresh = path.join(STATE, 'team', 'words.jsonl'); fs.renameSync(fresh, fresh + '.bak');
  await assert.rejects(word('codex', 'Claude отвалился', null), /Нужна метка сеанса owner=fallback-codex-<4 буквы>/);
});

test('3, Р-ж: гость-поручение — слово, поручения, правка работы — отказ в режиме и без; опознание не удалось — слово не записано; окружение поручения Codex и Antigravity — MOST_JOB_ID, MOST_CLIENT=job, без MOST_AUTHORITY', async () => {
  ready();
  const acc = lib('access');
  for (const phase of ['без режима', 'в режиме']) {
    if (phase === 'в режиме') await word('codex');
    as('codex', { job: 'job-1' });
    await assert.rejects(team().word({ action: 'record', who_down: 'claude', quote: 'Claude отвалился', owner: 'fallback-codex-zz99' }),
      /Гостю это действие запрещено: поручение-сеанс этого не делает: слово, поручения и перенос — только из чата; не могу подтвердить, что это чат \(это поручение-сеанс, а не чат\), — скажи это в чате Codex\./, phase);
    assert.match(lib('fallback').chatProof('codex').reason, /это поручение-сеанс, а не чат/);
    assert.throws(() => acc.guard('codex', 'codex_send', { folder: PROJECT, task: 't', owner: OWNER }), /Гостю это действие запрещено: поручение-сеанс этого не делает/, phase);
    assert.throws(() => acc.guard('antigravity', 'antigravity_send', { owner: OWNER }), /Гостю это действие запрещено: поручение-сеанс этого не делает/, phase);
    assert.throws(() => acc.guard('team', 'team_work', { action: 'update', name: 'w', owner: OWNER }), /Гостю это действие запрещено/, phase);
    as('antigravity', { job: 'agy-1', agy: true });
    await assert.rejects(team().word({ action: 'record', who_down: 'claude', quote: 'Claude отвалился', owner: AGY_OWNER }), /Гостю это действие запрещено: поручение-сеанс этого не делает/, phase);
  }
  // Отказы гостю вне запасного режима начинаются прежней фразой access.guard (tests/team-v14.js КР1 Н7).
  fs.renameSync(lib('user-word').file(), lib('user-word').file() + '.bak');
  as('codex');
  assert.doesNotThrow(() => acc.guard('codex', 'codex_send', { folder: PROJECT, task: 't' })); // team-v25: чат, не поручение
  for (const [fn, what] of [
    [() => acc.guard('antigravity', 'antigravity_apply', { id: 'x', owner: OWNER }), 'перенос'], [() => acc.guard('team', 'team_work', { action: 'update', owner: OWNER }), 'работа']])
    assert.throws(fn, /^Error: Гостю это действие запрещено/, what);
  for (const a of [{ action: 'record', who_down: 'codex', quote: 'Codex отвалился', owner: OWNER }, { action: 'return', quote: 'вернулся', owner: OWNER },
    { action: 'handover', owner: OWNER }, { action: 'rebind', quote: 'x', owner: OWNER }])
    await assert.rejects(team().word(a), /^Error: Гостю это действие запрещено/, a.action);
  fs.renameSync(lib('user-word').file() + '.bak', lib('user-word').file());
  const count = lib('user-word').claudeEntries().length;
  for (const bad of ['[]', 'не json']) {
    as('codex', { tree: bad });
    await assert.rejects(team().word({ action: 'record', who_down: 'claude', quote: 'Claude отвалился', owner: 'fallback-codex-zz98' }),
      /^Error: Гостю это действие запрещено: .*не могу подтвердить, что это чат \(не удалось снять отпечаток процесса\), — скажи это в чате Codex/);
  }
  assert.equal(lib('user-word').claudeEntries().length, count, 'слово не записано');
  const env = lib('fallback').jobEnv('job-7', { MOST_CLIENT: 'codex', MOST_AUTHORITY: 'claude', PATH: 'p' });
  assert.equal(env.MOST_JOB_ID, 'job-7'); assert.equal(env.MOST_CLIENT, 'job'); assert(!('MOST_AUTHORITY' in env)); assert.equal(env.PATH, 'p');
  // Настоящий запуск: основной сервер Codex — новое поручение и resume; основной сервер Antigravity — agy.
  as('claude');
  const codexLog = path.join(RUN, 'codex.log'), agyLog = path.join(RUN, 'agy-run.log');
  const codex = await mcp('codex', 'claude', { MOST_AUTHORITY: 'claude', CODEX_PATH: path.join(__dirname, 'fake-codex.js'), FAKE_CODEX_LOG: codexLog });
  try {
    const first = await codex.call('codex_send', { folder: PROJECT, task: 'Проверка', write: false }); assert(!first.error, first.text);
    const id1 = idOf(first.text);
    await until(() => read(path.join(STATE, 'codex-jobs', id1 + '.json')).status === 'done', 'поручение Codex');
    const second = await codex.call('codex_send', { folder: PROJECT, task: 'Продолжи', write: false, continue_id: id1 }); assert(!second.error, second.text);
    const id2 = idOf(second.text);
    await until(() => read(path.join(STATE, 'codex-jobs', id2 + '.json')).status === 'done', 'resume Codex');
    const rows = fs.readFileSync(codexLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(rows.map(r => r.env), [{ MOST_JOB_ID: id1, MOST_CLIENT: 'job', MOST_AUTHORITY: null }, { MOST_JOB_ID: id2, MOST_CLIENT: 'job', MOST_AUTHORITY: null }]);
    assert(rows[1].args.includes('resume'));
  } finally { await codex.close(); }
  const agy = await mcp('antigravity', 'claude', { MOST_AUTHORITY: 'claude', AGY_PATH: path.join(__dirname, 'fake-agy.js'), MOST_AGY_INPUT_FORMAT: 'legacy', FAKE_AGY_LOG: agyLog, MOST_QUEUE_TICK_MS: '100' });
  try {
    const sent = await agy.call('antigravity_send', { task: '[[FAKE:accept]] Проверка', mode: 'text', folder: PROJECT }); assert(!sent.error, sent.text);
    const id = idOf(sent.text);
    await until(() => fs.existsSync(agyLog), 'запуск agy');
    const row = JSON.parse(fs.readFileSync(agyLog, 'utf8').trim().split('\n').at(-1));
    assert.deepEqual(row.env, { MOST_JOB_ID: id, MOST_CLIENT: 'job', MOST_AUTHORITY: null });
  } finally { await agy.close(); }
});

test('4: не-дирижёр (чат Antigravity) — team_work update отказ', async () => {
  ready(); const w = await claudeWork(); await word('codex');
  as('antigravity', { agy: true });
  await assert.rejects(team().work({ action: 'update', name: 'w', owner: AGY_OWNER, expected_revision: w.revision, next_step: 'x' }), /Гостю это действие запрещено/);
  await assert.rejects(team().work({ action: 'claim', name: 'w', owner: AGY_OWNER, expected_revision: w.revision }), /Гостю это действие запрещено/);
});

test('5, К3: дирижёр забирает работу с живым поручением и свежей активностью; без режима — прежний отказ', async () => {
  ready(); let w = await claudeWork();
  job('codex', { ...bind(w, w.stages[0]), status: 'queued', role: 'текст', owner: null, folder: PROJECT });
  as('codex');
  await assert.rejects(team().work({ action: 'claim', name: 'w', owner: OWNER, expected_revision: w.revision }), /Гостю это действие запрещено/);
  as('claude');
  await assert.rejects(team().work({ action: 'claim', name: 'w', owner: 'claude-other', expected_revision: w.revision }), /Работа жива/);
  await word('codex'); as('codex');
  await team().work({ action: 'claim', name: 'w', owner: OWNER, expected_revision: w.revision });
  w = read(team().workFile('w'));
  assert.equal(w.owner, OWNER); assert(w.previous_owners.includes('claude-sess'));
});

test('6, Р-д, К6: Claude при активном режиме — изменения отказ с текстом Р-д; чтение проходит, баннер первой строкой', async () => {
  ready(); const w = await claudeWork(); await word('codex');
  as('claude'); const acc = lib('access'), t = team();
  await assert.rejects(t.work({ action: 'update', name: 'w', owner: 'claude-sess', expected_revision: w.revision, next_step: 'x' }), RD);
  for (const action of ['create', 'claim', 'close']) assert.throws(() => acc.guard('team', 'team_work', { action, name: 'w' }), RD);
  assert.throws(() => acc.guard('team', 'team_change', { action: 'commit' }), RD);
  await assert.rejects(t.word({ action: 'record', who_down: 'codex', quote: 'Codex отвалился' }), RD);
  assert.throws(() => acc.guard('codex', 'codex_send', { folder: PROJECT, task: 't', work: 'w', stage: 'Итог' }), RD);
  assert.throws(() => acc.guard('antigravity', 'antigravity_send', { task: 't', work: 'w', stage: 'Итог' }), RD);
  assert.throws(() => acc.guard('codex', 'codex_send', { folder: PROJECT, task: 't', write: true }), RD);
  // Перенос и отмена — тоже изменения (Codex 1c35bf39 п. 1); очередь дирижёра основной сервер исполняет сам (случай 13).
  for (const [server, tool, a] of [['antigravity', 'antigravity_apply', { id: 'x', to: path.join(PROJECT, 'x.txt') }], ['antigravity', 'antigravity_cancel', { id: 'x' }],
    ['codex', 'codex_cancel', { id: 'x' }], ['grok', 'grok_cancel', { id: 'x' }]]) assert.throws(() => acc.guard(server, tool, a), RD, tool);
  for (const [server, tool, a] of [['team', 'team_status', {}], ['team', 'team_work', { action: 'get' }], ['team', 'team_work', { action: 'list' }], ['codex', 'codex_status', {}],
    ['codex', 'codex_result', { id: 'x' }], ['team', 'team_change', { action: 'diff' }], ['team', 'team_word', { action: 'list' }], ['codex', 'codex_send', { folder: PROJECT, task: 't' }]]) acc.guard(server, tool, a);
  const s = await mcp('team', 'claude');
  try {
    const st = await s.call('team_status', {}); assert(!st.error, st.text);
    assert.match(st.text.split('\n')[0], /^Запасной режим: дирижёр Codex с \d\d:\d\d \(слово „Claude отвалился“, word-[0-9a-f-]+\); чат с меткой fallback-codex-ab12$/);
    const get = await s.call('team_work', { action: 'get', name: 'w', owner: 'claude-sess' }); assert(!get.error, get.text); assert.match(get.text, /^Запасной режим: дирижёр Codex/);
    const upd = await s.call('team_work', { action: 'update', name: 'w', owner: 'claude-sess', expected_revision: w.revision, next_step: 'x' });
    assert(upd.error); assert.match(upd.text, /^Запасной режим: дирижёр Codex/); assert.match(upd.text, /Ничего не меняй/);
  } finally { await s.close(); }
});

test('7, Р-б: дирижёр — team_change любое действие — отказ; инструмента у гостя нет', async () => {
  ready(); await word('codex'); as('codex'); const acc = lib('access');
  for (const action of ['diff', 'precheck', 'list', 'commit', 'merge', 'deploy']) assert.throws(() => acc.guard('team', 'team_change', { action, owner: OWNER }), /Гостю это действие запрещено/);
  const s = await mcp('team', 'codex', guestEnv());
  try {
    const tools = await s.tools(); assert(!tools.includes('team_change')); assert(tools.includes('team_word'));
    assert((await s.call('team_change', { action: 'list' })).error);
  } finally { await s.close(); }
});

function stageOf(name, opts = {}) {
  const g = lib('stage-gate'), w = { name, folder: PROJECT, stages: [{ title: 'Итог', weight: 100, accept_criteria: 'Проверено', state: 'идёт', level: 'обычный',
    author: { family: 'anthropic', model: 'claude' }, version: 'ver-' + name, ...opts }] };
  g.normalize(w, null); const s = w.stages[0]; s.version = g.version(w, s); return { w, s };
}
const review = (f, who, count = 0, patch = {}) => job(who, { ...bind(f.w, f.s), task: f.s.version, ...patch }, count ? 'НЕ ПРИНЯТО: ' + count + ' блокирующих' : 'ПРИНЯТО');
async function accept(f, extra = {}, conductor = null) {
  const g = lib('stage-gate'), s = { ...structuredClone(f.s), state: 'принят', evidence: 'проверено', ...extra };
  s.reviews = g.allJobs().filter(j => (j.workName || j.work) === f.w.name && j.role === 'проверка' && j.status === 'done').map(j => j.id);
  const out = await lib('request-context').context.run({ fallbackConductor: conductor }, () => g.evaluate(f.w, s, f.s));
  return { s, out };
}
const CONDUCTOR = { client: 'codex', active: true };

test('8, К4 (а′): этап Claude — openai и xai ПРИНЯТО, google НЕ ПРИНЯТО; dismiss в запасном режиме без пересмотра — не принят (ветки :257 и :263); вне режима — особое мнение', async () => {
  ready();
  // Вне режима: поблажка клиенту claude сохраняется (контроль).
  const c1 = stageOf('ctl-a'); review(c1, 'codex'); review(c1, 'grok'); const n1 = review(c1, 'antigravity', 1);
  c1.s.decisions = [{ kind: 'dismiss', version: c1.s.version, job_id: n1, reason: 'проверено по источнику', at: iso(Date.now()) }];
  await assert.rejects(accept(c1), /два ПРИНЯТО/);
  review(c1, 'antigravity'); let r = await accept(c1); assert.equal(r.s.state, 'принят');
  const c2 = stageOf('ctl-b'); review(c2, 'codex'); review(c2, 'grok'); const n2 = review(c2, 'antigravity', 1);
  c2.s.decisions = [{ kind: 'dismiss', version: c2.s.version, job_id: n2, reason: 'проверено по источнику', at: iso(Date.now()) }];
  review(c2, 'antigravity', 0, { finishedAt: iso(Date.now() + 3600000), startedAt: iso(Date.now() + 3500000) });
  r = await accept(c2); assert.equal(r.s.state, 'принят', 'ветка :263 вне режима');
  await word('codex');
  // В режиме: ветка :257 (отказ не снят следующим ПРИНЯТО).
  const a = stageOf('mode-a'); review(a, 'codex'); review(a, 'grok'); const na = review(a, 'antigravity', 1);
  a.s.decisions = [{ kind: 'dismiss', version: a.s.version, job_id: na, reason: 'проверено по источнику', at: iso(Date.now()) }];
  await assert.rejects(accept(a, {}, CONDUCTOR), /НЕ ПРИНЯТО antigravity — отклонено, ждёт пересмотра/);
  // Ветка :263: следующее ПРИНЯТО без причины отклонения пересмотром не считается.
  const b = stageOf('mode-b'); review(b, 'codex'); review(b, 'grok'); const nb = review(b, 'antigravity', 1);
  b.s.decisions = [{ kind: 'dismiss', version: b.s.version, job_id: nb, reason: 'проверено по источнику', at: iso(Date.now()) }];
  review(b, 'antigravity', 0, { finishedAt: iso(Date.now() + 3600000), startedAt: iso(Date.now() + 3500000) });
  await assert.rejects(accept(b, {}, CONDUCTOR), /отклонено, ждёт пересмотра/);
  // Решение, записанное в режиме, остаётся без поблажки и после возврата Claude.
  as('claude'); await team().word({ action: 'return', quote: 'Я вернулся' });
  await assert.rejects(accept(a), /отклонено, ждёт пересмотра/);
});

test('8, К4 (б, г): override от дирижёра — отказ; criterion_met при семье дирижёра среди авторов — отказ; anthropic в author нового или существующего этапа — отказ', async () => {
  ready(); await word('codex');
  const f = stageOf('ov'); review(f, 'codex'); review(f, 'grok'); review(f, 'antigravity', 1);
  for (const by of ['user', 'claude'])
    await assert.rejects(accept(f, { state: 'выдан без принятия', override: { by, reason: 'надо', quote: 'ставь', criterion: true } }, CONDUCTOR), /override и one_family \(решение Claude или пользователя\) дирижёр не записывает/);
  const m = stageOf('crit', { author: { authors: [{ family: 'anthropic', model: 'claude' }, { family: 'openai', model: 'gpt-6' }] } });
  job('codex', { ...bind(m.w, m.s), role: 'текст', task: 'текст' }); review(m, 'antigravity'); review(m, 'grok');
  await assert.rejects(accept(m, { criterion_met: { reason: 'проверено' } }, CONDUCTOR), /criterion_met — только если семьи дирижёра \(openai\) нет среди авторов части/);
  as('codex'); const t = team();
  await t.work({ action: 'create', name: 'c8', owner: OWNER, expected_revision: 0, ...workArgs, folder: PROJECT,
    stages: [{ title: 'Код', weight: 100, state: 'идёт', accept_criteria: 'работает', level: 'обычный', author: { family: 'openai', model: 'gpt-6' }, version: 'c8' }] });
  const w = read(t.workFile('c8'));
  await assert.rejects(t.work({ action: 'update', name: 'c8', owner: OWNER, expected_revision: w.revision, stages: [{ ...w.stages[0], author: { authors: [{ family: 'anthropic', model: 'claude' }, { family: 'openai', model: 'gpt-6' }] } }] }),
    /дирижёр не добавляет anthropic в author/);
  await assert.rejects(t.work({ action: 'create', name: 'c8b', owner: OWNER, expected_revision: 0, ...workArgs, folder: PROJECT,
    stages: [{ title: 'Текст', weight: 100, state: 'план', accept_criteria: 'есть', level: 'обычный', author: { family: 'anthropic', model: 'claude' }, version: 'c8b' }] }), /дирижёр не добавляет anthropic в author/);
});

test('8, К4 (в): в запасном режиме файл Sonnet не заменяет недоступную внешнюю семью независимо от источника слова', async () => {
  ready();
  as('claude'); const claudeWord = (await lib('user-word').record({ who_down: 'antigravity', quote: 'Antigravity отвалился' })).record;
  await word('codex');
  as('codex'); await team().word({ action: 'record', who_down: 'antigravity', quote: 'Гемини отвалился', owner: OWNER });
  const own = lib('user-word').read().find(r => r.quote === 'Гемини отвалился');
  assert.equal(own.source, 'chat-codex'); assert.equal(own.recorded_by, 'codex');
  const g = lib('stage-gate');
  for (const [evidence, ok] of [[own.id, false], [claudeWord.id, true]]) {
    const f = stageOf('w-' + ok, { author: { family: 'openai', model: 'gpt-6' } });
    job('codex', { ...bind(f.w, f.s), role: 'текст', task: 'текст' }); review(f, 'grok');
    const p = path.join(PROJECT, '.most', 'reviews', 'fresh-' + ok + '.txt');
    write(p, 'version: ' + f.s.version + '\nсемья: anthropic\nмодель: claude-sonnet-4.6\nзамена: antigravity\nдоказательство: ' + evidence + '\nответ\nПРИНЯТО');
    g.registerFile(f.w, f.s, p, f.s.version);
    await assert.rejects(accept(f, {}, CONDUCTOR), /нужно ПРИНЯТО другой семьи/);
  }
});

test('9: этап дирижёра — автор openai по поручению «текст» Codex, кворум google — принят; без поручения «текст» — «Автор без поручения «текст»»', async () => {
  ready(); await word('codex'); as('codex'); const t = team();
  await t.work({ action: 'create', name: 'c9', owner: OWNER, expected_revision: 0, ...workArgs, folder: PROJECT,
    stages: [{ title: 'Код', weight: 100, state: 'идёт', accept_criteria: 'работает', level: 'обычный', author: { family: 'openai', model: 'gpt-6' }, version: 'c9-v1' }] });
  let w = read(t.workFile('c9')); const s = w.stages[0], f = { w, s };
  const reviews = [review(f, 'antigravity'), review(f, 'grok')];
  const first = await t.work({ action: 'update', name: 'c9', owner: OWNER, expected_revision: w.revision, stages: [{ ...s, state: 'принят', evidence: 'кворум', reviews }] });
  assert.match(first, /Автор без поручения «текст»: этап\/openai/);
  w = read(t.workFile('c9')); assert.notEqual(w.stages[0].state, 'принят');
  job('codex', { ...bind(w, s), role: 'текст', task: 'напиши код' });
  await t.work({ action: 'update', name: 'c9', owner: OWNER, expected_revision: w.revision, stages: [{ ...w.stages[0], state: 'принят', evidence: 'кворум', reviews }] });
  assert.equal(read(t.workFile('c9')).stages[0].state, 'принят');
});

test('10, К1: смена дирижёра — слово о Codex из чата Antigravity; через 25 часов дирижёр тот же; успешное поручение Codex его не меняет', async () => {
  ready(); await word('codex');
  as('antigravity', { agy: true });
  assert.equal(await team().word({ action: 'record', who_down: 'codex', quote: 'Codex отвалился', owner: AGY_OWNER }), 'Записал: „Codex отвалился“ — дирижёр теперь Antigravity.');
  const W = lib('user-word');
  assert.equal(W.mode().conductor, 'antigravity'); assert.equal(W.mode().owner, AGY_OWNER); assert.equal(W.mode().entry.kind, 'conductor');
  assert(W.read().some(r => r.who_down === 'codex' && r.quote === 'Codex отвалился' && r.source === 'chat-antigravity'));
  assert.equal(W.mode(Date.now() + 25 * HOUR).conductor, 'antigravity');
  job('codex', { task: 'другая работа' });
  assert.equal(W.mode().conductor, 'antigravity'); assert.equal(W.mode(Date.now() + 25 * HOUR).conductor, 'antigravity');
  // Участник другой семьи слово о себе дирижёром не пишет; Grok — только дирижёр.
  as('codex');
  await assert.rejects(team().word({ action: 'record', who_down: 'grok', quote: 'Грок отвалился', owner: OWNER }), /Гостю это действие запрещено|записывает дирижёр/);
});

test('11, К2: сервер своей семьи — инструменты у гостя с самого старта; без режима чат Codex — разрешён, Antigravity — отказ; дирижёр — новое поручение', async () => {
  ready();
  let s = await mcp('codex', 'codex', guestEnv());
  try {
    assert.deepEqual(await s.tools(), ['codex_cancel', 'codex_result', 'codex_send', 'codex_status']);
    const r = await s.call('codex_send', { folder: PROJECT, task: 'Проверка', owner: OWNER });
    assert(!r.error, r.text); assert.match(r.text, /В ОЧЕРЕДИ/);
  } finally { await s.close(); }
  const team = await mcp('team', 'codex', guestEnv());
  try { assert.deepEqual(await team.tools(), ['team_rules', 'team_status', 'team_word', 'team_work']); } finally { await team.close(); }
  const agy = await mcp('antigravity', 'antigravity', guestEnv());
  try { assert.deepEqual(await agy.tools(), ['antigravity_apply', 'antigravity_cancel', 'antigravity_result', 'antigravity_send', 'antigravity_status']);
    const r = await agy.call('antigravity_send', { folder: PROJECT, task: 'Проверка', mode: 'review' });
    assert(r.error); assert.match(r.text, /только у дирижёра запасного режима/); } finally { await agy.close(); }
  await word('codex');
  s = await mcp('codex', 'codex', guestEnv());
  try {
    const r = await s.call('codex_send', { folder: PROJECT, task: 'Проверка', owner: OWNER });
    assert(!r.error, r.text); assert.match(r.text, /В ОЧЕРЕДИ/);
    const lines = r.text.split('\n'); assert.match(lines[0], /^Запасной режим: дирижёр Codex/); assert(lines.includes('Ты дирижёр: правила — team_rules part=fallback'));
    const other = await s.call('codex_send', { folder: PROJECT, task: 'Проверка', owner: 'fallback-codex-zz99' });
    assert(other.error); assert.match(other.text, /только у дирижёра/);
  } finally { await s.close(); }
});

test('12, К2: codex_send write=true от дирижёра Antigravity — основной сервер берёт под замком папки; после return — в очереди с причиной', async () => {
  ready(); await word('codex');
  as('antigravity', { agy: true }); await team().word({ action: 'record', who_down: 'codex', quote: 'Codex отвалился', owner: AGY_OWNER });
  const entry = lib('user-word').mode().entry.id;
  const g = await mcp('codex', 'antigravity', guestEnv({ MOST_TEST_AGY_PROBE: '1' }));
  let id;
  try {
    const r = await g.call('codex_send', { folder: PROJECT, task: 'ЗАПИШИ ФАЙЛ codex-out.txt', write: true, owner: AGY_OWNER });
    assert(!r.error, r.text); id = idOf(r.text);
  } finally { await g.close(); }
  const card = path.join(STATE, 'codex-jobs', id + '.json');
  assert.equal(read(card).fallbackWord, entry); assert.equal(read(card).status, 'queued'); assert.equal(read(card).owner, null);
  const locks = lib('locks'), held = await locks.tryLock('codex_folder', lib('paths').canon(PROJECT), { jobId: 'test' });
  assert(held.ok);
  const log = path.join(RUN, 'codex.log');
  const main = await mcp('codex', 'claude', { CODEX_PATH: path.join(__dirname, 'fake-codex.js'), FAKE_CODEX_LOG: log, MOST_QUEUE_TICK_MS: '100' });
  try {
    await sleep(1500);
    assert.equal(read(card).status, 'queued', 'папка занята — задание ждёт');
    await held.release();
    await until(() => read(card).status === 'done', 'запись по поручению дирижёра');
    const row = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.env.MOST_JOB_ID === id);
    assert(row.args.includes('workspace-write'));
    // Список записанных файлов с sha256 — в карточке поручения (Grok cfb0705b Б2).
    assert.deepEqual(read(card).writes, [{ path: 'codex-out.txt', sha256: sha('Codex написал codex-out.txt\n') }]);
    as('claude'); await team().word({ action: 'return', quote: 'Я вернулся' });
    const held2 = { ...read(card), id: 'held-' + crypto.randomBytes(4).toString('hex'), status: 'queued', resultFile: undefined, threadId: null, finishedAt: undefined, startedAt: iso(Date.now()) };
    json(path.join(STATE, 'codex-jobs', held2.id + '.json'), held2);
    await until(() => read(path.join(STATE, 'codex-jobs', held2.id + '.json')).fallbackHold, 'причина в карточке');
    const c = read(path.join(STATE, 'codex-jobs', held2.id + '.json'));
    assert.equal(c.status, 'queued'); assert.equal(c.fallbackHold, 'запасной режим снят — запись по поручению дирижёра ждёт Claude');
    const st = await main.call('codex_result', { id: held2.id }); assert.match(st.text, /Ждёт: запасной режим снят/);
  } finally { await main.close(); }
});

test('13, К2: antigravity_apply — от дирижёра Codex и от дирижёра Antigravity (своё поручение «текст») исполняет основной сервер; гость без прав — отказ', async () => {
  ready();
  const main = await mcp('antigravity', 'claude', { AGY_PATH: path.join(__dirname, 'fake-agy.js'), MOST_AGY_INPUT_FORMAT: 'legacy', MOST_QUEUE_TICK_MS: '100' });
  const cardOf = id => read(path.join(STATE, 'jobs', id, 'card.json'));
  try {
    const sent = await main.call('antigravity_send', { task: '[[FAKE:accept]] Текст главы', mode: 'text', folder: PROJECT }); assert(!sent.error, sent.text);
    const id1 = idOf(sent.text);
    await until(() => cardOf(id1).status === 'done', 'поручение Claude');
    await word('codex');
    const other = await mcp('antigravity', 'codex', guestEnv({ MOST_AGY_INPUT_FORMAT: 'legacy' }));
    try {
      const r = await other.call('antigravity_apply', { id: id1, to: path.join(PROJECT, 'out1.txt'), owner: 'fallback-codex-zz99' });
      assert(r.error); assert.match(r.text, /только у дирижёра запасного режима/);
      const ok = await other.call('antigravity_apply', { id: id1, to: path.join(PROJECT, 'out1.txt'), owner: OWNER });
      assert(!ok.error, ok.text); assert.match(ok.text, /поставлен в очередь основного сервера/);
    } finally { await other.close(); }
    await until(() => cardOf(id1).status === 'applied' && cardOf(id1).applyRequest?.done, 'перенос дирижёра Codex');
    assert(fs.existsSync(path.join(PROJECT, 'out1.txt'))); assert.equal(cardOf(id1).applyRequest.ok, true);
    // Дирижёр Antigravity: своё поручение «текст» себе новым сеансом и его перенос.
    as('antigravity', { agy: true }); await team().word({ action: 'record', who_down: 'codex', quote: 'Codex отвалился', owner: AGY_OWNER });
    const g = await mcp('antigravity', 'antigravity', guestEnv({ MOST_TEST_AGY_PROBE: '1', MOST_AGY_INPUT_FORMAT: 'legacy', AGY_PATH: path.join(__dirname, 'fake-agy.js') }));
    try {
      const own = await g.call('antigravity_send', { task: '[[FAKE:accept]] Свой текст', mode: 'text', folder: PROJECT, owner: AGY_OWNER }); assert(!own.error, own.text);
      const id2 = idOf(own.text);
      await until(() => cardOf(id2).status === 'done', 'поручение дирижёра Antigravity');
      assert.equal(cardOf(id2).from, 'antigravity');
      // Перезапись из очереди дирижёра — только с дословным ответом пользователя (помощник с чистой памятью, У3).
      const bare = await g.call('antigravity_apply', { id: id2, to: path.join(PROJECT, 'out1.txt'), overwrite: true, owner: AGY_OWNER });
      assert(bare.error); assert.match(bare.text, /перезапись \(overwrite\) в запасном режиме — только с дословным ответом пользователя/);
      const before = fs.readFileSync(path.join(PROJECT, 'out1.txt'), 'utf8');
      const ap = await g.call('antigravity_apply', { id: id2, to: path.join(PROJECT, 'out1.txt'), overwrite: true, quote: 'Да, перезапиши out1', owner: AGY_OWNER }); assert(!ap.error, ap.text);
      await until(() => cardOf(id2).status === 'applied' && cardOf(id2).applyRequest?.done, 'перенос дирижёра Antigravity');
      assert.equal(cardOf(id2).applyRequest.ok, true, JSON.stringify(cardOf(id2).applyRequest)); assert.equal(cardOf(id2).applyRequest.quote, 'Да, перезапиши out1');
      assert.equal(cardOf(id2).appliedTo, path.join(PROJECT, 'out1.txt')); assert(fs.readFileSync(path.join(PROJECT, 'out1.txt'), 'utf8').length && before !== undefined);
    } finally { await g.close(); }
    const denied = await main.call('antigravity_apply', { id: id1, to: path.join(PROJECT, 'x.txt') }); assert(denied.error);
  } finally { await main.close(); }
});

test('14, К5: Claude Desktop закрыт — слово записано, запуск один раз (close:false); через 2 минуты — без повтора; процесс жив, team мёртв — перезапуск; окружение гостя не передаётся', async () => {
  ready(); as('codex', { main: false });
  const calls = [], log = path.join(RUN, 'restart-1.log');
  const t = team({ evaluate: () => ({ desktopAlive: false }), restart: async (o, d) => { calls.push({ o, d }); return 'Запуск Claude запланирован (r1): через ~5 с Claude откроется; итог — уведомлением Windows и в ' + log; } });
  const out = await t.word({ action: 'record', who_down: 'claude', quote: 'Claude отвалился', owner: OWNER });
  assert.match(out, /\nОткрываю Claude Desktop — серверы связки живут в нём\.$/);
  assert(lib('user-word').mode().active, 'слово записано при закрытом Desktop');
  assert.equal(calls.length, 1); assert.equal(calls[0].o.close, false); assert.equal(calls[0].o.release, ROOT); assert.equal(calls[0].o.state, STATE);
  const dir = path.join(STATE, 'fallback'), launch = () => fs.readdirSync(dir).filter(n => n.startsWith('launch-'));
  assert.equal(launch().length, 1); const rec = path.join(dir, launch()[0]);
  assert.equal(read(rec).result, log + '.json');
  assert.match(lib('fallback').banner({ owner: OWNER }), /\nClaude Desktop: запускается \(\d\d:\d\d\)\./);
  // Итог пишет Windows PowerShell (Out-File -Encoding utf8) — с BOM (Codex 1c35bf39 п. 6).
  write(log + '.json', '\uFEFF' + JSON.stringify({ success: true })); assert.match(lib('fallback').banner({ owner: OWNER }), /\nClaude Desktop: серверы готовы\./);
  json(rec, { ...read(rec), at: iso(Date.now() - 120000) });
  assert.equal(await lib('fallback').launchDesktop(t.fallbackDeps), ''); assert.equal(calls.length, 1, 'через 2 минуты повтора нет');
  // 11 минут спустя: процесс Claude жив, team мёртв — перезапуск настоящим restart.js с подменой запуска.
  json(rec, { ...read(rec), at: iso(Date.now() - 11 * 60000) });
  let info;
  process.env.MOST_SECRET_FOR_TEST = 'guest';
  const msg = await lib('fallback').launchDesktop({ evaluate: () => ({ desktopAlive: true }),
    restartDeps: { launch: async (file, i) => { info = { ...i, script: fs.readFileSync(file, 'utf8') }; write(i.log, 'запущен ' + i.runId + '\n'); } } });
  assert.equal(msg, 'Claude Desktop открыт без серверов связки — перезапускаю его.');
  assert.equal(info.close, true); assert.match(info.script, /CloseMainWindow/);
  assert(!Object.keys(info.env).some(k => /^MOST_/i.test(k)), 'окружение гостя в запуск не передаётся');
  // Запуск без закрытия: сценарий не закрывает Claude.
  const started = await lib('restart').restart({ root: REPO, release: ROOT, state: STATE, close: false }, { launch: async (file, i) => { info = { ...i, script: fs.readFileSync(file, 'utf8') }; write(i.log, 'запущен ' + i.runId + '\n'); } });
  assert.match(started, /^Запуск Claude запланирован/); assert.doesNotMatch(info.script, /CloseMainWindow|Stop-Process/); assert.match(info.script, /Launch/);
  assert(!Object.keys(info.env).some(k => /^MOST_/i.test(k)));
});

test('15, Р-г, К3: возврат — без цитаты отказ; с цитатой режим снят; дирижёру «Claude вернулся»; claim Claude до handover и 15 минут — отказ, после — проходит; дирижёру «владение передано»', async () => {
  ready(); let w = await claudeWork(); let w2 = await claudeWork('w2'); await word('codex');
  as('codex'); const c = team();
  await c.work({ action: 'claim', name: 'w', owner: OWNER, expected_revision: w.revision });
  await c.work({ action: 'claim', name: 'w2', owner: OWNER, expected_revision: w2.revision });
  as('claude'); await assert.rejects(team().word({ action: 'return' }), /Нужна реплика пользователя дословно \(quote\)/);
  as('codex'); await assert.rejects(c.word({ action: 'return', owner: OWNER }), /Нужна реплика пользователя дословно \(quote\)/);
  as('claude'); assert.match(await team().word({ action: 'return', quote: 'Claude, ты вернулся' }), /^Записал возврат Claude: „Claude, ты вернулся“/);
  assert(!lib('user-word').mode().active);
  const back = new Date(lib('user-word').mode().returned.at), hhmm = String(back.getHours()).padStart(2, '0') + ':' + String(back.getMinutes()).padStart(2, '0');
  as('codex'); assert.equal(lib('fallback').banner({ owner: OWNER }).split('\n')[0], 'Claude вернулся в ' + hhmm + ' — остановись: итог в team_work next_step, затем team_word handover');
  // 15 минут тишины по работе w2 — Claude забирает без handover.
  const f2 = team().workFile('w2'); w2 = read(f2); json(f2, { ...w2, heartbeat_at: iso(Date.now() - 16 * 60000) }); w2 = read(f2);
  as('claude'); await team().work({ action: 'claim', name: 'w2', owner: 'claude-sess2', expected_revision: w2.revision });
  w = read(team().workFile('w'));
  await assert.rejects(team().work({ action: 'claim', name: 'w', owner: 'claude-sess2', expected_revision: w.revision }),
    /Дирижёр ещё работает \(последний вызов \d\d:\d\d\): claim — после его team_word handover или 15 минут тишины\./);
  as('codex'); assert.equal(await c.word({ action: 'handover', owner: OWNER }), 'Записал: дирижёр Codex остановился.');
  as('claude'); await team().work({ action: 'claim', name: 'w', owner: 'claude-sess2', expected_revision: w.revision });
  w = read(team().workFile('w'));
  as('codex'); await assert.rejects(c.work({ action: 'update', name: 'w', owner: OWNER, expected_revision: w.revision, next_step: 'итог' }), /владение передано claude-sess2 .* — остановитесь/);
});

test('16, Р-в: слово о Claude старше суток — режим действует', async () => {
  ready();
  write(lib('user-word').file(), JSON.stringify({ id: 'word-old', at: iso(Date.now() - 30 * HOUR), kind: 'record', who_down: 'claude', quote: 'Claude отвалился',
    source: 'chat-codex', recorded_by: 'codex', owner: OWNER, fingerprint: { pid: 4100, startedAt: APP_AT } }) + '\n');
  const m = lib('user-word').mode(); assert(m.active); assert.equal(m.conductor, 'codex');
  as('claude'); assert.throws(() => lib('access').guard('team', 'team_work', { action: 'update' }), RD);
});

test('17, Р-а, К8: host-fallback enter и roles-propose — указатель на rules/fallback.md, код 1; scripts/roles.cmd → task-roles-cli работает', async () => {
  for (const args of [['enter'], ['leave'], ['confirm-request', 'enter'], ['jobs-list'], ['actions-apply'], ['roles-propose', '--work', 'x']]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'host-fallback.js'), ...args], { encoding: 'utf8' });
    assert.equal(r.status, 1, args.join(' '));
    assert.equal((r.stdout + r.stderr).trim(), 'Запасной режим теперь по слову пользователя „Claude отвалился“ в чате Codex или Antigravity — rules/fallback.md');
  }
  const works = path.join(RUN, 'works'); fs.mkdirSync(works);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'task-roles-cli.js'), 'propose', '--work', 'demo', '--works-root', works, '--fallback-dir', path.join(RUN, 'fb')],
    { encoding: 'utf8', env: { ...process.env, MOST_REPO_ROOT: ROOT } });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).roles.status, 'proposed');
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'roles.cmd'), 'utf8'), /task-roles-cli\.js/);
});

test('18, К1: журнал с записями team-v18 читается по их правилам; прежний read() на журнале с новыми записями не падает', async () => {
  ready();
  as('claude'); await team().word({ action: 'record', who_down: 'grok', quote: 'Грок отвалился' });
  await word('codex');
  as('codex'); await team().word({ action: 'record', who_down: 'antigravity', quote: 'Гемини отвалился', owner: OWNER });
  const W = lib('user-word');
  assert.deepEqual(W.read().map(r => r.who_down), ['grok', 'antigravity']);
  assert(W.active('grok') && W.active('antigravity'));
  assert.match(W.listText(), /Запасной режим: действует, дирижёр Codex/);
  // read() из main 0371855d (team-v18) — дословно.
  const WHO = ['codex', 'antigravity', 'grok'];
  const oldRead = () => fs.readFileSync(W.file(), 'utf8').split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try {
      const r = JSON.parse(line);
      return r && typeof r.id === 'string' && WHO.includes(r.who_down) && typeof r.quote === 'string' && r.quote.trim() &&
        Number.isFinite(Date.parse(r.at)) ? [r] : [];
    } catch { return []; }
  });
  assert.deepEqual(oldRead().map(r => r.id), W.read().map(r => r.id));
});

test('19: новый процесс сервера видит режим и дирижёра из файла', async () => {
  ready(); await word('codex');
  const r = spawnSync(process.execPath, ['-e', "const m=require('./common/user-word').mode();console.log(JSON.stringify({a:m.active,c:m.conductor,o:m.owner}))"], { cwd: ROOT, encoding: 'utf8', env: process.env });
  assert.deepEqual(JSON.parse(r.stdout), { a: true, c: 'codex', o: OWNER });
  const s = await mcp('team', 'claude');
  try { const st = await s.call('team_status', {}); assert.match(st.text.split('\n')[0], /^Запасной режим: дирижёр Codex с \d\d:\d\d/); } finally { await s.close(); }
});

test('20, К12: установка при подменённом списке процессов со старыми гостями — строка отчёта; гость нового кода при несовпадении релиза — своя строка', async () => {
  const rel = 'a'.repeat(40), old = 'b'.repeat(40), live = path.join(REPO, 'live'), cmd = (r, n) => 'node "' + path.join(live, r, 'servers', n, 'index.js') + '"';
  const procs = [
    { pid: 10, ppid: 1, name: 'Codex.exe' }, { pid: 11, ppid: 10, name: 'codex.exe' }, { pid: 12, ppid: 11, name: 'node.exe', commandLine: cmd(old, 'team') },
    { pid: 20, ppid: 1, name: 'Antigravity.exe' }, { pid: 21, ppid: 20, name: 'language_server_windows_x64.exe' }, { pid: 22, ppid: 21, name: 'node.exe', commandLine: cmd(old, 'codex') },
    { pid: 30, ppid: 1, name: 'claude.exe' }, { pid: 31, ppid: 30, name: 'node.exe', commandLine: cmd(old, 'team') },
    { pid: 40, ppid: 11, name: 'node.exe', commandLine: cmd(rel, 'grok') },
    // Гость поручения codex exec основного сервера старого релиза — потомок Claude Desktop (помощник с чистой памятью, У6).
    { pid: 50, ppid: 1, name: 'claude.exe' }, { pid: 51, ppid: 50, name: 'node.exe' }, { pid: 52, ppid: 51, name: 'codex.exe' }, { pid: 53, ppid: 52, name: 'node.exe', commandLine: cmd(old, 'team') }];
  const cc = lib('client-configs'), stale = list => cc.staleGuests({ root: REPO, release: rel }, { processes: () => list });
  assert.equal(stale(procs), 'Codex и Antigravity работают со старыми серверами связки; слово о Claude заработает в них после перезапуска приложения.');
  assert.equal(stale(procs.filter(p => p.pid < 20 || p.pid >= 30)), 'Codex работает со старыми серверами связки; слово о Claude заработает в нём после перезапуска приложения.');
  assert.equal(stale(procs.filter(p => p.pid >= 30)), '', 'основные серверы Claude и гости нового релиза строки не дают');
  process.env.MOST_TEST_PROCESS_TREE = JSON.stringify(procs);
  assert.match(cc.staleGuests({ root: REPO, release: rel }), /^Codex и Antigravity работают со старыми серверами связки/);
  assert.match(fs.readFileSync(path.join(ROOT, 'common', 'team.js'), 'utf8'), /staleGuests\(\{ root: this\.root, release: deployedCommit \}, this\.staleDeps \|\| \{\}\)/);
  json(path.join(live, 'deployed.json'), { commit: rel });
  as('codex'); assert.equal(lib('fallback').releaseLine(old), 'Гость связки работает со старым релизом bbbbbbbb (установлен aaaaaaaa): перезапустите приложение.');
  assert.equal(lib('fallback').releaseLine(rel), '');
  as('claude'); assert.equal(lib('fallback').releaseLine(old), '');
});

test('21, К11: ссылка Antigravity на AGENTS.md старого релиза — после установки на текущий', async () => {
  const cc = lib('client-configs'), rel = path.join(REPO, 'live', 'a'.repeat(40)), oldRef = 'read_file(' + path.join(REPO, 'live', 'b'.repeat(40), 'AGENTS.md') + ')';
  const current = 'read_file(' + path.join(rel, 'AGENTS.md') + ')', foreign = 'read_file(' + path.join(RUN, 'other', 'b'.repeat(40), 'AGENTS.md') + ')';
  const cfg = { userSettings: { globalPermissionGrants: { allow: ['keep', oldRef, foreign, ...cc.grants] } } };
  const plans = cc.plans([{ kind: 'permissions', file: path.join(RUN, 'config.json'), config: cfg }], rel, REPO, STATE, 'node');
  assert.equal(plans.length, 1, 'все разрешения есть, но ссылка устарела — план установки');
  const allow = JSON.parse(plans[0].next).userSettings.globalPermissionGrants.allow;
  assert(allow.includes(current) && !allow.includes(oldRef) && allow.includes(foreign) && allow.includes('keep'));
  const done = { userSettings: { globalPermissionGrants: { allow } } };
  assert.deepEqual(cc.plans([{ kind: 'permissions', file: path.join(RUN, 'config.json'), config: done }], rel, REPO, STATE, 'node'), []);
});

test('22, К4а: этап Claude — поручение «текст» Codex — прежний отказ; continue_stage по снимку (копии, путь и хеш), принят кворумом; семья файла помощника его часть не проверяет; чужой этап и испорченная копия — отказ; этап с отказом снят', async () => {
  ready();
  write(path.join(PROJECT, 'claude.md'), 'Начало текста Claude\n'); write(path.join(PROJECT, 'helper.md'), 'Текст Antigravity\n'); write(path.join(PROJECT, 'codex.md'), 'Продолжение\n');
  write(path.join(PROJECT, 'helper2.md'), 'Черновик помощника\nправка Claude\n');
  as('claude'); const t = team();
  await t.work({ action: 'create', name: 'c22', owner: 'claude-sess', expected_revision: 0, ...workArgs, folder: PROJECT, stages: [
    { title: 'Глава', weight: 50, state: 'идёт', accept_criteria: 'написано', level: 'обычный', author: { family: 'anthropic', model: 'claude-opus-4.6' }, material: ['claude.md', 'helper.md', 'helper2.md'] },
    { title: 'Мелочь', weight: 30, state: 'план', accept_criteria: 'есть', level: 'обычный', author: { family: 'anthropic', model: 'claude-opus-4.6' }, version: 'm1' },
    { title: 'Код', weight: 20, state: 'идёт', accept_criteria: 'есть', level: 'обычный', author: { family: 'openai', model: 'gpt-6' }, version: 'k1' }] });
  let w = read(t.workFile('c22')); const [S1, small, code] = w.stages;
  // helper.md перенесён поручением «текст» Antigravity и не менялся; helper2.md перенесён, затем его правил Claude (хеш другой).
  const applied = (file, text) => ({ status: 'applied', appliedTo: path.join(PROJECT, file), apply: { target: path.join(PROJECT, file), newHash: sha(text) } });
  const agyText = job('antigravity', { ...bind(w, S1), role: 'текст', task: 'напиши часть', ...applied('helper.md', 'Текст Antigravity\n') });
  const agyText2 = job('antigravity', { ...bind(w, S1), role: 'текст', task: 'набросай черновик', ...applied('helper2.md', 'Черновик помощника\n') });
  const no = job('antigravity', { ...bind(w, S1), task: S1.version }, 'НЕ ПРИНЯТО: 1 блокирующее');
  await word('codex');
  const m = lib('user-word').mode(), snap = read(path.join(STATE, 'fallback', 'snapshot-' + m.word.id + '.json'));
  const snapStage = snap.works.find(x => x.name === 'c22').stages.find(s => s.id === S1.id);
  const claudeSha = sha('Начало текста Claude\n');
  assert.deepEqual(snapStage.material, [{ path: 'claude.md', sha256: claudeSha }, { path: 'helper.md', sha256: sha('Текст Antigravity\n') },
    { path: 'helper2.md', sha256: sha('Черновик помощника\nправка Claude\n') }]);
  const copy = path.join(STATE, 'fallback', 'snapshot-' + m.word.id, claudeSha);
  assert.equal(fs.readFileSync(copy, 'utf8'), 'Начало текста Claude\n', 'копия файла material в снимке');
  job('codex', { ...bind(w, S1), role: 'текст', task: 'допиши главу' });
  await assert.rejects(lib('stage-gate').evaluate(w, { ...structuredClone(S1), state: 'принят', evidence: 'x', reviews: [no] }, S1), /семья текста не совпадает с author части/);
  as('codex'); const c = team();
  await c.work({ action: 'claim', name: 'c22', owner: OWNER, expected_revision: w.revision });
  w = read(c.workFile('c22'));
  const cont = (id, extra = {}) => c.work({ action: 'update', name: 'c22', owner: OWNER, expected_revision: w.revision, continue_stage: { id, author: { family: 'openai', model: 'gpt-6' }, ...extra } });
  for (const id of [small.id, code.id, 'нет-такого']) await assert.rejects(cont(id), /нет в снимке запасного режима \(word-[0-9a-f-]+\) с автором anthropic и состоянием «идёт»/);
  // Claude-«зомби» после слова правит файл своими средствами: строка в баннере, продолжение берёт копию по хешу.
  write(path.join(PROJECT, 'claude.md'), 'Правка после слова\n');
  assert.match(lib('fallback').banner({ owner: OWNER }), /\nПосле слова изменены файлы этапов: claude\.md — этап-продолжение возьмёт их копии из снимка\./);
  fs.writeFileSync(copy, 'испорчено');
  await assert.rejects(cont(S1.id), /continue_stage: копии файла claude\.md в снимке нет или она не совпадает с хешем снимка — частичный результат Claude только из снимка/);
  fs.writeFileSync(copy, 'Начало текста Claude\n');
  as('claude'); await assert.rejects(t.work({ action: 'update', name: 'c22', owner: 'claude-sess', expected_revision: w.revision, continue_stage: { id: S1.id, author: { family: 'openai', model: 'gpt-6' } } }), RD);
  as('codex');
  await cont(S1.id, { material: ['codex.md'] });
  w = read(c.workFile('c22'));
  assert(!w.stages.some(s => s.id === S1.id), 'прежний этап снят'); assert(w.removed_stages.some(s => s.id === S1.id));
  assert.equal(w.plan_changes.at(-1).reason, 'продолжение этапа Claude в запасном режиме, снимок ' + m.word.id + '; снят этап ' + S1.id);
  const S2 = w.stages[0], restored = '.most/snapshot-' + m.word.id.slice(5, 13) + '/claude.md';
  assert.equal(S2.title, 'Глава (продолжение)'); assert.equal(S2.weight, 50); assert.equal(S2.continuation.word, m.word.id); assert.equal(S2.continuation.from, S1.id);
  assert.deepEqual(S2.continuation.restored, ['claude.md']);
  assert.equal(fs.readFileSync(path.join(PROJECT, restored), 'utf8'), 'Начало текста Claude\n');
  assert.equal(fs.readFileSync(path.join(PROJECT, 'claude.md'), 'utf8'), 'Правка после слова\n', 'живой файл не тронут');
  assert.deepEqual(S2.author[0], { part: 'продолжение', authors: [{ family: 'anthropic', model: 'claude-opus-4.6' }, { family: 'openai', model: 'gpt-6' }], material: [restored, 'codex.md'] });
  // Путь и хеш совпали с переносом — часть семьи помощника; путь совпал, хеш другой — обе семьи (anthropic и google).
  assert.equal(S2.author[1].part, 'поручение ' + agyText); assert.equal(S2.author[1].family, 'google'); assert.equal(S2.author[1].source_job, agyText); assert.deepEqual(S2.author[1].material, ['helper.md']);
  assert.equal(S2.author[2].part, 'поручение ' + agyText2 + ', файл изменён после него'); assert.deepEqual(S2.author[2].authors.map(a => a.family), ['anthropic', 'google']);
  assert.equal(S2.author[2].source_job, agyText2); assert.deepEqual(S2.author[2].material, ['helper2.md']);
  // Поле continuation ставит только сервер.
  await c.work({ action: 'update', name: 'c22', owner: OWNER, expected_revision: w.revision, stages: w.stages.map(s => s.id === code.id ? { ...s, continuation: { word: 'подделка' } } : s) });
  w = read(c.workFile('c22')); assert.equal(w.stages.find(s => s.id === code.id).continuation, undefined); assert.equal(w.stages[0].continuation.word, m.word.id);
  job('codex', { ...bind(w, S2), role: 'текст', task: 'допиши главу' });
  const hashes = S2.material.map(p => p + ' sha256-' + sha(fs.readFileSync(path.join(PROJECT, p)))).join('; ');
  const reviews = [job('antigravity', { ...bind(w, S2), task: S2.version }), job('grok', { ...bind(w, S2), task: S2.version + ' ' + hashes })];
  // Приёмка — через MCP-клиент гостя: схема zod переставляет ключи частей author (помощник с чистой памятью, Б2).
  const guest = await mcp('team', 'codex', guestEnv());
  try {
    const accept22 = async ids => {
      const cur = read(c.workFile('c22'));
      const res = await guest.call('team_work', { action: 'update', name: 'c22', owner: OWNER, expected_revision: cur.revision,
        stages: cur.stages.map(s => s.id === S2.id ? { ...s, state: 'принят', evidence: 'кворум', reviews: ids } : s) });
      assert(!res.error, res.text); return res.text;
    };
    // Google — автор частей помощника: его ПРИНЯТО засчитано только части «продолжение»; без openai части помощника ждут.
    const wait = await accept22(reviews);
    assert.match(wait, new RegExp('поручение ' + agyText + ': нужно ПРИНЯТО другой семьи')); assert.match(wait, new RegExp('поручение ' + agyText2 + ', файл изменён после него: нужно ПРИНЯТО другой семьи'));
    assert.doesNotMatch(wait, /продолжение: нужны два ПРИНЯТО/); assert.notEqual(read(c.workFile('c22')).stages[0].state, 'принят');
    reviews.push(job('codex', { ...bind(w, S2), task: S2.version }));
    const res = await accept22(reviews);
    w = read(c.workFile('c22'));
    assert.equal(w.stages[0].state, 'принят', res);
    assert.match(w.stages[0].gate.message, /авторство anthropic — по снимку запасного режима/);
  } finally { await guest.close(); }
});

test('23, К2: сеанс дирижёра — второй чат Codex с другой меткой участник; отпечаток мёртв — rebind по цитате; поручение, потомок основного сервера и другой релиз — не чат', async () => {
  ready(); await word('codex');
  as('codex'); const t = team(), f = lib('fallback');
  await assert.rejects(t.work({ action: 'create', name: 'x23', owner: 'fallback-codex-zz99', expected_revision: 0, ...workArgs, folder: PROJECT, stages: [] }), /Гостю это действие запрещено/);
  const other = f.banner({ owner: 'fallback-codex-zz99' });
  assert.match(other, /\nДирижёр — чат Codex с меткой fallback-codex-ab12; если метка не твоя — ты участник\./); assert.doesNotMatch(other, /Ты дирижёр/);
  assert.match(f.banner({ owner: OWNER }), /\nТы дирижёр: правила — team_rules part=fallback/);
  await assert.rejects(t.word({ action: 'rebind', quote: 'продолжай', owner: 'fallback-codex-new1' }), /Прежний сеанс дирижёра жив/);
  // Приложение перезапущено: новый родитель 4200, прежнего 4100 нет.
  as('codex', { parent: 4200 });
  assert.equal(f.session({ owner: OWNER }), null, 'прав нет ни у кого');
  assert.match(f.banner({ owner: 'fallback-codex-new1' }), /Прежний сеанс дирижёра завершён: если пользователь пишет тебе — team_word rebind/);
  await assert.rejects(t.word({ action: 'rebind', owner: 'fallback-codex-new1' }), /Нужна реплика пользователя дословно \(quote\)/);
  as('codex', { parent: 4200, job: 'job-9' });
  await assert.rejects(t.word({ action: 'rebind', quote: 'продолжай', owner: 'fallback-codex-new1' }), /Гостю это действие запрещено: поручение-сеанс этого не делает/);
  assert.match(f.chatProof('codex').reason, /это поручение-сеанс, а не чат/);
  as('codex', { parent: 4200 });
  assert.equal(await t.word({ action: 'rebind', quote: 'продолжай', owner: 'fallback-codex-new1' }), 'Записал: „продолжай“ — дирижёр Codex, новый сеанс fallback-codex-new1.');
  const m = lib('user-word').mode();
  assert.equal(m.owner, 'fallback-codex-new1'); assert.equal(m.fingerprint.pid, 4200); assert.equal(m.entry.kind, 'conductor'); assert.equal(m.entry.reason, 'rebind');
  assert(f.session({ owner: 'fallback-codex-new1' })?.active);
  // Потомок основного сервера (PID и время старта из ready) — поручение; PID отдан другому процессу — не основной сервер.
  const anc = start => JSON.stringify([{ pid: process.pid, ppid: 7000, name: 'node.exe', startedAt: iso(Date.now()) }, { pid: 7000, ppid: 1, name: 'node.exe', startedAt: start }]);
  as('codex', { tree: anc(READY_AT) });
  assert.match(f.chatProof('codex').reason, /среди предков — основной сервер team: это поручение/);
  await assert.rejects(t.word({ action: 'rebind', quote: 'x', owner: 'fallback-codex-q1w2' }), /среди предков — основной сервер team/);
  as('codex', { tree: anc(iso(Date.now() - 1000)) }); assert(f.chatProof('codex').ok, 'PID основного сервера отдан другому процессу');
  // Поручение-сирота: Claude Desktop упал, codex exec жив, его предок — основной сервер — мёртв. Отсекает первое условие (MOST_JOB_ID):
  // без переменной то же дерево прошло бы как чат.
  const orphan = JSON.stringify([{ pid: process.pid, ppid: 6100, name: 'node.exe', startedAt: iso(Date.now()) }, { pid: 6100, ppid: 7000, name: 'codex.exe', startedAt: iso(Date.now() - 60000) }]);
  as('codex', { tree: orphan, job: 'job-orphan' });
  assert.deepEqual(f.chatProof('codex'), { ok: false, job: true, reason: 'это поручение-сеанс, а не чат' });
  await assert.rejects(t.word({ action: 'rebind', quote: 'x', owner: 'fallback-codex-o1o2' }), /Гостю это действие запрещено: поручение-сеанс/);
  as('codex', { tree: orphan }); assert(f.chatProof('codex').ok, 'третье условие сироту не ловит — его ловит первое');
  // Поручения гостя — тоже только из доказанного чата (Codex 1c35bf39 п. 2): предки, неудавшееся опознание, другой релиз.
  const acc = lib('access'), send = () => acc.guard('antigravity', 'antigravity_send', { task: 't' });
  as('codex', { tree: anc(READY_AT) }); assert.throws(send, /^Error: Гостю это действие запрещено: поручение-сеанс этого не делает.*среди предков — основной сервер team/);
  assert.throws(() => acc.guard('grok', 'grok_send', { task: 't' }), /среди предков — основной сервер team/);
  as('codex', { tree: '[]' }); assert.throws(send, /не удалось снять отпечаток процесса/);
  as('codex', { tree: orphan }); send();
  ready({ release: path.join(RUN, 'other-release') }); as('codex', { parent: 4200 });
  // Другой релиз основного сервера обычным поручениям не мешает (гости открытых приложений после установки, помощник Н1);
  // слово и права дирижёра — нет, строка «перезапусти приложение» (помощник Н2).
  send();
  assert.match(f.chatProof('codex').reason, /основной сервер другого релиза/);
  await assert.rejects(t.word({ action: 'rebind', quote: 'x', owner: 'fallback-codex-r1r2' }),
    /^Error: Гостю это действие запрещено: сервер этого чата от прошлой установки — перезапусти приложение \(основной сервер другого релиза\)\./);
  // Записи основного сервера нет, она не читается или JSON повреждён — отказ по умолчанию (Codex 7a3bd85b п. 1).
  fs.rmSync(path.join(STATE, 'ready', 'team.json')); assert.match(f.chatProof('codex').reason, /нет записи основного сервера/);
  assert.throws(send, /не могу подтвердить, что это чат \(запись основного сервера \(state\\ready\\team\.json\) не прочитана\), — скажи это в чате Codex/);
  write(path.join(STATE, 'ready', 'team.json'), '{ битый json'); assert.throws(send, /запись основного сервера .* не прочитана/);
  write(path.join(STATE, 'ready', 'team.json'), JSON.stringify({ release: ROOT, startedAt: READY_AT })); assert.throws(send, /не прочитана/, 'без PID');
});

test('24, К2: после return дирижёру — team_work update только next_step; stages — отказ; handover — проходит; обычный чат снова может поручать своей семье', async () => {
  ready(); let w = await claudeWork(); await word('codex');
  as('codex'); const t = team();
  await t.work({ action: 'claim', name: 'w', owner: OWNER, expected_revision: w.revision });
  as('claude'); await team().word({ action: 'return', quote: 'Я снова здесь' });
  as('codex'); w = read(t.workFile('w'));
  await t.work({ action: 'update', name: 'w', owner: OWNER, expected_revision: w.revision, next_step: 'Итог дирижёра: сделано X' });
  w = read(t.workFile('w')); assert.equal(w.next_step, 'Итог дирижёра: сделано X');
  await assert.rejects(t.work({ action: 'update', name: 'w', owner: OWNER, expected_revision: w.revision, stages: w.stages }), /Гостю это действие запрещено/);
  await assert.rejects(t.work({ action: 'close', name: 'w', owner: OWNER, expected_revision: w.revision }), /Гостю это действие запрещено/);
  assert.doesNotThrow(() => lib('access').guard('codex', 'codex_send', { folder: PROJECT, task: 't', owner: OWNER }));
  assert.equal(await t.word({ action: 'handover', owner: OWNER }), 'Записал: дирижёр Codex остановился.');
});

test('25, К2: разрешения Antigravity и config.toml — team_word и antigravity_*; у каждого сервера env_vars = ["MOST_JOB_ID"]; проба установки — полный список, прежнему установщику — прежний', async () => {
  const cc = lib('client-configs'), rel = path.join(REPO, 'live', 'a'.repeat(40));
  for (const g of ['team/team_word', 'antigravity/antigravity_send', 'antigravity/antigravity_status', 'antigravity/antigravity_result', 'antigravity/antigravity_apply', 'antigravity/antigravity_cancel'])
    assert(cc.grants.includes('mcp(' + g + ')'), g);
  const text = cc.toml('# мой текст\n', rel, REPO, STATE, 'node');
  assert(text.includes('env_vars = ["MOST_JOB_ID"]'));
  const servers = cc.block(text).parsed.root.mcp_servers;
  assert.deepEqual(Object.keys(servers).sort(), ['antigravity', 'codex', 'team']);
  for (const n of Object.keys(servers)) {
    assert.deepEqual(servers[n].env_vars, ['MOST_JOB_ID'], n); assert.equal(servers[n].default_tools_approval_mode, 'approve', n); assert.equal(servers[n].env.MOST_CLIENT, 'codex', n);
  }
  assert.equal(cc.toml(text, rel, REPO, STATE, 'node'), text, 'повтор установки');
  const agy = cc.jsonConfig({}, 'agy', rel, REPO, STATE, 'node');
  assert.deepEqual(Object.keys(agy.mcpServers).sort(), ['antigravity', 'codex', 'team']);
  const acc = lib('access');
  assert.deepEqual(acc.guestTools('team', 'codex'), ['team_status', 'team_rules', 'team_work', 'team_word']);
  assert.deepEqual(acc.guestTools('team', 'grok'), ['team_status', 'team_rules', 'team_work']);
  assert.deepEqual(acc.guestTools('codex', 'codex'), ['codex_status', 'codex_send', 'codex_result', 'codex_cancel']);
  assert.deepEqual(acc.guestTools('antigravity', 'codex'), ['antigravity_status', 'antigravity_send', 'antigravity_result', 'antigravity_apply']);
  assert.deepEqual(acc.guestTools('codex', 'claude'), []);
  const probe = lib('probe').probe, file = path.join(ROOT, 'servers', 'team', 'index.js');
  const base = { ...process.env, MOST_CLIENT: 'codex', MOST_PROBE_ONLY: '1' };
  const full = (await probe(file, { ...base, MOST_PROBE_GUEST: 'full' })).tools.map(t => t.name).sort();
  assert.deepEqual(full, ['team_rules', 'team_status', 'team_word', 'team_work']);
  const legacy = (await probe(file, base)).tools.map(t => t.name).sort();
  assert.deepEqual(legacy, ['team_rules', 'team_status', 'team_work'], 'установщик прежнего релиза проверяет прежним списком');
  const own = (await probe(path.join(ROOT, 'servers', 'codex', 'index.js'), { ...base, MOST_PROBE_GUEST: 'full' })).tools.map(t => t.name).sort();
  assert.deepEqual(own, ['codex_cancel', 'codex_result', 'codex_send', 'codex_status']);
});

test('C, К1: переход режима атомарен — запись второго чата после возврата не выдаётся за участника и включает режим заново со снимком; запись участника режим не включает', async () => {
  ready(); await word('codex');
  const W = lib('user-word'), locks = lib('locks'), first = W.mode().word.id;
  // Запись участника после возврата (как в прежней гонке) режим не включает.
  fs.appendFileSync(W.file(), JSON.stringify({ id: 'word-ret-1', at: iso(Date.now()), kind: 'return', who_down: 'claude', quote: 'Я вернулся', by: 'claude' }) + '\n');
  fs.appendFileSync(W.file(), JSON.stringify({ id: 'word-part-1', at: iso(Date.now() + 1), kind: 'record', who_down: 'claude', quote: 'Claude упал', source: 'chat-antigravity', recorded_by: 'antigravity', participant: true }) + '\n');
  assert.equal(W.mode(Date.now() + 1000).active, false);
  // Новый режим; второй чат Codex ждёт замок журнала, пока возврат пишется, — и видит возврат.
  as('codex'); await team().word({ action: 'record', who_down: 'claude', quote: 'Claude отвалился снова', owner: OWNER });
  assert(W.mode().active);
  const held = await locks.tryLock('team_words', path.resolve(W.file())); assert(held.ok);
  as('codex');
  const pending = team().word({ action: 'record', who_down: 'claude', quote: 'Claude опять пропал', owner: 'fallback-codex-zz99' });
  await sleep(300);
  fs.appendFileSync(W.file(), JSON.stringify({ id: 'word-ret-2', at: iso(Date.now()), kind: 'return', who_down: 'claude', quote: 'Я здесь', by: 'claude' }) + '\n');
  await held.release();
  const out = await pending;
  assert.match(out, /^Записал: „Claude опять пропал“ — Claude недоступен; дирижёр — Codex/);
  const m = W.mode();
  assert(m.active); assert.equal(m.owner, 'fallback-codex-zz99'); assert.notEqual(m.word.id, first);
  assert(fs.existsSync(path.join(STATE, 'fallback', 'snapshot-' + m.word.id + '.json')), 'снимок у каждой включающей записи');
});

test('C, Grok cfb0705b: сбой снимка не глотается — строка в ответе и баннере; continue_stage отказывает', async () => {
  ready(); await claudeWork();
  as('codex');
  const t = team({ evaluate: () => ({ desktopAlive: true }), restart: async () => { throw Error('запуск не ожидался'); }, snapshot: () => { throw Error('диск занят'); } });
  const out = await t.word({ action: 'record', who_down: 'claude', quote: 'Claude отвалился', owner: OWNER });
  assert.match(out, /\nСнимок открытых работ не записан \(диск занят\): этап, начатый Claude, продолжить нельзя — continue_stage откажет/);
  assert.match(lib('fallback').banner({ owner: OWNER }), /\nСнимок открытых работ не записан \(диск занят\)/);
  let w = read(team().workFile('w'));
  await team().work({ action: 'claim', name: 'w', owner: OWNER, expected_revision: w.revision }); w = read(team().workFile('w'));
  await assert.rejects(team().work({ action: 'update', name: 'w', owner: OWNER, expected_revision: w.revision, continue_stage: { id: w.stages[0].id, author: { family: 'openai', model: 'gpt-6' } } }),
    /continue_stage: Снимок открытых работ не записан \(диск занят\)/);
});

test('D, Т4: в запасном режиме дирижёр не принимает этап «высокий» даже с зарегистрированным файлом помощника; Claude вне режима — принимает', async () => {
  ready();
  const make = name => {
    write(path.join(PROJECT, name + '.md'), 'Текст ' + name + '\n');
    const f = stageOf(name, { level: 'высокий', author: { family: 'openai', model: 'gpt-6' }, material: [name + '.md'] });
    job('codex', { ...bind(f.w, f.s), role: 'текст', task: 'текст' }); review(f, 'antigravity'); review(f, 'grok', 0, { task: f.s.version + ' sha256-' + sha('Текст ' + name + '\n') });
    const p = path.join(PROJECT, '.most', 'reviews', 'extra-' + name + '.txt');
    write(p, 'version: ' + f.s.version + '\nсемья: anthropic\nмодель: claude-sonnet-4.6\nответ\nПРИНЯТО'); lib('stage-gate').registerFile(f.w, f.s, p, f.s.version);
    return f;
  };
  const ctl = make('high-ctl');
  assert.equal((await accept(ctl)).s.state, 'принят', 'контроль: вне режима этап «высокий» принимается');
  await word('codex');
  const f = make('high-mode');
  await assert.rejects(accept(f, {}, CONDUCTOR), /Запасной режим: этап «высокий» ждёт Claude — дирижёр его не принимает/);
  await assert.rejects(accept(f, { state: 'идёт', criterion_met: { reason: 'проверено' } }, CONDUCTOR), /этап «высокий» ждёт Claude/);
});

test('E, К4: запреты дирижёра действуют и на этапах версии 14 — override, one_family, criterion_met', async () => {
  ready(); await word('codex');
  const g = lib('stage-gate'), f = stageOf('v14', { author: { family: 'openai', model: 'gpt-6' } });
  f.s.rules_version = 14;
  job('codex', { ...bind(f.w, f.s), role: 'текст', task: 'текст' });
  const run = extra => lib('request-context').context.run({ fallbackConductor: CONDUCTOR }, () => g.evaluate(f.w, { ...structuredClone(f.s), ...extra }, f.s));
  const issued = await run({ state: 'выдан без принятия', override: { by: 'user', quote: 'ставь' } });
  assert.match(issued, /выдано без принятия по слову пользователя: ставь/);
  await assert.rejects(run({ state: 'выдан без принятия', one_family: true, reason: 'нет второй семьи' }), /override и one_family/);
  await assert.rejects(run({ criterion_met: { reason: 'проверено' } }), /criterion_met — только если семьи дирижёра \(openai\) нет среди авторов части/);
});

test('F, К4а: этап Claude из снимка — дирижёр не меняет material, version, source_jobs, partial_sources, accept_criteria, artifact_manifest; принимает только с material, равным снимку', async () => {
  ready();
  write(path.join(PROJECT, 'fa.md'), 'Часть A\n'); write(path.join(PROJECT, 'fb.md'), 'Часть B\n'); write(path.join(PROJECT, 'extra.md'), 'Codex дописал\n');
  as('claude'); const t = team();
  await t.work({ action: 'create', name: 'f', owner: 'claude-sess', expected_revision: 0, ...workArgs, folder: PROJECT, stages: [
    { title: 'A', weight: 50, state: 'идёт', accept_criteria: 'есть', level: 'обычный', author: { family: 'anthropic', model: 'claude-opus-4.6' }, material: ['fa.md'] },
    { title: 'B', weight: 50, state: 'идёт', accept_criteria: 'есть', level: 'обычный', author: { family: 'anthropic', model: 'claude-opus-4.6' }, material: ['fb.md'] }] });
  await word('codex'); as('codex'); const c = team();
  let w = read(t.workFile('f'));
  await c.work({ action: 'claim', name: 'f', owner: OWNER, expected_revision: w.revision }); w = read(c.workFile('f'));
  const upd = (patch, id = w.stages[0].id) => c.work({ action: 'update', name: 'f', owner: OWNER, expected_revision: read(c.workFile('f')).revision,
    stages: read(c.workFile('f')).stages.map(s => s.id === id ? { ...s, ...patch } : s) });
  for (const [k, v] of [['material', ['fa.md', 'extra.md']], ['accept_criteria', 'иначе'], ['source_jobs', ['job-x']], ['version', 'другая'], ['partial_sources', []], ['artifact_manifest', 'fa.md']])
    await assert.rejects(upd({ [k]: v }), new RegExp('этап Claude «A» дирижёр не дописывает — ' + k + ' не меняется; продолжение — continue_stage'), k);
  // A не менялся после слова — кворум принимает; B правили после слова — только continue_stage.
  const A = w.stages[0], B = w.stages[1];
  job('antigravity', { ...bind(w, A), task: A.version }); job('codex', { ...bind(w, A), task: A.version });
  await upd({ state: 'принят', evidence: 'кворум' });
  assert.equal(read(c.workFile('f')).stages[0].state, 'принят');
  write(path.join(PROJECT, 'fb.md'), 'Часть B, правка после слова\n');
  await assert.rejects(upd({ state: 'принят', evidence: 'кворум' }, B.id), /этап Claude «B» принимается только с material, равным снимку word-[0-9a-f-]+; иначе — continue_stage/);
});

test('H, К4а: файл поручения Codex с записью — частью openai по списку writes (путь и хеш); при поручении Codex без списка — часть anthropic и openai', async () => {
  ready();
  write(path.join(PROJECT, 'h1.md'), 'Claude\n'); write(path.join(PROJECT, 'h2.md'), 'Codex написал h2.md\n');
  as('claude'); const t = team();
  await t.work({ action: 'create', name: 'h', owner: 'claude-sess', expected_revision: 0, ...workArgs, folder: PROJECT, stages: [
    { title: 'Глава', weight: 100, state: 'идёт', accept_criteria: 'есть', level: 'обычный', author: { family: 'anthropic', model: 'claude-opus-4.6' }, material: ['h1.md', 'h2.md'] }] });
  let w = read(t.workFile('h')); const S = w.stages[0];
  const listed = job('codex', { ...bind(w, S), role: 'текст', write: true, folder: PROJECT, writes: [{ path: 'h2.md', sha256: sha('Codex написал h2.md\n') }], task: 'напиши h2' });
  await word('codex'); as('codex'); const c = team();
  await c.work({ action: 'claim', name: 'h', owner: OWNER, expected_revision: w.revision }); w = read(c.workFile('h'));
  await c.work({ action: 'update', name: 'h', owner: OWNER, expected_revision: w.revision, continue_stage: { id: S.id, author: { family: 'google', model: 'gemini-3.8' } } });
  let N = read(c.workFile('h')).stages[0];
  assert.deepEqual(N.author[0], { part: 'продолжение', material: ['h1.md'], authors: [{ family: 'anthropic', model: 'claude-opus-4.6' }, { family: 'google', model: 'gemini-3.8' }] });
  assert.equal(N.author[1].part, 'поручение ' + listed); assert.equal(N.author[1].family, 'openai'); assert.deepEqual(N.author[1].material, ['h2.md']);
  assert.deepEqual(Object.keys(N.author[1]), ['part', 'material', 'source_job', 'family', 'model'], 'порядок ключей схемы zod');
  // Старое поручение Codex этой работы без списка writes: какие файлы оно трогало, неизвестно — часть anthropic и openai.
  const lib2 = lib('fallback');
  const old = { id: 'codex-old', who: 'codex', work: 'h', write: true, role: 'текст', status: 'done', folder: PROJECT, model: 'gpt-6' };
  as('codex');
  const base = () => ({ ...read(c.workFile('h')), stages: [structuredClone(S)] });
  write(path.join(PROJECT, 'h4.md'), 'добавлен в продолжение\n');
  const plan = lib2.continuation(base(), base(), { owner: OWNER, continue_stage: { id: S.id, author: { family: 'google', model: 'gemini-3.8' }, material: ['h4.md'] } },
    [...lib('stage-gate').allJobs(), old]);
  N = plan.stages[0];
  assert.deepEqual(N.author.map(p => p.part), ['продолжение', 'поручение ' + listed, 'файлы при поручениях Codex']);
  // Добавленный файл без известного писателя — та же ветка, что у файлов снимка: openai среди авторов части (Codex 9a66ede6).
  assert.deepEqual(N.author[2].material, ['h1.md', 'h4.md']); assert.deepEqual(N.author[2].authors.map(a => a.family), ['anthropic', 'openai']); assert.equal(N.author[2].source_job, 'codex-old');
  assert.deepEqual(N.author[0].material, []);
  // При продолжении семьёй openai эти файлы — в общей части anthropic и openai.
  const plan2 = lib2.continuation(base(), base(), { owner: OWNER, continue_stage: { id: S.id, author: { family: 'openai', model: 'gpt-6' } } },
    [...lib('stage-gate').allJobs(), old]);
  assert.deepEqual(plan2.stages[0].author[0].material, ['h1.md']); assert.equal(plan2.stages[0].author.length, 2);
  // Поручение без записи получает пустой список; файл папки складывается списком изменённых.
  const before = lib2.folderState(PROJECT); write(path.join(PROJECT, 'h3.md'), 'новый\n');
  assert.deepEqual(lib2.folderChanges(PROJECT, before), [{ path: 'h3.md', sha256: sha('новый\n') }]);
});

test('У2, К4 (а′): дата нового решения — серверная; отклонение, принятое дирижёром, ждёт пересмотра и при решении Claude до слова', async () => {
  ready();
  as('claude'); const t = team();
  await t.work({ action: 'create', name: 'u2', owner: 'claude-sess', expected_revision: 0, ...workArgs, folder: PROJECT, stages: [
    { title: 'Обзор', weight: 100, state: 'идёт', accept_criteria: 'есть', level: 'обычный', author: { family: 'anthropic', model: 'claude-opus-4.6' }, version: 'u2-v1' }] });
  let w = read(t.workFile('u2')); const S = w.stages[0];
  job('codex', { ...bind(w, S), task: S.version }); job('grok', { ...bind(w, S), task: S.version }); const no = job('antigravity', { ...bind(w, S), task: S.version }, 'НЕ ПРИНЯТО: 1 блокирующее');
  // Вторая работа: отклонение записал Claude до слова; принимает дирижёр.
  await t.work({ action: 'create', name: 'u2b', owner: 'claude-sess', expected_revision: 0, ...workArgs, folder: PROJECT, stages: [
    { title: 'Обзор', weight: 100, state: 'идёт', accept_criteria: 'есть', level: 'обычный', author: { family: 'anthropic', model: 'claude-opus-4.6' }, version: 'u2b-v1' }] });
  let wb = read(t.workFile('u2b')); const Sb = wb.stages[0];
  job('codex', { ...bind(wb, Sb), task: Sb.version }); job('grok', { ...bind(wb, Sb), task: Sb.version }); const nob = job('antigravity', { ...bind(wb, Sb), task: Sb.version }, 'НЕ ПРИНЯТО: 1 блокирующее');
  await t.work({ action: 'update', name: 'u2b', owner: 'claude-sess', expected_revision: wb.revision, stages: [{ ...Sb, decisions: [{ kind: 'dismiss', version: Sb.version, job_id: nob, reason: 'проверено Claude' }] }] });
  wb = read(t.workFile('u2b')); assert.equal(wb.stages[0].decisions.length, 1);
  await word('codex'); as('codex'); const c = team();
  await c.work({ action: 'claim', name: 'u2b', owner: OWNER, expected_revision: wb.revision }); wb = read(c.workFile('u2b'));
  const outb = await c.work({ action: 'update', name: 'u2b', owner: OWNER, expected_revision: wb.revision, stages: [{ ...wb.stages[0], state: 'принят', evidence: 'кворум' }] });
  assert.notEqual(read(c.workFile('u2b')).stages[0].state, 'принят', outb); assert.match(outb, /отклонено, ждёт пересмотра/);
  await c.work({ action: 'claim', name: 'u2', owner: OWNER, expected_revision: w.revision }); w = read(c.workFile('u2'));
  const out = await c.work({ action: 'update', name: 'u2', owner: OWNER, expected_revision: w.revision, stages: [{ ...w.stages[0], state: 'принят', evidence: 'кворум',
    decisions: [{ kind: 'dismiss', version: S.version, job_id: no, reason: 'проверено по источнику', at: '2020-01-01T00:00:00.000Z' }] }] });
  w = read(c.workFile('u2'));
  assert.notEqual(w.stages[0].state, 'принят', out); assert.match(out, /отклонено, ждёт пересмотра/);
  // Решение дирижёра записано с серверным временем (normalize), заявленное «2020» не принято.
  const stored = w.stages[0].decisions;
  assert.equal(stored.length, 1); assert(Date.parse(stored[0].at) >= Date.parse(lib('user-word').mode().since), stored[0].at);
});

test('Codex 7a3bd85b п. 2, помощник Н3–Н4: авторство файла — по всем писателям пути по времени; добавленные файлы — тем же правилом; поручение Codex во вложенной папке', async () => {
  ready();
  const v1 = 'Codex написал w1.md\n', v2 = 'Antigravity исправил w1.md\n';
  write(path.join(PROJECT, 'w1.md'), v2); write(path.join(PROJECT, 'w2.md'), 'правка после всех\n'); write(path.join(PROJECT, 'add-g.md'), 'Antigravity: новый файл\n');
  write(path.join(PROJECT, 'add-o.md'), 'Codex: новый файл\n'); write(path.join(PROJECT, 'w3.md'), 'правлено после совета\n'); write(path.join(PROJECT, 'add-s.md'), 'Codex: совет\n');
  as('claude'); const t = team();
  await t.work({ action: 'create', name: 'wr', owner: 'claude-sess', expected_revision: 0, ...workArgs, folder: PROJECT, stages: [
    { title: 'Глава', weight: 100, state: 'идёт', accept_criteria: 'есть', level: 'обычный', author: { family: 'anthropic', model: 'claude-opus-4.6' }, material: ['w1.md', 'w2.md', 'w3.md'] }] });
  let w = read(t.workFile('wr')); const S = w.stages[0], at = ms => iso(Date.now() - ms);
  // w3 писало поручение Codex с ролью «совет», потом файл правили: замок не примет автора без «текст» — файл справкой (помощник Т1).
  job('codex', { ...bind(w, S), role: 'совет', write: true, folder: PROJECT, task: 'совет', writes: [{ path: 'w3.md', sha256: sha('совет Codex\n') }] });
  // Codex записал w1 и w2 (раньше), Antigravity исправил и перенёс w1 и w2 (позже); w2 потом правил кто-то ещё.
  const cx = job('codex', { ...bind(w, S), role: 'текст', write: true, folder: PROJECT, startedAt: at(3e5), finishedAt: at(2e5), task: 'черновик',
    writes: [{ path: 'w1.md', sha256: sha(v1) }, { path: 'w2.md', sha256: sha('Codex написал w2.md\n') }] });
  const applied = (file, text) => ({ status: 'applied', appliedTo: path.join(PROJECT, file), appliedAt: at(1e5), apply: { target: path.join(PROJECT, file), newHash: sha(text) } });
  const ag1 = job('antigravity', { ...bind(w, S), role: 'текст', task: 'правка w1', startedAt: at(15e4), finishedAt: at(12e4), ...applied('w1.md', v2) });
  const ag2 = job('antigravity', { ...bind(w, S), role: 'текст', task: 'правка w2', startedAt: at(15e4), finishedAt: at(12e4), ...applied('w2.md', 'Antigravity исправил w2.md\n') });
  // Добавляемые файлы: add-g.md — перенос Antigravity, add-o.md — запись Codex.
  const agAdd = job('antigravity', { ...bind(w, S), role: 'текст', task: 'новый файл', ...applied('add-g.md', 'Antigravity: новый файл\n') });
  const cxAdd = job('codex', { ...bind(w, S), role: 'текст', write: true, folder: PROJECT, task: 'новый файл', writes: [{ path: 'add-o.md', sha256: sha('Codex: новый файл\n') }] });
  // add-s.md записало поручение Codex с ролью «совет» той же семьи, что продолжает этап (openai), хеш совпал (Codex 38eabe71).
  job('codex', { ...bind(w, S), role: 'совет', write: true, folder: PROJECT, task: 'совет файлом', writes: [{ path: 'add-s.md', sha256: sha('Codex: совет\n') }] });
  await word('codex'); as('codex'); const c = team();
  await c.work({ action: 'claim', name: 'wr', owner: OWNER, expected_revision: w.revision }); w = read(c.workFile('wr'));
  await c.work({ action: 'update', name: 'wr', owner: OWNER, expected_revision: w.revision, continue_stage: { id: S.id, author: { family: 'openai', model: 'gpt-6' }, material: ['add-g.md', 'add-o.md', 'add-s.md'] } });
  const N = read(c.workFile('wr')).stages[0], part = name => N.author.find(p => p.part.startsWith(name));
  // w1: последний писатель — Antigravity, хеш совпал: автор google (не «anthropic + openai» по первому совпадению Codex).
  assert.equal(part('поручение ' + ag1).family, 'google'); assert.deepEqual(part('поручение ' + ag1).material, ['w1.md']);
  // w2: хеш не совпал ни с одним писателем — anthropic и все семьи писателей; привязаны оба поручения «текст».
  const mixed = N.author.find(p => p.material.includes('w2.md'));
  assert.equal(mixed.part, 'поручения ' + cx + ', ' + ag2 + ', файл изменён после них');
  assert.deepEqual(mixed.authors.map(a => a.family), ['anthropic', 'openai', 'google']); assert.deepEqual(mixed.source_job, [cx, ag2]);
  // Добавленные файлы: перенос Antigravity — в часть google; запись Codex при продолжении семьёй openai — в общую часть.
  assert.equal(part('поручение ' + agAdd).family, 'google'); assert.deepEqual(part('поручение ' + agAdd).material, ['add-g.md']);
  assert.deepEqual(N.author[0].material, ['add-o.md']); assert(!N.author.some(p => p.part === 'поручение ' + cxAdd));
  assert.deepEqual(N.continuation.reference, ['w3.md', 'add-s.md']); assert(!N.author.some(p => p.material.includes('w3.md') || p.material.includes('add-s.md')));
  assert(!N.material.includes('add-s.md'), '«совет» семьи продолжения — справкой, не в авторском материале');
  // Google — автор части w1: его ПРИНЯТО этой части не засчитывается (кандидат — openai).
  const parts = lib('stage-gate').parts(N);
  assert(!['openai'].some(f => parts.find(p => p.part === 'поручение ' + ag1).families.includes(f)));
  // Поручение Codex без списка writes во вложенной папке работы — тоже «неизвестно что трогало» (помощник Н4).
  const sub = path.join(PROJECT, 'sub'); fs.mkdirSync(sub, { recursive: true });
  assert.equal(lib('fallback').unknownCodex({ name: 'wr', folder: PROJECT }, [{ who: 'codex', work: 'wr', write: true, status: 'done', folder: sub }]).length, 1);
  assert.equal(lib('fallback').unknownCodex({ name: 'wr', folder: PROJECT }, [{ who: 'codex', work: 'wr', write: true, status: 'done', folder: path.join(RUN, 'elsewhere') }]).length, 0);
});


test('Т1–Т9: тексты правил запасного режима', async () => {
  const text = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
  const fb = text('rules/fallback.md');
  assert(fb.startsWith('# Запасной режим: Claude отвалился\n')); assert(fb.trimEnd().split('\n').length <= 45);
  for (const s of ['team_word record who_down=claude', 'rebind', 'continue_stage', 'handover', 'Остаточные риски', 'перезапись чужого файла', '«высокий»',
    '`quote` в `antigravity_apply`']) assert(fb.includes(s), s);
  assert(!/токен|Судья gate|Человек — судья/i.test(fb));
  const agents = text('AGENTS.md');
  assert(agents.includes('## Если Claude отвалился')); assert(!agents.includes('Судья gate — человек')); assert(!agents.includes('человек включает штатный fallback'));
  assert(agents.includes('по решению Claude или дирижёра запасного режима (rules/fallback.md)')); assert(agents.includes('в запасном режиме — тоже только через поручения'));
  for (const [f, label] of [['rules/helpers/codex-section.md', 'fallback-codex-'], ['rules/helpers/antigravity-section.md', 'fallback-antigravity-']]) {
    const s = text(f);
    assert(s.includes('Claude — дирижёр и судья, кроме запасного режима') && (f.includes('codex-section') ? s.includes('Чат Codex может сам ставить поручения через мост, в том числе себе') : s.includes('кроме запасного режима по слову пользователя (ниже)')) && s.includes(label) && s.includes('team_word handover'), f);
  }
  assert(text('rules/helpers/antigravity-section.md').includes('«скажи это в чате Codex»'));
  const common = text('rules/common.md');
  assert(common.includes('дирижёр замечание к работе своей семьи не отклоняет — только через пересмотр проверяющим') && common.includes('в запасном режиме изменения связки ждут Claude (rules/fallback.md)') &&
    common.includes('в запасном режиме этап «высокий» ждёт Claude: помощника с чистой памятью без Claude нет.') && !common.includes('запасным ведущим с подтверждением человека'));
  const claude = text('rules/claude.md');
  for (const s of ['напоминание только смотрит статус и ничего не меняет', 'team_word return quote=<его реплика дословно>', 'сверки с текстом правил этого хода', 'сверка sha256 с исходником; расхождение — повторить запись']) assert(claude.includes(s), s);
  assert(text('rules/roles.md').includes('В запасном режиме дирижёр — Codex или Antigravity'));
  assert(text('rules/antigravity.md').includes('В запасном режиме перенос решает дирижёр, разрешение — то же поручение пользователя по работе'));
  for (const f of ['docs/HOWTO-fallback.md', 'docs/CLAUDE-HANDOFF-fallback.md']) { const d = text(f).replace(/^\uFEFF/, ''); assert.equal(d.trimEnd().split('\n').length, 5, f); assert(d.includes('Запасной режим с токеном выведен из работы в team-v19; порядок — rules/fallback.md.')); }
  const lessons = text('lessons.md');
  assert(lessons.includes('Связка останавливалась, когда отваливался Claude'));
});

async function main() {
  if (CASE !== undefined) {
    let code = 0;
    try { await tests[Number(CASE)][1](); }
    catch (e) { code = 1; console.error(e && e.stack || e); }
    process.exit(code);
  }
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, MOST_V19_CASE: String(i) }, encoding: 'utf8', timeout: 150000 });
    if (r.status === 0) console.log('ПРОЙДЕНО: ' + tests[i][0]);
    else { failed++; console.error('ПРОВАЛ: ' + tests[i][0] + '\n' + (r.stdout || '') + (r.stderr || '') + (r.error ? r.error.message : '')); }
  }
  console.log('Итого: пройдено ' + (tests.length - failed) + ', провалено ' + failed + ', пропущено 0');
  process.exitCode = failed ? 1 : 0;
}
main();
