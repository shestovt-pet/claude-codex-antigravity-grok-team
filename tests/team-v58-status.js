'use strict';
// team-v58-any-chat, task5 п.1: краткая сводка team_status отвечает за секунды.
//  — кэш разобранных карточек по пути+размеру+времени (common/team-store.js): старые завершённые карточки не перечитываются
//    и не переразбираются на каждый вызов; новая и изменившаяся карточка видны сразу;
//  — квота Codex кэшируется (срок несколько минут) и берётся с коротким пределом ожидания (common/quota-line.js);
//  — живость владельцев — один опрос на владельца (job-snapshot memoize), не по карточке.
process.env.MOST_AGY_CLI_SETTINGS = require('path').join(__dirname, '.tmp-agy-cli-settings-v58status-' + process.pid, 'settings.json');
process.env.MOST_DSH_CONFIG = require('path').join(__dirname, 'missing-dsh-config.yml');
process.env.MOST_DSH_RULES = require('path').join(__dirname, 'missing-dsh-rules.md');
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v58status-'));
const write = (f, bytes) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); };
const json = (f, value) => write(f, JSON.stringify(value));
Object.assign(process.env, { LOCALAPPDATA: path.join(RUN, 'local'), MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off',
  MOST_TEST_KEEP: '1', MOST_CLAUDE_CONFIGS: '[]', MOST_CODEX_JOBS_DIR: path.join(RUN, 'state/codex-jobs'), MOST_CODEX_ARCHIVE_DIR: path.join(RUN, 'archive'),
  MOST_CODEX_CONFIG: path.join(RUN, 'codex.toml'), MOST_AGY_MCP_CONFIG: path.join(RUN, 'agy.json'), MOST_AGY_CONFIG: path.join(RUN, 'permissions.json'),
  MOST_CODEX_RULES: path.join(RUN, 'missing-codex.md'), MOST_AGY_RULES: path.join(RUN, 'missing-agy.md'), MOST_CODEX_SESSIONS: path.join(RUN, 'sessions'),
  MOST_AGY_QUOTA_FILE: path.join(RUN, 'missing-agy-quota.json'), CODEX_PATH: path.join(__dirname, 'fake-codex.js') });
const stores = require('../common/team-store');
const quotaLine = require('../common/quota-line');
const { Team } = require('../common/team');

const tests = [], test = (name, fn) => tests.push([name, fn]);
const codexDir = process.env.MOST_CODEX_JOBS_DIR;
const ago = ms => new Date(Date.now() - ms).toISOString();

// 5000 завершённых карточек + 3 активных.
const N = 5000;
fs.mkdirSync(codexDir, { recursive: true });
for (let i = 0; i < N; i++) json(path.join(codexDir, 'done-' + i + '.json'), { id: 'done-' + i, status: 'done', startedAt: ago(5 * 86400000), archived: false });
const ACTIVE = ['act-a', 'act-b', 'act-c'];
for (const id of ACTIVE) json(path.join(codexDir, id + '.json'), { id, status: 'running', startedAt: ago(60000) });

test('п.1: кэш карточек — холодный ≤ ~10 с, прогретый < 2 с; счётчики верны', () => {
  const t0 = Date.now(); const cold = stores.list('codex', true); const coldMs = Date.now() - t0;
  assert.equal(cold.jobs.length, N + ACTIVE.length, 'все карточки прочитаны');
  assert.equal(cold.errors.length, 0);
  const t1 = Date.now(); const warm = stores.list('codex', true); const warmMs = Date.now() - t1;
  const t2 = Date.now(); stores.list('codex', true); const warm2Ms = Date.now() - t2;
  assert.equal(warm.jobs.length, N + ACTIVE.length);
  console.log('п.1 тайминги: холодный ' + coldMs + ' мс, прогретый ' + warmMs + '/' + warm2Ms + ' мс');
  assert.ok(coldMs < 10000, 'холодный первый вызов ≤ ~10 с: ' + coldMs);
  assert.ok(warm2Ms < 2000, 'прогретый вызов < 2 с: ' + warm2Ms);
  assert.ok(warmMs <= coldMs, 'прогретый не медленнее холодного');
});

test('п.1: новая карточка видна сразу (кэш не скрывает)', () => {
  stores.list('codex', true);
  json(path.join(codexDir, 'act-new.json'), { id: 'act-new', status: 'running', startedAt: ago(1000) });
  const after = stores.list('codex', true);
  assert.ok(after.jobs.some(j => j.id === 'act-new'), 'новая карточка в выдаче');
  fs.rmSync(path.join(codexDir, 'act-new.json'));
});

test('п.1: изменившаяся карточка видна сразу (размер/время изменились — перечитана)', () => {
  const file = path.join(codexDir, 'act-a.json');
  stores.list('codex', true);
  json(file, { id: 'act-a', status: 'done', startedAt: ago(60000), note: 'изменено' });
  const after = stores.list('codex', true).jobs.find(j => j.id === 'act-a');
  assert.equal(after.status, 'done', 'новый статус виден');
  assert.equal(after.note, 'изменено');
  json(file, { id: 'act-a', status: 'running', startedAt: ago(60000) }); // вернуть
});

test('п.1: краткая сводка team_status показывает активные карточки и отвечает повторно быстро', async () => {
  const t = new Team(RUN);
  const brief1 = await t.status();
  for (const id of ACTIVE) assert.ok(brief1.includes('codex ' + id.slice(0, 8)), 'активная ' + id + ' в сводке');
  const t0 = Date.now(); const brief2 = await t.status(); const ms = Date.now() - t0;
  console.log('п.1 краткая сводка (повтор): ' + ms + ' мс');
  assert.ok(brief2.includes('codex act-a'), 'повторная сводка верна');
  assert.ok(ms < 2000, 'повторная краткая сводка < 2 с: ' + ms);
});

test('п.1: квота Codex — кэш в пределах срока и прошлое значение при истечении предела', async () => {
  quotaLine.resetCodexCache();
  let v = { source: 'A', taken_at: 't1', all: [] };
  const q = { codexQuota: async () => v, rollout: () => null };
  const r1 = await quotaLine.codexQuotaCached(q, 'bin', undefined);
  assert.equal(r1.source, 'A');
  v = { source: 'B', taken_at: 't2', all: [] };
  const r2 = await quotaLine.codexQuotaCached(q, 'bin', undefined); // в пределах срока — прежнее значение
  assert.equal(r2.source, 'A', 'в пределах срока годности — кэш, внешний процесс не опрашивается');
  const old = process.env.MOST_CODEX_QUOTA_TTL_MS; process.env.MOST_CODEX_QUOTA_TTL_MS = '0';
  const r3 = await quotaLine.codexQuotaCached(q, 'bin', undefined); // срок истёк — свежее значение
  assert.equal(r3.source, 'B');
  const qFail = { codexQuota: async () => ({ source: 'данные не предоставлены', error: 'предел ожидания' }), rollout: () => null };
  const r4 = await quotaLine.codexQuotaCached(qFail, 'bin', undefined); // предел истёк — прошлый снимок, не ошибка
  assert.equal(r4.source, 'B', 'при истечении предела — прошлое значение с его временем снимка');
  if (old === undefined) delete process.env.MOST_CODEX_QUOTA_TTL_MS; else process.env.MOST_CODEX_QUOTA_TTL_MS = old;
  quotaLine.resetCodexCache();
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
