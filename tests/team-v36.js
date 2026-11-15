'use strict';
// team-v36, #c349acd0, замысел ред. 3, разделы 5 и 8 (без живых исполнителей).
const assert = require('assert'), fs = require('fs'), path = require('path');
const { Worker } = require('worker_threads');
const f = require('./team-v16-fixture');
const chain = require('../common/job-chain'), fallback = require('../common/fallback');
const members = require('../common/members'), access = require('../common/access');
const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, { NODE_ENV: 'test', MOST_TEST_PROCESS_TREE: JSON.stringify([
  { pid: 'self', ppid: 4100 }, { pid: 4100, ppid: 1 },
]), MOST_TEST_KEEP: '1', MOST_JOB_ID: '', TEMP: f.RUN, TMP: f.RUN, TMPDIR: f.RUN });
fallback.reset();
const registry = require('../common/members-store').create(path.join(f.root, 'state'));
registry.update(members.rev(), n => {
  const d = n.members.find(m => m.id === 'deepseek');
  d.roles = { ...d.roles, receives: true, sends: true, writer: true, voter: true };
}, { action: 'phase', who: 'claude', reason: 'тест цепочки', quote: 'тест' }, { phase: 'B' });
f.json(path.join(f.root, 'state/ready/team.json'), { pid: 7000, release: ROOT });
let seq = 0;
const tests = [], test = (name, fn) => tests.push([name, fn]);
const parent = (extra = {}) => ({ id: 'parent-' + (++seq), status: 'running', member: 'antigravity', ...extra });
const cardFile = (who, id) => path.join(f.stores.roots()[who], who === 'antigravity' ? id + '/card.json' : id + '.json');
const save = (who, j) => f.json(cardFile(who, j.id), { ...j, member: who });
const known = new Map();
function admit(p, a = {}, extra = {}) {
  process.env.MOST_JOB_ID = p.id; known.set(p.id, p);
  return chain.admit('codex', 'codex_send', a, { cards: [...known.values()], ancestors: [{ pid: 999999 }], ...extra });
}
const slots = (kind, id) => {
  const d = path.join(f.root, 'state/job-chain', kind, id);
  return fs.existsSync(d) ? fs.readdirSync(d).length : 0;
};

// Отдельные потоки одновременно проходят один барьер: проверяется wx на общем диске,
// а не последовательные вызовы в Promise.all одного потока.
async function race(parents) {
  const barrier = new SharedArrayBuffer(4), workers = [];
  try {
    const jobs = parents.map(p => {
      const worker = new Worker(`
        const { parentPort, workerData: d } = require('worker_threads');
        const chain = require(d.module);
        process.env.MOST_JOB_ID = d.parent.id;
        parentPort.postMessage('ready');
        Atomics.wait(new Int32Array(d.barrier), 0, 0);
        try { parentPort.postMessage({ value: chain.admit('codex', 'codex_send', {}, { cards: d.cards, ancestors: [{ pid: 999999 }] }) }); }
        catch (e) { parentPort.postMessage({ error: e.message }); }
      `, { eval: true, workerData: { parent: p, cards: [...known.values(), p].filter((j, i, a) => a.findIndex(k => k.id === j.id) === i), barrier, module: require.resolve('../common/job-chain') } });
      workers.push(worker);
      let ready, done;
      const started = new Promise((resolve, reject) => { ready = resolve; worker.once('error', reject); });
      const result = new Promise((resolve, reject) => {
        done = resolve; worker.once('error', reject);
        worker.once('exit', code => { if (code !== 0) reject(Error('worker exit ' + code)); });
      });
      worker.on('message', m => m === 'ready' ? ready() : done(m));
      return { started, result };
    });
    await Promise.all(jobs.map(j => j.started));
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
    return await Promise.all(jobs.map(j => j.result));
  } finally { await Promise.all(workers.map(w => w.terminate())); }
}

async function guest(who, client, p, fn) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(ROOT, 'servers', who, 'index.js')], stderr: 'pipe', env: { ...process.env,
      MOST_CLIENT: client, MOST_JOB_ID: p?.id || '', MOST_PROBE_ONLY: '1', MOST_DSH_NO_PROFILES: '1',
      MOST_AGY_INPUT_FORMAT: 'legacy', AGY_PATH: path.join(__dirname, 'fake-agy.js'),
      MOST_JOURNAL: path.join(f.RUN, 'agy.log'), MOST_INPUT_DIR: path.join(f.RUN, 'input'),
      MOST_AGY_CONFIG: path.join(f.RUN, 'permissions.json'), MOST_AGY_QUOTA_FILE: path.join(f.RUN, 'quota.json'),
      MOST_CODEX_CONFIG: path.join(f.RUN, 'missing.toml'), MOST_AGY_MCP_CONFIG: path.join(f.RUN, 'missing.json'),
      MOST_DSH_CONFIG: path.join(f.RUN, 'missing.yml'), MOST_DSH_RULES: path.join(f.RUN, 'missing-dsh.md'),
      MOST_AGY_RULES: path.join(f.RUN, 'missing-agy.md'), MOST_CODEX_RULES: path.join(f.RUN, 'missing-codex.md'),
    } });
  const c = new Client({ name: 'v36', version: '1' });
  try { await c.connect(transport); await fn(c); } finally { await c.close(); }
}
const text = r => (r.content || []).map(c => c.text || '').join('\n');
// team-v48e Г3: кепки/запреты вида цепочки сняты безусловно, тумблеры MOST_CHAIN_* удалены; withChain лишь очищает эти
// переменные среды (на случай унаследованных из окружения), прежних пределов они уже не возвращают.
const CHAIN_ENV = ['MOST_CHAIN_MAX_DEPTH', 'MOST_CHAIN_PER_PARENT', 'MOST_CHAIN_PER_ROOT', 'MOST_CHAIN_STRICT'];
function withChain(env, fn) {
  const old = {}; for (const k of CHAIN_ENV) old[k] = process.env[k];
  for (const k of CHAIN_ENV) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try { return fn(); } finally { for (const k of CHAIN_ENV) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}

for (const [from, to] of [['codex', 'deepseek'], ['codex', 'antigravity'], ['antigravity', 'codex'], ['antigravity', 'deepseek'], ['deepseek', 'antigravity'], ['deepseek', 'codex']]) {
  test(from + ' → ' + to + ': running, без записи, поля в сохранённой карточке', async () => {
    const p = parent(); save(from, p);
    await guest(to, from, p, async c => {
      const task = 'Цепочка ' + p.id;
      const r = await c.callTool({ name: to + '_send', arguments: { folder: f.project, task, role: 'совет', write: false,
        ...(to === 'antigravity' ? { mode: 'review', text: 'Материал для совета без голоса.' } : {}) } });
      assert(!r.isError, text(r));
      const j = f.stores.list(to, false).jobs.find(j => (j.task || j.poruchenie) === task);
      assert(j, text(r));
      assert.equal(j.status, 'queued'); assert.equal(j.parentJob, p.id); assert.equal(j.rootJob, p.id);
      assert.equal(j.depth, 1); assert.equal(j.rootSlot, 1); assert.equal(j.parentSlot, 1); assert(j.chainNonce);
      assert(!Object.hasOwn(j, 'fromChat')); assert.equal(chain.queuedRefusal(j, undefined, to), null);
      assert.equal(slots('parent', p.id), 1, 'повторный guard не тратит место');
      assert.equal(slots('root', p.id), 1);
    });
  });
}

test('team-v48 Г3: по умолчанию full_access/work/stage/continue_id и запись шире родителя — допускаются', () => withChain({}, () => {
  for (const a of [{ full_access: true }, { work: 'w' }, { stage: 's' }, { continue_id: 'old' }]) {
    const p = parent();
    assert.equal(admit(p, a).parentJob, p.id, 'без MOST_CHAIN_STRICT вид подпоручения не ограничен: ' + JSON.stringify(a));
    assert.equal(slots('parent', p.id), 1);
  }
  // запись шире непишущего родителя: по умолчанию допускается (место цепочки выдаётся).
  const w = parent(); assert.ok(admit(w, { write: true }).parentSlot, 'запись шире родителя допускается без MOST_CHAIN_STRICT');
}));
// team-v48e Г3: тумблер MOST_CHAIN_STRICT удалён — отдельного теста «под strict возвращается прежний отказ» больше нет.
test('team-v46: роль «проверка» подпоручению разрешается как совет (без голоса)', () => {
  const p = parent();
  assert.equal(admit(p, { role: 'проверка' }).parentJob, p.id);
});
test('team-v48 Г3: по умолчанию глубина не ограничена (третий и четвёртый уровни приняты)', () => withChain({}, () => {
  // Получатель подпоручений — codex (admit-хелпер), поэтому member предков codex не используем (иначе lineageRefusal).
  const root = parent(), p2 = parent({ ...admit(root), member: 'deepseek' });
  const second = admit(p2, { role: 'текст' }); assert.equal(second.depth, 2); assert.equal(second.rootJob, root.id);
  const p3 = parent({ ...second, member: 'antigravity' });
  const third = admit(p3); assert.equal(third.depth, 3);
  const p4 = parent({ ...third, member: 'deepseek' });
  assert.equal(admit(p4).depth, 4, 'без MOST_CHAIN_MAX_DEPTH глубина не ограничена');
}));
// team-v48e Г3: тумблеры MOST_CHAIN_MAX_DEPTH/PER_PARENT/PER_ROOT удалены — тестов «под переменной возвращается прежний
// предел» больше нет. Безусловное снятие проверяется выше (глубина/число не ограничены) и в §5-тестах ниже.
test('team-v48 Г3: по умолчанию число подпоручений у родителя не ограничено', () => withChain({}, () => {
  const p = parent(); for (let i = 0; i < 5; i++) assert.ok(admit(p).parentSlot);
  assert.equal(slots('parent', p.id), 5, 'пятое место выдано без предела');
}));
test('team-v48e §5: perParent>3 — один родитель раздаёт 8 подпоручений, все проходят, места уникальны', () => withChain({}, () => {
  const p = parent(); const got = [];
  for (let i = 0; i < 8; i++) { const c = admit(p); assert.ok(c.parentSlot); got.push(c.parentSlot); }
  assert.equal(slots('parent', p.id), 8); assert.equal(new Set(got).size, 8, 'места у родителя уникальны');
}));
test('team-v48e §5: perRoot>6 — параллельно у корня больше шести мест, все уникальны', async () => await withChain({}, async () => {
  // 3 admit(root) при создании родителей = 3 места корня, затем 9 заявок = всего 12 мест корня (прежний предел 6 снят).
  const root = parent(), parents = Array.from({ length: 3 }, () => parent({ ...admit(root), member: 'deepseek' }));
  const results = await race(parents.flatMap(p => [p, p, p])); // ещё 9 заявок
  assert.equal(results.filter(r => r.value).length, 9, 'без предела все 9 заявок выданы');
  assert.equal(slots('root', root.id), 12, 'всего 12 мест корня (3 + 9), предел 6 снят');
  const used = new Set(results.filter(r => r.value).map(r => r.value.rootSlot));
  assert.equal(used.size, 9, 'места корня у 9 заявок уникальны (атомарность сохранена)');
}));
test('Повторный admit того же объекта сохраняет место и nonce', () => {
  const p = parent(), a = {}, first = admit(p, a);
  assert.deepEqual(admit(p, a), first); assert.deepEqual(chain.fields(a), first);
  assert.equal(slots('parent', p.id), 1); assert.equal(slots('root', p.id), 1);
  assert.deepEqual(chain.fields({ ...a }), {});
});
test('Родитель done, отсутствует, без MOST_JOB_ID — отказ', () => {
  assert.throws(() => admit(parent({ status: 'done' })), /не идёт/);
  assert.throws(() => admit(parent(), {}, { cards: [] }), /не найдено/);
  process.env.MOST_JOB_ID = '';
  assert.throws(() => chain.admit('codex', 'codex_send', {}, { cards: [], ancestors: [] }), /нет номера/);
});
test('MOST_JOB_ID и предки указывают на разные поручения — отказ', () => {
  const startedAt = '2026-10-22T10:00:00Z';
  const p = parent({ childPid: 81, startedAt }), other = parent({ agyPid: 82, startedAt });
  process.env.MOST_JOB_ID = p.id;
  assert.match(chain.parent([p, other], [{ pid: 82, startedAt }]).error, /разные поручения/);
  assert.match(chain.parent([p, other], [{ pid: 81, startedAt }, { pid: 82, startedAt }]).error, /разные поручения/);
  assert.equal(chain.parent([p, other], [{ pid: 81, startedAt }]).job.id, p.id);
});
test('Из поручения apply/team_word — отказ «поручение-сеанс»; cancel — только свои потомки (§D.3)', () => {
  const now = new Date().toISOString();
  // team-v48e (ревью п.2/п.3): вызывающего подтверждает parent() по предкам процесса — карточка родителя в store, идёт,
  // и её childPid среди предков процесса (pid 4199 из дерева с окном времени); иначе отмена не дойдёт до проверки родства.
  const p = parent({ childPid: 4199, startedAt: now }); save('codex', p); process.env.MOST_JOB_ID = p.id; process.env.MOST_CLIENT = 'codex';
  const beforeTree = process.env.MOST_TEST_PROCESS_TREE;
  process.env.MOST_TEST_PROCESS_TREE = JSON.stringify([{ pid: 'self', ppid: 4199, startedAt: now }, { pid: 4199, ppid: 1, startedAt: now }]);
  fallback.reset();
  try {
    for (const tool of ['antigravity_apply', 'team_word'])
      assert.throws(() => fallback.guard(tool.split('_')[0], tool, { action: 'record' }), /поручение-сеанс этого не делает/i);
    // team-v48 Г4d (§D.3): *_cancel из поручения-сеанса проходит guard и проверяется на потомка; не-потомок/без номера — отказ «только для своих потомков».
    for (const tool of ['codex_cancel', 'antigravity_cancel', 'deepseek_cancel'])
      assert.throws(() => fallback.guard(tool.split('_')[0], tool, { id: 'not-a-descendant' }), /только для своих потомков/i);
  } finally {
    process.env.MOST_CLIENT = 'claude';
    if (beforeTree === undefined) delete process.env.MOST_TEST_PROCESS_TREE; else process.env.MOST_TEST_PROCESS_TREE = beforeTree;
    fallback.reset();
  }
});
test('team-v48e (ревью п.2): подмена MOST_JOB_ID чужого поручения — отмена отклонена проверкой предков процесса', () => {
  const before = process.env.MOST_JOB_ID, now = new Date().toISOString();
  try {
    // Процесс реально принадлежит поручению A (его childPid среди предков), но MOST_JOB_ID подставлен на чужое B.
    const forge = [
      { id: 'forge-A', member: 'codex', status: 'running', childPid: 4242, startedAt: now },
      { id: 'forge-B', member: 'codex', status: 'running', startedAt: now },
      { id: 'forge-Bc', member: 'deepseek', parentJob: 'forge-B' },
    ];
    process.env.MOST_JOB_ID = 'forge-B';
    assert.throws(() => chain.assertDescendant('forge-Bc', { cards: forge, ancestors: [{ pid: 4242, startedAt: now }] }),
      /не подтверждено предками процесса/, 'чужой MOST_JOB_ID не отменяет потомков B');
    // Законный вызов из самого B (его childPid среди предков) — отмена своего потомка проходит.
    const ok = [
      { id: 'forge-B2', member: 'codex', status: 'running', childPid: 5252, startedAt: now },
      { id: 'forge-B2c', member: 'deepseek', parentJob: 'forge-B2' },
    ];
    process.env.MOST_JOB_ID = 'forge-B2';
    assert.doesNotThrow(() => chain.assertDescendant('forge-B2c', { cards: ok, ancestors: [{ pid: 5252, startedAt: now }] }));
  } finally { if (before === undefined) delete process.env.MOST_JOB_ID; else process.env.MOST_JOB_ID = before; }
});
test('Свой сервер из поручения: цикл A→A — отказ (lineageRefusal); чужая семья — подпоручение', () => {
  const p = parent(); save('codex', p); process.env.MOST_JOB_ID = p.id;
  try {
    // team-v48e Г4b-2b: «подпоручение своему же серверу» снято безусловно — цикл A→A (codex→codex, семья уже в цепочке)
    // ловит lineageRefusal в admit; чужая семья (antigravity/deepseek из поручения codex) — законное подпоручение.
    process.env.MOST_CLIENT = 'codex';
    assert.throws(() => fallback.guard('codex', 'codex_send', {}), /уже есть в цепочке|цикл/);
    for (const who of ['antigravity', 'deepseek']) {
      process.env.MOST_CLIENT = who;
      assert.doesNotThrow(() => fallback.guard(who, who + '_send', {}));
    }
    assert.doesNotThrow(() => chain.admit('claude', 'claude_send', {}));
    assert.throws(() => chain.admit('team', 'team_send', {}), /team поручений не принимает/);
  } finally { process.env.MOST_CLIENT = 'claude'; }
});
test('team-v48e Г3: access.guard из поручения допускает чтение И опасные поля (вид подпоручения снят безусловно)', () => withChain({}, () => {
  const p = parent(); save('antigravity', p);
  process.env.MOST_JOB_ID = p.id; process.env.MOST_CLIENT = 'antigravity';
  try {
    const a = { write: false }; access.guard('codex', 'codex_send', a);
    assert.equal(chain.fields(a).parentJob, p.id);
    // Прежние опасные поля (write/full_access/work/stage/continue) теперь допускаются подпоручению: admit выдаёт место.
    for (const extra of [{ write: true }, { full_access: true }, { work: 'w' }, { stage: 's' }, { continue_id: 'x' }]) {
      const a2 = { ...extra };
      assert.doesNotThrow(() => access.guard('codex', 'codex_send', a2));
      assert.equal(chain.fields(a2).parentJob, p.id, 'место цепочки выдано: ' + JSON.stringify(extra));
    }
  } finally { process.env.MOST_CLIENT = 'claude'; }
}));
test('JSON parentJob из чата не попадает в карточку', async () => {
  const forged = { parentJob: 'forged', rootJob: 'forged', depth: 1, parentSlot: 1, rootSlot: 1, chainNonce: 'forged' };
  assert.deepEqual(chain.fields(forged), {});
  await guest('codex', 'antigravity', null, async c => {
    const task = 'Чат без цепочки';
    const r = await c.callTool({ name: 'codex_send', arguments: { folder: f.project, task, write: false, ...forged } });
    assert(!r.isError, text(r));
    const j = f.stores.list('codex', false).jobs.find(j => j.task === task); assert(j);
    for (const k of Object.keys(forged)) assert(!Object.hasOwn(j, k), k);
  });
});
test('Г4d (§D.3): isDescendant — только свои потомки (parentJob-путь к MOST_JOB_ID)', () => {
  const before = process.env.MOST_JOB_ID; process.env.MOST_JOB_ID = 'g4d-p';
  const now = new Date().toISOString();
  try {
    // team-v48e (ревью п.3): отмена разрешена только при положительном подтверждении предками — childPid идущего
    // поручения MOST_JOB_ID среди предков процесса (здесь pid 4100).
    const cards = [
      { id: 'g4d-p', member: 'codex', status: 'running', childPid: 4100, startedAt: now },
      { id: 'g4d-c', member: 'deepseek', parentJob: 'g4d-p' },
      { id: 'g4d-gc', member: 'antigravity', parentJob: 'g4d-c' },
      { id: 'g4d-foreign', member: 'codex' },
      { id: 'g4d-foreign-c', member: 'codex', parentJob: 'g4d-foreign' },
    ];
    assert(chain.isDescendant('g4d-c', { cards }), 'прямой потомок');
    assert(chain.isDescendant('g4d-gc', { cards }), 'внук');
    assert(!chain.isDescendant('g4d-p', { cards }), 'сам родитель — не потомок');
    assert(!chain.isDescendant('g4d-foreign', { cards }), 'чужая карточка');
    assert(!chain.isDescendant('g4d-foreign-c', { cards }), 'потомок чужого');
    assert(!chain.isDescendant('missing', { cards }), 'нет карточки');
    const anc = { cards, ancestors: [{ pid: 4100, startedAt: now }] };
    assert.throws(() => chain.assertDescendant('g4d-p', anc), /только для своих потомков/);
    assert.doesNotThrow(() => chain.assertDescendant('g4d-gc', anc));
    delete process.env.MOST_JOB_ID;
    assert(!chain.isDescendant('g4d-c', { cards }), 'без MOST_JOB_ID — нет');
  } finally { if (before === undefined) delete process.env.MOST_JOB_ID; else process.env.MOST_JOB_ID = before; }
});
test('team-v48e (ревью п.3): отмена из поручения — только при положительном подтверждении byAncestors', () => {
  const before = process.env.MOST_JOB_ID, now = new Date().toISOString();
  try {
    // (а) вызывающий процесс не потомок ни одного идущего поручения; MOST_JOB_ID=B подставлен → byAncestors=false, отказ.
    const none = [{ id: 'p3a-B', member: 'codex', status: 'running', startedAt: now }, { id: 'p3a-Bc', member: 'deepseek', parentJob: 'p3a-B' }];
    process.env.MOST_JOB_ID = 'p3a-B';
    assert.throws(() => chain.assertDescendant('p3a-Bc', { cards: none, ancestors: [{ pid: 777, startedAt: now }] }),
      /не подтверждено предками процесса/, 'процесс не потомок идущего поручения — отказ');
    // (б) A ждало очередь и стартовало позже — окно времени (startedAfter) исключает A из предков; `other` его не ловит,
    // но byAncestors для подставного B=false → отказ (прежде мёртвое условие p.job.id!==id пропускало B).
    const late = [
      { id: 'p3b-A', member: 'codex', status: 'running', childPid: 4242, startedAt: new Date(Date.now() - 24 * 3600000).toISOString() },
      { id: 'p3b-B', member: 'codex', status: 'running', startedAt: now },
      { id: 'p3b-Bc', member: 'deepseek', parentJob: 'p3b-B' },
    ];
    process.env.MOST_JOB_ID = 'p3b-B';
    assert.throws(() => chain.assertDescendant('p3b-Bc', { cards: late, ancestors: [{ pid: 4242, startedAt: now }] }),
      /не подтверждено предками процесса/, 'A исключено окном времени, B подставлен — byAncestors=false');
    // (в) законный вызов из B: его childPid среди предков процесса — отмена своего потомка проходит.
    const legit = [{ id: 'p3c-B', member: 'codex', status: 'running', childPid: 888, startedAt: now }, { id: 'p3c-Bc', member: 'deepseek', parentJob: 'p3c-B' }];
    process.env.MOST_JOB_ID = 'p3c-B';
    assert.doesNotThrow(() => chain.assertDescendant('p3c-Bc', { cards: legit, ancestors: [{ pid: 888, startedAt: now }] }));
  } finally { if (before === undefined) delete process.env.MOST_JOB_ID; else process.env.MOST_JOB_ID = before; }
});
test('team-v48e (ревью п.3): поручение ждало очередь >10 мин — отмена своего потомка проходит по childStartedAt', () => {
  const before = process.env.MOST_JOB_ID;
  const launchedAt = new Date().toISOString();
  const queuedLongAgo = new Date(Date.now() - 11 * 60000).toISOString(); // постановка 11 мин назад
  try {
    // B ждало в очереди 11 мин (startedAt), процесс запустился только что (childStartedAt). Сверка идёт с реальным
    // временем запуска, а не постановки, — законная отмена своего потомка проходит (прежде окно 10 мин её отклоняло).
    const waited = [
      { id: 'p3q-B', member: 'codex', status: 'running', childPid: 6363, startedAt: queuedLongAgo, childStartedAt: launchedAt },
      { id: 'p3q-Bc', member: 'deepseek', parentJob: 'p3q-B' },
    ];
    process.env.MOST_JOB_ID = 'p3q-B';
    assert.doesNotThrow(() => chain.assertDescendant('p3q-Bc', { cards: waited, ancestors: [{ pid: 6363, startedAt: launchedAt }] }),
      'очередь 11 мин, настоящий childPid — отмена проходит');
    // Процесс реально принадлежит A (его childPid среди предков), MOST_JOB_ID подставлен на Bf — отказ по-прежнему.
    const forged = [
      { id: 'p3q-A', member: 'codex', status: 'running', childPid: 6363, startedAt: queuedLongAgo, childStartedAt: launchedAt },
      { id: 'p3q-Bf', member: 'codex', status: 'running', startedAt: launchedAt },
      { id: 'p3q-Bfc', member: 'deepseek', parentJob: 'p3q-Bf' },
    ];
    process.env.MOST_JOB_ID = 'p3q-Bf';
    assert.throws(() => chain.assertDescendant('p3q-Bfc', { cards: forged, ancestors: [{ pid: 6363, startedAt: launchedAt }] }),
      /разные поручения|не подтверждено предками процесса/, 'подставной MOST_JOB_ID — отказ');
  } finally { if (before === undefined) delete process.env.MOST_JOB_ID; else process.env.MOST_JOB_ID = before; }
});
test('Г4d (§D.3): отмена из поручения-сеанса — свой потомок да, предок/чужой нет', async () => {
  const now = new Date().toISOString();
  // team-v48e (ревью п.3): отмена разрешена только при подтверждении предками — childPid поручения-сеанса g4d-anc
  // среди предков процесса-гостя (pid 4100 из дерева), окно времени startedAfter.
  save('codex', { id: 'g4d-anc', status: 'running', from: 'claude', childPid: 4100, startedAt: now });
  save('codex', { id: 'g4d-desc', status: 'queued', parentJob: 'g4d-anc', from: 'claude' });
  save('codex', { id: 'g4d-other', status: 'queued', from: 'claude' });
  const beforeTree = process.env.MOST_TEST_PROCESS_TREE;
  process.env.MOST_TEST_PROCESS_TREE = JSON.stringify([{ pid: 'self', ppid: 4100, startedAt: now }, { pid: 4100, ppid: 1, startedAt: now }]);
  // MOST_PROBE_GUEST=full — боевой набор инструментов (guestTools), чтобы поручение-сеанс получило codex_cancel (§D.3).
  const before = process.env.MOST_PROBE_GUEST; process.env.MOST_PROBE_GUEST = 'full';
  try {
    await guest('codex', 'job', { id: 'g4d-anc' }, async c => {
      assert((await c.listTools()).tools.map(t => t.name).includes('codex_cancel'), 'поручение-сеанс получает codex_cancel');
      const ok = await c.callTool({ name: 'codex_cancel', arguments: { id: 'g4d-desc' } });
      assert(!ok.isError, text(ok));
      const anc = await c.callTool({ name: 'codex_cancel', arguments: { id: 'g4d-anc' } });
      assert(anc.isError); assert.match(text(anc), /только для своих потомков/);
      const foreign = await c.callTool({ name: 'codex_cancel', arguments: { id: 'g4d-other' } });
      assert(foreign.isError); assert.match(text(foreign), /только для своих потомков/);
    });
  } finally {
    if (before === undefined) delete process.env.MOST_PROBE_GUEST; else process.env.MOST_PROBE_GUEST = before;
    if (beforeTree === undefined) delete process.env.MOST_TEST_PROCESS_TREE; else process.env.MOST_TEST_PROCESS_TREE = beforeTree;
  }
  assert.equal(JSON.parse(fs.readFileSync(cardFile('codex', 'g4d-desc'))).status, 'cancelled');
  assert.equal(JSON.parse(fs.readFileSync(cardFile('codex', 'g4d-other'))).status, 'queued');
  assert.equal(JSON.parse(fs.readFileSync(cardFile('codex', 'g4d-anc'))).status, 'running');
});
// team-v48e Г3: тумблер MOST_CHAIN_STRICT удалён — тест «под strict queuedRefusal отвергает вид» убран; безусловное снятие — ниже.
test('team-v48 Г3: по умолчанию queuedRefusal пропускает полный доступ/этап/запись шире родителя, но держит подпись и предков', () => withChain({}, () => {
  const p = parent(), j = { id: 'queued2', member: 'codex', status: 'queued', ...admit(p), write: false };
  assert.equal(chain.queuedRefusal(j, [p]), null);
  // вид подпоручения больше не отвергается (кроме подписи места и подлинности полей):
  for (const extra of [{ fullAccess: true }, { work: 'w' }, { stage: 's' }, { stageId: 's' }, { previous: 'old' }])
    assert.equal(chain.queuedRefusal({ ...j, ...extra }, [p]), null, JSON.stringify(extra));
  assert.equal(chain.queuedRefusal({ ...j, write: true }, [p]), null, 'запись шире родителя допускается');
  // подпись места, подлинность полей, запрет возврата к предку и схождение с родителем — по-прежнему держат:
  assert.match(chain.queuedRefusal({ ...j, chainNonce: 'foreign' }, [p]), /место.*не подтверждено/);
  assert.match(chain.queuedRefusal({ ...j, depth: 0 }, [p]), /повреждены поля цепочки/);
  assert.match(chain.queuedRefusal(j, [{ ...p, member: 'codex' }]), /уже есть в цепочке/);
  assert.match(chain.queuedRefusal(j, [{ ...p, rootJob: 'other' }]), /не сходится/);
}));
test('review: подпоручение не засчитывается голосом ни участника, ни этапа', () => {
  for (const who of ['codex', 'antigravity', 'deepseek']) {
    const id = f.job(f.fixture(), who, 0, { parentJob: 'parent-review' });
    for (const workReview of [false, true])
      assert.throws(() => f.stores.review(who, id, null, null, 'ПРИНЯТО', null, null, workReview), /голосом не засчитывается/);
  }
});
test('Профили DeepSeek: MCP most-read/most-write/most-full, env сохраняет номер поручения', () => {
  const dir = path.join(f.RUN, 'dsh'), profiles = require('../common/dsh-profiles');
  profiles.generate({}, dir, { release: ROOT, root: f.root, node: process.execPath });
  for (const name of ['most-read', 'most-write', 'most-review', 'most-full']) {
    const patch = fs.readFileSync(path.join(dir, 'profiles', name, 'cordis.patch.yml'), 'utf8');
    if (name === 'most-review') assert.doesNotMatch(patch, /dsh-mcp-client|mcp-most-/);
    else {
      for (const who of ['team', 'codex', 'antigravity']) assert(patch.includes('id: mcp-most-' + who), who);
      assert(!patch.includes('id: mcp-most-deepseek'));
      assert.equal((patch.match(/MOST_CLIENT: deepseek/g) || []).length, 3);
      assert.equal((patch.match(/MOST_JOB_ID: !!js process.env.MOST_JOB_ID \|\| ""/g) || []).length, 3);
      assert(patch.includes(JSON.stringify(process.execPath))); assert(patch.includes(JSON.stringify(f.root)));
    }
  }
});

test('Р1: получатель не повторяет родителя или любого предка, admit и очередь', () => {
  for (const server of ['codex', 'antigravity', 'deepseek']) {
    const root = parent({ member: server }), mid = parent({ member: server === 'codex' ? 'deepseek' : 'codex', parentJob: root.id, rootJob: root.id, depth: 1 });
    process.env.MOST_JOB_ID = mid.id;
    assert.throws(() => chain.admit(server, server + '_send', {}, { cards: [root, mid], ancestors: [{ pid: 999999 }] }), /уже есть в цепочке/);
    process.env.MOST_JOB_ID = root.id;
    assert.throws(() => chain.admit(server, server + '_send', {}, { cards: [root], ancestors: [{ pid: 999999 }] }), /уже есть в цепочке/);
  }
  const root = parent(), grant = admit(root), mid = parent({ ...grant, member: 'deepseek' });
  const j = { ...admit(mid), status: 'queued', member: 'codex' };
  assert.equal(chain.queuedRefusal(j, [root, mid]), null);
  assert.match(chain.queuedRefusal(j, [{ ...root, member: 'codex' }, mid]), /уже есть в цепочке/);
  assert.match(chain.queuedRefusal({ ...j, member: 'deepseek' }, [root, mid]), /уже есть в цепочке/);
  // Даже повреждённая цепочка с третьим уровнем не обходит проверку предков в admit.
  const third = parent({ ...j, status: 'running', member: 'codex' });
  process.env.MOST_JOB_ID = third.id;
  assert.throws(() => chain.admit('antigravity', 'antigravity_send', {}, { cards: [root, mid, third], ancestors: [{ pid: 999999 }] }), /уже есть в цепочке/);
});
test('Р2: queued требует running-родителя; waiting_quota допускает завершение и отсутствие', () => {
  const p = parent(), j = { ...admit(p), member: 'codex', status: 'queued' };
  assert.match(chain.queuedRefusal(j, []), /родитель не найдено/);
  for (const status of ['done', 'cancelled', 'waiting_quota']) {
    assert.match(chain.queuedRefusal(j, [{ ...p, status }]), /не идёт/);
    assert.equal(chain.queuedRefusal({ ...j, status: 'waiting_quota' }, [{ ...p, status }]), null);
  }
  assert.equal(chain.queuedRefusal({ ...j, status: 'waiting_quota' }, []), null);
  assert.equal(chain.queuedRefusal({ ...j, status: 'running' }, []), null);
  assert.equal(chain.queuedRefusal({ ...j, status: 'running' }, [{ ...p, status: 'done' }]), null);
});
for (const status of ['done', 'cancelled', 'running']) {
  test('Р2: очередь DeepSeek, родитель ' + status + ' во время ожидания замка карточки', async () => {
    const p = parent(); save('antigravity', p);
    process.env.MOST_JOB_ID = p.id;
    const fields = chain.admit('deepseek', 'deepseek_send', {}, { cards: [p], ancestors: [{ pid: 999999 }] });
    let card = { ...fields, id: 'deepseek-lock-' + p.id, member: 'deepseek', status: 'queued', write: false };
    assert.equal(chain.queuedRefusal(card, undefined, 'deepseek'), null);
    const source = fs.readFileSync(path.join(ROOT, 'servers/deepseek/index.js'), 'utf8');
    const section = (start, end) => {
      const a = source.indexOf(start), b = source.indexOf(end, a);
      assert(a >= 0 && b > a, 'границы кода сервера: ' + start);
      return source.slice(a, b);
    };
    // Исполняем настоящие queue, mutate и chatCardRefusal, без запуска MCP и dsh.
    const code = section('async function mutate(', 'async function normalized(') +
      section('function chatCardRefusal(', 'function fullAccessRefusal(') +
      section('async function queue()', 'const server = new McpServer');
    let waiting, unlock, executions = 0, admissions = 0, released = 0;
    const atLock = new Promise(resolve => { waiting = resolve; });
    const held = new Promise(resolve => { unlock = resolve; });
    const lock = () => ({ ok: true, release: async () => { released++; } });
    const context = {
      require: name => name.endsWith('/job-chain') ? chain :
        name.endsWith('/chain-deadline') ? require('../common/chain-deadline') :
        name.endsWith('/progress') ? { longRunning: async () => {} } :
        name.endsWith('/members') ? { recipientPaused: () => false } :
        name.endsWith('/notify') ? { transition: () => {} } : assert.fail(name),
      access: { guest: () => false }, currentBinary: () => 'fake-dsh', scanning: false, closing: false,
      stateDir: path.join(f.root, 'state'), list: () => [{ ...card }],
      load: id => { assert.equal(id, card.id); return { ...card }; },
      save: j => { card = { ...j }; },
      locks: {
        tryLock: async kind => { assert.equal(kind, 'deepseek_queue'); return lock(); },
        waitLock: async kind => {
          assert.equal(kind, 'deepseek_job'); waiting(); await held; return lock();
        },
        owner: () => ({ pid: 123 }),
      },
      restartHold: { locked: async (dir, fn) => fn() },
      admitExecution: () => { admissions++; }, execute: async () => { executions++; },
    };
    const pending = require('vm').runInNewContext(code + '\nqueue()', context);
    try {
      await Promise.race([atLock, pending.then(() => assert.fail('очередь не дождалась замка'))]);
      assert.equal(card.status, 'queued'); assert.equal(executions, 0);
      save('antigravity', { ...p, status });
    } finally { unlock(); await pending; }
    assert.equal(released, 2, 'освобождены замки очереди и карточки');
    assert.equal(context.scanning, false);
    assert.equal(executions, status === 'running' ? 1 : 0, 'число вызовов execute');
    assert.equal(admissions, status === 'running' ? 1 : 0);
    if (status === 'running') assert.equal(card.status, 'running');
    else {
      assert.equal(card.status, 'failed'); assert.match(card.error, /родитель не идёт/);
      assert.equal(card.fullAccessApplied, false); assert(Number.isFinite(Date.parse(card.finishedAt)));
    }
  });
}

test('Р1–Р3: очередь Antigravity отклоняет цикл до gen и проверяет места при повторе квоты', async () => {
  const root = parent(), mid = parent({ ...admit(root), member: 'deepseek' }), fields = admit(mid);
  save('antigravity', root); save('deepseek', mid);
  const source = fs.readFileSync(path.join(ROOT, 'servers/antigravity/index.js'), 'utf8');
  const queue = source.slice(source.indexOf('let scanning = false;'), source.indexOf('// ---------- запуск ----------'));
  for (const status of ['queued', 'waiting_quota']) {
    const card = { ...fields, id: 'queue-check', status, retry: {}, papkaCanon: f.project };
    let locks = 0;
    const context = {
      require: name => name.endsWith('/job-chain') ? chain : name.endsWith('/chain-deadline') ? require('../common/chain-deadline') : name.endsWith('/progress') ? { longRunning: async () => {} } : assert.fail(name),
      access: { guest: () => false }, shuttingDown: false, instancePipeOk: true,
      listJobs: () => [card], queueJobs: () => [card], updateJob: async (id, fn) => { await fn(card); return card; },
      ownerState: async () => 'dead', tryLock: async () => { locks++; return { ok: false }; }, nowIso: () => new Date().toISOString(),
    };
    // Родитель ещё идёт: проверяем именно чужой nonce, независимо от остановки по родителю.
    if (status === 'waiting_quota') card.chainNonce = 'foreign';
    await require('vm').runInNewContext(queue + '\nresumeQueue()', context);
    assert.equal(card.status, 'failed'); assert.equal(locks, 0);
    assert.match(card.error, status === 'queued' ? /уже есть в цепочке/ : /место.*не подтверждено/);
  }
});
test('Р3: оба файла мест существуют и оба nonce проверяются; подпись места сохранена', () => withChain({}, () => {
  const p = parent(), j = { ...admit(p), member: 'codex', status: 'queued' };
  for (const [kind, slot] of [['parent', j.parentSlot], ['root', j.rootSlot]]) {
    const file = path.join(f.root, 'state/job-chain', kind, p.id, String(slot));
    assert.equal(fs.readFileSync(file, 'utf8'), j.chainNonce);
    fs.writeFileSync(file, 'foreign');
    assert.match(chain.queuedRefusal(j, [p]), /место.*не подтверждено/);
    fs.writeFileSync(file, j.chainNonce);
    const field = kind + 'Slot';
    assert.match(chain.queuedRefusal({ ...j, [field]: 2 }, [p]), /место.*не подтверждено/);
    assert.match(chain.queuedRefusal({ ...j, [field]: undefined }, [p]), /повреждены поля/);
  }
}));
test('team-v48e Г3: work/этап/продолжение подпоручению допускаются у всех исполнителей (вид снят безусловно)', () => withChain({}, () => {
  const p = parent({ member: 'deepseek' }), fields = admit(p);
  for (const server of ['codex', 'deepseek', 'antigravity']) {
    const list = [{ ...p, member: server === 'deepseek' ? 'codex' : 'deepseek' }];
    const j = { ...fields, member: 'forged', status: 'queued' };
    for (const field of [server === 'antigravity' ? 'workName' : 'work', 'stage', 'stageId'])
      assert.equal(chain.queuedRefusal({ ...j, [field]: 'work' }, list, server), null, server + '/' + field + ' допущено');
  }
}));
test('Р5: сбой/пустой отпечаток — отказ; границы окна старта включены', () => {
  const startedAt = '2026-10-22T10:00:00Z', p = parent(), other = parent({ childPid: 82, startedAt });
  process.env.MOST_JOB_ID = p.id;
  const ancestors = fallback.ancestors;
  try {
    fallback.ancestors = () => { throw Error('snapshot failed'); };
    assert.match(chain.parent([p]).error, /отпечаток/);
    assert.throws(() => chain.admit('codex', 'codex_send', {}, { cards: [p] }), /отпечаток/);
  } finally { fallback.ancestors = ancestors; }
  assert.match(chain.parent([p], []).error, /отпечаток/);
  for (const offset of [-5001, -5000, 0, 600000, 600001]) {
    const result = chain.parent([p, other], [{ pid: 82, startedAt: new Date(Date.parse(startedAt) + offset).toISOString() }]);
    if (offset >= -5000 && offset <= 600000) assert.match(result.error, /разные поручения/);
    else assert.equal(result.job.id, p.id);
  }
  for (const value of [undefined, 'invalid']) assert.equal(chain.parent([p, other], [{ pid: 82, startedAt: value }]).byAncestors, false);
});
test('team-v48e Г3: родитель-проверка делегирует у всех исполнителей (запрет снят безусловно)', () => withChain({}, () => {
  for (const member of ['codex', 'antigravity', 'deepseek']) {
    const p = parent({ member, role: 'проверка' }), server = member === 'codex' ? 'deepseek' : 'codex';
    process.env.MOST_JOB_ID = p.id;
    const c = chain.admit(server, server + '_send', {}, { cards: [p], ancestors: [{ pid: 999999 }] });
    assert.equal(c.parentJob, p.id, member + ': родитель-проверка выдал место');
  }
  const p = parent(), j = { ...admit(p), member: 'codex', status: 'queued' };
  assert.equal(chain.queuedRefusal(j, [{ ...p, role: 'проверка' }]), null, 'queuedRefusal допускает родителя-проверку');
}));
test('Р7: доставляемые правила не содержат прежнего запрета подпоручений', () => {
  const files = ['rules/common.md', 'rules/fallback.md', ...fs.readdirSync(path.join(ROOT, 'rules/helpers')).filter(n => n.endsWith('.md')).map(n => 'rules/helpers/' + n)];
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /Поручение-сеанс поручений не ставит|поручение-сеанс не может (?:ставить|давать) поручения/i, file);
    assert.match(text, /подпоручени/i, file);
  }
  for (const who of ['codex', 'antigravity', 'deepseek']) {
    const delivered = require('../common/client-rules').body(who);
    assert.doesNotMatch(delivered, /Поручение-сеанс поручений не ставит/i, who);
    assert.match(delivered, /может отправлять другому участнику подпоручения/, who);
  }
});
test('Р8: guestTools для всех шести направлений и MOST_JOB_ID каждого сервера Codex', () => {
  for (const client of ['codex', 'antigravity', 'deepseek']) for (const server of ['codex', 'antigravity', 'deepseek'].filter(s => s !== client))
    for (const suffix of ['send', 'result', 'status']) assert(access.guestTools(server, client).includes(server + '_' + suffix), client + ' → ' + server + '_' + suffix);
  const configs = require('../common/client-configs');
  const config = configs.block(configs.toml('', ROOT, f.root, path.join(f.root, 'state'), process.execPath)).parsed.root;
  assert.deepEqual(Object.keys(config.mcp_servers).sort(), [...members.servers].sort());
  for (const server of members.servers) {
    assert.deepEqual(config.mcp_servers[server].env_vars, ['MOST_JOB_ID'], server);
    assert.equal(config.mcp_servers[server].env.MOST_CLIENT, 'codex');
  }
});

f.run(tests);
