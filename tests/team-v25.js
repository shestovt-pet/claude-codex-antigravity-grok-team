'use strict';
// team-v25, #455d6490, замысел ред. 2. О1–О12, только временные данные клона.
const fs = require('fs'), path = require('path'), cp = require('child_process'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..'), CASE = process.env.MOST_V25_CASE;
const tests = [], test = (name, fn) => tests.push([name, fn]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = r => r.content.map(c => c.text || '').join('\n');
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const json = (f, v) => write(f, JSON.stringify(v, null, 2));
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
let RUN, REPO, STATE, PROJECT, JOBS, LOG, RELEASE;
if (CASE !== undefined) {
  RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v25-'));
  REPO = path.join(RUN, 'repo'); STATE = path.join(RUN, 'state'); PROJECT = path.join(RUN, 'program');
  RELEASE = path.join(RUN, 'release');
  for (const name of ['common', 'rules', 'servers']) fs.cpSync(path.join(ROOT, name), path.join(RELEASE, name), { recursive: true });
  for (const name of ['package.json', 'AGENTS.md']) write(path.join(RELEASE, name), fs.readFileSync(path.join(ROOT, name)));
  JOBS = path.join(STATE, 'codex-jobs'); LOG = path.join(RUN, 'fake.jsonl');
  for (const p of [REPO, STATE, PROJECT, JOBS]) fs.mkdirSync(p, { recursive: true });
  for (const k of ['MOST_AUTHORITY', 'MOST_JOB_ID', 'MOST_FALLBACK_DIR', 'MOST_PROBE_ONLY', 'MOST_PROBE_GUEST', 'MOST_TEST_PROCESS_TREE']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', NODE_PATH: [process.env.NODE_PATH, path.join(ROOT, 'node_modules')].filter(Boolean).join(path.delimiter), MOST_REPO_ROOT: REPO, MOST_STATE_DIR: STATE,
    MOST_CLIENT: 'claude', MOST_CODEX_JOBS_DIR: JOBS, MOST_CODEX_ARCHIVE_DIR: path.join(RUN, 'archive'),
    MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off', MOST_TEST_KEEP: '1', MOST_QUEUE_TICK_MS: '100',
    MOST_CLAUDE_CONFIGS: '[]', MOST_CODEX_CONFIG: path.join(RUN, 'absent.toml'),
    MOST_AGY_MCP_CONFIG: path.join(RUN, 'absent.json'), MOST_AGY_QUOTA_FILE: path.join(RUN, 'quota.json'),
    MOST_CODEX_SESSIONS: path.join(RUN, 'sessions'), LOCALAPPDATA: path.join(RUN, 'local'),
    MOST_INPUT_DIR: path.join(STATE, 'input'), MOST_JOURNAL: path.join(STATE, 'agy.log'), MOST_AGY_CONFIG: path.join(RUN, 'permissions.json'),
    MOST_CODEX_RULES: path.join(RUN, 'AGENTS.md'), MOST_AGY_RULES: path.join(RUN, 'agy.md'),
    CODEX_PATH: path.join(__dirname, 'fake-codex.js'), FAKE_CODEX_LOG: LOG,
    AGY_PATH: path.join(__dirname, 'fake-agy.js'), MOST_AGY_INPUT_FORMAT: 'legacy', TEMP: RUN, TMP: RUN, TMPDIR: RUN });
}
const cardFile = id => path.join(JOBS, id + '.json');
const card = id => read(cardFile(id));
const logs = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const idOf = r => text(r).match(/Номер поручения: (\S+)/)?.[1];
const defaults = () => ({ folder: PROJECT, task: 'Проба', write: false, full_access: false, role: 'совет' });
async function until(fn, name, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw Error('Не дождались: ' + name);
}
async function mcp(extra = {}, server = 'codex') {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(RELEASE, 'servers', server, 'index.js')],
    env: { ...process.env, ...extra }, stderr: 'pipe' });
  let errors = ''; transport.stderr?.on('data', d => { errors += d; });
  const client = new Client({ name: 'team-v25', version: '1' });
  try { await client.connect(transport); }
  catch (e) { await client.close().catch(() => {}); throw Error(e.message + '\n' + errors); }
  return { call: (name, a = {}) => client.callTool({ name, arguments: a }), close: () => client.close(), tools: async () => (await client.listTools()).tools.map(t => t.name), errors: () => errors };
}
async function withMcp(fn, env) { const c = await mcp(env); try { await fn(c); } finally { await c.close(); } }
async function send(c, patch = {}) {
  const r = await c.call('codex_send', { ...defaults(), ...patch });
  assert(!r.isError, text(r)); assert(idOf(r), text(r)); return { id: idOf(r), response: r };
}
async function refuse(c, patch, pattern) {
  const before = fs.readdirSync(JOBS), n = logs().length;
  const r = await c.call('codex_send', { ...defaults(), ...patch });
  assert(r.isError, text(r)); assert.match(text(r), pattern);
  assert.deepEqual(fs.readdirSync(JOBS), before); assert.equal(logs().length, n);
}
function mode(row) { return row.args[row.args.indexOf('-s') + 1]; }
function junction(link, target) {
  if (process.platform !== 'win32') throw Object.assign(Error('junction требует Windows'), { skip: true });
  cp.execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { windowsHide: true, stdio: 'pipe' });
  assert(fs.lstatSync(link).isSymbolicLink()); assert.equal(fs.realpathSync(link), fs.realpathSync(target));
}
// Как oldModule в team-v21: доступ к внутренним функциям для детерминированной гонки
// и карточек, которые штатная очередь принципиально не запускает. Замки и fake-codex настоящие.
// MCP проверяет зарегистрированные инструменты; дерево процесса чата задано тестом.
function internals() {
  const Module = require('module'), file = path.join(RELEASE, 'servers/codex/index.js');
  const m = new Module(file, module); m.filename = file; m.paths = [...Module._nodeModulePaths(path.dirname(file)), path.join(ROOT, 'node_modules')];
  const source = fs.readFileSync(file, 'utf8'), end = source.lastIndexOf('\n(async () => {');
  assert(end > 0);
  m._compile(source.slice(0, end) + '\nmodule.exports = { fullAccessAllowed, fullAccessRefusal, sandboxMode, execute, send, queue, save, load, view, active, ownChatJob };', file);
  return m.exports;
}
function seeded(id, patch = {}) {
  const j = { id, folder: PROJECT, write: false, role: 'совет', from: 'claude', status: 'queued', task: 'SLOW',
    startedAt: new Date().toISOString(), quotaAttempts: 0, ...patch };
  json(cardFile(id), j); return j;
}


const lib = name => require(path.join(RELEASE, 'common', name));
const tree = parent => JSON.stringify([{ pid: 'self', ppid: parent || 4100, name: 'node.exe' },
  { pid: parent || 4100, ppid: 1, name: 'codex.exe' }]);
function ready() { json(path.join(STATE, 'ready/team.json'), { pid: 7000, release: RELEASE, startedAt: new Date().toISOString() }); }
const chatEnv = extra => ({ MOST_CLIENT: 'codex', MOST_TEST_PROCESS_TREE: tree(), ...extra });
function asChat(extra = {}) { Object.assign(process.env, chatEnv(extra)); lib('fallback').reset(); }
async function freeLocks(id, folder = PROJECT, thread) {
  for (const [kind, key] of [['codex_folder', lib('paths').canon(folder)], ['codex_execution', id], ['codex_queue', id], ['codex_job', id], ...(thread ? [['codex_session', thread]] : [])]) {
    const l = await lib('locks').tryLock(kind, key, {}); assert(l.ok, kind); await l.release();
  }
}

test('О1: инструменты, проба установки, очередь, ответ и сводка', async () => {
  ready(); const guest = await mcp(chatEnv());
  try {
    assert.deepEqual((await guest.tools()).sort(), ['codex_cancel', 'codex_result', 'codex_send', 'codex_status']);
    const j = await send(guest);
    assert.equal(card(j.id).from, 'codex'); assert.equal(card(j.id).fromChat, 'codex'); assert(!card(j.id).fallbackWord);
    assert.match(text(j.response), /Отправитель: codex \(чат\)/);
    const summary = await new (lib('team').Team)(REPO).status(undefined, undefined, false, true);
    assert(summary.includes(j.id) && summary.includes('Отправитель: codex (чат)'), summary);
    await withMcp(async main => {
      await until(() => card(j.id).status === 'done', 'исполнение чтения');
      const result = await guest.call('codex_result', { id: j.id });
      assert.match(text(result), /ПРИНЯТО/); assert.match(text(result), /Отправитель: codex \(чат\)/);
      assert.equal(mode(logs()[0]), 'read-only');
    });
  } finally { await guest.close(); }
  // Реальная функция установщика и MCP-пробы списков всех гостей, без установки.
  const Module = require('module'), file = path.join(RELEASE, 'common/deploy.js');
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.probeRelease = probeRelease;', file);
  await m.exports.probeRelease(RELEASE, REPO, 'a'.repeat(40), STATE, {}, async () => {});
  assert(fs.existsSync(path.join(RELEASE, 'probe-ok.json')));
});

test('О2: запись, замок папки, needs_decision, перезапуск без автоповтора', async () => {
  ready(); const guest = await mcp(chatEnv()); let main;
  try {
    const j = await send(guest, { write: true, task: 'ЗАПИШИ ФАЙЛ result.txt' });
    const held = await lib('locks').tryLock('codex_folder', lib('paths').canon(PROJECT), {}); assert(held.ok);
    try { main = await mcp(); await sleep(500); assert.equal(card(j.id).status, 'queued'); assert.equal(logs().length, 0); }
    finally { await held.release(); }
    await until(() => card(j.id).status === 'done', 'запись');
    assert(fs.existsSync(path.join(PROJECT, 'result.txt'))); assert.equal(mode(logs()[0]), 'workspace-write');
    const failed = await send(guest, { write: true, task: 'QUOTA' });
    await until(() => card(failed.id).status === 'needs_decision', 'сбой записи'); assert.equal(logs().length, 2);
    await main.close(); main = await mcp(); await sleep(600);
    assert.equal(logs().length, 2); assert.equal(card(failed.id).status, 'needs_decision');
    const next = await send(guest, { write: true, continue_id: failed.id, task: 'Продолжи' });
    await until(() => card(next.id).status === 'done', 'явное продолжение'); assert(logs().at(-1).args.includes('resume'));
  } finally { if (main) await main.close(); await guest.close(); }
});

test('О3: корень, клон, релиз, родители, junction; полный доступ', async () => {
  ready(); const clone = path.join(REPO, '.work/change'), release = path.join(REPO, 'live/hash');
  for (const folder of [clone, release]) fs.mkdirSync(folder, { recursive: true });
  const link = path.join(RUN, 'alias'); junction(link, REPO);
  const forbidden = [REPO, clone, release, RELEASE, path.join(RELEASE, 'common'), RUN, path.parse(RUN).root, link];
  await withMcp(async guest => { for (const folder of forbidden) await refuse(guest, { folder, write: true }, /Запись из чата Codex запрещена/); }, chatEnv());
  await withMcp(async main => { for (const folder of [RUN, path.parse(RUN).root, link]) await refuse(main, { folder, write: true, full_access: true }, /Полный доступ запрещён/); });
  assert.equal(logs().length, 0); await freeLocks('unused');
});

test('О3: смена realpath после постановки и после замков — отказ без оставленных замков', async () => {
  ready(); const api = internals(), paths = lib('paths'), locks = lib('locks');
  asChat(); const sent = await api.send({ ...defaults(), write: true }); const id = idOf(sent);
  process.env.MOST_CLIENT = 'claude'; const original = fs.realpathSync.native;
  fs.realpathSync.native = p => path.resolve(p) === PROJECT ? original(REPO) : original(p);
  try { await api.queue(); } finally { fs.realpathSync.native = original; }
  assert.equal(card(id).status, 'failed'); assert.match(card(id).error, /Запись из чата/); await freeLocks(id);
  // Та же смена пути непосредственно перед spawn, после снимка файлов под замком.
  const j = seeded('late-path', { from: 'codex', fromChat: 'codex', write: true, status: 'running', threadId: 'late-thread' });
  const held = await locks.tryLock('codex_folder', paths.canon(PROJECT), {}); assert(held.ok);
  const fallback = lib('fallback'), before = fallback.folderState;
  fallback.folderState = (...args) => { const value = before(...args); fs.realpathSync.native = p => path.resolve(p) === PROJECT ? original(REPO) : original(p); return value; };
  try { await api.execute(j, held); } finally { fallback.folderState = before; fs.realpathSync.native = original; }
  assert.equal(card(j.id).status, 'failed'); assert.equal(logs().length, 0); await freeLocks(j.id, PROJECT, j.threadId);
});

test('О4: поручение-сеанс не отправляет и не отменяет; недоказанный чат получает отказ', async () => {
  ready();
  for (const [id, fromChat] of [['foreign', undefined], ['own', 'codex']]) seeded(id, { from: fromChat || 'claude', fromChat });
  const before = fs.readdirSync(JOBS).map(n => [n, fs.readFileSync(path.join(JOBS, n), 'utf8')]);
  for (const server of ['codex', 'antigravity']) {
    const guest = await mcp(chatEnv({ MOST_JOB_ID: 'assigned-job' }), server);
    try {
      for (const continue_id of [undefined, 'foreign', 'own']) {
        const r = await guest.call(server + '_send', { ...defaults(), continue_id, mode: 'review' });
        assert(r.isError); assert.match(text(r), /поручение-сеанс/i);
      }
      if (server === 'codex') for (const id of ['foreign', 'own']) {
        const r = await guest.call('codex_cancel', { id }); assert(r.isError); assert.match(text(r), /поручение-сеанс/i);
      }
    } finally { await guest.close(); }
  }
  assert.deepEqual(fs.readdirSync(JOBS).map(n => [n, fs.readFileSync(path.join(JOBS, n), 'utf8')]), before);
  asChat(); const access = lib('access');
  const actions = [['codex', 'codex_send', {}], ['codex', 'codex_send', { write: true }], ['codex', 'codex_cancel', { id: 'own' }], ['antigravity', 'antigravity_send', {}]];
  for (const kind of ['missing', 'damaged', 'bad-tree', 'empty-tree', 'main-ancestor']) {
    ready(); asChat();
    if (kind === 'missing') {
      const read = fs.readFileSync; fs.readFileSync = function(f, ...args) { if (String(f) === path.join(STATE, 'ready/team.json')) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return read.call(this, f, ...args); };
      try { for (const [s, t, a] of actions) assert.throws(() => access.guard(s, t, a), /не прочитана/); } finally { fs.readFileSync = read; }
      continue;
    }
    if (kind === 'damaged') write(path.join(STATE, 'ready/team.json'), '{broken');
    if (kind === 'bad-tree') process.env.MOST_TEST_PROCESS_TREE = 'broken';
    if (kind === 'empty-tree') process.env.MOST_TEST_PROCESS_TREE = '[]';
    if (kind === 'main-ancestor') process.env.MOST_TEST_PROCESS_TREE = tree(7000);
    lib('fallback').reset();
    for (const [s, t, a] of actions) assert.throws(() => access.guard(s, t, a), /не могу подтвердить/);
  }
});

test('О5: полный доступ гостю запрещён до постановки', async () => {
  ready(); await withMcp(async guest => {
    for (const full_access of [true, 'true']) await refuse(guest, { full_access, write: true }, /Гостю полный доступ Codex запрещён/);
  }, chatEnv());
});

test('О6: противоречивые карточки не исполняются, согласованная — только в песочнице', async () => {
  const bad = [{ from: 'claude', write: false }, { from: 'claude', write: true }, { fullAccess: true, write: false },
    { fullAccess: true, write: true }, { folder: REPO, write: true }, { folder: RUN, write: true }, { fromChat: '', from: 'claude', fullAccess: true, write: true }];
  for (const [i, patch] of bad.entries()) seeded('bad-' + i, { from: 'codex', fromChat: 'codex', ...patch });
  seeded('word', { from: 'codex', fromChat: 'codex', write: true, fallbackWord: 'old-word' });
  await withMcp(async main => {
    await until(() => bad.every((_, i) => card('bad-' + i).status === 'failed') && card('word').fallbackHold, 'отказы карточек');
    for (const [i] of bad.entries()) { const c = card('bad-' + i); assert(c.error); assert.equal(c.fullAccessApplied, false); await freeLocks(c.id, c.folder); }
    assert.match(card('word').fallbackHold, /запасной режим снят/); assert.equal(logs().length, 0);
    const j = seeded('consistent', { from: 'codex', fromChat: 'codex', write: true, task: 'Проба' });
    await until(() => card(j.id).status === 'done', 'согласованная карточка');
    assert.equal(mode(logs()[0]), 'workspace-write'); assert.equal(card(j.id).fullAccessApplied, false);
  });
});

test('О6: карточка изменена после предварительного фильтра — повторный отказ под замком', async () => {
  const api = internals(), locks = lib('locks');
  const j = seeded('changed-fields', { from: 'codex', fromChat: 'codex', write: true });
  const original = locks.tryLock;
  locks.tryLock = async (kind, key, ...rest) => {
    const lock = await original(kind, key, ...rest);
    if (kind === 'codex_queue' && key === j.id && lock.ok) json(cardFile(j.id), { ...card(j.id), from: 'claude', fullAccess: true });
    return lock;
  };
  try { await api.queue(); } finally { locks.tryLock = original; }
  assert.equal(card(j.id).status, 'failed'); assert.match(card(j.id).error, /противоречивые поля/);
  assert.equal(logs().length, 0); await freeLocks(j.id);
});

test('О7: своя отмена; чужие продолжение и отмена не меняют карточки; чтение доступно', async () => {
  ready();
  for (const status of ['done', 'waiting_quota']) seeded(status, { status, threadId: 'thread-' + status, nextAttemptAt: '2999-01-01' });
  seeded('old-codex', { from: 'codex', status: 'waiting_quota', threadId: 'old-thread' });
  await withMcp(async guest => {
    for (const id of ['done', 'waiting_quota', 'old-codex']) {
      const before = fs.readFileSync(cardFile(id), 'utf8'); await refuse(guest, { continue_id: id }, /только свои поручения/);
      const r = await guest.call('codex_cancel', { id }); assert(r.isError); assert.match(text(r), /только свои поручения/);
      assert.equal(fs.readFileSync(cardFile(id), 'utf8'), before);
    }
    const own = await send(guest); const r = await guest.call('codex_cancel', { id: own.id });
    assert(!r.isError, text(r)); assert.equal(card(own.id).status, 'cancelled');
    const result = await guest.call('codex_result', { id: 'waiting_quota' }); assert(!result.isError, text(result));
    assert(!((await guest.call('codex_status')).isError));
  }, chatEnv());
});

test('О8, О10: Antigravity закрыт своей семье; чужие полномочия закрыты', async () => {
  ready(); asChat(); const access = lib('access');
  for (const [server, tool, args] of [['team', 'team_change', { action: 'start' }], ['team', 'team_work', { action: 'create' }],
    ['team', 'team_work', { action: 'update' }], ['antigravity', 'antigravity_apply', { id: 'x' }]])
    assert.throws(() => access.guard(server, tool, args), /Гостю это действие запрещено/);
  const agy = await mcp({ ...chatEnv(), MOST_CLIENT: 'antigravity' }, 'antigravity');
  try { const r = await agy.call('antigravity_send', { ...defaults(), mode: 'review' }); assert(r.isError); assert.match(text(r), /только у дирижёра/); }
  finally { await agy.close(); }
  const material = path.join(PROJECT, 'review.txt'); write(material, 'Материал проверки');
  const peer = await mcp(chatEnv(), 'antigravity');
  try { const r = await peer.call('antigravity_send', { ...defaults(), mode: 'review', file: material }); assert(!r.isError, text(r)); }
  finally { await peer.close(); }
});

test('О9: fallbackWord сохраняет исполнение и удержание после return/смены', async () => {
  ready(); asChat(); const fallback = lib('fallback'), words = lib('user-word'), owner = 'fallback-codex-ab12';
  const t = new (lib('team').Team)(REPO);
  t.fallbackDeps = { evaluate: () => ({ desktopAlive: true }), restart: async () => { throw Error('Не запускать Desktop'); } };
  await t.word({ action: 'record', who_down: 'claude', quote: 'Claude отвалился', owner });
  const api = internals(), r = await api.send({ ...defaults(), write: true, owner }); const id = idOf(r);
  assert.equal(card(id).fallbackWord, words.mode().entry.id); assert.equal(card(id).fromChat, 'codex'); assert.equal(fallback.queueHold(card(id)), '');
  process.env.MOST_CLIENT = 'claude'; await api.queue(); await until(() => card(id).status === 'done', 'запасной режим');
  await until(() => !api.active.size, 'конец исполнения');
  const old = seeded('old-word', { from: 'codex', fromChat: 'codex', write: true, fallbackWord: card(id).fallbackWord });
  await words.append({ kind: 'conductor', who_down: 'claude', quote: 'Смена', conductor: 'antigravity', owner: 'fallback-antigravity-ab12' });
  assert.match(fallback.queueHold(old), /дирижёр запасного режима сменился/);
  await api.queue(); assert.equal(card(old.id).status, 'queued'); assert.match(card(old.id).fallbackHold, /сменился/);
  await words.append({ kind: 'return', who_down: 'claude', quote: 'Claude вернулся', by: 'claude' });
  await api.queue(); assert.equal(card(old.id).status, 'queued'); assert.match(card(old.id).fallbackHold, /запасной режим снят/);
  assert.equal(logs().length, 1);
});

test('О9а: дирижёр активного режима продолжает и отменяет прежние поручения, как в базе (Codex c9116d5d)', async () => {
  ready(); asChat(); const words = lib('user-word'), owner = 'fallback-codex-cd34';
  const t = new (lib('team').Team)(REPO);
  t.fallbackDeps = { evaluate: () => ({ desktopAlive: true }), restart: async () => { throw Error('Не запускать Desktop'); } };
  await t.word({ action: 'record', who_down: 'claude', quote: 'Claude отвалился', owner });
  const word = words.mode().entry.id, api = internals();
  seeded('old-conductor', { from: 'codex', write: true, fallbackWord: word, status: 'needs_decision', threadId: 'thread-old' });
  seeded('old-claude', { from: 'claude', status: 'done', threadId: 'thread-claude' });
  seeded('claude-waiting', { from: 'claude' });
  // Без метки дирижёра в активном режиме отказ даёт уже fallback.guard (Codex 4c42429e); сам ownChatJob — «только свои».
  await assert.rejects(api.send({ ...defaults(), continue_id: 'old-claude' }), /только у дирижёра запасного режима/);
  assert.throws(() => api.ownChatJob(card('old-claude'), {}), /только свои поручения/);
  assert.throws(() => api.ownChatJob(card('claude-waiting'), { owner: 'fallback-codex-zz99' }), /только свои поручения/);
  // Дирижёр: старая карточка со словом без fromChat и поручение Claude продолжаются, как в базе.
  const a = await api.send({ ...defaults(), write: true, continue_id: 'old-conductor', owner, task: 'Продолжи' });
  assert(idOf(a), text(a)); assert.equal(card(idOf(a)).fallbackWord, word);
  const b = await api.send({ ...defaults(), continue_id: 'old-claude', owner, task: 'Продолжи' });
  assert(idOf(b), text(b));
  await withMcp(async guest => {
    const r = await guest.call('codex_cancel', { id: 'claude-waiting', owner }); assert(!r.isError, text(r));
  }, chatEnv());
  assert.equal(card('claude-waiting').status, 'cancelled');
  // После return — снова только свои.
  await words.append({ kind: 'return', who_down: 'claude', quote: 'Claude вернулся', by: 'claude' });
  assert.throws(() => api.ownChatJob(card('old-claude'), { owner }), /только свои поручения/);
  assert.equal(logs().length, 0);
});

test('О11: правила согласованы и доставляются; О12: адресная регрессия team-v19', async () => {
  const helper = fs.readFileSync(path.join(ROOT, 'rules/helpers/codex-section.md'), 'utf8');
  for (const phrase of ['Чат Codex может сам ставить поручения', 'codex_cancel', 'только свои', 'Полного доступа у гостя нет', 'Поручение-сеанс поручений не ставит и не отменяет']) assert(helper.includes(phrase), phrase);
  assert(!helper.includes('не разрешение самостоятельно отправлять задания'));
  const common = fs.readFileSync(path.join(ROOT, 'rules/common.md'), 'utf8');
  assert(!common.includes('себя никто не получает')); assert(!common.includes('Codex на запись и перенос Antigravity — нельзя'));
  assert(common.includes('для своего поручения из чата Codex — чат Codex'));
  assert(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8').includes('чат Codex для своего поручения вне связки'));
  assert(fs.readFileSync(path.join(ROOT, 'rules/fallback.md'), 'utf8').includes('Поручение-сеанс'));
  const rules = lib('client-rules'), target = path.join(RUN, 'delivered.md'); write(target, 'Личные правила\r\n<!-- most:begin -->\r\nСтарый раздел\r\n<!-- most:end -->\r\n');
  const plans = rules.plans([{ file: target, role: 'codex' }]); await rules.configure({ files: [{ file: target, role: 'codex' }] });
  assert(rules.evidence(plans, 'team-v25')[0].contentVerified); assert(fs.readFileSync(target, 'utf8').includes('Чат Codex может сам ставить поручения'));
  const old = fs.readFileSync(path.join(ROOT, 'tests/team-v19-claude-word.js'), 'utf8');
  assert(old.includes("as('codex', { job: 'job-1' })")); assert(old.includes("agy.call('antigravity_send'"));
  assert(old.includes("['codex_cancel', 'codex_result', 'codex_send', 'codex_status']"));
  assert(fs.readFileSync(path.join(ROOT, 'tests/run.js'), 'utf8').includes("'team-v25.js'"));
});

async function main() {
  if (CASE !== undefined) {
    try { await tests[Number(CASE)][1](); process.exit(0); }
    catch (e) { console.error(e.stack || e); process.exit(e.skip ? 77 : 1); }
  }
  let failed = 0, skipped = 0;
  for (let i = 0; i < tests.length; i++) {
    const r = cp.spawnSync(process.execPath, [__filename], { env: { ...process.env, MOST_V25_CASE: String(i) }, encoding: 'utf8', timeout: 90000 });
    if (r.status === 0) console.log('ПРОЙДЕНО: ' + tests[i][0]);
    else if (r.status === 77) { skipped++; console.log('ПРОПУЩЕНО: ' + tests[i][0] + '\n' + r.stderr); }
    else { failed++; console.error('ПРОВАЛ: ' + tests[i][0] + '\n' + (r.stdout || '') + (r.stderr || '') + (r.error?.message || '')); }
  }
  console.log('Итого: пройдено ' + (tests.length - failed - skipped) + ', провалено ' + failed + ', пропущено ' + skipped);
  process.exitCode = failed ? 1 : 0;
}
main();
