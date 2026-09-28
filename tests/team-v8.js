'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v8-'));
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const json = (f, s) => write(f, JSON.stringify(s)), read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_TEST_KEEP: '1', MOST_NOTIFY: 'off', MOST_CLIENT: 'claude',
  MOST_AGY_QUOTA_FILE: path.join(RUN, 'quota.json'), MOST_AGY_LOG_DIR: path.join(RUN, 'logs'), MOST_CLAUDE_CONFIGS: '[]',
  MOST_CODEX_CONFIG: path.join(RUN, 'absent.toml'), MOST_AGY_MCP_CONFIG: path.join(RUN, 'absent.json'), MOST_AGY_CONFIG: path.join(RUN, 'absent-permissions.json') });
delete process.env.MOST_QUOTA_RETRY_MS;
const aq = require('../common/agy-quota'), { agyAdvice } = require('../common/quota-advice');
const { selectModel, modelFields, quotaRetry } = require('../common/agy-model-quota');
const list = [{ id: 'gemini-test-high', name: 'Gemini Test (High)' }, { id: 'claude-test', name: 'Claude Test' }, { id: 'gpt-test', name: 'GPT-OSS' }];
const future = '2099-01-01T12:00:00Z', otherReset = '2099-01-01T15:00:00Z';
function snapshot() {
  return { accountEmail: 'test@example.invalid', text: 'аккаунт agy совпадает', data: { userStatus: { email: 'test@example.invalid', cascadeModelConfigData: {
    defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_GEMINI' } },
    clientModelConfigs: list.map((m, i) => ({ label: m.name, modelOrAlias: { model: i ? 'MODEL_' + i : 'MODEL_GEMINI' }, quotaInfo: i ? { remainingFraction: 1, resetTime: otherReset } : { resetTime: future } }))
  } } } };
}
const rows = s => s.data.userStatus.cascadeModelConfigData.clientModelConfigs;
const failure = { kind: 'quota', message: 'RESOURCE_EXHAUSTED' };
const job = s => modelFields(selectModel(undefined, s, list));
const tests = [], test = (label, fn) => tests.push({ label, fn });
test('Р1: отсутствующий ключ — 0 %, сброс сохранён, свободные модели видны', () => {
  const s = snapshot(), text = aq.parseQuota(s.data, s.accountEmail);
  assert.match(text, /Gemini Test \(High\): исчерпано \(осталось 0 %\), сброс/);
  assert.match(text, /Claude Test, GPT-OSS: осталось 100 %/);
  assert.match(agyAdvice(s), /осталось 0 %.*только обязательные голоса/);
  assert.equal(aq.modelQuota(rows(s)[0].quotaInfo).resetTime, future);
});
test('Р1: null, строка, неверные числа и время изолированы по модели', () => {
  for (const value of [null, '0', -0.01, 1.01, NaN, Infinity, undefined]) {
    const s = snapshot(); rows(s)[0].quotaInfo.remainingFraction = value;
    assert.match(aq.parseQuota(s.data), /Gemini Test \(High\): формат ответа изменился/);
    assert.match(aq.parseQuota(s.data), /Claude Test, GPT-OSS: осталось 100 %/);
    assert.match(agyAdvice(s), /формат ответа изменился/);
    assert.match(agyAdvice(s, 'MODEL_1'), /осталось 100 %/);
  }
  for (const resetTime of [null, '', 'не дата', 123]) assert.equal(aq.modelQuota({ resetTime }), null);
  for (const remainingFraction of [0, 1]) assert.equal(aq.modelQuota({ resetTime: future, remainingFraction }).remainingFraction, remainingFraction);
});
test('Р2: явная модель и модель по умолчанию через точный список agy', () => {
  const s = snapshot();
  assert.equal(selectModel(undefined, s, list).id, list[0].id);
  assert.equal(selectModel('Claude Test', s, list).id, list[1].id);
  assert.equal(selectModel('claude-test', s, list).id, list[1].id);
  assert(selectModel('claude test', s, list).error);
  delete s.data.userStatus.cascadeModelConfigData.defaultOverrideModelConfig;
  assert.equal(selectModel(undefined, s, list).id, null);
  assert.equal(selectModel(undefined, snapshot(), []).id, null);
  assert.equal(selectModel(undefined, snapshot(), [...list, list[0]]).id, null);
  const ambiguous = snapshot(); rows(ambiguous).push({ ...rows(ambiguous)[0] });
  assert.equal(selectModel(undefined, ambiguous, list).id, null);
});
test('ff955ccf: модель по умолчанию требует подтверждённого совпадения аккаунтов', () => {
  for (const [cliEmail, appEmail] of [['other@example.invalid', 'test@example.invalid'], [null, 'test@example.invalid'], ['test@example.invalid', null], [undefined, undefined]]) {
    const s = snapshot(); s.accountEmail = cliEmail; s.data.userStatus.email = appEmail;
    const selected = selectModel(undefined, s, list), card = modelFields(selected);
    assert.equal(selected.id, null); assert.equal(card.model, 'неизвестна'); assert.equal(card.modelAccount, null);
    const before = Date.now(), plan = quotaRetry(card, failure, s, list);
    assert.equal(plan.knownReset, false); assert.equal(plan.quotaResetTime, null);
    assert(Date.parse(plan.nextAttemptAt) >= before + 1800000 && Date.parse(plan.nextAttemptAt) <= Date.now() + 1800000);
    assert.equal(selectModel('claude-test', s, list).id, 'claude-test');
  }
  const confirmed = snapshot(); confirmed.accountEmail = 'TEST@example.invalid';
  assert.equal(selectModel(undefined, confirmed, list).id, list[0].id);
});
test('Р2: сброс только своей модели + ровно 60 секунд; счётчик не мешает известному сбросу', () => {
  const s = snapshot(), j = job(s), plan = quotaRetry({ ...j, quotaAttempts: 12 }, failure, s, list);
  assert.equal(plan.status, 'waiting_quota'); assert.equal(plan.knownReset, true);
  assert.equal(Date.parse(plan.nextAttemptAt), Date.parse(future) + 60000);
  const other = modelFields(selectModel('claude-test', s, list));
  assert.equal(Date.parse(quotaRetry(other, failure, s, list).nextAttemptAt), Date.parse(otherReset) + 60000);
  assert.equal(j.modelId, 'gemini-test-high');
});
test('Р2: неизвестная, старая, неоднозначная модель, источник и аккаунт — 30 минут', () => {
  const s = snapshot(), j = job(s), different = snapshot(); different.accountEmail = 'other@example.invalid';
  const switched = snapshot(); switched.accountEmail = switched.data.userStatus.email = 'new@example.invalid';
  const invalid = snapshot(); rows(invalid)[0].quotaInfo.remainingFraction = null;
  const ambiguous = snapshot(); rows(ambiguous).push({ ...rows(ambiguous)[0] });
  for (const [card, snap, cli] of [[{}, s, list], [{ model: j.model }, s, list], [{ ...j, modelId: 'unknown' }, s, list], [j, {}, list], [j, different, list], [j, switched, list], [j, { ...s, accountEmail: null }, list], [j, s, []], [j, s, [...list, list[0]]], [j, invalid, list], [j, ambiguous, list]]) {
    const before = Date.now(), plan = quotaRetry(card, failure, snap, cli);
    assert.equal(plan.knownReset, false); assert.equal(plan.quotaResetTime, null);
    assert(Date.parse(plan.nextAttemptAt) >= before + 1800000 && Date.parse(plan.nextAttemptAt) <= Date.now() + 1800000);
  }
});
test('Р2: прошедший сброс — первая проба через 90 секунд, затем 30 минут', () => {
  const s = snapshot(); rows(s)[0].quotaInfo.resetTime = '2020-01-01T00:00:00Z';
  const j = job(s), now = Date.now(), first = quotaRetry(j, failure, s, list, now);
  assert.equal(Date.parse(first.nextAttemptAt), now + 90000); assert.equal(first.knownReset, false);
  const before = Date.now(), second = quotaRetry({ ...j, ...first, quotaAttempts: 1 }, failure, s, list);
  assert(Date.parse(second.nextAttemptAt) >= before + 1800000);
  assert.equal(quotaRetry({ ...j, ...second, quotaAttempts: 12 }, failure, s, list).status, 'failed');
});
test('Р3: подсказка о свободных моделях без автоматической смены', () => {
  const s = snapshot(), j = job(s), plan = quotaRetry(j, failure, s, list);
  assert.match(plan.quotaAdvice, /Gemini Test \(High\): сброс/);
  assert.match(plan.quotaAdvice, /Свободные модели Antigravity: Claude Test, GPT-OSS/);
  assert.match(plan.quotaAdvice, /Автоматической смены модели нет/);
  assert.equal(plan.modelId, undefined); assert.equal(j.modelId, list[0].id);
});
test('Р4/Р5: проверки правил из замысла, без изменения самих правил', () => {
  const text = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  // Личный скилл хроник не входит в публичную копию (team-v11) — тогда его проверка пропускается.
  if (fs.existsSync(path.join(ROOT, 'skill/vtm-hronika/SKILL.md'))) {
    assert.match(text('skill/vtm-hronika/SKILL.md').replace(/\s+/g, ' '), /Antigravity — литературный текст/);
    assert(!/художественн/i.test(text('skill/vtm-hronika/SKILL.md')));
  } else console.log('Личный скилл хроник отсутствует (публичная копия): проверка его формулировок пропущена.');
  assert.match(text('rules/brief.md').split('\n')[0], /roles/);
  assert.match(text('rules/antigravity.md'), /Кому поручить[^\n]*Grok/);
  const grokLines = text('rules/claude.md').split('\n').filter(line => /Grok/.test(line) && line.trim());
  assert.equal(new Set(grokLines).size, grokLines.length);
  assert.equal((text('rules/claude.md').match(/## Совещательное ревью Grok/g) || []).length, 1);
  assert(!text('rules/claude.md').includes('Жёсткое ревью замысла и итога, сбор и чтение больших материалов — Grok.'));
});
test('Р2/Р3: сервер — --model, карточка, ответ, повтор той же моделью и гостевая очередь', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  write(path.join(RUN, 'logs/cli-test.log'), 'applyAuthResult: email=test@example.invalid\n');
  const s = snapshot(); json(process.env.MOST_AGY_QUOTA_FILE, s.data);
  const log = path.join(RUN, 'calls.jsonl');
  async function open(guest = false) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers/antigravity/index.js')], env: { ...process.env,
      MOST_CLIENT: guest ? 'codex' : 'claude', AGY_PATH: path.join(__dirname, 'fake-agy.js'), MOST_AGY_INPUT_FORMAT: 'legacy', FAKE_AGY_LOG: log }, stderr: 'pipe' });
    const client = new Client({ name: 'team-v8', version: '1' }); await client.connect(transport); return { client, transport };
  }
  const text = r => r.content.map(c => c.text || '').join('\n');
  async function send(client, name, model) {
    const folder = path.join(RUN, name); fs.mkdirSync(folder);
    const response = text(await client.callTool({ name: 'antigravity_send', arguments: { folder, task: 'Проверь [[FAKE:quota]]', ...(model ? { model } : {}) } }));
    const id = /Задание (\S+) (?:запущено|в очереди)/.exec(response)?.[1]; assert(id, response); return id;
  }
  async function wait(client, id) {
    let result, card;
    for (let i = 0; i < 25; i++) {
      result = text(await client.callTool({ name: 'antigravity_result', arguments: { id, wait_sec: 1 } }));
      card = read(path.join(RUN, 'state/jobs', id, 'card.json'));
      if (card.status === 'waiting_quota') return { result, card };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(JSON.stringify(card));
  }
  const guest = await open(true); let guestId;
  try { guestId = await send(guest.client, 'guest'); } finally { await guest.client.close(); await guest.transport.close(); }
  const main = await open();
  try {
    for (const [id, expected, reset] of [[guestId, list[0].id, future], [await send(main.client, 'default'), list[0].id, future], [await send(main.client, 'explicit', 'claude-test'), list[1].id, otherReset]]) {
      const { card, result } = await wait(main.client, id);
      assert.equal(card.modelId, expected); assert.equal(card.retry.args[card.retry.args.indexOf('--model') + 1], expected);
      assert.equal(Date.parse(card.nextAttemptAt), Date.parse(reset) + 60000);
      assert(result.includes(card.nextAttemptAt)); assert.match(result, /Свободные модели Antigravity/);
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(c => c.cwd === card.papka);
      assert.equal(calls.length, 1); assert.equal(calls[0].model, expected);
    }
    for (const condition of ['mismatch', 'unknown-app', 'unknown-agy']) {
      const unconfirmed = snapshot();
      if (condition === 'mismatch') unconfirmed.data.userStatus.email = 'other@example.invalid';
      if (condition === 'unknown-app') delete unconfirmed.data.userStatus.email;
      write(path.join(RUN, 'logs/cli-test.log'), condition === 'unknown-agy' ? 'no authentication record\n' : 'applyAuthResult: email=test@example.invalid\n');
      json(process.env.MOST_AGY_QUOTA_FILE, unconfirmed.data);
      const before = Date.now(), id = await send(main.client, condition), { card, result } = await wait(main.client, id);
      assert.equal(card.model, 'неизвестна'); assert.equal(card.modelId, null); assert.equal(card.modelAccount, null);
      assert(!card.retry.args.includes('--model')); assert.equal(card.knownReset, false); assert.equal(card.quotaResetTime, null);
      assert(Date.parse(card.nextAttemptAt) >= before + 1800000 && Date.parse(card.nextAttemptAt) <= Date.now() + 1800000);
      assert.match(result, /Время сброса своей модели неизвестно/);
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(c => c.cwd === card.papka);
      assert.equal(calls.length, 1); assert.equal(calls[0].model, null);
    }
    write(path.join(RUN, 'logs/cli-test.log'), 'applyAuthResult: email=test@example.invalid\n');
    json(process.env.MOST_AGY_QUOTA_FILE, { closed: true });
    const before = Date.now(), unknownId = await send(main.client, 'unknown');
    const unknown = await wait(main.client, unknownId);
    assert.equal(unknown.card.model, 'неизвестна'); assert.equal(unknown.card.modelId, null);
    assert(!unknown.card.retry.args.includes('--model')); assert.equal(unknown.card.knownReset, false);
    assert(Date.parse(unknown.card.nextAttemptAt) >= before + 1800000 && Date.parse(unknown.card.nextAttemptAt) <= Date.now() + 1800000);
    assert.match(unknown.result, /Время сброса своей модели неизвестно/);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).find(c => c.cwd === unknown.card.papka).model, null);
    // Новый процесс поднимает сохранённое ожидание; меняем только срок в тестовой карточке.
  } finally { await main.client.close(); await main.transport.close(); }
  const cardFile = path.join(RUN, 'state/jobs', guestId, 'card.json'), saved = read(cardFile);
  saved.nextAttemptAt = new Date(Date.now() - 1000).toISOString(); json(cardFile, saved);
  s.data.userStatus.cascadeModelConfigData.defaultOverrideModelConfig.modelOrAlias.model = 'MODEL_1'; json(process.env.MOST_AGY_QUOTA_FILE, s.data);
  const resumed = await open();
  try {
    for (let i = 0; i < 40; i++) {
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(c => c.cwd === saved.papka);
      if (calls.length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const { card } = await wait(resumed.client, guestId);
    assert.equal(card.modelId, list[0].id); assert.equal(Date.parse(card.nextAttemptAt), Date.parse(future) + 60000);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(c => c.cwd === saved.papka);
    assert.equal(calls.length, 2); assert(calls.every(c => c.model === list[0].id));
  } finally { await resumed.client.close(); await resumed.transport.close(); }
});
(async () => {
  console.log('team-v8: ' + process.platform + ' ' + process.version + '; ' + RUN);
  let passed = 0, failed = 0;
  for (const t of tests) { try { await t.fn(); passed++; console.log('OK ' + t.label); } catch (e) { failed++; console.log('ПРОВАЛ ' + t.label + '\n' + e.stack); } }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0'); process.exitCode = failed ? 1 : 0;
})();
