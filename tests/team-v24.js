'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const fx = require('./team-v16-fixture');
const { fixture, job, fresh, gate, stores, write, json, root, project, RUN, run } = fx;
const snapshots = require('../common/job-snapshot'), { Team } = require('../common/team');
process.env.CODEX_PATH = path.join(__dirname, 'fake-codex.js');
const tests = [], test = (name, fn) => tests.push([name, fn]);
const card = (who, id) => who === 'antigravity' ? path.join(stores.roots()[who], id, 'card.json') : path.join(stores.roots()[who], id + '.json');
function update(who, id, patch) { const file = card(who, id); json(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }); }
function reviews(f) {
  f.s.state = 'принят';
  f.s.reviews = gate.allJobs().filter(j => gate.belongs(j, f.w, f.s) && j.role === 'проверка' && j.task === f.s.version).map(j => j.id);
}
async function evaluated(f, snapshot, old) {
  const w = structuredClone(f.w), s = w.stages[0];
  try { return { message: await gate.evaluate(w, s, old && structuredClone(old), undefined, snapshot), s }; }
  catch (e) { return { error: e.message, code: e.code, s }; }
}
function persisted(f) {
  Object.assign(f.w, { revision: 1, goal: 'Проверка снимка', done_criteria: 'Проверено', next_step: 'Проверка', reminders: [] });
  json(path.join(root, 'works', f.w.name + '.json'), f.w);
  return new Team(root);
}
async function quiet(fn) {
  const quota = require('../common/quota-line'), drift = require('../common/release-drift'), locks = require('../common/locks');
  const saved = [quota.quotaLine, drift.lines, locks.ownerState, locks.probeOwner];
  quota.quotaLine = async () => 'Квоты: тест'; drift.lines = () => [];
  locks.ownerState = async () => 'alive'; locks.probeOwner = async () => ({ state: 'none' });
  try { return await fn(); }
  finally { [quota.quotaLine, drift.lines, locks.ownerState, locks.probeOwner] = saved; }
}
for (const version of [14, 15]) test('О1: правила ' + version + ', источники, положительные, отрицательные и исторические отзывы', async () => {
  const f = fixture({ author: { family: 'google', model: 'gemini' } }); f.s.rules_version = version;
  job(f, 'antigravity', 0, { role: 'текст' });
  job(f, 'codex', 1, { task: 'old-version' });
  const review = job(f); reviews(f);
  let expected = await evaluated(f); assert(!expected.error, expected.error); assert.equal(expected.s.state, 'принят');
  assert.deepStrictEqual(await evaluated(f, snapshots.create()), expected);
  write(path.join(stores.roots().codex, review + '.result.txt'), 'НЕ ПРИНЯТО: 1 блокирующее');
  expected = await evaluated(f); assert(expected.error);
  assert.deepStrictEqual(await evaluated(f, snapshots.create()), expected);
  // Запоздалый отказ снимает принятие и при повторном чтении, и со снимком.
  const old = { ...structuredClone(f.s), state: 'принят' };
  expected = await evaluated(f, undefined, old);
  if (version === 14) assert.match(expected.error, /Этап не принят/);
  else assert.equal(expected.s.state, 'идёт');
  assert.deepStrictEqual(await evaluated(f, snapshots.create(), old), expected);
});
for (const version of [14, 15]) test('О1: общий материал, прежнее время изменения, правила ' + version, async () => {
  const file = path.join(project, 'shared-' + version + '.txt'); write(file, 'редакция А');
  const f = fixture({ material: [file], level: 'высокий' }); f.s.rules_version = version;
  job(f); job(f, 'antigravity'); fresh(f); reviews(f);
  const second = structuredClone(f), snapshot = snapshots.create();
  const first = await evaluated(f, snapshot); assert(!first.error, first.error); assert.equal(first.s.state, 'принят');
  const times = fs.statSync(file); write(file, 'редакция Б'); fs.utimesSync(file, times.atime, times.mtime);
  const next = await evaluated(second, snapshot, first.s);
  assert.notEqual(next.s.version, first.s.version); assert.equal(next.s.state, 'идёт');
  assert.deepStrictEqual(next, await evaluated(second, undefined, first.s));
});
test('К1: модуль снимка защищён от быстрого пути', () => {
  assert(require('../common/precheck').fastProtected('common/job-snapshot.js'));
});
test('О2: снимок неизменен после записи, следующий запрос видит новую карточку', async () => {
  const f = fixture(), id = job(f), before = snapshots.create();
  update('codex', id, { status: 'failed' });
  assert.equal(before.get('codex', id).status, 'done');
  assert.equal(snapshots.create().get('codex', id).status, 'failed');
  assert.equal(stores.review('codex', id, null, null, 'ПРИНЯТО', null, null, true, before).status, 'done');
  assert.throws(() => stores.review('codex', id, null, null, 'ПРИНЯТО', null, null, true, snapshots.create()), /завершённое задание/);
});
test('О3: повреждённая посторонняя карточка сохраняет ошибки review/source и сводки', async () => {
  const f = fixture(), id = job(f), file = card('codex', 'unrelated-broken'); write(file, '{');
  try {
    const snapshot = snapshots.create();
    for (const action of [s => stores.review('codex', id, null, null, 'ПРИНЯТО', null, null, true, s), s => stores.source('codex', id, s)]) {
      let expected; try { action(); } catch (e) { expected = e; }
      assert.equal(expected.code, 'STAGE_READ_FAILED');
      assert.throws(() => action(snapshot), e => e.code === expected.code && e.message === expected.message);
    }
    assert.deepStrictEqual(snapshot.list('codex'), stores.list('codex'));
    await quiet(async () => { const text = await new Team(root).status(); assert(text.includes(file)); });
  } finally { json(file, { id: 'unrelated-broken', status: 'failed' }); }
});
test('О4: отсутствующий номер, одинаковые номера помощников, действующая карточка и архив', () => {
  const f = fixture(), id = job(f), agyId = job(f, 'antigravity');
  const agy = JSON.parse(fs.readFileSync(card('antigravity', agyId), 'utf8'));
  json(card('antigravity', id), { ...agy, id });
  write(path.join(stores.roots().antigravity, id, 'result.txt'), 'Текст Antigravity\nПРИНЯТО');
  json(path.join(stores.roots().antigravity, id, 'meta.json'), { hash: fx.sha('Текст Antigravity\nПРИНЯТО') });
  process.env.MOST_CODEX_ARCHIVE_DIR = path.join(RUN, 'archive');
  json(path.join(process.env.MOST_CODEX_ARCHIVE_DIR, id + '.json'), { id, status: 'failed' });
  json(path.join(process.env.MOST_CODEX_ARCHIVE_DIR, 'archive-only.json'), { id: 'archive-only', status: 'done' });
  const snapshot = snapshots.create();
  assert.equal(snapshot.get('codex', id).status, 'done'); assert.equal(snapshot.get('codex', id, true).status, 'failed');
  assert.equal(snapshot.list('codex').jobs.filter(j => j.id === id).length, 2);
  assert.deepStrictEqual(snapshot.list('codex'), stores.list('codex'));
  assert.notEqual(stores.source('codex', id, snapshot), stores.source('antigravity', id, snapshot));
  for (const missing of ['missing', 'archive-only']) {
    assert.throws(() => stores.review('codex', missing, null, null, 'ПРИНЯТО', null, null, true, snapshot), /завершённое задание/);
    assert.throws(() => stores.source('codex', missing, snapshot), /нет принятого сервером/);
  }
});
test('О3/О4: повреждение архива не влияет на действующие review/source', () => {
  const id = job(fixture()), file = path.join(process.env.MOST_CODEX_ARCHIVE_DIR, 'broken.json'); write(file, '{');
  try {
    const snapshot = snapshots.create();
    assert(snapshot.list('codex').errors.length); assert.equal(snapshot.list('codex', false).errors.length, 0);
    assert.deepStrictEqual(snapshot.list('codex'), stores.list('codex'));
    assert.equal(stores.source('codex', id, snapshot), stores.source('codex', id));
    assert.deepStrictEqual(stores.review('codex', id, null, null, 'ПРИНЯТО', null, null, true, snapshot), stores.review('codex', id, null, null, 'ПРИНЯТО', null, null, true));
  } finally { json(file, { id: 'broken', status: 'failed' }); }
});
test('О3: ошибка обхода архива отложена до его потребителя', () => {
  const id = job(fixture()), original = fs.readdirSync;
  const denied = Object.assign(Error('Проверка EACCES архива'), { code: 'EACCES' });
  fs.readdirSync = function(dir, ...args) {
    if (dir === process.env.MOST_CODEX_ARCHIVE_DIR) throw denied;
    return original.call(this, dir, ...args);
  };
  try {
    const snapshot = snapshots.create();
    assert.throws(() => stores.list('codex'), e => e === denied);
    assert.throws(() => snapshot.list('codex'), e => e === denied);
    assert.deepStrictEqual(snapshot.list('codex', false), stores.list('codex', false));
    assert.equal(stores.source('codex', id, snapshot), stores.source('codex', id));
  } finally { fs.readdirSync = original; }
});
test('О3: ошибка чтения сохраняет принятие этапа и предупреждение', async () => {
  const f = fixture(); job(f); job(f, 'antigravity'); reviews(f); const team = persisted(f);
  const file = card('codex', 'stage-unrelated-broken'); write(file, '{');
  try {
    const before = await team.refreshWork(team.workFile(f.w.name), { readOnly: true });
    const after = await team.refreshWork(team.workFile(f.w.name), { readOnly: true, snapshot: snapshots.create() });
    assert.deepStrictEqual(after, before); assert.equal(after.stages[0].state, 'принят');
    assert(after.stages[0].gate.warning.includes(file));
  } finally { json(file, { id: 'stage-unrelated-broken', status: 'failed' }); }
});
test('О5: Promise один на полную метку, включая одновременную проверку', async () => {
  await quiet(async () => {
    const locks = require('../common/locks'), calls = []; locks.ownerState = async owner => { calls.push(owner); return 'alive'; };
    const a = { instance: 'same', pid: 1, startedAt: 'a' }, snapshot = snapshots.create();
    const first = snapshot.ownerState(a); assert.strictEqual(snapshot.ownerState({ ...a }), first);
    await Promise.all([first, snapshot.ownerState({ ...a, pid: 2 }), snapshot.ownerState({ ...a, startedAt: 'b' })]);
    assert.equal(calls.length, 3);
    await snapshots.create().ownerState(a); assert.equal(calls.length, 4);
  });
});
for (const full of [false, true]) test('О5: ' + (full ? 'полная' : 'краткая') + ' сводка проверяет только активных владельцев', async () => {
  const f = fixture(), owner = { instance: 'owner-test', pid: 123, startedAt: 'start' };
  const ids = [job(f, 'codex', 0, { status: 'running', owner }), job(f, 'antigravity', 0, { status: 'running', owner }),
    job(f, 'codex', 0, { status: 'running', owner: { ...owner, pid: 456 } }), job(f, 'codex', 0, { status: 'running', owner: { ...owner, startedAt: 'other' } })];
  job(f, 'codex', 0, { owner: { instance: 'completed-owner' } });
  try {
    await quiet(async () => {
      const calls = []; require('../common/locks').ownerState = async o => { calls.push(o); return 'alive'; };
      await new Team(root).status(undefined, undefined, false, full);
      assert.equal(calls.length, 3); assert(!calls.some(o => o?.instance === 'completed-owner'));
    });
  } finally { ids.forEach((id, i) => update(i === 1 ? 'antigravity' : 'codex', id, { status: 'done' })); }
});
function countReads() {
  const counts = new Map(), files = new Map();
  for (const who of ['codex', 'antigravity']) for (const j of stores.list(who).jobs) files.set(j.cardFile, who);
  const original = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (files.has(String(file))) counts.set(String(file), (counts.get(String(file)) || 0) + 1);
    return original.call(this, file, ...args);
  };
  return { counts, files, restore() { fs.readFileSync = original; }, check(multiplier = 1) {
    assert.equal(counts.size, files.size);
    for (const [file, count] of counts) assert.equal(count, multiplier, file + ': ' + count + ' чтений');
  } };
}
test('О6: N карточек и M этапов — одно чтение на весь status/list/get, включая source и review', async () => {
  const f = fixture({ author: { family: 'google', model: 'gemini' } });
  job(f, 'antigravity', 0, { role: 'текст' }); job(f, 'codex', 1, { task: 'historic' }); job(f); reviews(f);
  const team = persisted(f);
  for (let i = 0; i < 3; i++) {
    const extra = fixture(); job(extra); job(extra, 'antigravity'); reviews(extra); persisted(extra);
  }
  await quiet(async () => {
    for (const action of [() => team.status(), () => team.status(undefined, undefined, false, true),
      () => team.work({ action: 'list' }), () => team.work({ action: 'get', name: f.w.name })]) {
      const measured = countReads();
      try { const text = await action(); assert(!text.includes('не принято')); measured.check(); }
      finally { measured.restore(); }
    }
  });
});
test('О2/О6: два перекрывающихся запроса имеют независимые снимки', async () => {
  const f = fixture(), id = job(f, 'codex', 0, { status: 'running', owner: { instance: 'concurrent' } });
  const team = new Team(root);
  await quiet(async () => {
    const quota = require('../common/quota-line'), entered = [];
    let firstEntered; const ready = new Promise(resolve => { firstEntered = resolve; });
    quota.quotaLine = () => new Promise(resolve => { entered.push(resolve); firstEntered(); });
    const measured = countReads();
    try {
      const first = team.status(); await ready;
      update('codex', id, { status: 'done' });
      // Запись фикстуры читает JSON сама; не относится к серверному запросу.
      measured.counts.set(card('codex', id), measured.counts.get(card('codex', id)) - 1);
      let secondEntered; const readySecond = new Promise(resolve => { secondEntered = resolve; });
      quota.quotaLine = () => { secondEntered(); return Promise.resolve('Квоты: тест'); };
      const second = team.status(); await readySecond;
      const secondText = await second; entered[0]('Квоты: тест'); const firstText = await first;
      assert(firstText.includes(id.slice(0, 8))); assert(!secondText.includes(id.slice(0, 8)));
      measured.check(2);
    } finally { measured.restore(); }
  });
});
run(tests);
