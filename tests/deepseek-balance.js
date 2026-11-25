'use strict';
// quota-622 (слово пользователя 23.11.2026): «на счёте DeepSeek нет денег» (dsh ACCOUNT_QUOTA / Insufficient Balance).
//  1 распознавание по диагностике провайдера (живая строка прогона zhivoj-brod-4), текст ответа — не доказательство;
//  2 отметка «нет денег»: быстрый отказ сутки, снятие первым успехом, окно, прежние карточки до правки;
//  3 настоящий deepseek_send с подставным dsh: карточка с отметкой, следующий вызов — быстрый отказ без запуска CLI,
//    force после пополнения — успех и снятие отметки;
//  4 сценарий: запасной участник; без запасного — пауза с причиной и продолжение через resume (одна попытка с force);
//    раннер сценария: карточка/текст «нет денег» → 'balance', force доходит до *_send;
//  5 team_status: строка квоты DeepSeek «на счёте нет денег» со временем отметки; сценарии на паузе в краткой сводке.
const fs = require('fs'), path = require('path'), assert = require('assert');
const { serverReady } = require('./runner-support');
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-q622-'));
Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_TEST_KEEP: '1', MOST_NOTIFY: 'off', MOST_CLIENT: 'claude', MOST_CLAUDE_CONFIGS: '[]', MOST_JOB_ID: '',
  MOST_CODEX_CONFIG: path.join(RUN, 'missing.toml'), MOST_AGY_MCP_CONFIG: path.join(RUN, 'missing.json'), MOST_AGY_CONFIG: path.join(RUN, 'missing-permissions.json'), CODEX_PATH: path.join(__dirname, 'fake-codex.js') });
const quota = require('../common/quota'), qm = require('../common/quota-mark'), scenario = require('../common/scenario');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tests = [], test = (name, fn) => tests.push({ name, fn });
const text = r => (r.content || []).map(c => c.text || '').join('\n');
const LIVE = 'DeepSeek не завершил поручение: ????: ?? 㤠???? ???? 䠩??.\r\n[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)\ndsh: ACCOUNT_QUOTA: Insufficient Balance (request_id: 1eea0066-5881-4a09-bc48-c416581fdc2e)\n';

test('1 распознавание: ACCOUNT_QUOTA / QUOTA / Insufficient Balance / 402 — нет денег; прочее — нет', () => {
  assert.equal(quota.balanceExhausted(LIVE), true, 'живая строка zhivoj-brod-4');
  assert.equal(quota.balanceExhausted('dsh: QUOTA: Insufficient Balance'), true, 'QUOTA по API-ключу');
  assert.equal(quota.balanceExhausted('dsh: QUOTA: provider said no'), true, 'код QUOTA dsh');
  assert.equal(quota.balanceExhausted('HTTP 402 Payment Required'), true, '402');
  assert.equal(quota.balanceExhausted('insufficient_balance'), true);
  for (const t of ['The balance column stores money.', 'quota.js: waiting_quota', 'ACCOUNT_QUOTAS_TABLE', '429 Too Many Requests', 'internal error', ''])
    assert.equal(quota.balanceExhausted(t), false, 'не баланс: ' + t);
  assert.equal(quota.quotaExhausted(LIVE), false, 'окно квоты — другое (прежний распознаватель не срабатывал, отсюда ошибка)');
});

test('2 отметка «нет денег»: сутки быстрого отказа, снятие успехом/окном, прежние карточки, тексты', () => {
  const now = Date.now(), at = t => new Date(now - t).toISOString();
  const bal = t => ({ status: 'failed', errorKind: 'balance', quotaReason: 'balance', retryKind: 'quota', lastQuotaAt: at(t), finishedAt: at(t) });
  let b = qm.blocked([bal(3 * 3600000)], { now });
  assert.equal(b.blocked, true, 'через 3 ч всё ещё действует (не 10-минутное окно)'); assert.equal(b.kind, 'balance');
  assert.equal(qm.blocked([bal(25 * 3600000)], { now }).blocked, false, 'через сутки — одна настоящая попытка');
  assert.equal(qm.blocked([bal(60000), { status: 'done', finishedAt: at(1000) }], { now }).blocked, false, 'успех после отметки снимает');
  assert.equal(qm.blocked([{ status: 'done', finishedAt: at(120000) }, bal(60000)], { now }).blocked, true, 'успех ДО отметки не снимает');
  assert.equal(qm.blocked([{ ...bal(60000), status: 'cancelled' }], { now }).blocked, false, 'снятая пользователем — не отметка');
  assert.equal(qm.blocked([{ ...bal(60000), status: 'needs_decision' }], { now }).blocked, true, 'писатель на решении — отметка есть');
  // Карточка до правки (как 03f8bd93…): failed, без quotaReason, ошибка с ACCOUNT_QUOTA → отметка по finishedAt.
  const legacy = { status: 'failed', error: LIVE, finishedAt: at(120000) };
  b = qm.blocked([legacy], { now }); assert.equal(b.blocked, true, 'прежняя карточка распознана'); assert.equal(b.kind, 'balance');
  assert.equal(qm.blocked([{ status: 'failed', error: 'DeepSeek не завершил поручение: сбой', finishedAt: at(1000) }], { now }).blocked, false);
  // Окно квоты (waiting_quota) по-прежнему 10 минут и kind 'quota'.
  const wq = { status: 'waiting_quota', retryKind: 'quota', lastQuotaAt: at(60000) };
  assert.equal(qm.blocked([wq], { now }).kind, 'quota');
  assert.equal(qm.blocked([{ ...wq, lastQuotaAt: at(700000) }], { now }).blocked, false);
  const iso = at(60000);
  assert.match(qm.refusalText('DeepSeek', iso, 'balance'), /^На счёте DeepSeek нет денег \(отметка .+\); пополните счёт и повторите с force: true/);
  assert.match(qm.refusalText('Kimi', iso), /^Лимит Kimi исчерпан с/, 'прежний текст квоты не тронут');
  assert.match(qm.statusText([bal(60000)]), /^на счёте нет денег \(отметка \d\d\.\d\d\.\d{4}, \d\d:\d\d:\d\d/);
  assert.equal(qm.statusText([]), null);
});

async function server(name, env = {}) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers', name, 'index.js')], env: { ...process.env, NODE_ENV: 'test', ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'q622', version: '1' }); await client.connect(transport);
  await serverReady(path.join(RUN, 'state'), transport.pid);
  return { client, close: async () => { await client.close(); await transport.close(); } };
}
const material = path.join(RUN, 'material'); fs.mkdirSync(material, { recursive: true });
const cardsDir = () => path.join(RUN, 'state', 'deepseek-jobs');
const readCard = id => JSON.parse(fs.readFileSync(path.join(cardsDir(), id + '.json'), 'utf8'));
async function finished(id) { let c; for (let i = 0; i < 150; i++) { c = readCard(id); if (!['queued', 'running'].includes(c.status)) return c; await sleep(100); } return c; }
const plog = path.join(RUN, 'dsh.log');
const calls = () => fs.existsSync(plog) ? fs.readFileSync(plog, 'utf8').trim().split('\n').filter(Boolean).length : 0;

test('3 настоящий deepseek_send: «нет денег» → отметка; затем быстрый отказ без CLI; force после пополнения — успех и снятие', async () => {
  const s = await server('deepseek', { DSH_PATH: path.join(__dirname, 'fake-dsh.cmd'), MOST_DSH_NO_PROFILES: '1', FAKE_PROMPT_LOG: plog });
  try {
    const r = await s.client.callTool({ name: 'deepseek_send', arguments: { folder: material, role: 'совет', task: 'ход игрока NO_MONEY' } });
    const id = /Номер поручения: (\S+)/.exec(text(r))?.[1]; assert(id, text(r));
    const c = await finished(id);
    assert.equal(c.status, 'failed', JSON.stringify(c));
    assert.equal(c.errorKind, 'balance'); assert.equal(c.quotaReason, 'balance'); assert.equal(c.retryKind, 'quota');
    assert(Number.isFinite(Date.parse(c.lastQuotaAt)), 'свежая отметка времени');
    assert.match(c.error, /^На счёте DeepSeek нет денег \(dsh: ACCOUNT_QUOTA: Insufficient Balance/, c.error);
    assert(!/https?:|model listing/.test(c.error), 'в причине только строка отказа, без ссылок и шума: ' + c.error);
    assert.equal(calls(), 1);
    // Новое поручение без force — быстрый отказ, CLI не запускается, карточки нет.
    const before = fs.readdirSync(cardsDir()).length;
    const r2 = await s.client.callTool({ name: 'deepseek_send', arguments: { folder: material, role: 'совет', task: 'обычная задача' } });
    assert.match(text(r2), /На счёте DeepSeek нет денег/, text(r2));
    assert.match(text(r2), /waiting_quota|Пополните счёт/, text(r2));
    assert.equal(calls(), 1, 'CLI не запускался'); assert.equal(fs.readdirSync(cardsDir()).length, before, 'карточки не появилось');
    // Пополнили счёт → force: true — настоящая попытка, успех снимает отметку.
    const r3 = await s.client.callTool({ name: 'deepseek_send', arguments: { folder: material, role: 'совет', task: 'обычная задача', force: true } });
    const id3 = /Номер поручения: (\S+)/.exec(text(r3))?.[1]; assert(id3, text(r3));
    assert.equal((await finished(id3)).status, 'done');
    const r4 = await s.client.callTool({ name: 'deepseek_send', arguments: { folder: material, role: 'совет', task: 'ещё задача' } });
    const id4 = /Номер поручения: (\S+)/.exec(text(r4))?.[1]; assert(id4, 'после успеха отметка снята: ' + text(r4));
    assert.equal((await finished(id4)).status, 'done'); assert.equal(calls(), 3);
  } finally { await s.close(); }
});

// ───────── 4 сценарий ─────────
const scRoot = path.join(RUN, 'sc');
function makeRunner(behavior) {
  const rec = { started: [] }; const jobs = new Map(); let seq = 0;
  return { rec, quotaBlocked: () => false, paused: () => false,
    async start(a) { const id = 'j' + (++seq); rec.started.push({ id, member: a.member, key: a.key, force: a.force === true, continueId: a.continueId || null }); jobs.set(id, { ...a, st: behavior(a) }); return { jobId: id }; },
    async poll(id) { const j = jobs.get(id); if (j.st === 'balance') return { terminal: true, status: 'balance', error: 'На счёте DeepSeek нет денег', seconds: 1 };
      return { terminal: true, status: 'done', text: 'ответ ' + j.key, seconds: 1, chars_in: 10, chars_out: 5, memberJobId: 'm-' + id }; },
    async cancel() { return { confirmed: true }; }, async close() {} };
}
function make(id, members) {
  const dir = scenario.dirOf(scRoot, id); fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, 'scenario.json'); fs.writeFileSync(sf, JSON.stringify({ id, members }));
  return scenario.create(scRoot, { scenarioFile: sf, hook: { interp: process.execPath, script: sf } });
}
// Крючок: 2 хода; игрок «p» — участники из файла сценария; ответ с ошибкой — «провал игрока» (как крючок zhivoj-brod-4).
function hookFor(members, seen) {
  return (_S, payload) => { seen.push(payload.results.map(r => r.status + ':' + r.member));
    const st = payload.state || { n: 0 }; st.n++;
    if (payload.results.some(r => r.status !== 'done')) return { state: st, done: true, note: 'повторный провал игрока' };
    if (st.n > 2) return { state: st, done: true, note: 'готово' };
    return { state: st, send: [{ key: 'p', members, session: 'p', task: 'ход ' + st.n }] }; };
}

test('4а сценарий: «нет денег» у DeepSeek → запасной участник по списку, крючок провала не видит', async () => {
  make('sc-fb', ['deepseek', 'codex']); const seen = [];
  const runner = makeRunner(a => (a.member === 'deepseek' ? 'balance' : 'ok'));
  const S = await scenario.drive(scRoot, 'sc-fb', { runner, invokeHook: hookFor(['deepseek', 'codex'], seen), now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 100 });
  assert.equal(S.status, 'done', scenario.statusLine(S)); assert.equal(S.note, 'готово');
  assert(seen.flat().every(x => x === 'done:codex'), JSON.stringify(seen));
});

test('4б сценарий без запасного: пауза с причиной, resume — одна попытка с force и продолжение', async () => {
  const mgr = require('../common/scenario-manager'), access = require('../common/access');
  const orig = access.chatSession; access.chatSession = () => true;
  try {
    make('sc-pause', ['deepseek']); const seen = [];
    let money = false;
    const runner = makeRunner(a => (a.member === 'deepseek' && !(money && a.force) && !money ? 'balance' : 'ok'));
    const deps = { runner, invokeHook: hookFor(['deepseek'], seen), now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 100 };
    let S = await scenario.drive(scRoot, 'sc-pause', deps);
    assert.equal(S.status, 'paused', scenario.statusLine(S));
    assert.match(S.pauseReason, /^нет денег на счёте DeepSeek/);
    assert.match(scenario.statusLine(S), /ПАУЗА: нет денег на счёте DeepSeek/);
    assert.equal(seen.length, 1, 'крючок не получил «провал» (только старт): ' + JSON.stringify(seen));
    assert.equal(runner.rec.started.length, 1, 'без повторов впустую');
    assert.deepEqual(scenario.pausedList(scRoot).filter(x => x.startsWith('sc-pause')).length, 1);
    // Подъём после перезапуска моста паузу не снимает.
    const before = runner.rec.started.length;
    mgr.resumeAll(scRoot); await sleep(30);
    assert.equal(scenario.loadState(scRoot, 'sc-pause').status, 'paused'); assert.equal(runner.rec.started.length, before);
    // Счёт пополнен → resume: та же задача тому же участнику с force, сценарий доходит до конца.
    money = true;
    const resp = await mgr.command({ action: 'resume', id: 'sc-pause' }, { stateDir: scRoot, deps });
    assert.match(resp, /возобновлён/);
    { const t = mgr.active.get('sc-pause'); assert(t, 'цикл поднят'); await t.done; }
    S = scenario.loadState(scRoot, 'sc-pause');
    assert.equal(S.status, 'done', scenario.statusLine(S)); assert.equal(S.note, 'готово'); assert(!S.pauseReason);
    const again = runner.rec.started[before];
    assert.equal(again.member, 'deepseek'); assert.equal(again.key, 'p'); assert.equal(again.force, true, 'после resume — force');
    assert.equal(runner.rec.started[before + 1].force, false, 'force — только одна попытка');
  } finally { access.chatSession = orig; }
});

test('4в сценарий: resume без пополнения — снова пауза, не «провал игрока»', async () => {
  const mgr = require('../common/scenario-manager'), access = require('../common/access');
  const orig = access.chatSession; access.chatSession = () => true;
  try {
    make('sc-pause2', ['deepseek']); const seen = [];
    const runner = makeRunner(() => 'balance');
    const deps = { runner, invokeHook: hookFor(['deepseek'], seen), now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 100 };
    await scenario.drive(scRoot, 'sc-pause2', deps);
    await mgr.command({ action: 'resume', id: 'sc-pause2' }, { stateDir: scRoot, deps });
    { const t = mgr.active.get('sc-pause2'); assert(t, 'цикл поднят'); await t.done; }
    const S = scenario.loadState(scRoot, 'sc-pause2');
    assert.equal(S.status, 'paused'); assert.equal(seen.length, 1, JSON.stringify(seen)); assert.equal(runner.rec.started.length, 2);
  } finally { access.chatSession = orig; }
});

test('4г раннер сценария: карточка и текст «нет денег» → balance; force доходит до deepseek_send', async () => {
  const { senderRunner } = require('../common/scenario-senders');
  const state = path.join(RUN, 'sc-state'), folder = path.join(RUN, 'sc-folder'); fs.mkdirSync(folder, { recursive: true });
  const args = [];
  const clientFactory = async member => ({ async callTool({ arguments: a }) {
    args.push(a);
    if (/TEXT/.test(a.task)) return { content: [{ type: 'text', text: qm.refusalText('DeepSeek', new Date().toISOString(), 'balance') }] };
    const dir = path.join(state, member + '-jobs'); fs.mkdirSync(dir, { recursive: true });
    const id = 'ds-' + args.length;
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, requestId: a.request_id, status: 'failed', errorKind: 'balance', quotaReason: 'balance', error: 'На счёте DeepSeek нет денег', lastQuotaAt: new Date().toISOString() }));
    return { content: [{ type: 'text', text: 'Номер поручения: ' + id }] };
  }, async close() {} });
  const runner = senderRunner(state, { id: 'q', folder }, { clientFactory });
  for (const [task, force] of [['CARD', true], ['TEXT', false]]) {
    const h = (await runner.start({ key: 'k', member: 'deepseek', task, requestId: 'rq-' + task, force })).jobId;
    let p, n = 0; do { await sleep(2); p = await runner.poll(h); } while (!p.terminal && ++n < 100);
    assert.equal(p.status, 'balance', task + ': ' + JSON.stringify(p));
  }
  assert.equal(args[0].force, true); assert.equal(args[1].force, undefined);
  assert.equal(runner.quotaBlocked('deepseek'), true, 'отметка по карточке видна раннеру (обход участника)');
  await runner.close();
});

test('5 team_status: строка квоты DeepSeek «на счёте нет денег» со временем; сценарии на паузе в сводке', () => {
  const ql = require('../common/quota-line');
  const dir = cardsDir(); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  let line = ql.composeLine({ state: path.join(RUN, 'state', 'team') }, 'x', 'y');
  assert(!/нет денег/.test(line), 'без отметки строки нет: ' + line);
  const at = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(path.join(dir, 'b1.json'), JSON.stringify({ id: 'b1', status: 'failed', errorKind: 'balance', quotaReason: 'balance', retryKind: 'quota', lastQuotaAt: at, finishedAt: at }));
  line = ql.composeLine({ state: path.join(RUN, 'state', 'team') }, 'x', 'y');
  assert(line.includes('DeepSeek — на счёте нет денег (отметка ' + new Date(at).toLocaleString('ru-RU')), line);
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({ id: 'ok', status: 'done', finishedAt: new Date().toISOString() }));
  line = ql.composeLine({ state: path.join(RUN, 'state', 'team') }, 'x', 'y');
  assert(!/нет денег/.test(line), 'успех снял отметку: ' + line);
  const src = fs.readFileSync(path.join(ROOT, 'common', 'summary.js'), 'utf8');
  assert(src.includes("pausedList(require('./paths').stateDir)") && src.includes('Сценарии на паузе: '), 'краткая сводка называет сценарии на паузе');
});

(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) try { await fn(); passed++; console.log('OK ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed); process.exitCode = failed ? 1 : 0;
  if (!failed) try { fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 5 }); } catch {}
})();
