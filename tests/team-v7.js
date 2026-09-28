'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v7-'));
Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_TEST_KEEP: '1', MOST_NOTIFY: 'off', MOST_CLIENT: 'claude', MOST_CLAUDE_CONFIGS: '[]',
  MOST_CODEX_CONFIG: path.join(RUN, 'missing.toml'), MOST_AGY_MCP_CONFIG: path.join(RUN, 'missing.json'), MOST_AGY_CONFIG: path.join(RUN, 'missing-permissions.json'), CODEX_PATH: path.join(__dirname, 'fake-codex.js') });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const json = (file, data) => write(file, JSON.stringify(data));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const tests = [], test = (name, fn) => tests.push({ name, fn });
const { codexAdvice, agyAdvice } = require('../common/quota-advice');
test('Р1/Р4: правила распределения и проверки терминов', () => {
  // Убираем только оформление и переносы строк; проверяем связанные положения,
  // а не наличие отдельных слов в разных местах документа.
  const contains = (file, phrases) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\*\*/g, '').replace(/\s+/g, ' ');
    for (const phrase of phrases) assert(text.includes(phrase), file + ': отсутствует положение «' + phrase + '»');
  };
  contains('rules/roles.md', [
    'Все трое помощников участвуют в обсуждении замысла и в итоговом ревью',
    'Codex — критик логики и проверяемости замысла и итога; код и автотесты. Рутины не получает.',
    'Antigravity — автор литературного текста',
    'Механика — перенос, раскладка, переименование, оформление, сверка форматов — сервер (`antigravity_apply`, `team_change`) или Claude скриптом на диске, не модели.',
    'Grok получает готовый текст и сам выписывает из него все специальные термины, имена, названия, переводы.',
    'термин | варианты | ссылка и короткая цитата | рекомендация',
    'Строка без ссылки не засчитывается.',
    'Спорный термин — два и более варианта в ходу, конфликт издатель/вики/форум или нет устойчивой практики. Для него — не меньше двух источников.',
    'Без таблицы с решениями текст не готов',
    'Для хроник и сеттингов пользователя решает его принятый русский канон (файлы проекта); таблица сообщества его не заменяет.',
  ]);
  contains('rules/grok.md', [
    'проверка терминов (сам выписывает их из готового текста)',
    'термин | варианты | ссылка и короткая цитата | рекомендация',
  ]);
  contains('rules/antigravity.md', [
    'Литературный текст (будет опубликован, прочитан вслух, отдан пользователю как готовое произведение) пишет Antigravity',
    'Готовый текст уходит Grok: он сам выписывает термины, имена, названия и переводы',
    'Без таблицы с решениями текст не готов.',
  ]);
  // Личный скилл хроник не входит в публичную копию (team-v11) — тогда его проверка пропускается.
  if (fs.existsSync(path.join(ROOT, 'skill/vtm-hronika/SKILL.md'))) contains('skill/vtm-hronika/SKILL.md', [
    'Механику — перенос, раскладку, оформление — делает сервер или я скриптом, не модели.',
    'Все трое помощников обсуждают замысел и смотрят итог',
    'Antigravity — литературный текст',
    'Grok получает готовый текст, сам выписывает термины, имена, названия и переводы',
    'термин | варианты | ссылка и цитата | рекомендация',
    'строка без ссылки не засчитывается; спорный термин — минимум два источника.',
    'Без таблицы с решениями текст не выдаётся.',
    'Для хроники решает принятый канон проекта (записи, книги-опоры, Chicago by Night для Чикаго): таблица сообщества его не заменяет',
  ]);
});
function snapshot(remaining) {
  return { text: 'аккаунт agy совпадает', data: { userStatus: { cascadeModelConfigData: {
    defaultOverrideModelConfig: { modelOrAlias: { model: 'chosen' } },
    clientModelConfigs: [{ label: 'Выбранная', modelOrAlias: { model: 'chosen' }, quotaInfo: { remainingFraction: remaining / 100, resetTime: '2099-01-01T12:00:00Z' } },
      { label: 'Другая', modelOrAlias: { model: 'other' }, quotaInfo: { remainingFraction: .01, resetTime: '2099-01-01T12:00:00Z' } }],
  } } } };
}
test('Р2: границы Codex, неизвестная и повреждённая квота', () => {
  for (const [used, expected] of [[49, 'обычное'], [50, 'только обсуждение'], [80, 'только обязательные']])
    assert(codexAdvice({ weekly: { used_percent: used }, source: 'проба' }).includes(expected));
  for (const value of [undefined, null, '80', NaN, -1, 101]) assert.match(codexAdvice({ weekly: { used_percent: value } }), /не виден$/);
});
test('Р2: Antigravity — выбранная модель, точные пороги, сброс и неизвестность', () => {
  for (const [left, expected] of [[36, 'обычное'], [35, 'обычное'], [34, 'предупреждение'], [20, 'предупреждение'], [19, 'отложить до сброса'], [10, 'отложить до сброса'], [9, 'только обязательные']])
    assert(agyAdvice(snapshot(left)).includes(expected), String(left));
  assert.match(agyAdvice(snapshot(90), 'other'), /только обязательные/);
  assert.match(agyAdvice(snapshot(90), 'missing'), /не виден$/);
  assert.match(agyAdvice({}), /не виден$/);
  assert.match(agyAdvice({ ...snapshot(9), text: 'аккаунт agy не совпадает' }), /не виден$/);
});
test('Р2/Р6: настоящая краткая сводка — подсказки и рутина за сутки', async () => {
  process.env.MOST_AGY_QUOTA_FILE = path.join(RUN, 'quota.json'); json(process.env.MOST_AGY_QUOTA_FILE, snapshot(19).data);
  const stores = require('../common/team-store');
  for (const [id, hours, stage] of [['routine', 2, 'рутина: перенос'], ['old', 25, 'рутина'], ['review', 1, 'ревью']])
    json(path.join(stores.roots().codex, id + '.json'), { id, startedAt: new Date(Date.now() - hours * 3600000).toISOString(), stage, status: 'done' });
  const team = new (require('../common/team').Team)(RUN);
  const result = await team.status(undefined, undefined, false, false, { agy_model: 'chosen' });
  assert.match(result, /новые крупные тексты отложить/); assert.match(result, /Grok: квота не видна/);
  assert.match(result, /Grok — 0 поручений/); assert.match(result, /Рутина за сутки[^\n]*codex — 1/);
});
test('Краткая сводка: 16 поручений ждут квоту, одна строка на участника, подробности в full', async () => {
  const stores = require('../common/team-store'), locks = require('../common/locks');
  const oldList = stores.list, oldOwner = locks.ownerState;
  const earliest = new Date('2099-01-01T09:15:00Z');
  const jobs = Array.from({ length: 16 }, (_, i) => ({ id: 'agy-quota-' + String(i).padStart(2, '0'),
    status: 'waiting_quota', startedAt: new Date().toISOString(),
    nextAttemptAt: i === 15 ? earliest.toISOString() : i === 0 ? 'не дата' : new Date(earliest.getTime() + (16 - i) * 3600000).toISOString() }));
  const byWho = {
    antigravity: [...jobs, { id: 'archived-quota', status: 'waiting_quota', archived: true, nextAttemptAt: '2000-01-01T01:00:00Z' }, { id: 'queued-job', status: 'queued' }],
    codex: [{ id: 'codex-quota-1', status: 'waiting_quota' }, { id: 'codex-quota-2', status: 'waiting_quota', nextAttemptAt: 'не дата' }], grok: [],
  };
  stores.list = who => ({ jobs: byWho[who], errors: [] }); locks.ownerState = async () => 'unknown';
  try {
    const team = new (require('../common/team').Team)(RUN);
    const compact = require('../common/format').format('Команда', { status: 'done' }, await team.status());
    const expectedTime = earliest.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    assert(compact.includes('Antigravity: Ждут квоту: 16 поручений, ближайшее продолжение ' + expectedTime));
    assert(compact.includes('Codex: Ждут квоту: 2 поручений, ближайшее продолжение время неизвестно'));
    assert.equal((compact.match(/Ждут квоту:/g) || []).length, 2);
    assert.match(compact, /подробности: full=true/);
    assert.match(compact, /queued-j: В ОЧЕРЕДИ/);
    assert(!compact.includes('archived-quota'));
    for (const j of jobs) assert(!compact.includes(j.id.slice(0, 8)));
    assert(compact.length <= 3000, 'Размер краткой сводки: ' + compact.length);
    const full = await team.status(undefined, undefined, false, true);
    for (const j of jobs) assert(full.includes('Номер поручения: ' + j.id), j.id);
    assert(full.includes(earliest.toISOString()));
    assert(!full.includes('Ждут квоту:'));
    byWho.antigravity = []; byWho.codex = [];
    assert(!(await team.status()).includes('Ждут квоту:'));
  } finally { stores.list = oldList; locks.ownerState = oldOwner; }
});
function work(name, owner, minutes) {
  json(path.join(RUN, 'works', name + '.json'), { name, title: 'Работа ' + name, owner, created_at: new Date(Date.now() - minutes * 60000).toISOString(), stages: [{ state: 'идёт' }] });
}
test('Р7: свой владелец, работа, без метки — имя и владелец', () => {
  work('one', 'alice', 16); work('two', 'bob', 28);
  const reminder = require('../common/work-owner').reminder;
  assert.match(reminder(RUN, undefined, { owner: 'alice' }), /Работа one/);
  assert(!reminder(RUN, undefined, { owner: 'alice' }).includes('bob'));
  assert.equal(reminder(RUN, undefined, { owner: 'alice', work: 'two' }), '');
  assert.match(reminder(RUN, undefined, { work: 'two' }), /владелец bob/);
  assert.match(reminder(RUN), /Работа one[\s\S]*Работа two/);
});
test('Р7: общий транспорт — одновременно, обратный порядок, отказ схемы, без метки', async () => {
  assert.deepEqual(require('../common/request-context').scope(null), {});
  const sent = [], transport = require('../common/public-transport').publicTransport({ send: async message => sent.push(message) });
  transport.onmessage = async message => {
    await new Promise(resolve => setTimeout(resolve, message.id === 1 ? 30 : 1));
    await transport.send({ id: message.id, result: { isError: message.id === 2, content: [{ type: 'text', text: require('../common/format').format('Команда', {}, 'Ответ') }] } });
  };
  await Promise.all([transport.onmessage({ id: 1, method: 'tools/call', params: { arguments: { owner: 'alice' } } }), transport.onmessage({ id: 2, method: 'tools/call', params: { arguments: { owner: 'bob' } } })]);
  assert.equal(sent[0].id, 2);
  for (const m of sent) { const text = m.result.content[0].text; assert.equal((text.match(/⚠/g) || []).length, 1); assert(text.includes(m.id === 1 ? 'alice' : 'bob')); assert(!text.includes(m.id === 1 ? 'bob' : 'alice')); }
  await transport.onmessage({ id: 3, method: 'tools/call' }); assert.match(sent.at(-1).result.content[0].text, /alice[\s\S]*bob/);
});
test('Р7: team_status через SDK принимает owner/work, включая ошибку схемы', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers/team/index.js')], env: { ...process.env }, stderr: 'pipe' });
  const client = new Client({ name: 'v7', version: '1' }); await client.connect(transport);
  try {
    const replies = await Promise.all(['alice', 'bob'].map(owner => client.callTool({ name: 'team_status', arguments: { owner, full: 'bad' } })));
    replies.forEach((reply, i) => { assert(reply.isError); const text = reply.content[0].text; assert(text.includes(i ? 'bob' : 'alice')); assert(!text.includes(i ? 'alice' : 'bob')); });
    const reply = await client.callTool({ name: 'team_status', arguments: { owner: 'alice', work: 'one' } });
    assert(!reply.isError); assert.equal((reply.content[0].text.match(/⚠/g) || []).length, 1); assert(!reply.content[0].text.split('Команда')[0].includes('bob'));
  } finally { await client.close(); await transport.close(); }
});
test('Р8: диагностический предел, размер части, цитата модели не является ошибкой', () => {
  const { outputLimit } = require('../common/agy-input');
  assert.equal(outputLimit({ output: 'exceeded the output token limit' }), null);
  assert.match(outputLimit({ agyError: 'exceeded the output token limit' }, 'строка\n'.repeat(94)), /по 40 строк/);
  assert.match(outputLimit({ stderr: 'OUTPUT TOKEN LIMIT' }, 'строка\n'.repeat(21)), /по 11 строк/);
  assert.match(outputLimit({ diagnostics: ['output token limit'] }, ''), /по 1 строк/);
});
test('Р8/Р9: дочерний процесс — предел без ожидания квоты; оба способа доставки и переход', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  for (const [n, mode, directive, long] of [[0, '', 'OUTPUT_LIMIT', false], [1, 'legacy', 'OUTPUT_LIMIT', false], [2, '', '', true], [3, 'legacy', '', true], [4, '', 'PROTOCOL_ERROR', true], [5, '', 'PROTOCOL_ERROR', false]]) {
    const log = path.join(RUN, 'agy-' + n + '.log'), folder = path.join(RUN, 'material-' + n), file = path.join(folder, 'source.txt');
    write(file, 'Строка материала\n'.repeat(long ? 10000 : 94));
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers/antigravity/index.js')], env: { ...process.env, AGY_PATH: path.join(__dirname, 'fake-agy-stream.js'), MOST_AGY_INPUT_FORMAT: mode, FAKE_STREAM_LOG: log }, stderr: 'pipe' });
    const client = new Client({ name: 'v7', version: '1' }); await client.connect(transport);
    try {
      const reply = await client.callTool({ name: 'antigravity_send', arguments: { folder, file, task: 'Проверь текст. ' + directive, mode: 'review' } });
      const id = /Задание (\S+) запущено/.exec(reply.content[0].text)?.[1]; assert(id, reply.content[0].text);
      let card, result;
      for (let i = 0; i < 20; i++) { result = await client.callTool({ name: 'antigravity_result', arguments: { id, wait_sec: 1 } }); card = read(path.join(RUN, 'state/jobs', id, 'card.json')); if (card.status !== 'running') break; }
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(calls.length, directive === 'PROTOCOL_ERROR' ? 2 : 1);
      for (const call of calls) {
        const inline = !call.args.includes('--print');
        assert.equal(call.event.message.content.includes('Весь материал приложен, файлы не открывать.'), inline);
        assert(call.files.every(text => !text.includes('Весь материал приложен, файлы не открывать.')));
      }
      if (directive === 'OUTPUT_LIMIT') { assert.equal(card.status, 'failed'); assert.match(result.content[0].text, /Ответ не поместился.*по 40 строк/); assert(!card.nextAttemptAt); assert(!fs.existsSync(path.join(RUN, 'state/jobs', id, 'result.txt'))); }
      else assert.equal(card.status, 'done');
    } finally { await client.close(); await transport.close(); }
  }
});
test('Р10: ворота Codex и Antigravity — формы 1/2/5/11/21, прежняя форма и строгий отказ', () => {
  const stores = require('../common/team-store'), base = 'a'.repeat(40), candidate = 'b'.repeat(40);
  for (const who of ['codex', 'antigravity']) for (const [last, ok] of [
    ['ПРИНЯТО', true], ...['1 блокирующее', '2 блокирующих', '5 блокирующих', '11 блокирующих', '21 блокирующее', '1 блокирующих'].map(s => ['НЕ ПРИНЯТО: ' + s, true]),
    ...['0 блокирующих', '-1 блокирующее', '1 блокирующее лишнее', '1 блокирующая'].map(s => ['НЕ ПРИНЯТО: ' + s, false]),
  ]) {
    const id = 'vote', dir = path.join(stores.roots()[who], id), text = 'Замечания\n' + last;
    const file = who === 'codex' ? id + '.attempt-0.result.txt' : 'result.txt';
    write(path.join(dir, file), text); json(path.join(dir, 'meta.json'), { hash: crypto.createHash('sha256').update(text).digest('hex') });
    json(path.join(dir, 'card.json'), { id, status: 'done', mode: 'review', task: base + ' ' + candidate + ' #d17b3da7' });
    const run = () => stores.review(who, id, base, candidate, last === 'ПРИНЯТО' ? 'ПРИНЯТО' : 'НЕ ПРИНЯТО', '#d17b3da7');
    if (ok) assert.equal(run().reviewText, text); else assert.throws(run, /Последняя строка/);
  }
});
(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) try { await fn(); passed++; console.log('OK ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed); process.exitCode = failed ? 1 : 0;
})();
