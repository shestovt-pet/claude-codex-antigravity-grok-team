'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-fix1-'));
process.env.MOST_REPO_ROOT = RUN;
process.env.MOST_STATE_DIR = path.join(RUN, 'state');
process.env.MOST_CODEX_JOBS_DIR = path.join(RUN, 'state/codex-jobs');
process.env.LOCALAPPDATA = path.join(RUN, 'local');
process.env.MOST_TEST_KEEP = '1';
process.env.MOST_NOTIFY = 'off';
process.env.MOST_CLIENT = 'claude';
const migration = require('../common/state-migration'), deploy = require('../common/deploy');
const git = require('../common/team-git'), { Team } = require('../common/team');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const json = (file, value) => write(file, JSON.stringify(value));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const tests = [];
const test = (label, fn) => tests.push({ label, fn });

test('Перенос копии настоящей карточки b8d28417 без результата и ожидающих карточек', async () => {
  const root = path.join(RUN, 'incomplete'), state = path.join(root, 'state'), source = path.join(root, 'old');
  const real = read(path.join(__dirname, 'fixtures/codex-b8d28417-running.json'));
  json(path.join(source, 'codex-jobs', real.id + '.json'), real);
  for (const status of ['queued', 'waiting', 'waiting_quota', 'delivery_unclear']) {
    json(path.join(source, 'codex-jobs', status + '.json'), { id: status, status, resultFile: status + '.result.txt' });
  }
  await migration.migrate({ root, state, sources: [source] });
  for (const id of [real.id, 'queued', 'waiting', 'waiting_quota', 'delivery_unclear']) {
    const card = read(path.join(state, 'codex-jobs', id, 'card.json'));
    assert.equal(card.migration.note, 'перенесено без результата');
    assert.notEqual(card.status, 'migration_damaged');
  }
  assert.equal(read(path.join(state, 'codex-jobs', real.id, 'card.json')).status, 'running');
  assert(fs.existsSync(migration.marker(state)));
});

test('Повреждения разных карточек не мешают переносу исправной и метке готовности', async () => {
  const root = path.join(RUN, 'damaged'), state = path.join(root, 'state'), source = path.join(root, 'old');
  json(path.join(source, 'codex-jobs/missing.json'), { id: 'missing', status: 'done' });
  json(path.join(source, 'codex-jobs/hash.json'), { id: 'hash', status: 'done', resultFile: 'hash.result.txt', resultHash: 'wrong' });
  write(path.join(source, 'codex-jobs/hash.result.txt'), 'ПРИНЯТО');
  write(path.join(source, 'codex-jobs/broken.json'), '{');
  json(path.join(source, 'jobs/applied/card.json'), { id: 'applied', status: 'applied' });
  const outside = path.join(root, 'outside');
  json(path.join(outside, 'card.json'), { id: 'escape', status: 'done' });
  fs.symlinkSync(outside, path.join(source, 'codex-jobs/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  json(path.join(source, 'codex-jobs/good.json'), { id: 'good', status: 'running' });
  await migration.migrate({ root, state, sources: [source] });
  for (const id of ['missing', 'hash', 'broken', 'applied', 'escape']) {
    assert.equal(read(path.join(state, 'quarantine', id, 'card.json')).status, 'migration_damaged');
    assert(!fs.existsSync(path.join(state, 'codex-jobs', id)));
  }
  assert(!fs.existsSync(path.join(state, 'quarantine/escape/codex-jobs-0/card.json')));
  assert(fs.existsSync(path.join(outside, 'card.json')));
  assert(fs.existsSync(path.join(state, 'codex-jobs/good/card.json')));
  assert(fs.existsSync(migration.marker(state)));
  const previous = process.env.MOST_CODEX_JOBS_DIR;
  process.env.MOST_CODEX_JOBS_DIR = path.join(state, 'codex-jobs');
  try { assert.throws(() => require('../common/team-store').review('codex', 'hash'), /ПЕРЕНОС: ПОВРЕЖДЁН/); }
  finally { process.env.MOST_CODEX_JOBS_DIR = previous; }
});

test('claim согласует карточку с погибшим процессом перед передачей работы', async () => {
  const team = new Team(RUN, path.join(RUN, 'team'));
  const file = path.join(RUN, 'works/abandoned.json');
  json(file, { name: 'abandoned', owner: 'old', revision: 1, heartbeat_at: '2020-01-01T00:00:00Z',
    stages: [], reminders: [], goal: 'Проверка', done_criteria: 'Передача', next_step: 'Проверка' });
  const cardFile = path.join(process.env.MOST_CODEX_JOBS_DIR, 'dead.json');
  json(cardFile, { id: 'dead', work: 'abandoned', status: 'running', owner: { instance: crypto.randomUUID(), pid: 999999 } });
  const agyFile = path.join(process.env.MOST_STATE_DIR, 'jobs/dead-agy/card.json');
  json(agyFile, { id: 'dead-agy', work: 'abandoned', status: 'running', owner: { instance: crypto.randomUUID() } });
  await team.work({ action: 'claim', name: 'abandoned', owner: 'new', expected_revision: 1 });
  assert.equal(read(cardFile).status, 'lost');
  assert.equal(read(agyFile).status, 'lost');
  assert.equal(read(file).owner, 'new');
});

test('Старый релиз: три сервера и старое хранилище → проверка четырёх, перенос, гости и перезапуск', async () => {
  const root = path.join(RUN, 'upgrade'); fs.mkdirSync(root);
  git.git(root, ['init', '-b', 'main']);
  git.git(root, ['config', 'user.name', 'Тест']); git.git(root, ['config', 'user.email', 'test@example.invalid']);
  write(path.join(root, 'README.md'), 'Проверка');
  git.git(root, ['add', 'README.md']); git.git(root, ['commit', '-m', 'Проверка']);
  const commit = git.hash(root), release = path.join(root, 'live', commit), oldState = path.join(root, 'live/.deploy-state');
  const names = ['antigravity', 'codex', 'team', 'grok'];
  // Релиз содержит настоящий код кандидата; старый deploy проверял только три сервера.
  for (const dir of ['servers', 'common']) fs.cpSync(path.join(__dirname, '..', dir), path.join(release, dir), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(release, 'package.json'));
  json(path.join(release, 'probe-ok.json'), { commit, root, servers: names.slice(0, 3), at: new Date().toISOString() });
  const config = path.join(root, 'claude.json');
  json(config, { mcpServers: Object.fromEntries(names.slice(0, 3).map(n => [n, { command: process.execPath,
    args: [path.join(release, 'servers', n, 'index.js')], env: { MOST_REPO_ROOT: root, MOST_STATE_DIR: oldState } }])) });
  process.env.MOST_CODEX_CONFIG = path.join(root, 'codex.toml'); write(process.env.MOST_CODEX_CONFIG, '');
  process.env.MOST_AGY_MCP_CONFIG = path.join(root, 'agy.json'); json(process.env.MOST_AGY_MCP_CONFIG, {});
  process.env.MOST_AGY_CONFIG = path.join(root, 'permissions.json'); json(process.env.MOST_AGY_CONFIG, {});
  json(path.join(oldState, 'codex-jobs/old.json'), { id: 'old', status: 'running' });
  // Промежуточный запуск новых серверов с MOST_STATE_DIR старого формата.
  const probe = require('../common/probe').probe;
  for (const n of names.slice(0, 3)) await probe(path.join(release, 'servers', n, 'index.js'), {
    ...process.env, MOST_REPO_ROOT: root, MOST_STATE_DIR: oldState, MOST_PROBE_ONLY: '0', MOST_CLIENT: 'claude',
    MOST_CODEX_JOBS_DIR: path.join(oldState, 'codex-jobs'), MOST_INPUT_DIR: path.join(oldState, 'input'), MOST_JOURNAL: path.join(oldState, 'antigravity.log'),
  });
  assert(!fs.existsSync(migration.marker(path.join(root, 'state'))));
  for (const n of names.slice(0, 3)) assert(fs.existsSync(path.join(oldState, 'ready', n + '.json')));
  const probes = [];
  let restarted = false;
  await deploy.deploy({ root, commit, configs: [config], restartClaude: true }, {
    probe: async (file, env) => { probes.push([path.basename(path.dirname(file)), env.MOST_CLIENT]); return probe(file, env); },
    restart: { launch: async (file, { runId, log }) => {
      const script = fs.readFileSync(file, 'utf8');
      assert(script.includes(path.join(root, 'state')) && script.includes("'grok'"));
      restarted = true; write(log, 'запущен ' + runId);
    } },
  });
  assert.equal(probes.length, 10);
  assert.deepEqual(read(path.join(release, 'probe-ok.json')).servers, names);
  for (const n of names) assert.equal(read(config).mcpServers[n].env.MOST_STATE_DIR, path.join(root, 'state'));
  assert(fs.readFileSync(process.env.MOST_CODEX_CONFIG, 'utf8').includes('[mcp_servers.grok]'));
  assert(read(process.env.MOST_AGY_MCP_CONFIG).mcpServers.grok);
  assert(!fs.existsSync(path.join(root, 'state/codex-jobs/old/card.json')));
  assert(!fs.existsSync(migration.marker(path.join(root, 'state'))));
  assert(restarted);
  for (const n of names) {
    const server = read(config).mcpServers[n];
    await probe(server.args[0], { ...process.env, ...server.env, MOST_PROBE_ONLY: '0',
      MOST_CODEX_JOBS_DIR: path.join(root, 'state/codex-jobs'), MOST_INPUT_DIR: path.join(root, 'state/input'),
      MOST_JOURNAL: path.join(root, 'state/antigravity.log') });
    const ready = read(path.join(root, 'state/ready', n + '.json'));
    assert.equal(ready.release, release);
    assert(fs.existsSync(path.join(root, 'state/codex-jobs/old/card.json')));
    assert(fs.existsSync(migration.marker(path.join(root, 'state'))));
  }
});

test('Неудачная повторная проверка сохраняет старую метку и настройки', async () => {
  const root = path.join(RUN, 'upgrade'), commit = git.hash(root), release = path.join(root, 'live', commit);
  const marker = path.join(release, 'probe-ok.json'), config = path.join(root, 'claude.json');
  const old = { ...read(marker), servers: ['antigravity', 'codex', 'team'] };
  json(marker, old);
  const before = fs.readFileSync(config, 'utf8');
  await assert.rejects(deploy.deploy({ root, commit, configs: [config] }, {
    probe: async () => { throw Error('Пробный запуск не прошёл'); },
  }), /Пробный запуск не прошёл/);
  assert.deepEqual(read(marker), old);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
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
