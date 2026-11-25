'use strict';
// cache-622: порядок частей запроса ради кэша префикса (М1), продолжение разговора Antigravity (М2), учёт токенов
// DeepSeek и agy (М3), модель Claude-исполнителя по классу (М4). Настоящие серверы через MCP и фейковые CLI; Claude —
// настоящий execute с подменой spawn (как team-v48-adapters). Тесты Kimi (порядок входа, М5, токены) — в kimi-full.js.
const fs = require('fs'), path = require('path'), assert = require('assert'), os = require('os');
const { serverReady } = require('./runner-support');
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-c622-'));
Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_TEST_KEEP: '1', MOST_NOTIFY: 'off', MOST_CLIENT: 'claude', MOST_CLAUDE_CONFIGS: '[]', MOST_JOB_ID: '',
  MOST_CODEX_CONFIG: path.join(RUN, 'missing.toml'), MOST_AGY_MCP_CONFIG: path.join(RUN, 'missing.json'), MOST_AGY_CONFIG: path.join(RUN, 'missing-permissions.json'), CODEX_PATH: path.join(__dirname, 'fake-codex.js') });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tests = [], test = (name, fn) => tests.push({ name, fn });
const text = r => (r.content || []).map(c => c.text || '').join('\n');
const log = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

// Позиции частей в тексте: каждая есть и идут строго по возрастанию.
function inOrder(prompt, parts, label) {
  const at = parts.map(p => { const i = prompt.indexOf(p); assert(i >= 0, label + ': нет «' + p + '» во входе:\n' + prompt.slice(0, 3000)); return i; });
  for (let i = 1; i < at.length; i++) assert(at[i] > at[i - 1], label + ': «' + parts[i] + '» должно идти после «' + parts[i - 1] + '» (' + at.join(', ') + ')');
}

async function server(name, env = {}) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers', name, 'index.js')], env: { ...process.env, NODE_ENV: 'test', ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'c622', version: '1' }); await client.connect(transport);
  await serverReady(path.join(RUN, 'state'), transport.pid);
  return { client, close: async () => { await client.close(); await transport.close(); } };
}
const material = path.join(RUN, 'material'); write(path.join(material, 'вложение.txt'), 'ВЛОЖЕНИЕ-ОДИН');

// ---------- общий модуль (codex, claude, deepseek) ----------
test('М1: prompt-order — шапка → материал текстом → вложения → задача; больше порога — путь; шапка постоянна', () => {
  const po = require('../common/prompt-order');
  const tf = path.join(RUN, 'po-input.txt'); write(tf, 'МАТЕРИАЛ-ОДИН');
  const af = path.join(RUN, 'po-attach.txt'); write(af, '\n\n----- вложение: x -----\nВЛОЖЕНИЕ-ОДИН\n----- конец вложения: x -----');
  const job = { task: 'ЗАДАЧА-ОДИН', textFile: tf, attachFile: af };
  const p = po.build(job);
  inOrder(p, ['Это отдельное поручение', 'Только чтение', 'Не обходи ограничения', 'Материал:\nМАТЕРИАЛ-ОДИН', 'Материал вложен ниже', 'ВЛОЖЕНИЕ-ОДИН', 'Поручение:\nЗАДАЧА-ОДИН'], 'build');
  assert(p.trimEnd().endsWith('ЗАДАЧА-ОДИН'), 'задача — последней, без строки-напоминания после неё');
  assert(!p.includes('Материал в файле'), 'материал до порога вкладывается текстом');
  const big = po.build(job, { limit: 5 });
  inOrder(big, ['Не обходи ограничения', 'Материал в файле: ' + tf, 'ВЛОЖЕНИЕ-ОДИН', 'ЗАДАЧА-ОДИН'], 'больше порога');
  assert(!big.includes('МАТЕРИАЛ-ОДИН'));
  assert.equal(po.inlineLimit({}), 300000, 'порог по умолчанию — 300 000 знаков');
  assert.equal(po.inlineLimit({ MOST_INLINE_MATERIAL_CHARS: '1000' }), 1000);
  // Шапка одинакова у разных поручений одного доступа (кэш префикса), различается только по доступу.
  const other = po.build({ task: 'ДРУГОЕ', textFile: null });
  assert.equal(other.split('\n').slice(0, 3).join('\n'), p.split('\n').slice(0, 3).join('\n'));
  assert.notEqual(po.head({ write: true })[1], po.head({})[1]);
  // Все три адаптера собирают текст этим модулем; старой строки «Материал в файле» в серверах нет.
  for (const who of ['codex', 'claude', 'deepseek']) {
    const src = fs.readFileSync(path.join(ROOT, 'servers', who, 'index.js'), 'utf8');
    assert(src.includes("child.stdin.end(require('../../common/prompt-order').build(job));"), who + ': сборка через prompt-order');
    assert(!src.includes("'Материал в файле: '"), who + ': путь к материалу больше не собирается в сервере');
  }
});

test('М1: Codex — настоящий codex_send: материал и вложения раньше задачи; больше порога — путь', async () => {
  const lf = path.join(RUN, 'codex.log');
  for (const [limit, inline] of [[undefined, true], ['5', false]]) {
    const s = await server('codex', { FAKE_CODEX_LOG: lf, ...(limit ? { MOST_INLINE_MATERIAL_CHARS: limit } : {}) });
    try {
      const before = log(lf).length;
      const r = await s.client.callTool({ name: 'codex_send', arguments: { folder: material, role: 'совет', task: 'ЗАДАЧА-КОДЕКС', text: 'МАТЕРИАЛ-КОДЕКС', files: [path.join(material, 'вложение.txt')] } });
      assert(!r.isError, text(r));
      const id = /Номер поручения: (\S+)/.exec(text(r))?.[1]; assert(id, text(r));
      for (let i = 0; i < 20 && log(lf).length === before; i++) await s.client.callTool({ name: 'codex_result', arguments: { id, wait_sec: 2 } });
      assert.equal(log(lf).length, before + 1, text(r));
      const p = log(lf)[before].prompt;
      if (inline) inOrder(p, ['Это отдельное поручение', 'Материал:\nМАТЕРИАЛ-КОДЕКС', 'ВЛОЖЕНИЕ-ОДИН', 'Поручение:\nЗАДАЧА-КОДЕКС'], 'codex');
      else { inOrder(p, ['Это отдельное поручение', 'Материал в файле: ', 'ВЛОЖЕНИЕ-ОДИН', 'ЗАДАЧА-КОДЕКС'], 'codex путь'); assert(!p.includes('МАТЕРИАЛ-КОДЕКС')); }
      assert(p.trimEnd().endsWith('ЗАДАЧА-КОДЕКС'));
    } finally { await s.close(); }
  }
});

test('М1/М3: DeepSeek — настоящий deepseek_send: порядок частей; токены из status/step_end dsh (сумма шагов)', async () => {
  const lf = path.join(RUN, 'dsh.log');
  const s = await server('deepseek', { DSH_PATH: path.join(__dirname, 'fake-dsh.cmd'), MOST_DSH_NO_PROFILES: '1', FAKE_PROMPT_LOG: lf });
  try {
    const r = await s.client.callTool({ name: 'deepseek_send', arguments: { folder: material, role: 'совет', task: 'ЗАДАЧА-DS USAGE', text: 'МАТЕРИАЛ-DS', files: [path.join(material, 'вложение.txt')] } });
    assert(!r.isError, text(r));
    const id = /Номер поручения: (\S+)/.exec(text(r))?.[1]; assert(id, text(r));
    let card; for (let i = 0; i < 100; i++) { card = read(path.join(RUN, 'state', 'deepseek-jobs', id + '.json')); if (!['queued', 'running'].includes(card.status)) break; await sleep(100); }
    assert.equal(card.status, 'done', JSON.stringify(card));
    const p = log(lf).at(-1).prompt;
    inOrder(p, ['Это отдельное поручение', 'Материал:\nМАТЕРИАЛ-DS', 'ВЛОЖЕНИЕ-ОДИН', 'Поручение:\nЗАДАЧА-DS'], 'deepseek');
    // Шаг 1: 1295 + 13056 + 0, шаг 2: 100 + 14336 + 7 → вход; из кэша — чтение кэша; выход — сумма.
    assert.deepEqual(card.tokens, { tokens_in: 1295 + 13056 + 100 + 14336 + 7, tokens_cached: 13056 + 14336, tokens_out: 2 + 50 });
  } finally { await s.close(); }
});

test('М3: usage — поля DeepSeek API, dsh, Anthropic и agy; сумма шагов; Kimi wire.jsonl — последний ход', () => {
  const u = require('../common/usage');
  assert.deepEqual(u.genericTokens({ prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20, completion_tokens: 5 }), { tokens_in: 120, tokens_out: 5, tokens_cached: 100 });
  assert.deepEqual(u.genericTokens({ prompt_tokens: 130, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 30, completion_tokens: 5 }), { tokens_in: 130, tokens_out: 5, tokens_cached: 100 });
  assert.deepEqual(u.genericTokens({ inputTokens: 1295, outputTokens: 2, cacheReadTokens: 13056, cacheWriteTokens: 0, totalTokens: 14353 }), { tokens_in: 14351, tokens_cached: 13056, tokens_out: 2 });
  assert.deepEqual(u.genericTokens({ input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 3 }), { tokens_in: 115, tokens_out: 3, tokens_cached: 100 });
  assert.deepEqual(u.genericTokens({ input_tokens: 2919, output_tokens: 101, cache_read_tokens: 11944, total_tokens: 3020 }), { tokens_in: 2919 + 11944, tokens_out: 101, tokens_cached: 11944 }, 'agy: input без кэша');
  assert.deepEqual(u.codexTokens({ usage: { input_tokens: 50, cached_input_tokens: 40, output_tokens: 2 } }), { tokens_in: 50, tokens_out: 2, tokens_cached: 40 });
  assert.deepEqual(u.addTokens({ tokens_in: 1, tokens_cached: 0, tokens_out: 1 }, { tokens_in: 2, tokens_cached: 2, tokens_out: 3 }), { tokens_in: 3, tokens_cached: 2, tokens_out: 4 });
  const wire = [{ type: 'turn.prompt' }, { type: 'usage.record', usage: { inputOther: 5, output: 1 } }, { type: 'turn.prompt' },
    { type: 'usage.record', usage: { inputOther: 10, output: 2, inputCacheRead: 30, inputCacheCreation: 1 } }, { type: 'usage.record', usage: { inputOther: 4, output: 3 } }].map(e => JSON.stringify(e)).join('\n');
  assert.deepEqual(u.kimiWireTokens(wire), { tokens_in: 45, tokens_cached: 30, tokens_out: 5 });
  assert.equal(u.kimiTokens('нет_такого', path.join(RUN, 'нет-дома')), null, 'нет журнала — токенов нет, без догадок');
});

// ---------- Claude (М1, М4) ----------
function internals(who, names) {
  const Module = require('module'), file = path.resolve(__dirname, '../servers', who, 'index.js'), m = new Module(file, module);
  m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  const src = fs.readFileSync(file, 'utf8'), end = src.lastIndexOf('\n(async () => {');
  assert(end > 0); m._compile(src.slice(0, end) + '\nmodule.exports = { ' + names + ' };', file);
  return m.exports;
}
test('М1/М4: Claude — порядок частей и --model из карточки (sonnet); без модели флага нет', async () => {
  const cp = require('child_process'), realSpawn = cp.spawn, realExec = cp.execFileSync, lf = path.join(RUN, 'claude.log');
  const old = { CLAUDE_PATH: process.env.CLAUDE_PATH, FAKE_PROMPT_LOG: process.env.FAKE_PROMPT_LOG };
  Object.assign(process.env, { CLAUDE_PATH: process.execPath, FAKE_PROMPT_LOG: lf });
  cp.execFileSync = (bin, a, ...rest) => Array.isArray(a) && a[0] === '--help' ? require('../common/claude-args').REQUIRED_FLAGS.join(' ') : realExec(bin, a, ...rest);
  let captured = [];
  cp.spawn = (bin, a, opts) => { captured.push(a); return realSpawn(process.execPath, [path.join(__dirname, 'fake-claude.js')], opts); };
  try {
    const api = internals('claude', 'execute, save, load, active');
    const tf = path.join(RUN, 'claude-input.txt'); write(tf, 'МАТЕРИАЛ-CL');
    for (const [id, model] of [['c622-claude-sonnet', 'sonnet'], ['c622-claude-default', undefined]]) {
      const card = { id, status: 'running', member: 'claude', from: 'claude', folder: material, write: false, task: 'ЗАДАЧА-CL', textFile: tf, role: 'совет', startedAt: new Date().toISOString(), ...(model ? { model } : {}) };
      api.save(card); captured = [];
      await api.execute(card, null);
      for (let i = 0; i < 100 && api.active.has(id); i++) await sleep(50);
      assert.equal(api.load(id).status, 'done', JSON.stringify(api.load(id)));
      const args = captured.at(-1);
      if (model) assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'sonnet']);
      else assert(!args.includes('--model'), 'модель аккаунта — без флага');
      inOrder(log(lf).at(-1).prompt, ['Это отдельное поручение', 'Материал:\nМАТЕРИАЛ-CL', 'Поручение:\nЗАДАЧА-CL'], 'claude');
    }
  } finally {
    cp.spawn = realSpawn; cp.execFileSync = realExec;
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  // Постановка: send выбирает модель таблицей model-choice('claude') и пишет строку выбора; явная model сильнее.
  const src = fs.readFileSync(path.join(ROOT, 'servers', 'claude', 'index.js'), 'utf8');
  assert(src.includes("mc.choose('claude', { ...a, effort: undefined })") && src.includes("const chosenModel = choice.named ? a.model : choice.model;"));
  assert(/model: z\.string\(\)\.regex\(/.test(src), 'model в схеме claude_send');
});

// ---------- Antigravity (М1, М2) ----------
test('М1: Antigravity — постоянные правила → материал и вложения → поручение → реестр и метки; метки работают в конце', async () => {
  const lf = path.join(RUN, 'agy-order.log');
  const s = await server('antigravity', { AGY_PATH: path.join(__dirname, 'fake-agy-stream.js'), FAKE_STREAM_LOG: lf });
  try {
    const r = await s.client.callTool({ name: 'antigravity_send', arguments: { folder: material, mode: 'text', model: 'test-model', task: 'ЗАДАЧА-AG ECHO_MARKERS', text: 'МАТЕРИАЛ-AG', files: [path.join(material, 'вложение.txt')] } });
    const id = /Задание (\S+) запущено/.exec(text(r))?.[1]; assert(id, text(r));
    let card; for (let i = 0; i < 40; i++) { await s.client.callTool({ name: 'antigravity_result', arguments: { id, wait_sec: 1 } }); card = read(path.join(RUN, 'state/jobs', id, 'card.json')); if (card.status !== 'running') break; }
    assert.equal(card.status, 'done', JSON.stringify(card));
    const p = log(lf).at(-1).event.message.content;
    inOrder(p, ['Весь материал приложен', 'ПРАВИЛА ОТВЕТА:', 'Не вызывай инструменты изменения файлов', 'Материал:\nМАТЕРИАЛ-AG', 'Материал вложен ниже', 'ВЛОЖЕНИЕ-ОДИН', '=== ПОРУЧЕНИЕ ===', 'ЗАДАЧА-AG', 'ПРАВИЛА ОТВЕТА (окончание):', 'Участники · rev', 'MCP разрешены только по маскам', '<<<РЕЗУЛЬТАТ-'], 'antigravity');
    assert(p.indexOf('<<<РЕЗУЛЬТАТ-') > p.lastIndexOf('ЗАДАЧА-AG'), 'метки — после задачи');
    // Разметка результата по-прежнему работает: вне меток — отброшено, внутри — результат.
    const result = fs.readFileSync(path.join(RUN, 'state/jobs', id, 'result.txt'), 'utf8');
    assert.equal(result.trim(), 'ГОТОВЫЙ ТЕКСТ', result);
    assert(!(card.warnings || []).some(w => /метки результата не найдены/.test(w)), JSON.stringify(card.warnings));
    // Поручение в карточке — без материала и вложений (они отдельным блоком).
    assert(!card.poruchenie.includes('МАТЕРИАЛ-AG') && card.material.includes('МАТЕРИАЛ-AG') && card.material.includes('ВЛОЖЕНИЕ-ОДИН'));
    // Режим замечаний: текст для работы и опора — до поручения, реестр — после.
    const file = path.join(material, 'текст.txt'); write(file, 'Строка проверки\n');
    const r2 = await s.client.callTool({ name: 'antigravity_send', arguments: { folder: material, file, mode: 'review', model: 'test-model', task: 'ЗАДАЧА-ЗАМЕЧАНИЯ' } });
    const id2 = /Задание (\S+) запущено/.exec(text(r2))?.[1]; assert(id2, text(r2));
    for (let i = 0; i < 40; i++) { await s.client.callTool({ name: 'antigravity_result', arguments: { id: id2, wait_sec: 1 } }); if (read(path.join(RUN, 'state/jobs', id2, 'card.json')).status !== 'running') break; }
    inOrder(log(lf).at(-1).event.message.content, ['ПРАВИЛА ОТВЕТА:', 'Строки текста пронумерованы', '=== ТЕКСТ ДЛЯ РАБОТЫ ===', '1| Строка проверки', '=== ПОРУЧЕНИЕ ===', 'ЗАДАЧА-ЗАМЕЧАНИЯ', 'Участники · rev'], 'antigravity review');
  } finally { await s.close(); }
});

test('М1: Antigravity, файловый режим (legacy) — пути временной папки в самом конце', () => {
  const api = internals('antigravity', 'buildFilePrompt, buildInlinePrompt');
  const dir = fs.mkdtempSync(path.join(RUN, 'agy-input-'));
  const markers = { start: '<<<РЕЗУЛЬТАТ-ABCDEF>>>', end: '<<<КОНЕЦ-РЕЗУЛЬТАТА-ABCDEF>>>' };
  const fp = api.buildFilePrompt('ЗАДАЧА-Ф', 'pravka', { text: 'ТЕКСТ', copyName: 'tekst.txt' }, [], dir, markers, 'Материал:\nМАТ-Ф');
  inOrder(fp.prompt, ['ПРАВИЛА ОТВЕТА:', 'Материал:\nМАТ-Ф', '=== ПОРУЧЕНИЕ ===', 'ЗАДАЧА-Ф', markers.start, 'Тексты лежат файлами', path.join(dir, 'tekst.txt')], 'файловый режим');
  const inline = api.buildInlinePrompt('ЗАДАЧА', 'tekst', null, [], markers, '');
  assert(inline.trimEnd().endsWith('в отчёте не повторяй.'), 'последний пункт — правило меток');
});

test('М2: agy-input — id разговора из init/step_update/result; разнобой — null; расход этого хода — сумма шагов', () => {
  const ai = require('../common/agy-input');
  const ev = (o) => JSON.stringify(o);
  const raw = [ev({ event: 'init', conversation_id: 'aaaaaaaa-1111', init: {} }),
    ev({ event: 'step_update', step_update: { conversation_id: 'aaaaaaaa-1111', step_type: 'agent_response', usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 1, total_tokens: 12 } } }),
    ev({ event: 'result', result: { conversation_id: 'aaaaaaaa-1111', status: 'SUCCESS', response: 'ок', usage: { input_tokens: 99, output_tokens: 9, total_tokens: 108 } } })].join('\n');
  const r = ai.parseResults(raw);
  assert.equal(r.conversationId, 'aaaaaaaa-1111');
  assert.equal(r.turnUsage.input_tokens, 10); assert.equal(r.turnUsage.output_tokens, 2);
  assert.equal(ai.parseResults(raw.replace(/"conversation_id":"aaaaaaaa-1111","status"/, '"conversation_id":"bbbbbbbb-2222","status"')).conversationId, null, 'два разных id — ненадёжно');
  assert.equal(ai.parseResults(ev({ event: 'result', result: { status: 'SUCCESS', response: 'x' } })).conversationId, null);
});

test('М2: Antigravity continue_id — id разговора в карточке, --conversation, те же проверки; второе продолжение — отказ', async () => {
  const lf = path.join(RUN, 'agy-cont.log');
  const s = await server('antigravity', { AGY_PATH: path.join(__dirname, 'fake-agy-stream.js'), FAKE_STREAM_LOG: lf, FAKE_AGY_CONVERSATION: 'conv-c622', FAKE_AGY_MODELS: 'test-model  Test\nother-model  Other' });
  const send = async a => { const r = await s.client.callTool({ name: 'antigravity_send', arguments: { folder: material, mode: 'text', model: 'test-model', role: 'совет', ...a } }); return { r, id: /Задание (\S+) запущено/.exec(text(r))?.[1] }; };
  const done = async id => { let c; for (let i = 0; i < 40; i++) { await s.client.callTool({ name: 'antigravity_result', arguments: { id, wait_sec: 1 } }); c = read(path.join(RUN, 'state/jobs', id, 'card.json')); if (c.status !== 'running') break; } return c; };
  try {
    const first = await send({ task: 'первый ход' }); assert(first.id, text(first.r));
    const c1 = await done(first.id); assert.equal(c1.status, 'done', JSON.stringify(c1));
    assert.match(c1.conversationId, /^conv-c622-/, 'id разговора захвачен из потока');
    assert(!log(lf).at(-1).args.includes('--conversation'), 'первый ход — новый разговор');
    // Другая модель, роль или папка — отказ до задания.
    for (const [extra, re] of [[{ model: 'other-model' }, /продолжение не меняет модель/], [{ role: 'проверка' }, /сохраните роль/], [{ folder: RUN }, /сохраните папку проекта/], [{ continue_id: 'нет_такого_id' }, /нет карточки Antigravity|некорректный номер/]]) {
      const bad = await send({ task: 'второй ход', continue_id: first.id, ...extra });
      assert(!bad.id && re.test(text(bad.r)), JSON.stringify(extra) + ': ' + text(bad.r));
    }
    const second = await send({ task: 'второй ход', continue_id: first.id, model: undefined }); assert(second.id, text(second.r)); // модель не названа — берётся модель исходного разговора
    assert.match(text(second.r), /Продолжение разговора Antigravity conv-c622-/);
    const c2 = await done(second.id); assert.equal(c2.status, 'done', JSON.stringify(c2));
    const args = log(lf).at(-1).args;
    assert.deepEqual(args.slice(args.indexOf('--conversation'), args.indexOf('--conversation') + 2), ['--conversation', c1.conversationId]);
    assert.equal(c2.continuedFrom, first.id); assert.equal(c2.conversationId, c1.conversationId);
    assert.equal(read(path.join(RUN, 'state/jobs', first.id, 'card.json')).continuedBy, second.id);
    assert.match(c2.modelChoiceLine, /продолжение разговора/);
    const again = await send({ task: 'ещё', continue_id: first.id });
    assert(!again.id && /уже продолжено/.test(text(again.r)), text(again.r));
    // Без захваченного id — честный отказ.
    const card = read(path.join(RUN, 'state/jobs', second.id, 'card.json')); delete card.conversationId;
    write(path.join(RUN, 'state/jobs', second.id, 'card.json'), JSON.stringify(card));
    const noConv = await send({ task: 'ещё', continue_id: second.id });
    assert(!noConv.id && /нет id разговора agy/.test(text(noConv.r)), text(noConv.r));
  } finally { await s.close(); }
});

// ---------- исправление по взгляду участников (Б1–Б5, У1–У4) ----------
test('Б1: Antigravity — порог материала 300 000 знаков: ровно 300 000 — текстом, 300 001 — путём (файл в --add-dir); порядок тот же', async () => {
  const lf = path.join(RUN, 'agy-limit.log');
  const s = await server('antigravity', { AGY_PATH: path.join(__dirname, 'fake-agy-stream.js'), FAKE_STREAM_LOG: lf });
  try {
    for (const [n, inline] of [[300000, true], [300001, false]]) {
      const big = 'я'.repeat(n - 1) + 'Ж';
      const r = await s.client.callTool({ name: 'antigravity_send', arguments: { folder: material, mode: 'text', model: 'test-model', task: 'ЗАДАЧА-ПОРОГ', text: big } });
      const id = /Задание (\S+) запущено/.exec(text(r))?.[1]; assert(id, text(r));
      let card; for (let i = 0; i < 60; i++) { await s.client.callTool({ name: 'antigravity_result', arguments: { id, wait_sec: 1 } }); card = read(path.join(RUN, 'state/jobs', id, 'card.json')); if (card.status !== 'running') break; }
      assert.equal(card.status, 'done', JSON.stringify(card).slice(0, 2000));
      const row = log(lf).at(-1), p = row.event.message.content;
      if (inline) {
        assert(p.includes(big), n + ': материал вклеен текстом'); assert(!p.includes('Материал в файле:')); assert(!row.args.includes('--add-dir'));
        inOrder(p, ['Весь материал приложен', 'ПРАВИЛА ОТВЕТА:', 'Материал:\n', '=== ПОРУЧЕНИЕ ===', 'ЗАДАЧА-ПОРОГ'], 'agy 300000');
      } else {
        assert(!p.includes(big), n + ': материал не вклеен');
        const file = /Материал в файле: (.+)/.exec(p)?.[1]?.trim(); assert(file, 'строка пути');
        assert.equal(path.dirname(file), row.args[row.args.indexOf('--add-dir') + 1], 'папка материала открыта agy через --add-dir');
        assert(row.files.includes(big), 'agy видит файл материала');
        assert(!p.includes('Весь материал приложен'), 'пометка «всё приложено» не ставится');
        inOrder(p, ['Материал поручения лежит файлом', 'ПРАВИЛА ОТВЕТА:', 'Материал в файле: ', '=== ПОРУЧЕНИЕ ===', 'ЗАДАЧА-ПОРОГ', 'ПРАВИЛА ОТВЕТА (окончание):'], 'agy 300001');
      }
    }
  } finally { await s.close(); }
});

test('Б5/У1/У4/Б3: Antigravity — продолжение failed-карточки; расход хода без usage шагов; обрыв до отметки; смена модели при повторе по квоте', async () => {
  const lf = path.join(RUN, 'agy-fix.log');
  const s = await server('antigravity', { AGY_PATH: path.join(__dirname, 'fake-agy-stream.js'), FAKE_STREAM_LOG: lf, FAKE_AGY_CONVERSATION: 'conv-fix', FAKE_AGY_USAGE_TOTAL: '1',
    FAKE_AGY_MODELS: 'test-model  Test\nother-model  Other', MOST_QUEUE_TICK_MS: '300' });
  const send = async a => { const r = await s.client.callTool({ name: 'antigravity_send', arguments: { folder: material, mode: 'text', model: 'test-model', role: 'совет', ...a } }); return { r, id: /Задание (\S+) запущено/.exec(text(r))?.[1] }; };
  const cardOf = id => read(path.join(RUN, 'state/jobs', id, 'card.json'));
  const done = async (id, until = c => !['running', 'queued', 'waiting_quota'].includes(c.status)) => { let c; for (let i = 0; i < 60; i++) { await s.client.callTool({ name: 'antigravity_result', arguments: { id, wait_sec: 1 } }); c = cardOf(id); if (until(c)) break; } return c; };
  const patch = (id, fn) => { const c = cardOf(id); fn(c); write(path.join(RUN, 'state/jobs', id, 'card.json'), JSON.stringify(c)); };
  try {
    const first = await send({ task: 'ход один' }); assert(first.id, text(first.r));
    const c1 = await done(first.id); assert.equal(c1.status, 'done', JSON.stringify(c1));
    assert.deepEqual(c1.usageTotal, { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 });
    // Б5: неуспешный (failed) ход с id разговора продолжается, как у других адаптеров.
    patch(first.id, c => { c.status = 'failed'; c.error = 'пробная ошибка'; });
    const second = await send({ task: 'ход два', continue_id: first.id }); assert(second.id, text(second.r));
    const c2 = await done(second.id); assert.equal(c2.status, 'done', JSON.stringify(c2));
    const args2 = log(lf).at(-1).args; assert.equal(args2[args2.indexOf('--conversation') + 1], c1.conversationId);
    // У1: у продолжения нет usage шагов — расход хода = разность накопленных итогов (2020 − 1010), а не итог разговора.
    assert.deepEqual(c2.usage, { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 }, 'расход этого хода');
    assert.deepEqual(c2.usageTotal, { input_tokens: 2000, output_tokens: 20, total_tokens: 2020 });
    assert.deepEqual(c2.tokens, { tokens_in: 1000, tokens_out: 10 });
    // Б5: прочие проверки сохраняются — неподтверждённая остановка, отменённая карточка — отказ.
    patch(second.id, c => { c.stopUnconfirmed = { pid: 1, reason: 'проба' }; });
    const stopBad = await send({ task: 'ход три', continue_id: second.id });
    assert(!stopBad.id && /остановка исходного поручения .* не подтверждена/.test(text(stopBad.r)), text(stopBad.r));
    patch(second.id, c => { delete c.stopUnconfirmed; c.status = 'cancelled'; });
    const cancelled = await send({ task: 'ход три', continue_id: second.id });
    assert(!cancelled.id && /не завершено \(статус cancelled\)/.test(text(cancelled.r)), text(cancelled.r));
    patch(second.id, c => { c.status = 'done'; });
    // У4: обрыв между сохранением карточки-продолжения и отметкой continuedBy — повторно продолжить нельзя.
    const orphan = 'orphan-' + Date.now();
    write(path.join(RUN, 'state/jobs', orphan, 'card.json'), JSON.stringify({ ...cardOf(second.id), id: orphan, continuedFrom: second.id, status: 'lost' }));
    const afterCrash = await send({ task: 'ход три', continue_id: second.id });
    assert(!afterCrash.id && /уже продолжено \(orphan-/.test(text(afterCrash.r)), text(afterCrash.r));
    assert.equal(cardOf(second.id).continuedBy, undefined, 'на исходной отметки нет — она ставится только после сохранения новой карточки');
    fs.rmSync(path.join(RUN, 'state/jobs', orphan), { recursive: true, force: true });
    // Б3: продолжение упирается в квоту; при повторе модель запуска сменилась (отложенный выбор модели) — запуск с
    // --conversation на другой модели запрещён: понятная ошибка, отметка с исходной снимается.
    const third = await send({ task: 'ход три QUOTA_ONCE', continue_id: second.id }); assert(third.id, text(third.r));
    const q = await done(third.id, c => c.status === 'waiting_quota' || c.status === 'failed' || c.status === 'done');
    assert.equal(q.status, 'waiting_quota', JSON.stringify(q));
    assert.equal(cardOf(second.id).continuedBy, third.id);
    patch(third.id, c => { c.modelSelectionPending = true; c.requestedModel = 'other-model'; c.modelByBridge = false; c.nextAttemptAt = new Date(0).toISOString(); });
    const c3 = await done(third.id, c => !['running', 'queued', 'waiting_quota'].includes(c.status));
    assert.equal(c3.status, 'failed', JSON.stringify(c3));
    assert.match(c3.error, /не меняет модель: разговор шёл на test-model, запуск — на other-model/);
    assert.equal(log(lf).filter(x => x.event.message.content.includes('ход три QUOTA_ONCE')).length, 1, 'второй запуск agy не состоялся');
    assert.equal(cardOf(second.id).continuedBy, undefined, 'отметка «продолжено» снята');
    // Причина видна и в antigravity_result.
    const res = await s.client.callTool({ name: 'antigravity_result', arguments: { id: third.id } });
    assert.match(text(res), /не меняет модель/);
  } finally { await s.close(); }
});

test('Б2/У2: DeepSeek — поле change даёт changeReview и review_high (v4-pro); usage шага в полях API разбирается', async () => {
  const lf = path.join(RUN, 'dsh-b2.log');
  const changeReview = { name: 'ds-vote', base: 'a'.repeat(40), candidate: 'b'.repeat(40) };
  const changeFile = path.join(RUN, 'state', 'changes', changeReview.name + '.json');
  write(changeFile, JSON.stringify({ ...changeReview, status: 'кандидат' }));
  const s = await server('deepseek', { DSH_PATH: path.join(__dirname, 'fake-dsh.cmd'), MOST_DSH_NO_PROFILES: '1', FAKE_PROMPT_LOG: lf });
  const finish = async r => { const id = /Номер поручения: (\S+)/.exec(text(r))?.[1]; assert(id, text(r)); let card; for (let i = 0; i < 100; i++) { card = read(path.join(RUN, 'state', 'deepseek-jobs', id + '.json')); if (!['queued', 'running'].includes(card.status)) break; await sleep(100); } return card; };
  try {
    const r = await s.client.callTool({ name: 'deepseek_send', arguments: { folder: material, role: 'проверка', task: 'Дай оценку этому изменению USAGE_API', change: changeReview.name } });
    assert(!r.isError, text(r));
    const card = await finish(r);
    assert.equal(card.status, 'done', JSON.stringify(card)); assert.deepEqual(card.changeReview, changeReview);
    assert.equal(card.model, 'deepseek-v4-pro', 'голос по изменению — review_high'); assert.match(card.modelChoiceLine, /review_high/);
    assert.deepEqual(card.tokens, { tokens_in: 1000, tokens_out: 7, tokens_cached: 900 }, 'У2: prompt_cache_hit/miss_tokens в step_end');
    const plain = await finish(await s.client.callTool({ name: 'deepseek_send', arguments: { folder: material, role: 'проверка', task: 'Дай оценку этому изменению' } }));
    assert.equal(plain.changeReview, undefined); assert.notEqual(plain.model, 'deepseek-v4-pro');
    for (const [extra, re] of [[{ change: 'missing' }, /не найдено/], [{ role: 'совет' }, /допустим для нового поручения DeepSeek/]]) {
      const bad = await s.client.callTool({ name: 'deepseek_send', arguments: { folder: material, role: 'проверка', task: 'x', change: changeReview.name, ...extra } });
      assert(bad.isError, JSON.stringify(extra)); assert.match(text(bad), re);
    }
    write(changeFile, JSON.stringify({ ...changeReview, status: 'слито' }));
    const closed = await s.client.callTool({ name: 'deepseek_send', arguments: { folder: material, role: 'проверка', task: 'x', change: changeReview.name } });
    assert(closed.isError); assert.match(text(closed), /открытая карточка/);
  } finally { await s.close(); }
  // Codex — та же общая проверка (common/change-review).
  assert(fs.readFileSync(path.join(ROOT, 'servers', 'codex', 'index.js'), 'utf8').includes("require('../../common/change-review').resolve(a, stateDir, 'Codex')"));
});

test('У3: dsh — tokens_in + tokens_out == totalTokens шага (живая проба dsh 23.11.2026 и запись в кэш)', () => {
  const u = require('../common/usage');
  for (const step of [{ inputTokens: 1303, outputTokens: 2, cacheReadTokens: 9472, cacheWriteTokens: 0, totalTokens: 10777 }, // живая проба
    { inputTokens: 100, outputTokens: 50, cacheReadTokens: 14336, cacheWriteTokens: 7, totalTokens: 14493 }]) {
    const t = u.genericTokens(step);
    assert.equal(t.tokens_in + t.tokens_out, step.totalTokens, JSON.stringify(step));
  }
});

test('М2: сценарий — продолжение только у участников с continue_id; Claude получает memory_file', () => {
  const sc = require('../common/scenario');
  assert.deepEqual([...sc.CAN_CONTINUE].sort(), ['antigravity', 'codex', 'deepseek', 'kimi']);
  const src = fs.readFileSync(path.join(ROOT, 'common', 'scenario.js'), 'utf8');
  assert(src.includes('sess.member === member && CAN_CONTINUE.has(member)'));
});

(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) try { await fn(); passed++; console.log('OK ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed); process.exitCode = failed ? 1 : 0;
  if (!failed) try { fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 5 }); } catch {} // при провале папку оставляем для разбора
})();
