'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v29-'));
const write = (f, bytes) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); };
const json = (f, value) => write(f, JSON.stringify(value));
Object.assign(process.env, { LOCALAPPDATA: path.join(RUN, 'local'), MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off',
  MOST_TEST_KEEP: '1', MOST_CLAUDE_CONFIGS: '[]', MOST_CODEX_JOBS_DIR: path.join(RUN, 'state/codex-jobs'), MOST_CODEX_ARCHIVE_DIR: path.join(RUN, 'archive'),
  MOST_CODEX_CONFIG: path.join(RUN, 'codex.toml'), MOST_AGY_MCP_CONFIG: path.join(RUN, 'agy.json'), MOST_AGY_CONFIG: path.join(RUN, 'permissions.json'),
  MOST_CODEX_RULES: path.join(RUN, 'missing-codex.md'), MOST_AGY_RULES: path.join(RUN, 'missing-agy.md'), MOST_CODEX_SESSIONS: path.join(RUN, 'sessions'),
  MOST_AGY_QUOTA_FILE: path.join(__dirname, 'fixtures/team-v29/agy-quota.json'), MOST_AGY_LOG_DIR: path.join(RUN, 'agy-log'), CODEX_PATH: path.join(__dirname, 'fake-codex.js') });
write(path.join(RUN, 'agy-log/cli-test.log'), 'applyAuthResult: email=quota@example.invalid\n');
const { Team } = require('../common/team'), summary = require('../common/summary'), stores = require('../common/team-store');
const fixture = JSON.parse(fs.readFileSync(process.env.MOST_AGY_QUOTA_FILE));
const tests = [], test = (name, fn) => tests.push([name, fn]);
const ago = hours => new Date(Date.now() - hours * 3600000).toISOString();
function work(name, extra = {}) { return { name, revision: 1, reminders: [], goal: 'цель', done_criteria: 'готово', next_step: 'следующий шаг', created_at: ago(100), updated_at: ago(1),
  stages: [{ id: 's', title: 'Этап', state: 'идёт', weight: 100 }], ...extra }; }
async function withJobs(jobs, fn) { const old = stores.list; stores.list = who => ({ jobs: jobs[who] || [], errors: [] }); try { return await fn(); } finally { stores.list = old; } }
test('О7: уровни склеены внутри квоты, пояснение один раз, одиночная модель сохранена', () => {
  const parse = require('../common/agy-quota').parseQuota;
  const text = parse(fixture, 'quota@example.invalid');
  for (const name of ['Claude Opus 5.5', 'Claude Sonnet 5.5']) assert(text.includes(name + ' (Low, Medium, High) [семья anthropic]'));
  assert.equal(text.split('та же семья, что ведущий').length - 1, 1);
  const single = structuredClone(fixture); single.userStatus.cascadeModelConfigData.clientModelConfigs = [{ label: 'Gemini Test (High)', quotaInfo: { remainingFraction: .5, resetTime: '2099-01-01T12:00:00Z' } }];
  assert.match(parse(single), /Gemini Test \(High\) \[семья google\]: осталось 50 %/);
  const split = structuredClone(fixture); split.userStatus.cascadeModelConfigData.clientModelConfigs[7].quotaInfo.remainingFraction = .1;
  const separate = parse(split); assert.match(separate, /Claude Opus 5.5 \(Medium\).*осталось 10 %/);
});
test('О8: завершённые только счётчиком, полная сводка сохраняет этапы', async () => {
  const t = new Team(RUN), w = work('closed-o8', { closed: true, stages: [{ id: 's', title: 'Закрытый этап', state: 'выдан без принятия', weight: 100, gate: { reasons: ['причина'], files: ['файл'], warning: 'скрытое предупреждение' } }] });
  json(t.workFile(w.name), w);
  const brief = await t.status();
  assert.match(brief, /Работы: завершено 1; этапов «выдан без принятия» в завершённых: 1/);
  assert(!brief.includes('Закрытый этап')); assert(!brief.includes('скрытое предупреждение'));
  const full = await t.status(undefined, undefined, false, true); assert.match(full, /Закрытый этап/); assert.match(full, /выдан без принятия/);
});
test('О9: разные старые счётчики, свежие и активные по строкам, full сохраняет все остановки', async () => {
  const jobs = [
    { id: 'old-decision', status: 'needs_decision', startedAt: ago(25) },
    { id: 'stop-old', status: 'stop_unconfirmed', startedAt: ago(25) },
    { id: 'cancel-old', status: 'cancelled', stopUnconfirmed: true, startedAt: ago(25) },
    { id: 'new-decision', status: 'needs_decision', startedAt: ago(1) },
    { id: 'cancel-new', status: 'cancelled', stopUnconfirmed: true, startedAt: ago(1) },
    ...['running', 'queued', 'cancelling', 'cancel_requested', 'delivery_unclear', 'migration_conflict', 'applying'].map((status, i) => ({ id: 'active-' + i, status, startedAt: ago(30) }))
  ];
  await withJobs({ codex: jobs }, async () => {
    const t = new Team(RUN), text = await t.status();
    assert.match(text, /нужно решение по 1 поручениям старше суток/); assert.match(text, /остановка не подтверждена у 2 поручений старше суток/);
    for (const j of jobs.slice(3)) assert(text.includes(j.id.slice(0, 8)), j.id);
    assert(!text.includes('old-deci')); assert(!text.includes('stop-old')); assert(!text.includes('cancel-o'));
    const full = await t.status(undefined, undefined, false, true); for (const j of jobs) assert(full.includes(j.id), j.id);
  });
});
test('Р9: порядок снятия, блоки работ, обязательное превышение и место паузы', async () => {
  const rows = [{ text: 'обязательная'.repeat(30) }, ...[5, 4, 3, 2, 1, 0].map(priority => ({ text: 'строка-' + priority, priority })),
    { text: 'новая\nподробность новой', priority: 6, updated: 2, work: true }, { text: 'старая\nподробность старой', priority: 6, updated: 1, work: true }];
  const all = summary.fit(rows, 10000); assert(!all.includes('Ещё не показано'));
  const small = summary.fit(rows, 460); assert(!small.includes('старая')); assert(small.includes('новая')); for (let p = 0; p < 6; p++) assert(!small.includes('строка-' + p));
  const over = summary.fit(rows, 10); assert(over.startsWith(rows[0].text)); assert.match(over, /из них работ: 2/);
  const text = await summary.compact({ root: RUN, state: path.join(RUN, 'state/team'), works: () => [] }, 'квоты', undefined,
    { budget: 1, restartWarnings: ['Пауза перезапуска: тест места обязательной строки'] });
  assert(text.includes('Пауза перезапуска: тест места обязательной строки'));
});
test('Р9: снимок оболочки не перечитывается после измерения', async () => {
  const pub = require('../common/public-transport'), owner = require('../common/work-owner'), fallback = require('../common/fallback');
  const oldReminder = owner.reminder, oldBanner = fallback.banner; let reads = 0;
  owner.reminder = () => { reads++; return '⚠ Статус пользователю снимок'; }; fallback.banner = () => { reads++; return 'Баннер снимок'; };
  try {
    const sent = [], transport = pub.publicTransport({ send: async m => sent.push(m) });
    transport.onmessage = async m => {
      const context = require('../common/request-context').context.getStore(); pub.snapshot(context);
      const before = pub.decorate(require('../common/format').format('Команда', {}, 'тело'), context);
      owner.reminder = () => { throw Error('повторное чтение'); }; fallback.banner = owner.reminder;
      await transport.send({ id: m.id, result: { content: [{ type: 'text', text: require('../common/format').format('Команда', {}, 'тело') }] } });
      assert.equal(sent.at(-1).result.content[0].text, before);
    };
    await transport.onmessage({ id: 1, method: 'tools/call', params: { arguments: { owner: 'тест' } } }); assert.equal(reads, 2);
  } finally { owner.reminder = oldReminder; fallback.banner = oldBanner; }
});
async function mcp(root) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers/team/index.js')], stderr: 'pipe', env: { ...process.env,
    MOST_REPO_ROOT: root, MOST_STATE_DIR: path.join(root, 'state'), MOST_CODEX_JOBS_DIR: path.join(root, 'state/codex-jobs'), MOST_CODEX_ARCHIVE_DIR: path.join(root, 'archive') } });
  const c = new Client({ name: 'v29', version: '1' }); await c.connect(transport);
  return { close: () => c.close(), call: async full => {
    const r = await c.callTool({ name: 'team_status', arguments: { full, owner: 'status-owner' } });
    const text = r.content.filter(x => x.type === 'text').map(x => x.text).join('\n'); assert(!r.isError, text); return text;
  } };
}
function statusFixture(root, crowded) {
  fs.mkdirSync(root, { recursive: true });
  // Собственная граница git без истории не даёт status читать родительский клон.
  cp.execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  json(path.join(root, 'state/restart-hold.json'), { id: 'pause-o10', runId: 'pause-o10', createdAt: ago(0), executor: require('../common/restart-hold').fingerprint(process.pid) });
  json(path.join(root, 'state/team/claude-quota.json'), { calls: 20, written: 1000, reread: 2000000, window_h: 5, taken_at: ago(0), source: 'снимок' });
  for (let i = 0; i < (crowded ? 60 : 1); i++) json(path.join(root, 'works/closed-' + i + '.json'), work('closed-' + i, { closed: true,
    stages: [{ title: 'Завершённый', state: 'выдан без принятия', weight: 100, gate: { files: ['file'], reasons: ['причина'] } }] }));
  if (crowded) for (let i = 0; i < 25; i++) json(path.join(root, 'works/open-' + i + '.json'), work('open-' + i, { updated_at: ago(25 - i),
    stages: [{ title: 'Этап ' + i, state: 'выдан без принятия', weight: 100, gate: { files: ['file'], reasons: ['причина'], ...(i === 0 ? { warning: 'ПРЕДУПРЕЖДЕНИЕ-ДАВНЕГО' } : {}) } }] }));
  json(path.join(root, 'works/remind.json'), work('remind', { owner: 'status-owner', created_at: ago(1), status_sent_at: ago(1) }));
  for (let i = 0; i < 30; i++) json(path.join(root, 'state/codex-jobs/decision-' + i + '.json'), { id: 'decision-' + i, status: 'needs_decision', startedAt: ago(25) });
  json(path.join(root, 'state/codex-jobs/running.json'), { id: 'running-o10', status: 'running', startedAt: ago(1) });
  json(path.join(root, 'state/jobs/applying/card.json'), { id: 'applying', status: 'applying', startedAt: ago(30) });
  write(path.join(root, 'works/broken.json'), '{');
  json(path.join(root, 'state/team/changes/active.json'), { name: 'active', title: 'Изменение в работе', status: 'разработка', requestMark: '#45e7aa10', request: 'Проверить сводку' });
  json(path.join(root, 'state/deploy-ops/check.json'), { id: 'check', status: 'перезапуск не запущен', createdAt: ago(1) });
  write(path.join(root, 'state/team/words.jsonl'), JSON.stringify({ id: 'word-o10', kind: 'record', who_down: 'claude', quote: 'Claude отвалился', at: ago(1), recorded_by: 'codex', owner: 'fallback-codex-test' }) + '\n');
}
test('О10: настоящий MCP, текущий состав квот, переполнение и вариант без лишнего', async () => {
  for (const crowded of [true, false]) {
    const root = path.join(RUN, crowded ? 'crowded' : 'small'); statusFixture(root, crowded); const server = await mcp(root);
    try {
      const text = await server.call(false); console.log('О10 ' + (crowded ? 'с избытком' : 'без лишнего') + ': ' + text.length + ' знаков');
      assert(text.length <= 3000, text);
      for (const marker of ['Квоты:', 'Claude Desktop', 'Gemini 4 Argon', 'Gemini 3.8 Flash', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-OSS 120B', 'обычное распределение',
        'Запасной режим: дирижёр Codex', 'Статус пользователю', 'Работы: завершено', 'нужно решение по 30', 'running-', 'applying', '#45e7aa10', 'Изменение в работе', 'broken', 'перезапуск не запущен', 'Пауза перезапуска: операция pause-o10', 'исполнитель жив', 'старые серверы не принимают новые поручения', 'Расхождения подключений', 'Дальше:']) assert(text.includes(marker), marker + '\n' + text);
      assert.equal((text.match(/Статус пользователю/g) || []).length, 1);
      if (crowded) {
        assert.match(text, /Ещё не показано/); assert.match(text, /open-0: Этап 0 — ПРЕДУПРЕЖДЕНИЕ-ДАВНЕГО/);
        assert(!text.includes('open-0: принято')); assert(!text.includes('open-0: Этап 0 — выдан')); assert(!text.includes('open-0: Этап 0 — место'));
        const shown = [...text.matchAll(/open-(\d+): принято/g)].map(m => Number(m[1]));
        assert(shown.length > 0, 'должен остаться блок самой свежей работы');
        assert.deepEqual(shown.sort((a,b) => a-b), Array.from({ length: 25 - Math.min(...shown) }, (_, i) => Math.min(...shown) + i));
      } else assert(!text.includes('Ещё не показано'), text);
      const full = await server.call(true); assert(full.includes('Завершённый')); assert(full.includes('decision-29'));
    } finally { await server.close(); }
  }
});
test('Р10: успешная уборка сокращена только в краткой сводке; сбои обязательны', async () => {
  const file = path.join(RUN, 'state/deploy-ops/cleanup.json');
  const op = { id: 'cleanup', status: 'завершено', createdAt: ago(0), cleanup: { state: 'готово', removed: 0, failed: 0, blocked: ['release-one', 'release-two'] } };
  json(file, op);
  const t = new Team(RUN), brief = await t.status(), full = await t.status(undefined, undefined, false, true);
  assert.match(brief, /релизы не удалялись: 2 — full=true/); assert(!brief.includes('release-one')); assert(full.includes('release-one; release-two'));
  for (const status of ['перезапуск идёт', 'перезапуск не запущен', 'перезапуск не подтверждён', 'отказ']) {
    json(file, { ...op, status });
    const text = await summary.compact(t, 'квоты', undefined, { budget: 1 }); assert(text.includes('Установка cleanup: ' + status));
  }
  json(file, { ...op, cleanup: { state: 'ошибка', reason: 'сбой уборки' } });
  assert((await summary.compact(t, 'квоты', undefined, { budget: 1 })).includes('сбой уборки'));
});
test('Р13: нет источника по умолчанию — пропуск; неверный явный источник — ошибка', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'trio-v5.js')).toString('utf8');
  const body = source.slice(source.indexOf("test('Р4: полная оболочка"), source.indexOf("test('Р5: настоящие ворота merge"));
  let check; const env = { ...process.env }; delete env.MOST_TEST_STATUS_SOURCE;
  new Function('test', 'process', 'fs', 'path', 'RUN', 'assert', body)((_name, fn) => { check = fn; }, { env }, { existsSync: () => false }, path, RUN, assert);
  assert.equal(await check(), 'нет копии текущих данных');
  env.MOST_TEST_STATUS_SOURCE = path.join(RUN, 'missing-source');
  await assert.rejects(check(), /MOST_TEST_STATUS_SOURCE: папка не существует/);
});
test('О11: oldModule читает фикстуры без git, current читает текущий файл', () => {
  const source = fs.readFileSync(path.join(__dirname, 'team-v21-paths.js')).toString('utf8');
  const body = source.slice(source.indexOf('function oldModule('), source.indexOf('\nasync function patched'));
  const oldModule = new Function('fs', 'path', 'Module', 'module', 'ROOT', '__dirname', 'cp', 'require', body + '\nreturn oldModule;')(fs, path, Module, module, ROOT, __dirname, { execFileSync: () => { throw Error('git вызван'); } }, require);
  for (const name of ['deploy-ops', 'deploy', 'after-deploy', 'team']) assert(oldModule(name));
  assert.equal(typeof oldModule('deploy-ops', {}, true).cleanupLine, 'function');
});
test('О11: побайтная сверка четырёх фикстур с историей', () => {
  const exists = cp.spawnSync('git', ['cat-file', '-e', '97e948f0^{commit}'], { cwd: ROOT, stdio: 'pipe' });
  if (exists.status !== 0) return 'нет истории git';
  for (const name of ['deploy-ops', 'deploy', 'after-deploy', 'team']) {
    const historical = cp.execFileSync('git', ['show', '97e948f0:common/' + name + '.js'], { cwd: ROOT, maxBuffer: 2e6 });
    assert.deepEqual(fs.readFileSync(path.join(__dirname, 'fixtures/release-97e948f0/common', name + '.js.txt')), historical, name);
  }
});

// Часть Б: состояние каждого протокольного опыта изолировано; реальные замки не подменяются.
const hold = require('../common/restart-hold'), locks = require('../common/locks'), restart = require('../common/restart');
const fresh = name => { const root = path.join(RUN, 'b-' + name); fs.mkdirSync(root, { recursive: true }); return root; };
const read = f => JSON.parse(fs.readFileSync(f).toString('utf8').replace(/^\uFEFF/, ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const signal = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const self = () => hold.fingerprint(process.pid);
const serverInfo = (startedAt = new Date().toISOString(), ancestors = []) => ({ startedAt, parent: self(), ancestors, closed: false });
const fixtureProcess = { pid: 717171, startedAt: '2020-01-01T00:00:00.100Z' };
const alive = { fingerprint: pid => pid === fixtureProcess.pid ? fixtureProcess : self() };
const dead = { fingerprint: pid => pid === fixtureProcess.pid ? null : self() };
function pause(state, runId, executor = fixtureProcess) { const h = { id: runId, runId, createdAt: new Date().toISOString(), executor }; json(hold.holdFile(state), h); return h; }
function closing(state, runId, targets = [], proc = fixtureProcess) { const c = { decision: 'закрываю', id: runId, runId, ...proc, publishedAt: new Date().toISOString(), targets }; hold.publish(hold.claimFile(state, runId), c); return c; }
async function unlocked(state) { const l = await locks.tryLock('job_start', 'all', {}, state); assert(l.ok, 'замок не отпущен'); await l.release(); }
test('О1–О2: прямое хранилище, живой/мёртвый/неизвестный владелец, apply.owner и ошибки', async () => {
  const state = fresh('live'), live = require('../common/live-jobs');
  const mine = locks.owner(), gone = { instance: 'dead-' + Date.now(), pid: 999999, startedAt: ago(1) };
  for (const status of ['running', 'cancelling', 'cancel_requested', 'stop_unconfirmed', 'cancelled']) {
    const file = path.join(state, 'codex-jobs/a.json'); json(file, { id: 'abcdefgh-more', status, stopUnconfirmed: status === 'cancelled', owner: mine, folder: 'чужая-папка', from: 'claude', work: 'другая-работа', startedAt: ago(1) });
    const rows = await live.running({ stateDir: state }); assert.equal(rows.length, 1); assert.match(live.describe(rows), /abcdefgh.*чужая-папка.*идёт.*claude.*другая-работа/);
    json(file, { id: 'a', status, stopUnconfirmed: status === 'cancelled', owner: gone }); assert.equal((await live.running({ stateDir: state })).length, 0);
  }
  for (const status of ['queued', 'waiting_quota', 'needs_decision', 'done']) { json(path.join(state, 'codex-jobs/a.json'), { id: 'a', status, owner: mine }); assert.equal((await live.running({ stateDir: state })).length, 0); }
  json(path.join(state, 'jobs/b/card.json'), { id: 'b', status: 'applying', owner: gone, apply: { owner: mine } }); assert.equal((await live.running({ stateDir: state })).length, 1);
  json(path.join(state, 'jobs/b/card.json'), { id: 'b', status: 'applying', owner: mine, apply: { owner: gone } }); assert.equal((await live.running({ stateDir: state })).length, 0);
  for (const owner of [mine, null]) { json(path.join(state, 'jobs/b/card.json'), { id: 'b', status: 'running', owner }); assert.equal((await live.running({ stateDir: state })).length, 1); }
  write(path.join(state, 'jobs/b/card.json'), '{'); await assert.rejects(live.running({ stateDir: state }), /Не удалось проверить поручения/);
});
test('О1–О2: team deploy отказывает до установщика; без перезапуска Р1 не вызывается', async () => {
  const root = fresh('team-deploy'), state = path.join(root, 'state'), t = new Team(root, path.join(state, 'team'));
  json(path.join(state, 'codex-jobs/a.json'), { id: 'foreign-job', status: 'running', owner: locks.owner(), folder: 'чужая-папка', startedAt: ago(1) });
  const deployer = require('../common/deploy'), old = deployer.locked; let calls = 0;
  deployer.locked = async () => { calls++; throw Error('установщик вызван'); };
  try { await assert.rejects(t.changeInner({ action: 'deploy', restart_claude: true }), /не начата.*foreign-.*чужая-папка.*идёт/); assert.equal(calls, 0);
    await assert.rejects(t.changeInner({ action: 'deploy', restart_claude: false }), /установщик вызван/); assert.equal(calls, 1);
  } finally { deployer.locked = old; }
});
test('О2а: внешний deploy проверяет blob, единственное целое объявление, старый релиз и ошибку чтения', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'common/deploy.js')).toString('utf8'), root = fresh('protocol');
  for (const text of ['', 'const RESTART_HOLD_PROTOCOL = 0;', 'module.exports={};', 'const RESTART_HOLD_PROTOCOL = 1;\nconst RESTART_HOLD_PROTOCOL = 2;', 'const RESTART_HOLD_PROTOCOL = 1.5;', null, 'const RESTART_HOLD_PROTOCOL = 1;']) {
    const m = new Module(path.join(ROOT, 'common/deploy.js'), module); m.filename = path.join(ROOT, 'common/deploy.js'); m.paths = module.paths;
    let installed = false, requested;
    m.require = name => name === './team-git' ? { ...require('../common/team-git'), repository() {}, hash: () => 'f'.repeat(40), deployGit: (_, args) => { requested = args; if (text === null) throw Error('read'); return text; } } : name === './deploy-ops' ? { assertIdle() { installed = true; throw Error('дошли до установки'); } } : Module.createRequire(m.filename)(name);
    m._compile(source, m.filename);
    const valid = text === 'const RESTART_HOLD_PROTOCOL = 1;';
    await assert.rejects(m.exports.deploy({ root, external: true, restartClaude: true }), valid ? /дошли до установки/ : /не умеет безопасный перезапуск/);
    assert.equal(installed, valid); assert.deepEqual(requested, ['cat-file', 'blob', 'f'.repeat(40) + ':common/restart-hold.js']);
    await assert.rejects(m.exports.deploy({ root, external: true, restartClaude: false }), /дошли до установки/);
  }
});
test('О2а: самостоятельная история — отсутствующий, неверный и действующий протокол', async () => {
  const root = fresh('protocol-history'), deploy = require('../common/deploy').deploy;
  const git = args => cp.execFileSync('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', '-c', 'user.name=Team test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  git(['init', '-b', 'main']); write(path.join(root, 'README.txt'), 'Самостоятельная история теста.\n');
  const commits = [];
  for (const text of [null, 'const RESTART_HOLD_PROTOCOL = 0;', 'const RESTART_HOLD_PROTOCOL = 1;\nconst RESTART_HOLD_PROTOCOL = 2;', 'const RESTART_HOLD_PROTOCOL = 1.5;', 'const RESTART_HOLD_PROTOCOL = 1;']) {
    if (text !== null) write(path.join(root, 'common/restart-hold.js'), text + '\n');
    git(['add', '.']); git(['commit', '-m', 'Protocol fixture ' + commits.length]);
    commits.push({ commit: git(['rev-parse', 'HEAD']), valid: text === 'const RESTART_HOLD_PROTOCOL = 1;' });
  }
  // Рабочее дерево уже содержит верный протокол: проверяться обязан blob выбранного коммита.
  for (const { commit, valid } of commits) {
    const options = { root, commit, external: true, restartClaude: true, dryRun: true, configs: [] };
    if (valid) assert.match(await deploy(options), /Проверочный режим/);
    else await assert.rejects(deploy(options), /не умеет безопасный перезапуск/);
    assert.match(await deploy({ ...options, restartClaude: false }), /Проверочный режим/);
    assert(!fs.existsSync(path.join(root, 'live'))); assert(!fs.existsSync(path.join(root, 'state')));
  }
});
test('О2а: сверка запрета перезапуска с настоящей базой 6311d885', async () => {
  const exists = cp.spawnSync('git', ['cat-file', '-e', '6311d885^{commit}'], { cwd: ROOT, stdio: 'pipe' });
  if (exists.status !== 0) return 'нет коммита 6311d885 в истории';
  await assert.rejects(require('../common/deploy').deploy({ root: ROOT, commit: '6311d885', external: true, restartClaude: true }), /не умеет безопасный перезапуск/);
});
test('О2б, О6к,м: причины отказа, нечитаемые данные, время нового сервера', async () => {
  const state = fresh('admit'), s = serverInfo(ago(1)); pause(state, 'run');
  const active = hold.admit(state, s, alive); assert.equal(active.kind, 'pause'); assert.match(active.reason, /операция run/);
  const newer = serverInfo(new Date(Date.now() + 1000).toISOString()); assert.equal(hold.admit(state, newer, alive).ok, false);
  closing(state, 'run'); json(hold.claimFile(state, 'run', true), { closedAt: new Date().toISOString() });
  assert.equal(hold.admit(state, s, alive).kind, 'old'); assert.equal(hold.admit(state, newer, alive).ok, true);
  assert.equal(hold.resolved(state, alive), false); assert.equal(hold.resolved(state, dead), true);
  await hold.cleanup(state, dead); assert(!fs.existsSync(hold.holdFile(state))); assert.equal(hold.admit(state, s, dead).kind, 'old');
  assert(!hold.admit(state, s, dead).reason.includes('операция'));
  const other = fresh('parent-unknown'); const unknown = hold.admit(other, newer, { fingerprint: () => { throw Error('access'); } });
  assert.equal(unknown.kind, 'parent'); assert(!unknown.reason.includes('операция'));
  write(hold.holdFile(other), '{'); assert.equal(hold.admit(other, newer).ok, false);
  pause(other, 'bad'); write(hold.claimFile(other, 'bad'), '{'); assert.equal(hold.admit(other, newer).ok, false);
});
test('О6а,ф,х: Р1 и ошибка Р1 отменяют свою паузу; id без операции равен runId', async () => {
  for (const malformed of [false, true]) {
    const root = fresh('r1-' + malformed), state = path.join(root, 'state'), file = path.join(state, 'codex-jobs/a.json');
    write(file, malformed ? '{' : JSON.stringify({ id: 'running', status: 'running', owner: locks.owner() }));
    let launches = 0;
    await assert.rejects(restart.restart({ root, release: root, state }, { launch: async () => launches++ }), /Claude не перезапущен/);
    assert.equal(launches, 0); assert(!fs.existsSync(hold.holdFile(state)));
    const claims = fs.readdirSync(path.join(state, 'restart-claims')); assert.equal(claims.length, 1); assert.equal(read(path.join(state, 'restart-claims', claims[0])).decision, 'отмена');
    json(file, { id: 'fixed', status: 'done' }); assert(hold.admit(state, serverInfo()).ok); await unlocked(state);
  }
  const state = fresh('id'); const h = await hold.begin(state, { runId: 'fallback' }); assert.equal(h.id, h.runId); assert(!hold.warnings(state).join('').includes('undefined')); await hold.abort(state, h);
});
test('О6а: занятый job_start ждут, исчерпание ожидания не создаёт паузы', async () => {
  const state = fresh('busy'), l = await locks.tryLock('job_start', 'all', {}, state); assert(l.ok);
  try { await assert.rejects(hold.begin(state, { runId: 'busy' }, { lockWaitMs: 100 }), /замок запуска поручений занят/); assert(!fs.existsSync(hold.holdFile(state))); }
  finally { await l.release(); }
  const first = await locks.tryLock('job_start', 'all', {}, state), entered = signal(); let acquired = false;
  const waiting = hold.locked(state, () => { acquired = true; entered.resolve(); }); await sleep(100); assert(!acquired); await first.release(); await waiting; assert(acquired); await unlocked(state);
});
test('О6в,г,д,е: исход запуска, гонка отмены, ошибка ожидания и неизменяемая пауза', async () => {
  for (const outcome of ['refused', 'unknown', 'closing']) {
    const root = fresh('launch-' + outcome), state = path.join(root, 'state'); let info;
    await assert.rejects(restart.restart({ root, release: root, state, waitCompletion: true }, { completionMs: 1,
      launch: async (_, i) => { info = i; if (outcome === 'closing') closing(state, i.runId, [], self()); throw Object.assign(Error('исход ' + outcome), { creationRefused: outcome === 'refused' }); }
    }), e => { assert.equal(!!e.restartStarted, outcome === 'closing'); return true; });
    assert.equal(fs.existsSync(hold.holdFile(state)), outcome === 'closing');
    const d = read(hold.claimFile(state, info.runId)); assert.equal(d.decision, outcome === 'closing' ? 'закрываю' : 'отмена');
    if (outcome !== 'closing') assert.equal(hold.publish(hold.claimFile(state, info.runId), { decision: 'закрываю' }), false);
    else { const oldNow = Date.now; Date.now = () => oldNow() + 40 * 60000; try { assert.equal(hold.resolved(state), false); assert.equal(hold.admit(state, serverInfo()).ok, false); } finally { Date.now = oldNow; } }
    await unlocked(state);
  }
});
test('О6е,ж,л,н: умерший исполнитель, отмена наблюдателя, выигравший сценарий и ошибка публикации', async () => {
  const state = fresh('observer'), s = serverInfo(); pause(state, 'dead');
  assert.equal(hold.admit(state, s, { ...dead, early: true }).ok, true); assert(!fs.existsSync(hold.claimFile(state, 'dead')));
  write(hold.claimFile(state, 'ignored') + '.123.tmp', '{'); assert.equal(hold.admit(state, s, dead).ok, true); assert.equal(read(hold.claimFile(state, 'dead')).decision, 'отмена');
  const race = fresh('observer-race'); pause(race, 'race'); const original = fs.linkSync;
  fs.linkSync = (from, to) => { if (to === hold.claimFile(race, 'race')) { fs.linkSync = original; closing(race, 'race', [], self()); const e = Error('exists'); e.code = 'EEXIST'; throw e; } return original(from, to); };
  try { assert.equal(hold.admit(race, s, dead).ok, false); } finally { fs.linkSync = original; }
  const broken = fresh('publish-error'); pause(broken, 'error'); fs.linkSync = () => { throw Error('I/O'); };
  try { assert.equal(hold.admit(broken, s, dead).ok, false); } finally { fs.linkSync = original; }
  assert(!fs.readdirSync(path.join(broken, 'restart-claims')).some(f => f.endsWith('.tmp')));
  const gone = fresh('dead-scenario'); pause(gone, 'gone'); closing(gone, 'gone'); assert(hold.resolved(gone, dead)); assert(!hold.resolved(gone, { fingerprint: () => { throw Error('unknown'); } }));
});
test('О6з,и,о,п: чужая пауза неизменна, уборка под замком, отметки переживают уборку без итога', async () => {
  const state = fresh('cleanup'), h = await hold.begin(state, { runId: 'A' }); const bytes = fs.readFileSync(hold.holdFile(state));
  await assert.rejects(hold.begin(state, { runId: 'B' }), /другой перезапуск.*A/); assert.deepEqual(fs.readFileSync(hold.holdFile(state)), bytes);
  closing(state, 'A'); json(hold.claimFile(state, 'A', true), { closedAt: new Date().toISOString() });
  const old = serverInfo(ago(1)), held = await locks.tryLock('job_start', 'all', {}, state);
  const cleanup = hold.cleanup(state, dead); const next = hold.begin(state, { runId: 'B' }, dead); await sleep(120); assert.deepEqual(fs.readFileSync(hold.holdFile(state)), bytes); await held.release();
  const results = await Promise.allSettled([cleanup, next]); assert.equal(results[1].status, 'fulfilled'); assert.equal(read(hold.holdFile(state)).runId, 'B');
  assert(fs.existsSync(hold.claimFile(state, 'A'))); assert(fs.existsSync(hold.claimFile(state, 'A', true)));
  await hold.abort(state, results[1].value); assert.equal(hold.admit(state, old, dead).kind, 'old'); await unlocked(state);
  assert(!restart.script({ state, runId: 'script', log: 'log', release: 'release' }).includes('restart-hold.json'));
});
test('О6р,у: последняя свежая проверка родителя, PID переиспользован, stdio закрыт', async () => {
  const state = fresh('parent'), s = serverInfo(); assert(hold.admit(state, s).ok);
  assert.equal(hold.admit(state, s, { fingerprint: () => null }).kind, 'old');
  assert.equal(hold.admit(state, s, { fingerprint: () => ({ ...s.parent, startedAt: ago(100) }) }).kind, 'old');
  assert.equal(hold.admit(state, { ...s, closed: true }).kind, 'old');
  pause(state, 'order'); closing(state, 'order'); const calls = [];
  const out = hold.admit(state, s, { fingerprint: pid => { calls.push(pid); return null; } });
  assert.equal(out.kind, 'old'); assert.deepEqual(calls, [fixtureProcess.pid, s.parent.pid]);
});
test('О6ц,ч: обречена вся цепочка и поздний сервер; нечитаемая отметка учитывает только Claude', async () => {
  const state = fresh('doomed'), target = { ...self(), name: 'claude.exe' }, s = serverInfo(new Date(Date.now() + 5000).toISOString(), [{ pid: 12, startedAt: ago(1), name: 'claude.exe' }, target]);
  pause(state, 'doomed'); closing(state, 'doomed', [target]); assert.equal(hold.admit(state, s, dead).kind, 'doomed');
  assert.match(hold.warnings(state, dead).join('\n'), /Claude должен был закрыться/); await hold.cleanup(state, dead);
  assert.equal(hold.admit(state, s, dead).kind, 'doomed'); assert(hold.admit(state, serverInfo(), dead).ok);
  const broken = fresh('bad-closing'), file = hold.claimFile(broken, 'bad'); write(file, '{'); const at = fs.statSync(file).mtimeMs;
  const shell = { ...target, name: 'services.exe', startedAt: new Date(at - 10000).toISOString() };
  assert(hold.admit(broken, serverInfo(undefined, [shell, { ...target, startedAt: new Date(at + 5000).toISOString() }])).ok);
  assert(!hold.admit(broken, serverInfo(undefined, [{ ...target, startedAt: new Date(at - 10000).toISOString() }])).ok);
  json(hold.claimFile(broken, 'bad', true), { closedAt: 'не дата' }); assert(!hold.admit(broken, serverInfo(ago(1))).ok);
  assert(hold.admit(broken, serverInfo(new Date(Date.now() + 5000).toISOString(), [shell])).ok);
});
async function childNode() { const p = cp.spawn(process.execPath, ['-e', 'process.stdin.resume()'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); await new Promise((r,j) => { p.once('spawn', r); p.once('error', j); }); return p; }
async function stopChild(p) { if (p.exitCode === null && p.signalCode === null) { const closed = new Promise(r => p.once('exit', r)); p.stdin.end(); await closed; } }
async function powershell(source, dir) { const file = path.join(dir, 'test-' + require('crypto').randomUUID() + '.ps1'); write(file, Buffer.from('\uFEFF' + source)); return new Promise((resolve, reject) => cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, timeout: 30000 }, (e, out, err) => e ? reject(Error(e.message + err)) : resolve(out))); }
test('О6р: настоящий родитель умер после разрешения; результат жизни не кешируется', async () => {
  const p = await childNode(), state = fresh('real-parent'); let fp;
  try { fp = hold.fingerprint(p.pid); const s = { startedAt: new Date().toISOString(), parent: fp, ancestors: [fp] }; assert(hold.admit(state, s).ok); await stopChild(p); assert.equal(hold.admit(state, s).kind, 'old'); }
  finally { await stopChild(p); }
});
test('О6с: настоящая конкуренция Node linkSync и PowerShell File.Move — один полный победитель', async () => {
  const dir = fresh('atomic');
  for (let i = 0; i < 4; i++) {
    const file = hold.claimFile(dir, 'race-' + i), barrier = path.join(dir, 'go-' + i), ready = path.join(dir, 'ready-' + i), result = path.join(dir, 'ps-' + i);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ps = powershell("$ErrorActionPreference='Stop'\n$f='" + file.replace(/'/g,"''") + "'\n$t=$f+'.'+$PID+'.'+[guid]::NewGuid().ToString('N')+'.tmp'\ntry { [IO.File]::WriteAllText($t,'{\"winner\":\"powershell\",\"complete\":true}'); [IO.File]::WriteAllText('" + ready + "','ready'); while (-not [IO.File]::Exists('" + barrier + "')) { Start-Sleep -Milliseconds 1 }; try { [IO.File]::Move($t,$f); [IO.File]::WriteAllText('" + result + "','won') } catch { [IO.File]::WriteAllText('" + result + "','lost') } } finally { if ([IO.File]::Exists($t)) { [IO.File]::Delete($t) } }", dir);
    while (!fs.existsSync(ready)) await sleep(10); write(barrier, 'go'); if (i % 2) await sleep(2);
    const won = hold.publish(file, { winner: 'node', complete: true }); await ps;
    assert.equal(Number(won) + Number(fs.readFileSync(result).toString() === 'won'), 1); const value = read(file); assert(value.complete); assert.equal(value.winner, won ? 'node' : 'powershell');
    assert(!fs.readdirSync(path.dirname(file)).some(f => f.endsWith('.tmp')));
  }
});
test('О6б,ч: настоящий PowerShell закрывает только targets; новый процесс после снимка остаётся', async () => {
  const dir = fresh('powershell-targets'), target = await childNode(), snap = path.join(dir, 'snapshot'), proceed = path.join(dir, 'proceed'), newcomer = path.join(dir, 'newcomer'); let outsider;
  try {
    // Подмена только перечисления имени Claude. Новый процесс создаётся после снимка targets.
    const prelude = "$ErrorActionPreference='Stop'\nfunction Get-Process { param($Id,$Name,$ErrorAction) if ($Name -eq 'claude') { $ids=@(" + target.pid + "); if ([IO.File]::Exists('" + newcomer + "')) { $ids+= [int][IO.File]::ReadAllText('" + newcomer + "') }; Microsoft.PowerShell.Management\\Get-Process -Id $ids -ErrorAction SilentlyContinue } else { Microsoft.PowerShell.Management\\Get-Process -Id $Id -ErrorAction SilentlyContinue } }\nfunction Start-Sleep { param($Seconds,$Milliseconds) if ($Seconds -eq 8) { [IO.File]::WriteAllText('" + snap + "','snapshot'); while (-not [IO.File]::Exists('" + proceed + "')) { Microsoft.PowerShell.Utility\\Start-Sleep -Milliseconds 5 } }; Microsoft.PowerShell.Utility\\Start-Sleep -Milliseconds 5 }\n";
    const running = powershell(prelude + restart.closingScript({ state: dir, runId: 'ps' }), dir);
    const deadline = Date.now() + 15000; while (!fs.existsSync(snap) && Date.now() < deadline) await sleep(10); assert(fs.existsSync(snap));
    outsider = await childNode(); write(newcomer, String(outsider.pid)); write(proceed, 'go'); await running;
    const c = read(hold.claimFile(dir, 'ps')); assert.equal(c.targets.length, 1); assert.equal(c.targets[0].pid, target.pid); assert.equal(hold.processState(c.targets[0]), 'dead'); assert.equal(hold.processState(hold.fingerprint(outsider.pid)), 'alive'); assert(read(hold.claimFile(dir, 'ps', true)).closedAt);
    assert(!fs.existsSync(hold.holdFile(dir))); assert(!fs.readdirSync(path.join(dir, 'restart-claims')).some(f => f.endsWith('.tmp')));
  } finally { write(proceed, 'go'); await stopChild(target); if (outsider) await stopChild(outsider); }
});
test('Р3: без waitCompletion достаточно подтверждения запуска; итог не требуется', async () => {
  for (const source of ['log', 'claim']) {
    const root = fresh('launch-confirmed-' + source), state = path.join(root, 'state'); let info;
    const out = await restart.restart({ root, release: root, state }, { completionMs: 0, launch: async (_, i) => {
      info = i;
      if (source === 'log') write(i.log, 'запущен ' + i.runId + '\n');
      else { closing(state, i.runId, [], self()); throw Error('ответ Create потерялся'); }
    } });
    assert.match(out, /Перезапуск Claude запланирован/); assert(!fs.existsSync(info.result));
    assert(fs.existsSync(hold.holdFile(state)), 'пауза снимается протоколом, а не возвратом restart');
    assert.equal(fs.existsSync(hold.claimFile(state, info.runId)), source === 'claim');
    if (source === 'log') await hold.abort(state, read(hold.holdFile(state)));
  }
});
test('Р3: финальная проверка запуска при waitMs:0 и записи в последнем интервале', async () => {
  for (const source of ['immediate', 'last-interval']) {
    const root = fresh('launch-final-' + source), state = path.join(root, 'state'); let info, now = 0, sleeps = 0;
    const filename = path.join(ROOT, 'common/restart.js'), m = { exports: {} };
    // Управляем только часами и ожиданием этого модуля: последний интервал всегда пересекает срок.
    require('vm').runInNewContext(fs.readFileSync(filename).toString('utf8'), {
      module: m, require: Module.createRequire(filename), process, Buffer,
      Date: class extends Date { static now() { return now; } },
      setTimeout: (done, ms) => { sleeps++; now += ms; write(info.log, 'запущен ' + info.runId + '\n'); done(); }
    }, { filename });
    const out = await m.exports.restart({ root, release: root, state }, {
      waitMs: source === 'immediate' ? 0 : 50, launch: async (_, i) => {
        info = i; if (source === 'immediate') write(i.log, 'запущен ' + i.runId + '\n');
      }
    });
    assert.match(out, /Перезапуск Claude запланирован/); assert.equal(sleeps, source === 'immediate' ? 0 : 1);
    assert(!fs.existsSync(info.result)); assert(fs.existsSync(hold.holdFile(state)));
    assert(!fs.existsSync(hold.claimFile(state, info.runId)), 'успешный запуск не публикует отмену');
    await hold.abort(state, read(hold.holdFile(state)));
  }
});
test('Р3: ожидание итога различает подтверждённый запуск, отсутствие и чужую строку журнала', async () => {
  for (const source of ['log', 'missing', 'other-run', 'late-log', 'no-wait']) {
    const root = fresh('launch-timeout-' + source), state = path.join(root, 'state'); let info, now = 0;
    const confirmed = source === 'log' || source === 'late-log';
    await assert.rejects(restart.restart({ root, release: root, state, waitCompletion: source !== 'no-wait' }, {
      completionMs: 1, waitMs: 0, now: () => now,
      sleep: async ms => { now += ms; if (source === 'late-log') write(info.log, 'запущен ' + info.runId + '\n'); },
      launch: async (_, i) => {
        info = i;
        if (source === 'log' || source === 'other-run') write(i.log, 'запущен ' + (source === 'log' ? i.runId : 'чужой-запуск') + '\n');
      }
    }), e => {
      assert.match(e.message, confirmed ? /сценарий запущен, закрытие отменено.*Истекло время ожидания итога/ : /запуск сценария не подтверждён/);
      if (!confirmed) assert(!e.message.includes('сценарий запущен, закрытие отменено'));
      if (source !== 'no-wait') assert.match(e.message, /Истекло время ожидания итога/);
      assert(e.restartNotStarted); return true;
    });
    assert(!fs.existsSync(hold.holdFile(state))); assert.equal(read(hold.claimFile(state, info.runId)).decision, 'отмена');
  }
});
test('Р3: запасной режим сообщает о запуске сценария; отказ протокола сохранён', async () => {
  for (const kind of ['restart', 'start', 'refused']) {
    const root = fresh('fallback-message-' + kind), state = path.join(root, 'state');
    const filename = path.join(ROOT, 'common/fallback.js'), m = new Module(filename, module);
    m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
    m.require = name => name === './paths' ? { repoRoot: root, stateDir: state } : Module.createRequire(filename)(name);
    m._compile(fs.readFileSync(filename).toString('utf8'), filename);
    const out = await m.exports.launchDesktop({ evaluate: () => ({ desktopAlive: kind !== 'start' }), restart: async options => {
      assert.equal(options.close, kind !== 'start'); assert(!options.waitCompletion);
      if (kind === 'refused') throw Error('идут поручения');
      return 'Перезапуск Claude запланирован';
    } });
    assert.equal(out, kind === 'restart' ? 'Claude Desktop открыт без серверов связки — перезапускаю его.' :
      kind === 'start' ? 'Открываю Claude Desktop — серверы связки живут в нём.' : 'Claude не перезапущен: идут поручения');
  }
});
test('О6т: close:false не создаёт ни паузы, ни отметок', async () => {
  const root = fresh('start-only'); const out = await restart.restart({ root, release: root, close: false }, { launch: async (_, i) => write(i.log, 'запущен ' + i.runId + '\n') });
  assert.match(out, /Запуск Claude запланирован/); assert(!fs.existsSync(path.join(root, 'state/restart-hold.json'))); assert(!fs.existsSync(path.join(root, 'state/restart-claims')));
  assert(!restart.script({ runId: 'start', state: root, release: root, log: 'log', close: false }).includes('Publish-Claim'));
});

// Настоящие обработчики без stdio-цикла; подменены исполнитель модели и снимок предков.
function executorHarness(who) {
  process.env.AGY_PATH = path.join(__dirname, 'fake-agy.js');
  const filename = path.join(ROOT, 'servers', who, 'index.js'), m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const source = fs.readFileSync(filename).toString('utf8'), end = source.lastIndexOf('(async () => {'); assert(end > 0);
  const tail = who === 'codex' ? `
execute = async (j, l) => { if (l) await l.release(); };
module.exports = { send, queue, list, load, setServer: value => { restartServer = value; } };
` : `
instancePipeOk = true;
resolveModel = async () => ({ id: 'test', name: 'Test', family: 'google' });
runJob = (j, args, input, folder, l) => { l.release(); };
module.exports = { send: a => context.run({ args: a }, () => HANDLERS.most_poruchit(a)), apply: (a,o) => context.run({ args:a }, () => HANDLERS.most_perenesti(a,o)), queue: resumeQueue, list: listJobs, load: loadJob, setServer: value => { restartServer = value; } };
`;
  m._compile(source.slice(0, end) + tail, filename); m.exports.setServer(serverInfo()); return m.exports;
}
async function clearJobs(h, who) {
  for (const j of h.list()) json(who === 'codex' ? path.join(RUN, 'state/codex-jobs', j.id + '.json') : path.join(RUN, 'state/jobs', j.id, 'card.json'), { ...j, status: 'done', applyRequest: null });
}
test('Р3: Codex без стартового цикла снимает снимок под job_start перед send и queue', async () => {
  const state = path.join(RUN, 'state'), originalServer = hold.server, originalLocked = hold.locked;
  let underLock = false;
  hold.locked = (dir, fn, deps) => originalLocked(dir, async () => { underLock = true; try { return await fn(); } finally { underLock = false; } }, deps);
  try { for (const route of ['send', 'queue']) for (const outcome of ['ok', 'unknown', 'pause']) {
    const h = executorHarness('codex'); h.setServer(undefined); await clearJobs(h, 'codex');
    let captures = 0; const snapshot = serverInfo();
    if (outcome === 'unknown') Object.assign(snapshot, { error: 'CIM недоступен', captureAttemptAt: Date.now() });
    hold.server = (dir, name) => { assert(underLock); assert.equal(dir, state); assert.equal(name, 'codex'); captures++; return snapshot; };
    const id = 'init-' + route + '-' + outcome, folder = fresh(id);
    const pending = outcome === 'pause' ? pause(state, id, self()) : null;
    if (route === 'send') {
      const action = h.send({ folder, task: 'тест', write: false });
      if (outcome === 'ok') await action; else await assert.rejects(action, e => e.restartHold && e.kind === (outcome === 'pause' ? 'pause' : 'parent'));
    } else {
      json(path.join(state, 'codex-jobs', id + '.json'), { id, folder, write: false, from: 'claude', status: 'queued', task: 'тест', startedAt: ago(1) });
      await h.queue(); assert.equal(h.load(id).status, outcome === 'ok' ? 'running' : 'queued');
    }
    assert.equal(captures, 1); if (pending) await hold.abort(state, pending); await clearJobs(h, 'codex'); await unlocked(state);
  } } finally { hold.server = originalServer; hold.locked = originalLocked; }
});
test('Р3: прежние отказы аргументов и карточки раньше раннего допуска; пустое состояние читается', async () => {
  const h = executorHarness('codex'), state = path.join(RUN, 'state'), folder = fresh('validation-order');
  const p = pause(state, 'validation-order', self());
  try {
    await assert.rejects(h.send({ folder, task: 'тест', write: false, model: 'bad model' }), /Недопустимая модель/);
    json(path.join(state, 'codex-jobs/validation-prior.json'), { id: 'validation-prior', folder, write: true, from: 'claude', status: 'done', threadId: 'thread-validation' });
    await assert.rejects(h.send({ folder, task: 'тест', write: false, continue_id: 'validation-prior' }), /Сохраните папку, режим записи и доступ/);
    await assert.rejects(h.send({ folder, task: 'тест', write: false }), /Идёт перезапуск/);
  } finally { await hold.abort(state, p); }
  const absent = path.join(fresh('absent-state'), 'missing'), snapshot = serverInfo();
  assert(!fs.existsSync(absent)); assert(hold.admit(absent, snapshot).ok);
  write(path.join(absent, 'unrelated.json'), '{'); write(path.join(absent, 'restart-claims/note.txt'), '{');
  assert(hold.admit(absent, snapshot).ok);
});
test('О3: Codex send и продолжение — обе стороны гонки с задержкой более трёх секунд', async () => {
  const h = executorHarness('codex'), state = path.join(RUN, 'state'), gate = require('../common/stage-gate'), originalPrepare = gate.prepareJob, originalLocked = hold.locked;
  try { for (const continuation of [false, true]) {
    const folder = fresh('codex-send-' + continuation), prior = 'prior-' + continuation;
    if (continuation) json(path.join(state, 'codex-jobs', prior + '.json'), { id: prior, status: 'done', threadId: 'thread', folder, write: true, from: 'claude' });
    const args = { folder, task: 'тест', write: true, ...(continuation ? { continue_id: prior } : {}) };
    const entered = signal(), release = signal(); gate.prepareJob = async () => { entered.resolve(); await release.promise; };
    const sending = h.send(args), rejected = assert.rejects(sending, /Идёт перезапуск Claude/);
    await entered.promise; await sleep(3100); const pause = await hold.begin(state, { runId: 'send-' + continuation }); release.resolve(); await rejected;
    assert(!h.list().some(j => j.folder === folder && j.status === 'running')); await hold.abort(state, pause); await unlocked(state);
    for (const [kind, key] of [['codex_folder', require('../common/paths').canon(folder)], ['codex_queue', prior]]) { const l = await locks.tryLock(kind, key, {}, state); assert(l.ok); await l.release(); }
    gate.prepareJob = async () => {};
    const inside = signal(), finish = signal(); hold.locked = (st, fn, deps) => originalLocked(st, async () => { inside.resolve(); await finish.promise; return fn(); }, deps);
    const first = h.send(args); await inside.promise; hold.locked = originalLocked;
    let launched = false; const second = restart.restart({ root: RUN, state, release: ROOT }, { launch: async () => { launched = true; } }), denied = assert.rejects(second, /идут поручения/);
    await sleep(100); finish.resolve(); await first; await denied; assert(!launched); await clearJobs(h, 'codex'); await unlocked(state);
  } } finally { gate.prepareJob = originalPrepare; hold.locked = originalLocked; }
});
test('О4: очередь Codex оставляет queued/waiting_quota; отмена и поколение после закрыто', async () => {
  const h = executorHarness('codex'), state = path.join(RUN, 'state'), s = serverInfo(); h.setServer(s);
  for (const status of ['queued', 'waiting_quota']) {
    const id = 'queue-' + status, file = path.join(state, 'codex-jobs', id + '.json');
    json(file, { id, status, folder: RUN, write: false, from: 'claude', owner: locks.owner(), nextAttemptAt: ago(1), startedAt: ago(1), retryKind: 'quota' });
    const p = await hold.begin(state, { runId: id }); await h.queue(); assert.equal(read(file).status, status); await hold.abort(state, p); await h.queue(); assert.equal(read(file).status, 'running'); await clearJobs(h, 'codex');
  }
  const id = 'closed-queued', file = path.join(state, 'codex-jobs', id + '.json'); json(file, { id, status: 'queued', folder: RUN, write: false, from: 'claude' });
  const closedAt = new Date().toISOString(); json(hold.claimFile(state, 'queue-closed', true), { closedAt });
  await h.queue(); assert.equal(read(file).status, 'queued'); h.setServer(serverInfo(new Date(Date.parse(closedAt) + 1).toISOString())); await h.queue(); assert.equal(read(file).status, 'running'); await clearJobs(h, 'codex'); await unlocked(state);
});
test('О5: Antigravity send и перенос отказывают после ранней проверки; очередь переноса не done', async () => {
  const h = executorHarness('antigravity'), state = path.join(RUN, 'state'), gate = require('../common/stage-gate'), originalPrepare = gate.prepareJob;
  const entered = signal(), release = signal(); gate.prepareJob = async () => { entered.resolve(); await release.promise; };
  try {
    const folder = fresh('agy-send'), sending = h.send({ papka_proekta: folder, poruchenie: 'текст', task: 'текст', rezhim: 'tekst' });
    await entered.promise; const p = await hold.begin(state, { runId: 'agy-send' }); release.resolve(); const out = await sending;
    assert(out.isError); assert.match(out.content[0].text, /Идёт перезапуск/); assert(!h.list().some(j => j.papka === folder && j.status === 'running'));
    await hold.abort(state, p); const gen = await locks.tryLock('gen', require('../common/paths').canon(folder), {}, state); assert(gen.ok); await gen.release();
  } finally { gate.prepareJob = originalPrepare; }
  const folder = fresh('agy-apply'), target = path.join(folder, 'output.txt'), id = 'apply-test', file = path.join(state, 'jobs', id, 'card.json');
  json(file, { id, status: 'done', papka: folder, draftPath: path.join(folder, '_draft.txt'), rezhim: 'tekst', from: 'claude', startedAt: ago(1) }); write(path.join(path.dirname(file), 'result.txt'), 'готовый результат');
  const targetLock = await locks.tryLock('apply', require('../common/paths').canonMaybe(target), {}, state);
  assert(targetLock.ok); const sending = h.apply({ nomer: id, kuda: target }); await sleep(100);
  const p = await hold.begin(state, { runId: 'apply' }); await targetLock.release(); const out = await sending; assert(out.isError); assert.equal(read(file).status, 'done'); assert(!fs.existsSync(target));
  json(file, { ...read(file), applyRequest: { kuda: target, word: 'test-word', at: new Date().toISOString() } });
  const word = require('../common/user-word'), original = word.mode; word.mode = () => ({ active: true, entry: { id: 'test-word' } });
  try { await h.queue(); assert(!read(file).applyRequest.done); await hold.abort(state, p); await h.queue(); assert(read(file).applyRequest.done); assert.equal(read(file).status, 'applied'); assert.equal(fs.readFileSync(target).toString(), 'готовый результат'); }
  finally { word.mode = original; }
  await unlocked(state); const l = await locks.tryLock('apply', require('../common/paths').canonMaybe(target), {}, state); assert(l.ok); await l.release(); await clearJobs(h, 'antigravity');
});
test('О4–О5: очередь Antigravity — гостевые queued, квота и transient без потери карточки', async () => {
  const h = executorHarness('antigravity'), state = path.join(RUN, 'state');
  for (const [status, retryKind] of [['queued', null], ['waiting_quota', 'quota'], ['waiting_quota', 'transient']]) {
    const id = 'agy-queue-' + (retryKind || 'guest'), folder = fresh(id), file = path.join(state, 'jobs', id, 'card.json');
    json(file, { id, status, retryKind, papka: folder, papkaCanon: require('../common/paths').canon(folder), from: 'codex', owner: locks.owner(), startedAt: ago(1), nextAttemptAt: ago(1), retry: { args: [] } });
    const p = await hold.begin(state, { runId: id }); await h.queue(); assert.equal(read(file).status, status); await hold.abort(state, p); await h.queue(); assert.equal(read(file).status, 'running');
    if (retryKind) assert.equal(read(file)[retryKind === 'quota' ? 'quotaAttempts' : 'transientAttempts'], 1);
    await clearJobs(h, 'antigravity'); await unlocked(state);
  }
});
test('О6т: все входы закрытия проходят протокол, включая CLI без --result и запасной режим', async () => {
  const deploy = require('../common/deploy'), saved = Object.fromEntries(['MOST_CODEX_CONFIG', 'MOST_AGY_MCP_CONFIG', 'MOST_AGY_CONFIG'].map(k => [k, process.env[k]]));
  try { for (const route of ['configure', 'configureClients', 'cli-config', 'cli-clients', 'deploy']) for (const late of [false, true]) {
    const root = fresh('entry-' + route + '-' + late), state = path.join(root, 'state'), id = 'a'.repeat(40), release = path.join(root, 'live', id), config = path.join(root, 'claude.json');
    for (const name of require('../common/members').servers) write(path.join(release, 'servers', name, 'index.js'), '');
    write(path.join(release, 'common/access.js'), fs.readFileSync(path.join(ROOT, 'common/access.js')));
    json(path.join(release, 'probe-ok.json'), { root, commit: id, at: new Date().toISOString(), servers: ['antigravity', 'codex', 'team'] }); json(config, {});
    process.env.MOST_CODEX_CONFIG = path.join(root, 'codex.toml'); write(process.env.MOST_CODEX_CONFIG, ''); process.env.MOST_AGY_MCP_CONFIG = path.join(root, 'agy.json'); json(process.env.MOST_AGY_MCP_CONFIG, {}); process.env.MOST_AGY_CONFIG = path.join(root, 'permissions.json'); json(process.env.MOST_AGY_CONFIG, {});
    const addJob = () => json(path.join(state, 'codex-jobs/a.json'), { id: 'foreign', status: 'running', owner: locks.owner(), folder: root });
    if (!late) addJob(); let launched = false;
    const deps = { probe: async () => {}, rules: { files: [] }, hook: async phase => { if (late && /^config\d+$/.test(phase)) addJob(); }, restart: { launch: async () => { launched = true; throw Error('закрытие недопустимо'); } } };
    let action;
    if (route === 'configure') action = () => deploy.configure({ release, configs: [config], restartClaude: true }, deps);
    if (route === 'configureClients') action = () => deploy.configureClients({ release, restartClaude: true }, deps);
    if (route.startsWith('cli-')) action = () => require('../tools/deploy').main([route === 'cli-config' ? '--config-only' : '--clients-only', '--release', release, ...(route === 'cli-config' ? ['--config', config] : []), '--restart-claude'], { configure: o => deploy.configure(o, deps), configureClients: o => deploy.configureClients(o, deps), print() {} });
    if (route === 'deploy') {
      const filename = path.join(ROOT, 'common/deploy.js'), m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
      m.require = name => name === './team-git' ? { ...require('../common/team-git'), repository() {}, hash: () => id } : Module.createRequire(filename)(name);
      m._compile(fs.readFileSync(filename).toString('utf8'), filename); action = () => m.exports.deploy({ root, configs: [config], restartClaude: true }, deps);
    }
    await assert.rejects(action(), /идут поручения/); assert(!launched, route); assert(!fs.existsSync(hold.holdFile(state))); await unlocked(state);
  } } finally { for (const [k,v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v; }
  const state = path.join(RUN, 'state'), file = path.join(state, 'codex-jobs/fallback-live.json'); json(file, { id: 'fallback-live', status: 'running', owner: locks.owner() });
  const result = await require('../common/fallback').launchDesktop({ evaluate: () => ({ desktopAlive: true }), restartDeps: { launch: async () => { throw Error('не должен закрывать'); } } });
  assert.match(result, /Claude не перезапущен.*идут поручения/); json(file, { id: 'fallback-live', status: 'done' }); assert(!fs.existsSync(hold.holdFile(state)));
});
test('О6г,д,л: живой PowerShell до и после публикации — отмена и ожидание имеют одного победителя', async () => {
  for (const first of ['node', 'powershell']) {
    const root = fresh('real-race-' + first), state = path.join(root, 'state'), ready = path.join(root, 'ready'), go = path.join(root, 'go'), stop = path.join(root, 'stop'); let child, ended, info;
    try {
      const action = restart.restart({ root, release: root, state, waitCompletion: true }, { completionMs: 50,
        launch: async (_, i) => {
          info = i;
          const body = "$ErrorActionPreference='Stop'\nfunction Get-Process { param($Id,$Name,$ErrorAction) if ($Name -eq 'claude') { return @() } else { Microsoft.PowerShell.Management\\Get-Process -Id $Id -ErrorAction SilentlyContinue } }\nfunction Start-Sleep { param($Seconds,$Milliseconds) Microsoft.PowerShell.Utility\\Start-Sleep -Milliseconds 5 }\n[IO.File]::WriteAllText('" + ready + "','ready')\nwhile (-not [IO.File]::Exists('" + go + "')) { Microsoft.PowerShell.Utility\\Start-Sleep -Milliseconds 5 }\n" + restart.closingScript({ state, runId: i.runId }) + "\nwhile (-not [IO.File]::Exists('" + stop + "')) { Microsoft.PowerShell.Utility\\Start-Sleep -Milliseconds 5 }";
          const file = path.join(root, 'scenario.ps1'); write(file, Buffer.from('\uFEFF' + body));
          child = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.resume(); child.stderr.resume(); ended = new Promise(r => child.once('exit', r));
          const deadline = Date.now() + 15000; while (!fs.existsSync(ready) && Date.now() < deadline) await sleep(10); assert(fs.existsSync(ready));
          if (first === 'powershell') { write(go, 'go'); while (!fs.existsSync(hold.claimFile(state, i.runId)) && Date.now() < deadline) await sleep(10); assert(fs.existsSync(hold.claimFile(state, i.runId))); }
          throw Error('неизвестный исход создания процесса');
        } });
      await assert.rejects(action, e => { assert.equal(!!e.restartStarted, first === 'powershell'); return true; });
      if (first === 'node') write(go, 'go');
      assert.equal(read(hold.claimFile(state, info.runId)).decision, first === 'node' ? 'отмена' : 'закрываю');
      if (first === 'powershell') { assert.equal(hold.resolved(state), false); assert(!hold.admit(state, serverInfo(ago(1))).ok); }
    } finally { write(go, 'go'); write(stop, 'stop'); if (ended) await ended; }
    await hold.cleanup(state); assert(!fs.existsSync(hold.holdFile(state))); await unlocked(state);
  }
});
test('Р3, О6ч: сервер записывает всю цепочку; ошибка снимка — журнал и обязательная строка', () => {
  const now = new Date().toISOString(), rows = [{ pid: process.pid, ppid: 222, startedAt: now, name: 'node.exe' }, { pid: 222, ppid: 333, startedAt: ago(1), name: 'claude.exe' }, { pid: 333, ppid: 444, startedAt: ago(2), name: 'claude.exe' }, { pid: 444, ppid: 0, startedAt: ago(3), name: 'services.exe' }];
  const state = fresh('capture'), server = hold.server(state, 'test', { processTable: () => rows });
  assert.deepEqual(server.ancestors.map(p => p.pid), [222, 333, 444]); assert.equal(server.parent.pid, 222); assert(!server.error);
  assert.deepEqual(read(path.join(state, 'restart-servers', process.pid + '.json')).ancestors, server.ancestors);
  const failed = hold.server(state, 'test', { processTable: () => { throw Error('снимок недоступен'); } }); assert(failed.error);
  assert.equal(hold.admit(state, failed).kind, 'parent'); assert.match(hold.warnings(state).join('\n'), /Не удалось проверить цепочку предков сервера test/);
});
for (const variant of ['missing-ancestor', 'doomed', 'reused-ancestor', 'missing-parent', 'reused-parent']) test('Р3: конец цепочки предков — ' + variant, async () => {
  const state = fresh('chain-' + variant), rows = [
    { pid: process.pid, ppid: 222, startedAt: '2026-10-18T10:00:00.000Z', name: 'node.exe' },
    { pid: 222, ppid: 10068, startedAt: '2026-10-18T09:00:00.000Z', name: 'claude.exe' },
    { pid: 10068, ppid: 9996, startedAt: '2026-10-13T14:23:49.000Z', name: 'explorer.exe' }];
  if (variant === 'reused-ancestor') rows.push({ pid: 9996, ppid: 1, startedAt: '2026-10-18T08:00:00.000Z', name: 'another.exe' });
  if (variant === 'missing-parent') rows.splice(1, 1);
  if (variant === 'reused-parent') rows[1].startedAt = '2026-10-18T11:00:00.000Z';
  const deps = { processTable: () => rows, fingerprint: pid => rows.find(p => p.pid === pid) || null };
  const server = hold.server(state, 'chain-test', deps), orphan = variant.endsWith('-parent');
  assert(!server.error); assert.equal(server.ended, orphan ? 'broken' : 'root'); assert.deepEqual(server.ancestors.map(p => p.pid), orphan ? [] : [222, 10068]);
  assert.equal(server.parent?.pid || null, orphan ? null : 222);
  assert.equal(read(path.join(state, 'restart-servers', process.pid + '.json')).parent?.pid || null, orphan ? null : 222);
  assert.equal(read(path.join(state, 'restart-servers', process.pid + '.json')).ended, server.ended);
  if (variant === 'doomed') closing(state, 'chain-target', [rows[1]]);
  await hold.locked(state, () => {
    const out = hold.admit(state, server, deps);
    assert.equal(out.ok ? 'ok' : out.kind, orphan ? 'old' : variant === 'doomed' ? 'doomed' : 'ok');
    if (orphan) assert.match(out.reason, /остался от закрытого Claude/);
    else if (variant !== 'doomed') assert.equal(hold.admit(state, server, { fingerprint: () => null }).kind, 'old', 'жизнь родителя должна проверяться свежим запросом');
  });
});
for (const reused of [false, true]) test('Р3: оборванная цепочка ниже Claude — ' + (reused ? 'PID launcher переиспользован' : 'launcher завершился'), async () => {
  const wrapper = { pid: 222, ppid: 333, startedAt: ago(2), name: 'wrapper.exe' };
  const target = { pid: 444, ppid: 0, startedAt: ago(4), name: 'claude.exe' };
  const rows = [{ pid: process.pid, ppid: wrapper.pid, startedAt: ago(1), name: 'node.exe' }, wrapper, target];
  if (reused) rows.push({ pid: 333, ppid: 444, startedAt: ago(1), name: 'other.exe' });
  const server = hold.capture({ processTable: () => rows });
  assert.equal(server.ended, 'broken'); assert(!server.error); assert.deepEqual(server.ancestors.map(p => p.pid), [222]);
  for (const variant of ['none', 'live', 'dead', 'reused-target', 'closed', 'unknown-table', 'empty-table', 'unknown-time', 'unreadable', 'unreadable-closed', 'other-closed']) {
    const state = fresh('broken-' + reused + '-' + variant); let reads = 0;
    if (variant !== 'none') {
      // Несколько отметок проверяются по одной таблице; первые две цели мертвы.
      closing(state, 'a-dead', [{ ...target, pid: 555 }]); closing(state, 'b-dead', [{ ...target, pid: 556 }]);
      closing(state, 'c-claim', [target]);
      if (variant.startsWith('unreadable')) write(hold.claimFile(state, 'c-claim'), '{');
      if (variant.endsWith('closed')) json(hold.claimFile(state, variant === 'other-closed' ? 'another-run' : 'c-claim', true), { closedAt: ago(1) });
    }
    const deps = { fingerprint: pid => { assert.equal(pid, wrapper.pid, 'цель проверяется отдельным запросом'); return wrapper; }, processTable: () => {
      reads++; if (variant === 'unknown-table') throw Error('таблица недоступна');
      if (variant === 'empty-table') return [];
      return variant === 'dead' ? rows.filter(p => p.pid !== target.pid) : rows.map(p => p.pid !== target.pid ? p :
        variant === 'unknown-time' ? { ...p, startedAt: null } : variant === 'reused-target' ? { ...p, startedAt: ago(0) } : p);
    } };
    await hold.locked(state, () => {
      const out = hold.admit(state, server, deps), denied = ['live', 'unknown-table', 'empty-table', 'unknown-time', 'unreadable', 'other-closed'].includes(variant);
      assert.equal(out.ok ? 'ok' : out.kind, denied ? 'parent' : 'ok', variant);
      if (denied) assert.match(out.reason, /Не удалось проверить, что Claude этого сервера работает/);
    });
    assert.equal(reads, variant === 'none' ? 0 : 1, variant + ': таблица снимается один раз');
    if (variant === 'dead') {
      await hold.locked(state, () => assert.equal(hold.admit(state, server, { ...deps, processTable: () => { reads++; return rows; } }).kind, 'parent'));
      assert.equal(reads, 2, 'снимок не должен переживать вызов admit');
    }
  }
});
test('Р3: root без Claude и закрытая отметка не требуют дорогой проверки целей', async () => {
  const target = { pid: 444, startedAt: ago(4), name: 'claude.exe' };
  for (const rootPid of [0, 4]) {
    const state = fresh('root-' + rootPid), parent = { pid: 222, ppid: rootPid, startedAt: ago(2), name: 'wrapper.exe' };
    const server = hold.capture({ processTable: () => [{ pid: process.pid, ppid: 222, startedAt: ago(1) }, parent,
      ...(rootPid === 4 ? [{ pid: 4, ppid: 0, startedAt: null, name: 'System' }] : [])] });
    assert.equal(server.ended, 'root'); closing(state, 'root-target', [target]);
    const deps = { fingerprint: () => parent, processTable: () => { throw Error('лишняя таблица'); } };
    await hold.locked(state, () => assert(hold.admit(state, server, deps).ok));
    server.ended = 'broken'; json(hold.claimFile(state, 'root-target', true), { closedAt: ago(1) });
    await hold.locked(state, () => assert(hold.admit(state, server, deps).ok));
  }
});
test('Р3: нет сервера или не читается время в таблице — ошибка снимка и отказ parent', async () => {
  const state = fresh('missing-server');
  for (const rows of [[], [{ pid: process.pid, ppid: 222, startedAt: ago(0) },
    { pid: 222, ppid: 333, startedAt: ago(1) }, { pid: 333, ppid: 0, startedAt: null }]]) {
    const server = hold.capture({ processTable: () => rows });
    assert.match(server.error, /Нет процесса сервера|Не прочитано время запуска в таблице/);
    await hold.locked(state, () => assert.equal(hold.admit(state, server).kind, 'parent'));
  }
});
for (const expected of ['ok', 'doomed', 'old']) test('Р3: повтор снимка через 10 с — ' + expected, async () => {
  const state = fresh('recapture-' + expected), start = '2026-01-01T00:00:00.000Z';
  const rows = [{ pid: process.pid, ppid: 222, startedAt: start, name: 'node.exe' },
    { pid: 222, ppid: 333, startedAt: '2025-01-01T00:00:00.000Z', name: 'node.exe' },
    { pid: 333, ppid: 0, startedAt: '2024-01-01T00:00:00.000Z', name: 'claude.exe' }];
  let now = 0, attempts = 0, available = false, underLock = false;
  const deps = { now: () => now, serverStartedAt: start, fingerprint: pid => rows.find(p => p.pid === pid) || null,
    processTable: () => { attempts++; if (attempts > 1) assert(underLock, 'повтор вне job_start'); if (!available) throw Error('временный сбой CIM'); return rows; } };
  const server = hold.server(state, 'recapture-test', deps), file = path.join(state, 'restart-servers', process.pid + '.json');
  const before = fs.readFileSync(file);
  const decisive = () => hold.locked(state, async () => {
    const busy = await locks.tryLock('job_start', 'all', {}, state);
    if (busy.ok) await busy.release(); assert.equal(busy.ok, false, 'job_start не занят');
    underLock = true; try { return hold.admit(state, server, deps); } finally { underLock = false; }
  });
  assert.equal((await decisive()).kind, 'parent'); assert.equal(attempts, 1);
  available = true; now = 9999;
  assert.equal(hold.admit(state, server, { ...deps, early: true }).kind, 'parent');
  assert.equal((await decisive()).kind, 'parent'); assert.equal(attempts, 1);
  now = 10000;
  if (expected === 'doomed') closing(state, 'recaptured-target', [rows[2]]);
  assert(hold.admit(state, server, { ...deps, early: true }).ok); assert.equal(attempts, 1);
  assert.deepEqual(fs.readFileSync(file), before, 'ранняя проверка переписала снимок');
  if (expected === 'old') server.closed = true;
  const out = await decisive(); assert.equal(out.ok ? 'ok' : out.kind, expected); assert.equal(attempts, 2);
  assert(!server.error); assert.equal(server.startedAt, start); assert.equal(server.closed, expected === 'old');
  const saved = read(file); assert(!saved.error); assert.equal(saved.name, 'recapture-test');
  assert.equal(saved.startedAt, start); assert.deepEqual(saved.ancestors, server.ancestors);
  assert.deepEqual(server.ancestors.map(p => p.pid), [222, 333]);
  assert(!hold.warnings(state, deps).some(line => line.includes('Не удалось проверить цепочку')));
  now += 10000; await decisive(); assert.equal(attempts, 2, 'исправный снимок снят повторно');
});
test('Р3: неудачный повтор снимка сохраняет отказ parent и интервал 10 с', async () => {
  const state = fresh('recapture-failed'); let now = 0, attempts = 0;
  const deps = { now: () => now, fingerprint: () => fixtureProcess,
    processTable: () => { attempts++; throw Error('CIM недоступен'); } };
  const server = hold.server(state, 'failed-retry', deps);
  for (const [at, count] of [[0, 1], [9999, 1], [10000, 2], [10001, 2], [19999, 2], [20000, 3]]) {
    now = at; await hold.locked(state, () => assert.equal(hold.admit(state, server, deps).kind, 'parent'));
    assert.equal(attempts, count); assert(server.error);
  }
});
test('О6в: настоящий разбор Win32_Process.Create отличает код отказа от неизвестного исхода', async () => {
  const original = cp.execFile;
  try { for (const known of [true, false]) {
    const root = fresh('cim-return-' + known), state = path.join(root, 'state');
    cp.execFile = (exe, args, options, callback) => { assert.equal(exe, 'powershell.exe'); assert.match(args.at(-1), /Invoke-CimMethod.*Win32_Process/); assert(options.windowsHide); callback(known ? null : Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }), known ? 'CREATE_RETURN=5\r\n' : ''); };
    await assert.rejects(restart.restart({ root, release: root, state }), e => { assert.equal(!!e.creationRefused, known); assert(e.restartNotStarted); return true; });
    assert(!fs.existsSync(hold.holdFile(state))); await unlocked(state);
  } } finally { cp.execFile = original; }
});
test('О6е,ж,и: настоящий процесс сценария завершён до решения и после закрываю без файла итога', async () => {
  for (const published of [false, true]) {
    const state = fresh('dead-real-' + published), p = await childNode();
    try {
      const fp = hold.fingerprint(p.pid); pause(state, 'scenario', published ? self() : fp);
      if (published) closing(state, 'scenario', [], fp);
      assert.equal(hold.resolved(state), false); await stopChild(p);
      await hold.locked(state, () => assert(hold.admit(state, serverInfo()).ok));
      assert(hold.resolved(state)); await hold.cleanup(state); assert(!fs.existsSync(hold.holdFile(state)));
      assert.equal(read(hold.claimFile(state, 'scenario')).decision, published ? 'закрываю' : 'отмена');
    } finally { await stopChild(p); }
  }
});
test('О6п: задержанный настоящий send после закрыто и уборки старому поколению отказан', async () => {
  const h = executorHarness('codex'), state = path.join(RUN, 'state'), folder = fresh('old-handler'), gate = require('../common/stage-gate'), original = gate.prepareJob;
  const entered = signal(), release = signal(); gate.prepareJob = async () => { entered.resolve(); await release.promise; };
  try {
    const sending = h.send({ folder, task: 'тест', write: false }), denied = assert.rejects(sending, /остался от закрытого Claude/); await entered.promise;
    const p = await hold.begin(state, { runId: 'old-handler' }); closing(state, p.runId); json(hold.claimFile(state, p.runId, true), { closedAt: new Date().toISOString() });
    await hold.cleanup(state, dead); release.resolve(); await denied; assert(!h.list().some(j => j.folder === folder && j.status === 'running')); await unlocked(state);
  } finally { release.resolve(); gate.prepareJob = original; }
});
test('О6а: настоящий job_start занят дольше штатных 30 секунд — сценарий не запускается', async () => {
  const root = fresh('lock-30-seconds'), state = path.join(root, 'state'), l = await locks.tryLock('job_start', 'all', {}, state); assert(l.ok);
  let launched = false; const started = Date.now();
  try {
    await assert.rejects(restart.restart({ root, release: root, state }, { launch: async () => { launched = true; } }), /замок запуска поручений занят/);
    assert(Date.now() - started >= 30000); assert(!launched); assert(!fs.existsSync(hold.holdFile(state)));
  } finally { await l.release(); }
  await unlocked(state);
});
test('О6у: настоящий родитель закрыт между проверкой умершего сценария и последним допуском', async () => {
  const state = fresh('last-parent'), parent = await childNode();
  try {
    const fp = hold.fingerprint(parent.pid), server = { startedAt: new Date().toISOString(), parent: fp, ancestors: [fp] }; pause(state, 'last'); closing(state, 'last');
    await hold.locked(state, () => {
      const out = hold.admit(state, server, { fingerprint: pid => {
        if (pid === fixtureProcess.pid) { cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Stop-Process -Id ' + parent.pid + ' -Force -ErrorAction Stop'], { windowsHide: true, stdio: 'pipe' }); return null; }
        return hold.fingerprint(pid);
      } });
      if (out.ok) json(path.join(state, 'running.json'), { status: 'running' });
      assert.equal(out.kind, 'old'); assert(!fs.existsSync(path.join(state, 'running.json')));
    });
  } finally { await stopChild(parent); }
  await unlocked(state);
});
(async () => {
  let passed = 0, failed = 0, skipped = 0;
  for (const [name, fn] of tests) try { const reason = await fn(); if (reason) { skipped++; console.log('ПРОПУЩЕНО: ' + name + ' — ' + reason); } else { passed++; console.log('ПРОЙДЕНО: ' + name); } }
  catch (e) { failed++; console.error('ПРОВАЛЕНО: ' + name + '\n' + e.stack); }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено ' + skipped); process.exitCode = failed ? 1 : 0;
})();
