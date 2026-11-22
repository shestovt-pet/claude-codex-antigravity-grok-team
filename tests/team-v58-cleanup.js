'use strict';
// team-v58-any-chat, task5 пп.2–4: уборка после установки не останавливает сервер team и не держит замок репозитория.
//  — отдельный процесс с пределом времени (common/cleanup-run.js); при истечении — «прервана по времени»;
//  — замок репозитория берётся на удаление КАЖДОГО пути и сразу отпускается; сбой не оставляет замков;
//  — состояние уборки хранит PID: «идёт» действительно, только пока процесс жив (deploy-ops.cleanupLine); снимок 38b0578e;
//  — team_status отвечает во время уборки строкой «уборка идёт с …», не ждёт её.
process.env.MOST_AGY_CLI_SETTINGS = require('path').join(__dirname, '.tmp-agy-cli-v58cl-' + process.pid, 'settings.json');
process.env.MOST_DSH_CONFIG = require('path').join(__dirname, 'missing-dsh-config.yml');
process.env.MOST_DSH_RULES = require('path').join(__dirname, 'missing-dsh-rules.md');
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v58cl-'));
const write = (f, bytes) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); };
const json = (f, value) => write(f, JSON.stringify(value));
Object.assign(process.env, { LOCALAPPDATA: path.join(RUN, 'local'), MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off',
  MOST_TEST_KEEP: '1', MOST_CLAUDE_CONFIGS: '[]', MOST_CODEX_JOBS_DIR: path.join(RUN, 'state/codex-jobs'), MOST_CODEX_ARCHIVE_DIR: path.join(RUN, 'archive'),
  MOST_CODEX_CONFIG: path.join(RUN, 'codex.toml'), MOST_AGY_MCP_CONFIG: path.join(RUN, 'agy.json'), MOST_AGY_CONFIG: path.join(RUN, 'permissions.json'),
  MOST_CODEX_RULES: path.join(RUN, 'missing-codex.md'), MOST_AGY_RULES: path.join(RUN, 'missing-agy.md'), MOST_CODEX_SESSIONS: path.join(RUN, 'sessions'),
  MOST_AGY_QUOTA_FILE: path.join(RUN, 'missing-agy-quota.json'), CODEX_PATH: path.join(__dirname, 'fake-codex.js') });
const ad = require('../common/after-deploy'), ops = require('../common/deploy-ops'), cleanupRun = require('../common/cleanup-run');
const { Team } = require('../common/team');
const tests = [], test = (name, fn) => tests.push([name, fn]);
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

// Замок-заглушка: один одновременный держатель; события lock/release по порядку.
function fakeLocks() {
  let held = 0; const events = [];
  return { held: () => held, events,
    tryLock: async () => { if (held > 0) return { ok: false, busy: true, state: 'alive' }; held++; events.push('lock'); return { ok: true, release: async () => { held--; events.push('release'); } }; } };
}
function planStub(paths) { const logFile = path.join(RUN, 'cleanup-log.jsonl'); return { planFor: () => ({ plan: { remove: paths.map(p => ({ path: p })), keep: [], blocked: [] }, d: { logFile } }) }; }

test('п.2: предел времени — уборка прекращается со статусом «прервана по времени», замок отпущен', async () => {
  const file = path.join(RUN, 'state/deploy-ops/limit.json'); json(file, { id: 'limit', createdAt: new Date().toISOString(), status: 'завершено', cleanup: { state: 'идёт', started: new Date().toISOString(), pid: process.pid } });
  const lk = fakeLocks();
  const r = await cleanupRun.run({ root: RUN, id: 'limit', limitMs: -1, now: Date.now }, { ops, locks: lk, canon: p => p, cleanup: { ...planStub(['a', 'b']), removeOne: () => ({ ok: true }) } });
  assert.equal(r.state, 'прервана'); assert.match(r.reason, /предел времени/);
  assert.equal(readJson(file).cleanup.state, 'прервана');
  assert.equal(lk.held(), 0, 'замок не держится после предела');
});

test('п.2: замок берётся на каждый путь и сразу отпускается; «готово» с числом удалённых', async () => {
  const file = path.join(RUN, 'state/deploy-ops/each.json'); json(file, { id: 'each', createdAt: new Date().toISOString(), status: 'завершено' });
  const lk = fakeLocks();
  const r = await cleanupRun.run({ root: RUN, id: 'each', limitMs: 1e9, now: Date.now }, { ops, locks: lk, canon: p => p, cleanup: { ...planStub(['a', 'b']), removeOne: x => ({ ...x, ok: true }) } });
  assert.equal(r.state, 'готово'); assert.equal(r.removed, 2);
  assert.deepEqual(lk.events, ['lock', 'release', 'lock', 'release'], 'замок на каждый путь, отпущен сразу');
  assert.equal(lk.held(), 0);
});

test('п.2: замок репозитория занят — путь не удалён, но замок не занят этим процессом; остальная уборка продолжается', async () => {
  const file = path.join(RUN, 'state/deploy-ops/busy.json'); json(file, { id: 'busy', createdAt: new Date().toISOString(), status: 'завершено' });
  let first = true;
  const lk = { held: () => 0, tryLock: async () => { if (first) { first = false; return { ok: false, busy: true, state: 'alive' }; } return { ok: true, release: async () => {} }; } };
  const r = await cleanupRun.run({ root: RUN, id: 'busy', limitMs: 1e9, now: Date.now }, { ops, locks: lk, canon: p => p, cleanup: { ...planStub(['a', 'b']), removeOne: x => ({ ...x, ok: true }) } });
  assert.equal(r.state, 'готово'); assert.equal(r.removed, 1); assert.equal(r.failed, 1);
});

test('п.2: сбой удаления пути не оставляет замков (release в finally)', async () => {
  const file = path.join(RUN, 'state/deploy-ops/fail.json'); json(file, { id: 'fail', createdAt: new Date().toISOString(), status: 'завершено' });
  const lk = fakeLocks();
  await assert.rejects(cleanupRun.run({ root: RUN, id: 'fail', limitMs: 1e9, now: Date.now }, { ops, locks: lk, canon: p => p, cleanup: { ...planStub(['a']), removeOne: () => { throw Error('boom'); } } }));
  assert.equal(lk.held(), 0, 'замок отпущен даже при исключении удаления');
});

test('п.3: team_status во время уборки отвечает строкой «уборка идёт с …», не ждёт', async () => {
  const root = path.join(RUN, 'during'); fs.mkdirSync(path.join(root, 'live', 'rel'), { recursive: true });
  const id = 'during-op', file = path.join(root, 'state', 'deploy-ops', id + '.json');
  json(file, { id, root, release: path.join(root, 'live', 'rel'), status: 'завершено', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cleanup: { state: 'идёт', started: new Date().toISOString(), pid: process.pid } });
  const t = new Team(root);
  const t0 = Date.now(); const brief = await t.status(); const ms = Date.now() - t0;
  assert.match(brief, /уборка: идёт с /, brief);
  assert.ok(ms < 3000, 'сводка не ждёт уборку: ' + ms + ' мс');
});

test('п.4: распознавание прерванной уборки по PID и времени (снимок 38b0578e)', () => {
  // cleanup «идёт» с 18.11 08:00 UTC, процесс мёртв → «прервана» (даже если бы время было свежим — ловит мёртвый PID).
  assert.equal(ops.cleanupLine({ state: 'идёт', started: '2026-11-18T08:00:00Z', pid: 2147483000 }, Date.parse('2026-11-18T08:05:00Z'), { alive: () => false }), 'уборка: прервана');
  assert.equal(ops.cleanupLine({ state: 'идёт', started: '2026-11-18T08:00:00Z', pid: process.pid }, Date.parse('2026-11-18T08:05:00Z'), { alive: () => true }), 'уборка: идёт с 2026-11-18T08:00:00Z');
  // Давний старт → прервана по времени даже при живом PID.
  assert.equal(ops.cleanupLine({ state: 'идёт', started: '2026-11-18T08:00:00Z', pid: process.pid }, Date.parse('2026-11-18T09:00:00Z'), { alive: () => true }), 'уборка: прервана');
});

test('п.2/4: afterDeploy запускает уборку отдельным процессом (PID в записи), мёртвый PID — повтор вручную', async () => {
  const name = 'spawn', root = path.join(RUN, name); fs.mkdirSync(path.join(root, 'live', 'rel'), { recursive: true });
  const file = path.join(root, 'state', 'deploy-ops', 'op-' + name + '.json');
  json(file, { id: 'op-' + name, root, release: path.join(root, 'live', 'rel'), status: 'завершено', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  let spawned = null;
  const opts = { root, stateDir: path.join(root, 'state'), spawnCleanup: (args) => { spawned = args; return { pid: 4242, startedAt: new Date().toISOString() }; } };
  const text = await ad.afterDeploy('op-' + name, opts);
  assert.match(text, /запущена отдельным процессом \(PID 4242\)/);
  assert.ok(spawned && spawned.root === root && spawned.id === 'op-' + name, 'процессу переданы root и id');
  const rec = readJson(file).cleanup; assert.equal(rec.state, 'идёт'); assert.equal(rec.pid, 4242);
  // Процесс уборки «умер»: повторный afterDeploy распознаёт прерванную уборку и не перезапускает автоматически.
  ops.update(file, { cleanup: { state: 'идёт', started: rec.started, pid: 2147483000 } });
  const again = await ad.afterDeploy('op-' + name, { ...opts, spawnCleanup: () => { throw Error('не должен запускаться'); } });
  assert.match(again, /прервана — автоматически не повторяется, нужна ручная уборка/);
});

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('OK ' + name); passed++; }
    catch (e) { console.log('FAIL ' + name + '\n' + (e.stack || e.message)); failed++; }
  }
  try { fs.rmSync(RUN, { recursive: true, force: true }); } catch {}
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0');
  if (failed) process.exitCode = 1;
})();
