'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-fix2-'));
process.env.MOST_REPO_ROOT = RUN;
process.env.MOST_STATE_DIR = path.join(RUN, 'state');
process.env.MOST_CODEX_JOBS_DIR = path.join(RUN, 'state/codex-jobs');
process.env.LOCALAPPDATA = path.join(RUN, 'local');
process.env.MOST_TEST_KEEP = '1';
process.env.MOST_NOTIFY = 'off';
process.env.MOST_CLIENT = 'claude';
const migration = require('../common/state-migration');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const json = (file, value) => write(file, JSON.stringify(value));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const tests = [], test = (label, fn) => tests.push({ label, fn });
function fixture(name) {
  const root = path.join(RUN, name), state = path.join(root, 'state'), source = path.join(root, 'old');
  return { root, state, source, sources: [source] };
}
function sourceJob(source, kind, id, status, text = 'ПРИНЯТО') {
  const base = kind === 'jobs' ? path.join(source, kind, id) : path.join(source, kind);
  const card = { id, status };
  if (status === 'done') {
    card.resultFile = path.join(base, kind === 'jobs' ? 'result.txt' : id + '.result.txt');
    card.resultHash = crypto.createHash('sha256').update(text).digest('hex');
    write(card.resultFile, text);
    if (kind === 'jobs') json(path.join(base, 'meta.json'), { hash: card.resultHash });
  }
  json(path.join(base, kind === 'jobs' ? 'card.json' : id + '.json'), card);
}
for (const kind of ['jobs', 'codex-jobs']) {
  test('Позднее завершение после готовности: ' + kind, async () => {
    const f = fixture(kind);
    sourceJob(f.source, kind, 'late', 'running');
    await migration.migrate(f);
    const file = path.join(f.state, kind, 'late/card.json');
    assert(fs.existsSync(migration.marker(f.state)));
    json(file, { ...read(file), status: 'lost' });
    sourceJob(f.source, kind, 'late', 'done');
    await migration.migrate(f);
    const card = read(file);
    assert.equal(card.status, 'done');
    assert.equal(fs.readFileSync(card.resultFile, 'utf8'), 'ПРИНЯТО');
    assert(!card.migration.note);
    assert.equal(read(path.join(f.state, 'migration.log')).updated, 1);
    await migration.migrate(f);
    assert.equal(read(path.join(f.state, 'migration.log')).updated, 1);
    sourceJob(f.source, kind, 'late', 'running');
    await migration.migrate(f);
    assert.equal(read(file).status, 'done');
  });
}
test('Завершение во время первичного переноса подбирается следующей сверкой', async () => {
  const f = fixture('during'); sourceJob(f.source, 'codex-jobs', 'race', 'running');
  await migration.migrate({ ...f, hook: async phase => {
    if (phase === 'before_publish') sourceJob(f.source, 'codex-jobs', 'race', 'done');
  } });
  assert.equal(read(path.join(f.state, 'codex-jobs/race/card.json')).status, 'running');
  await migration.migrate(f);
  assert.equal(read(path.join(f.state, 'codex-jobs/race/card.json')).status, 'done');
});
test('Смена карточки между списком файлов и чтением не создаёт ложный карантин', async () => {
  const f = fixture('snapshot-race'); sourceJob(f.source, 'codex-jobs', 'race', 'running');
  const original = fs.readdirSync, dir = path.join(f.source, 'codex-jobs');
  let reads = 0;
  fs.readdirSync = function (file, ...args) {
    const names = original.call(fs, file, ...args);
    if (path.resolve(file) === dir && ++reads === 2) sourceJob(f.source, 'codex-jobs', 'race', 'done');
    return names;
  };
  try { await migration.migrate(f); } finally { fs.readdirSync = original; }
  assert(!fs.existsSync(path.join(f.state, 'quarantine/race')));
  await migration.migrate(f);
  assert.equal(read(path.join(f.state, 'codex-jobs/race/card.json')).status, 'done');
  assert(!fs.existsSync(path.join(f.state, 'quarantine/race')));
});
test('Сбой обновления не теряет исходный комплект; метка не мешает повтору', async () => {
  const f = fixture('retry'); sourceJob(f.source, 'codex-jobs', 'retry', 'running');
  await migration.migrate(f); sourceJob(f.source, 'codex-jobs', 'retry', 'done');
  await assert.rejects(migration.migrate({ ...f, hook: async phase => {
    if (phase === 'before_publish') throw Error('Прервано до публикации');
  } }), /Прервано/);
  assert.equal(read(path.join(f.state, 'codex-jobs/retry/card.json')).status, 'running');
  await migration.migrate(f);
  assert.equal(read(path.join(f.state, 'codex-jobs/retry/card.json')).status, 'done');
});
test('Разные окончательные результаты сохраняются в карантине и запрещают голос', async () => {
  const f = fixture('conflict'); sourceJob(f.source, 'codex-jobs', 'same', 'done');
  await migration.migrate(f);
  sourceJob(f.source, 'codex-jobs', 'same', 'done', 'НЕ ПРИНЯТО: 1 блокирующих');
  await migration.migrate(f);
  const quarantine = path.join(f.state, 'quarantine/same');
  assert.match(read(path.join(quarantine, 'card.json')).migration.reason, /окончательных/);
  const copies = fs.readdirSync(quarantine).filter(n => n.startsWith('codex-jobs-'));
  assert.equal(copies.length, 2);
  const texts = copies.map(n => fs.readFileSync(path.join(quarantine, n, 'same.result.txt'), 'utf8'));
  assert(texts.includes('ПРИНЯТО') && texts.includes('НЕ ПРИНЯТО: 1 блокирующих'));
  const old = process.env.MOST_CODEX_JOBS_DIR;
  process.env.MOST_CODEX_JOBS_DIR = path.join(f.state, 'codex-jobs');
  try { assert.throws(() => require('../common/team-store').review('codex', 'same'), /ПОВРЕЖДЁН/); }
  finally { process.env.MOST_CODEX_JOBS_DIR = old; }
  await migration.migrate(f);
  assert.equal(fs.readdirSync(quarantine).filter(n => n.startsWith('codex-jobs-')).length, 2);
});
test('Планировщик: барьер при старте, интервал пять минут, поздний результат и новые задания', async () => {
  const f = fixture('timer'); sourceJob(f.source, 'codex-jobs', 'old', 'running');
  let tick, unreferenced = false;
  const timer = await migration.start(f, { setInterval: (fn, ms) => {
    assert(fs.existsSync(migration.marker(f.state)));
    assert.equal(ms, 300000); tick = fn;
    return { unref() { unreferenced = true; } };
  } });
  assert(timer && unreferenced);
  sourceJob(f.source, 'codex-jobs', 'old', 'done');
  sourceJob(f.source, 'codex-jobs', 'new', 'done');
  await tick();
  for (const id of ['old', 'new']) assert.equal(read(path.join(f.state, 'codex-jobs', id, 'card.json')).status, 'done');
  // Повторный запуск с существующей меткой тоже подбирает новый номер.
  sourceJob(f.source, 'codex-jobs', 'restart', 'done');
  await migration.start(f, { setInterval: () => ({ unref() {} }) });
  assert.equal(read(path.join(f.state, 'codex-jobs/restart/card.json')).status, 'done');
});
test('Гости и пробный запуск не запускают перенос и периодическую сверку', async () => {
  for (const env of [{ MOST_CLIENT: 'codex' }, { MOST_CLIENT: 'antigravity' }, { MOST_PROBE_ONLY: '1' }]) {
    const f = fixture(crypto.randomUUID()); sourceJob(f.source, 'codex-jobs', 'old', 'running');
    await migration.start({ ...f, env }, { setInterval: () => { throw Error('Не должен запускаться'); } });
    assert(!fs.existsSync(f.state));
  }
});
test('Одновременные сверки публикуют поздний результат один раз', async () => {
  const f = fixture('parallel'); sourceJob(f.source, 'codex-jobs', 'late', 'running');
  await migration.migrate(f); sourceJob(f.source, 'codex-jobs', 'late', 'done');
  await Promise.all([1, 2, 3].map(() => migration.migrate(f)));
  assert.equal(read(path.join(f.state, 'codex-jobs/late/card.json')).status, 'done');
  assert.equal(read(path.join(f.state, 'migration.log')).updated, 1);
});
test('Занятая карточка не перезаписывается; следующий проход обновляет её', async () => {
  const f = fixture('busy'); sourceJob(f.source, 'codex-jobs', 'late', 'running');
  await migration.migrate(f); sourceJob(f.source, 'codex-jobs', 'late', 'done');
  const lock = await require('../common/locks').tryLock('codex_job', 'late', {}, f.state);
  assert(lock.ok);
  try {
    await migration.migrate(f);
    assert.equal(read(path.join(f.state, 'codex-jobs/late/card.json')).status, 'running');
  } finally { await lock.release(); }
  await migration.migrate(f);
  assert.equal(read(path.join(f.state, 'codex-jobs/late/card.json')).status, 'done');
});
test('Сбой периодической сверки записывается, следующий запуск восстанавливается', async () => {
  const f = fixture('failed-tick'); sourceJob(f.source, 'codex-jobs', 'late', 'running');
  let tick, fail = false;
  await migration.start({ ...f, hook: async phase => {
    if (fail && phase === 'before_publish') throw Error('Сбой сверки для проверки');
  } }, { setInterval: fn => { tick = fn; return { unref() {} }; } });
  sourceJob(f.source, 'codex-jobs', 'late', 'done'); fail = true;
  await tick();
  assert.match(read(path.join(f.state, 'migration-error.json')).error, /Сбой сверки/);
  fail = false; await tick();
  assert.equal(read(path.join(f.state, 'codex-jobs/late/card.json')).status, 'done');
  assert(read(path.join(f.state, 'migration-error.json')).resolvedAt);
});
test('team_status показывает номера и причины ошибок и карантина', async () => {
  const f = { root: RUN, state: path.join(RUN, 'state'), sources: [path.join(RUN, 'bad-source')] };
  json(path.join(f.sources[0], 'codex-jobs/broken.json'), { id: 'broken', status: 'done' });
  await migration.migrate(f);
  const { Team } = require('../common/team');
  const text = await new Team(RUN, path.join(f.state, 'team')).status();
  assert.match(text, /Ошибка переноса · broken · Неполный результат/);
  assert.match(text, /ПЕРЕНОС: ПОВРЕЖДЁН · broken · Неполный результат/);
});
(async () => {
  let passed = 0, failed = 0;
  for (const { label, fn } of tests) {
    try { await fn(); passed++; console.log('ПРОЙДЕНО: ' + label); }
    catch (e) { failed++; console.error('ПРОВАЛЕНО: ' + label + '\n' + e.stack); }
  }
  console.log(`Итого: пройдено ${passed}, провалено ${failed}, пропущено 0`);
  process.exitCode = failed ? 1 : 0;
})();
