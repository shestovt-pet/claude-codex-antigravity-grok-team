'use strict';
// team-v60: краткая team_status на живом состоянии — за секунды.
//  (а) краткая сводка НЕ вызывает refreshWork/stage-gate и НЕ запускает powershell на каждый PID (один снимок таблицы
//      процессов на запрос); full — переоценку этапов делает;
//  (б) send codex/deepseek/kimi без role и folder принимается как «совет» в служебной папке; antigravity text без folder
//      принимается.
process.env.NODE_ENV = 'test';
const fs = require('fs'), path = require('path'), os = require('os');
const assert = require('assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { serverReady } = require('./runner-support');

const ROOT = path.resolve(__dirname, '..');
const RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v60status-'));
const STATE = path.join(RUN, 'state');
fs.mkdirSync(STATE, { recursive: true });
Object.assign(process.env, {
  MOST_REPO_ROOT: RUN, MOST_STATE_DIR: STATE, MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off',
  MOST_TEST_KEEP: '1', MOST_CLAUDE_CONFIGS: '[]', CODEX_PATH: path.join(__dirname, 'fake-codex.js'),
});
const json = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };

const tests = [], test = (n, f) => tests.push([n, f]);

// ---------- (а1) restart-hold.warnings: один снимок таблицы процессов на запрос, не Get-Process на каждый PID ----------
test('(а) restart-hold.warnings: один снимок таблицы процессов на весь вызов, без powershell на каждый PID', () => {
  const fb = require('../common/fallback');
  const rh = require('../common/restart-hold');
  const cp = require('child_process');
  const state = fs.mkdtempSync(path.join(RUN, 'rh-'));
  const START = '2026-01-01T00:00:00.000Z';
  const pids = [100001, 100002, 100003, 100004];
  // Четыре «ошибочных» сервера с живыми PID — прежде это давало по одному Get-Process на PID.
  for (const pid of pids) json(path.join(state, 'restart-servers', pid + '.json'), { name: 'srv' + pid, error: 'нет цепочки', process: { pid, startedAt: START } });
  const tree = pids.map(pid => ({ pid, ppid: 1, name: 'node', startedAt: START }));
  process.env.MOST_TEST_PROCESS_TREE = JSON.stringify(tree);

  let ptCalls = 0, psCalls = 0;
  const origPT = fb.processTable, origExec = cp.execFileSync;
  fb.processTable = (...a) => { ptCalls++; return origPT(...a); };
  cp.execFileSync = (c, ...a) => { if (/powershell/i.test(String(c))) psCalls++; return origExec(c, ...a); };
  let lines;
  try { lines = rh.warnings(state); }
  finally { fb.processTable = origPT; cp.execFileSync = origExec; delete process.env.MOST_TEST_PROCESS_TREE; }

  const hits = lines.filter(l => /Не удалось проверить цепочку предков/.test(l));
  assert.equal(hits.length, 4, 'все 4 живых PID проверены по снимку (строк: ' + hits.length + ')');
  assert.equal(ptCalls, 1, 'снимок таблицы процессов взят ровно один раз на запрос (взято: ' + ptCalls + ')');
  assert.equal(psCalls, 0, 'powershell per-PID не запускался (запусков: ' + psCalls + ')');
});

// ---------- (а2) краткая сводка не переоценивает этапы (refreshWork); full — переоценивает ----------
test('(а) краткая team_status не вызывает refreshWork/stage-gate; full — вызывает', async () => {
  const teamMod = require('../common/team');
  const { Team } = teamMod;
  // Валидная карточка работы с уровневым этапом — чтобы refreshWork в full реально дошёл до stage-gate.
  json(path.join(RUN, 'works', 'demo.json'), {
    name: 'demo', title: 'Демо', revision: 1, goal: 'ц', done_criteria: 'к', next_step: 'ш', reminders: [],
    stages: [{ id: 's1', title: 'Этап 1', state: 'идёт', weight: 100, level: 'обычный', accept_criteria: 'a' }],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  // Свежий кэш внешней квоты — чтобы краткая сводка не порождала отвязанный quota-refresh.
  json(path.join(STATE, 'team', 'quota-ext-cache.json'), { codexText: 'c', agyText: 'a', at: new Date().toISOString() });

  let refreshCount = 0;
  const orig = Team.prototype.refreshWork;
  Team.prototype.refreshWork = function (...a) { refreshCount++; return orig.apply(this, a); };
  try {
    const t = new Team(RUN);
    refreshCount = 0;
    const brief = await t.status();
    assert.equal(refreshCount, 0, 'краткая сводка не вызывает refreshWork (вызовов: ' + refreshCount + ')');
    assert.ok(/Демо/.test(brief), 'строка прогресса работы в краткой сводке есть (из сохранённого состояния)');

    refreshCount = 0;
    try { await t.status(null, null, false, true); } catch { /* тяжёлые секции full (git и пр.) ловятся самим status */ }
    assert.ok(refreshCount >= 1, 'full переоценивает этапы через refreshWork (вызовов: ' + refreshCount + ')');
  } finally { Team.prototype.refreshWork = orig; }
});

// ---------- (б1) scratch-folder: без role и без записи → «совет» + служебная папка (codex/deepseek/kimi) ----------
test('(б) send без role и folder — «совет» в служебной папке; write без папки её не подставляет', () => {
  const sf = require('../common/scratch-folder');
  const a = { task: '2+2?' };
  const folder = sf.ensure(a);
  assert.equal(a.role, 'совет', 'отсутствующая роль закреплена как «совет»');
  assert.equal(a.scratchFolder, true, 'взята служебная папка');
  assert.ok(path.isAbsolute(folder) && fs.statSync(folder).isDirectory(), 'служебная папка — абсолютная существующая (гейт серверов проходит)');
  assert.notEqual(a.role, 'проверка', 'не проверка');

  const w = { task: 'x', write: true };
  sf.ensure(w);
  assert.equal(w.folder, undefined, 'write=true без папки служебную не подставляет (прежний отказ сохраняется)');

  // codex/deepseek/kimi все проходят через общий scratch-folder.ensure перед гейтом папки — отдельного кода на каждого нет.
  for (const rel of ['servers/codex/index.js', 'servers/deepseek/index.js', 'servers/kimi/index.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(src.includes("scratch-folder').ensure(a)"), rel + ': делегирует scratch-folder.ensure(a)');
  }
});

// ---------- (б2) antigravity: режим text без folder принимается ----------
test('(б) antigravity text без folder — принимается (служебная папка)', async () => {
  const INDEX = path.join(ROOT, 'servers/antigravity/index.js');
  const FAKE = path.join(__dirname, 'fake-agy.js');
  const agyState = path.join(RUN, 'agy-state');
  fs.mkdirSync(agyState, { recursive: true });
  const env = { ...process.env, NODE_ENV: 'test', AGY_PATH: FAKE, MOST_STATE_DIR: agyState, MOST_JOURNAL: path.join(RUN, 'agy-zhurnal.txt'), MOST_HEARTBEAT_MS: '500' };
  delete env.MOST_TEST_PROCESS_TREE;
  const transport = new StdioClientTransport({ command: process.execPath, args: [INDEX], env, stderr: 'pipe' });
  const client = new Client({ name: 'most-test', version: '1.0.0' });
  await client.connect(transport);
  await serverReady(agyState, transport.pid);
  try {
    const b64 = s => Buffer.from(s, 'utf8').toString('base64');
    const r = await client.callTool({ name: 'antigravity_send', arguments: { task: 'напиши [[FAKE:literal:' + b64('Строка один.\nСтрока два.') + ']]' } }, undefined, { timeout: 120000 });
    const text = (r.content || []).map(c => c.text || '').join('\n');
    assert.ok(!/папки проекта нет/.test(text), 'text без folder не отклонён из-за папки: ' + text.slice(0, 200));
    const id = (text.match(/Задание (\S+) запущено/) || [])[1];
    assert.ok(id, 'поручение принято и запущено: ' + text.slice(0, 200));
    // Дождаться завершения — не оставлять процессов.
    const until = Date.now() + 60000; let res;
    do { res = await client.callTool({ name: 'antigravity_result', arguments: { id, wait_sec: 5 } }, undefined, { timeout: 120000 }); }
    while (/ещё идёт|сейчас переносится/.test((res.content || []).map(c => c.text || '').join('\n')) && Date.now() < until);
  } finally {
    try { await client.close(); } catch {}
    try { transport._process && transport._process.kill(); } catch {}
  }
});

// ---------- (в) добавка: исчерпание 5-часового лимита подписки Kimi ----------
test('(в) quota.quotaExhausted/providerLine: распознаёт признаки лимита; строка провайдера без ссылок и путей', () => {
  const q = require('../common/quota');
  const line = "error: failed to run prompt: provider.api_error: You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. See https://example.com/usage C:\\Users\\x\\log.txt";
  assert.equal(q.quotaExhausted(line), true, 'строка с «usage limit» распознана как квота');
  assert.equal(q.quotaExhausted('error: failed to run prompt: internal error'), false, 'обычная ошибка не считается квотой');
  assert.equal(q.quotaExhausted('Kimi не завершил поручение: код 1'), false, 'голый «код 1» не считается квотой');
  const clean = q.providerLine(line);
  assert.match(clean, /usage limit/, 'суть провайдера сохранена');
  assert.doesNotMatch(clean, /https?:\/\//, 'ссылки убраны');
  assert.doesNotMatch(clean, /C:\\/, 'пути убраны');
});

test('(в) исполнитель Kimi с выводом «usage limit» и код 1 → waiting_quota + «Лимит Kimi исчерпан», не «код 1»; обычный код 1 — failed', async () => {
  const h = require('./fake-kimi');
  const f = h.setup(); f.active(); f.probe();
  const c = await h.client(f);
  const sendK = async (task) => {
    const before = new Set(h.cards(f).map(j => j.id));
    // team-v63 (п.5): цепочка проверочных отправок через действующую waiting_quota — force, иначе мост их не запустит.
    const r = await c.callTool({ name: 'kimi_send', arguments: { folder: f.folder, task, role: 'проверка', force: true } });
    assert(!r.isError, h.text(r)); const j = h.cards(f).find(j => !before.has(j.id)); assert(j, h.text(r)); return h.wait(f, j.id);
  };
  try {
    const q = await sendK('FAKE:quota');
    assert.equal(q.status, 'waiting_quota', JSON.stringify(q));
    assert.equal(q.retryKind, 'quota', 'механизм квоты — тот же, что у других (retryKind=quota)');
    assert.ok(q.lastQuotaAt, 'зафиксировано время исчерпания');
    assert.match(q.error, /Лимит Kimi исчерпан/, 'понятное сообщение владельцу');
    assert.match(q.error, /usage limit/, 'исходная строка провайдера приложена');
    assert.doesNotMatch(q.error, /код 1/, 'не невнятное «код 1»');
    assert.equal(q.voteEligible, false, 'исчерпание не голосует');

    const plain = await sendK('FAKE:fail-code');
    assert.equal(plain.status, 'failed', JSON.stringify(plain));
    assert.match(plain.error, /код 1/, 'обычный код 1 без признаков квоты остаётся как был');
    assert.notEqual(plain.retryKind, 'quota', 'обычный сбой не помечается квотой');
  } finally {
    try { await c.close(); } catch {}
    try { fs.rmSync(f.root, { recursive: true, force: true }); } catch {}
  }
});

(async () => {
  let passed = 0, failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('OK ' + n); passed++; }
    catch (e) { console.log('FAIL ' + n + '\n' + (e.stack || e.message)); failed++; }
  }
  try { fs.rmSync(RUN, { recursive: true, force: true }); } catch {}
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0');
  if (failed) process.exitCode = 1;
})();
