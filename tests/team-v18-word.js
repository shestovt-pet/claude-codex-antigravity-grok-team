'use strict';
// team-v18 (К1, К2, К6, К7, Т1–Т11): слово пользователя «X отвалился» — запись, действие, тексты правил.
// Номера в названиях — «Опасные случаи» замысла team-v18. Каждый случай — отдельный процесс со своей временной папкой.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const CASE = process.env.MOST_V18_CASE, ROOT = path.resolve(__dirname, '..');
let RUN, STATE;
if (CASE !== undefined) {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'most-v18-word-'));
  STATE = path.join(RUN, 'state');
  Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: STATE, MOST_CODEX_JOBS_DIR: path.join(STATE, 'codex-jobs'), MOST_CODEX_ARCHIVE_DIR: '',
    MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off', MOST_TEST_KEEP: '1', MOST_CLAUDE_CONFIGS: '[]', MOST_PROBE_ONLY: '1',
    MOST_FALLBACK_DIR: path.join(RUN, 'fallback') });
  delete process.env.MOST_AUTHORITY;
}
const lib = name => require('../common/' + name);
const tests = [], test = (name, fn) => tests.push([name, fn]);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const json = (f, x) => write(f, JSON.stringify(x, null, 2));
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const iso = ms => new Date(ms).toISOString();
const HOUR = 3600000, WHO = ['codex', 'antigravity', 'grok'], NAMES = { codex: 'Codex', antigravity: 'Antigravity', grok: 'Grok' };
const two = n => String(n).padStart(2, '0');
const local = ms => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()) + ' ' + two(d.getDate()) + '.' + two(d.getMonth() + 1); };

// Успешное поручение участника: завершено с проверенным ответом (Grok — подписанным).
function success(who, finishedAt, patch = {}) {
  const roots = lib('team-store').roots(), id = who + '-ok-' + crypto.randomUUID().slice(0, 8);
  let text = 'Ответ ' + id + '\nПРИНЯТО\n';
  if (who === 'grok') text += 'КОНТРОЛЬ ' + 'a'.repeat(64) + '\nКОНЕЦ ОТВЕТА\n';
  const card = { id, status: 'done', startedAt: iso(finishedAt - 1000), finishedAt: iso(finishedAt), task: 'другая работа', ...patch };
  if (who === 'antigravity') {
    write(path.join(roots.antigravity, id, 'result.txt'), text); json(path.join(roots.antigravity, id, 'meta.json'), { hash: sha(text) });
    json(path.join(roots.antigravity, id, 'card.json'), card);
  } else {
    card.resultFile = id + '.result.txt'; if (who === 'grok' && !patch.unsigned) card.resultHash = sha(text);
    write(path.join(roots[who], card.resultFile), text); json(path.join(roots[who], id + '.json'), card);
  }
  return id;
}
async function mcp(client) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers/team/index.js')], stderr: 'pipe', env: { ...process.env, MOST_CLIENT: client } });
  const c = new Client({ name: 'v18-word', version: '1' });
  await c.connect(transport);
  const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { error: !!r.isError, text: (r.content || []).map(x => x.text || '').join('\n') }; };
  return { client: c, call, close: () => c.close() };
}
function rules(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }
function files(d) {
  return fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]);
}
function item(text, title, number) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), start = lines.indexOf('## ' + title);
  assert(start >= 0, title);
  let end = lines.findIndex((l, i) => i > start && /^#{2,} /u.test(l)); if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end), at = body.findIndex(l => l.startsWith(number + '. '));
  let stop = body.findIndex((l, i) => i > at && /^\d+\. /u.test(l)); if (stop < 0) stop = body.length;
  return body.slice(at, stop).join('\n');
}

for (const who of ['codex', 'antigravity', 'grok']) test('1, В5 ' + NAMES[who] + ': гостевой клиент записать слово не может', async () => {
  process.env.MOST_CLIENT = who;
  await assert.rejects(lib('user-word').record({ who_down: 'codex', quote: 'Codex отвалился' }), /Гостю это действие запрещено/);
  const { Team } = lib('team');
  await assert.rejects(new Team(RUN).word({ action: 'record', who_down: 'codex', quote: 'Codex отвалился' }), /Гостю/);
  assert(!fs.existsSync(lib('user-word').file()));
  const guest = await mcp(who);
  try {
    assert(!(await guest.client.listTools()).tools.some(t => t.name === 'team_word'), 'гостю инструмент не выдаётся');
    const r = await guest.call('team_word', { action: 'record', who_down: 'codex', quote: 'Codex отвалился' }).catch(e => ({ error: true, text: e.message }));
    assert(r.error, r.text);
  } finally { await guest.close(); }
  assert(!fs.existsSync(lib('user-word').file()));
});

test('1: запасной режим (authority=user) — запись слова запрещена и клиенту claude', async () => {
  write(path.join(process.env.MOST_FALLBACK_DIR, 'session.json'), JSON.stringify({ authority: 'user', mode: 'fallback' }));
  await assert.rejects(lib('user-word').record({ who_down: 'grok', quote: 'Грок отвалился' }), /Гостю/);
});

test('22: поля team_word проходят MCP-схему; запись видна после перезапуска; два одновременных слова целы', async () => {
  let s = await mcp('claude');
  try {
    const tool = (await s.client.listTools()).tools.find(t => t.name === 'team_word');
    assert(tool, 'инструмент есть у клиента claude');
    // team-v19 К2: схема расширена словом о Claude (who_down=claude; return, handover, rebind); слово о себе Claude отклоняет сервер.
    assert.deepEqual(tool.inputSchema.properties.action.enum, ['record', 'list', 'return', 'handover', 'rebind']);
    assert.deepEqual(tool.inputSchema.properties.who_down.enum, ['codex', 'antigravity', 'grok', 'claude']);
    assert(tool.inputSchema.properties.quote);
    const change = (await s.client.listTools()).tools.find(t => t.name === 'team_change').inputSchema.properties;
    assert(change.action.enum.includes('grok_slot')); assert.deepEqual(change.slot.enum, ['codex', 'antigravity']); assert.deepEqual(change.phase.enum, ['design', 'verdict']);
    const bad = await s.call('team_word', { action: 'record', who_down: 'claude', quote: 'x' }).catch(e => ({ error: true, text: e.message }));
    assert(bad.error, 'слово о Claude из чата Claude — отказ'); assert.match(bad.text, /О себе Claude слово не записывает/);
    const r = await s.call('team_word', { action: 'record', who_down: 'codex', quote: 'кодекс лёг, работаем без него' });
    assert(!r.error, r.text); assert.match(r.text, /Записал: „кодекс лёг, работаем без него“ — недоступен Codex/);
    const both = await Promise.all([s.call('team_word', { action: 'record', who_down: 'antigravity', quote: 'гемини отвалился' }),
      s.call('team_word', { action: 'record', who_down: 'grok', quote: 'грок не отвечает' })]);
    assert(both.every(x => !x.error), both.map(x => x.text).join('\n'));
  } finally { await s.close(); }
  await Promise.all([lib('user-word').record({ who_down: 'codex', quote: 'одновременно 1' }), lib('user-word').record({ who_down: 'codex', quote: 'одновременно 2' })]);
  const lines = fs.readFileSync(lib('user-word').file(), 'utf8').trim().split('\n');
  assert.equal(lines.length, 5); lines.forEach(l => JSON.parse(l));
  assert.equal(new Set(lines.map(l => JSON.parse(l).id)).size, 5);
  s = await mcp('claude');
  try {
    const list = await s.call('team_word', { action: 'list' });
    for (const q of ['кодекс лёг, работаем без него', 'гемини отвалился', 'грок не отвечает', 'одновременно 1', 'одновременно 2']) assert(list.text.includes('„' + q + '“'), q);
  } finally { await s.close(); }
});

for (const who of WHO) test('23, К1, В5 ' + NAMES[who] + ': строка записи называет выпавшего и местное время; слово действует до успешного ответа, но не дольше суток', async () => {
  const words = lib('user-word');
  const { record, text } = await words.record({ who_down: who, quote: 'ну всё, ' + who + ' умер' });
  assert.equal(text, 'Записал: „ну всё, ' + who + ' умер“ — недоступен ' + NAMES[who] + ' до первого его успешного ответа, но не дольше суток (до ' + local(Date.parse(record.at) + 24 * HOUR) + ')');
  assert.equal(record.source, 'chat-claude'); assert.equal(record.recorded_by, 'claude'); assert(/^word-/.test(record.id));
  assert.equal(words.active(who, Date.now()).id, record.id);
  for (const other of WHO.filter(w => w !== who)) assert.equal(words.active(other, Date.now()), null);
  // Не дольше суток (до успешных ответов, чтобы проверить именно срок).
  assert.equal(words.active(who, Date.parse(record.at) + 24 * HOUR - 1).id, record.id);
  assert.equal(words.active(who, Date.parse(record.at) + 24 * HOUR), null);
  assert.equal(words.active(who, Date.parse(record.at) - 1), null, 'слово не действует раньше записи');
  // Неуспешные и непроверенные поручения слово не снимают.
  const after = Date.parse(record.at) + 100;
  success(who, after, { status: 'cancelled' }); success(who, after, { status: 'lost' });
  if (who === 'grok') success(who, after, { unsigned: true });
  else success(who, after, { cancelled: true });
  assert.equal(words.active(who, after + 1000).id, record.id);
  // Успешный ответ снимает слово с момента ответа.
  const ok = success(who, after + 500);
  assert.equal(words.active(who, after + 400).id, record.id);
  assert.equal(words.active(who, after + 600), null);
  assert.equal(words.success(who, Date.parse(record.at), after + 600).id, ok);
  // Повтор слова — новая запись.
  const again = (await words.record({ who_down: who, quote: 'снова лёг' })).record;
  assert.notEqual(again.id, record.id); assert.equal(words.read().length, 2);
  assert.equal(words.active(who, Date.now() + 10).id, again.id);
  assert(!Object.keys(words).some(k => /update|delete|remove|edit/i.test(k)), 'правки и удаления записей нет');
  await assert.rejects(words.record({ who_down: who, quote: '   ' }), /дословно/);
  await assert.rejects(words.record({ who_down: 'claude', quote: 'Claude отвалился' }), /who_down/);
});

test('Antigravity mv5y4jpo п. 1: один журнал слов — запись через Team с другой папкой карточек видна всем читателям', async () => {
  const { Team } = lib('team'), words = lib('user-word');
  const team = new Team(RUN, path.join(RUN, 'другая-папка-карточек'));
  assert.match(await team.word({ action: 'record', who_down: 'codex', quote: 'кодекс отвалился' }), /недоступен Codex/);
  assert.equal(words.file(), path.join(STATE, 'team', 'words.jsonl'));
  assert(!fs.existsSync(path.join(RUN, 'другая-папка-карточек', 'words.jsonl')), 'журнал не зависит от папки карточек Team');
  const w = words.active('codex');
  assert(w && words.byId(w.id).quote === 'кодекс отвалился');
  assert.match(await new Team(RUN).word({ action: 'list' }), /кодекс отвалился/);
});

test('Antigravity mv5y4jpo п. 2: время для holds/active — число, ISO-строка или Date', async () => {
  const words = lib('user-word'), r = (await words.record({ who_down: 'grok', quote: 'грок отвалился' })).record;
  const later = Date.parse(r.at) + 1000;
  for (const at of [later, new Date(later).toISOString(), new Date(later)]) {
    assert.equal(words.holds(r, at), true, String(at));
    assert.equal(words.active('grok', at).id, r.id, String(at));
  }
  assert.equal(words.holds(r, 'не время'), false);
});

test('22: повреждённая строка журнала пропускается, остальные записи читаются', async () => {
  const words = lib('user-word');
  await words.record({ who_down: 'codex', quote: 'первое' });
  fs.appendFileSync(words.file(), '{"id":"обрыв');
  fs.appendFileSync(words.file(), '\n');
  await words.record({ who_down: 'grok', quote: 'второе' });
  assert.deepEqual(words.read().map(r => r.quote), ['первое', 'второе']);
});

test('18: Grok выпал при настроенном мосте — unavailable=true со словом принято, без слова отказ', async () => {
  json(path.join(STATE, 'grok-webhook.json'), { url: 'https://api2.cursor.sh/automations/webhook/test', key: 'k' });
  lib('grok').config();
  const gate = lib('grok-gate'), c = { name: 'x', requestMark: '#12345678', designHash: 'a'.repeat(64), base: 'b'.repeat(40), candidate: 'c'.repeat(40) };
  await assert.rejects(gate.record(c, 'design', { unavailable: true }), /Мост настроен/);
  await lib('user-word').record({ who_down: 'codex', quote: 'Codex отвалился' });
  await assert.rejects(gate.record(c, 'design', { unavailable: true }), /Мост настроен/, 'слово о другом участнике не годится');
  const w = (await lib('user-word').record({ who_down: 'grok', quote: 'Грок отвалился' })).record;
  assert.match(await gate.record(c, 'verdict', { unavailable: true }), /недоступен/);
  assert.equal(c.grokVerdict.status, 'недоступен'); assert.equal(c.grokVerdict.word_id, w.id);
  success('grok', Date.now() + 1000);
  await new Promise(r => setTimeout(r, 1100));
  await assert.rejects(gate.record(c, 'design', { unavailable: true }), /Мост настроен/, 'после успешного ответа Grok слово не действует');
});

test('18: team_change отклоняет Grok даже при записанном слове о недоступности', async () => {
  json(path.join(STATE, 'grok-webhook.json'), { url: 'https://api2.cursor.sh/automations/webhook/test', key: 'k' });
  const g = lib('team-git'), { Team } = lib('team'), root = path.join(RUN, 'repo');
  fs.mkdirSync(root); g.git(root, ['init', '-b', 'main']); g.git(root, ['config', 'user.email', 't@example.invalid']); g.git(root, ['config', 'user.name', 'Тест']);
  write(path.join(root, '.gitignore'), '.work/\n'); write(path.join(root, 'f.txt'), 'x'); g.git(root, ['add', '-A']); g.git(root, ['commit', '-m', 'База']);
  const design = path.join(RUN, 'design.md'); write(design, '# Замысел\n\n## А\nтекст\n');
  const team = new Team(root);
  await team.change({ action: 'start', name: 'ch', request: 'Запрос пользователя для проверки слова Grok.', design_file: design });
  await assert.rejects(team.change({ action: 'design', name: 'ch', who: 'grok', unavailable: true }), /Grok выключен из связки/);
  assert.match(await team.word({ action: 'record', who_down: 'grok', quote: 'Grok отвалился' }), /недоступен Grok/);
  const before = read(team.changeFile('ch'));
  await assert.rejects(team.change({ action: 'design', name: 'ch', who: 'grok', unavailable: true }), /Grok выключен из связки/);
  assert.deepEqual(read(team.changeFile('ch')), before);
});

test('24: добавленные предложения п. 5 и п. 8 «Кто принимает итог» одинаковы в common.md и helpers', async () => {
  const common = rules('rules/common.md'), helpers = rules('skill/helpers/SKILL.md');
  const t5 = 'Доказательство и без поручения — слово пользователя «X отвалился»: его собственная реплика в чате Claude; Claude записывает её дословно через `team_word` и показывает ему строку записи. Слово действует до первого успешного ответа выпавшего, но не дольше 24 часов; после — доказательство по поручению, как выше, без нового слова. Слово не отменяет отказ, поданный до него, и не заменяет поручение на пересмотр после отклонённого замечания.';
  const t6 = 'Codex и Antigravity обязательны; недоступен один — изменение ждёт. Решение о слиянии принимает Claude. Решение пользователя проверку не заменяет.';
  for (const text of [common, helpers]) {
    assert.equal(item(text, 'Кто принимает итог', 5).split(t5).length - 1, 1);
    assert.equal(item(text, 'Кто принимает итог', 8).split(t6).length - 1, 1);
  }
  const added = (text, n, phrase) => item(text, 'Кто принимает итог', n).split(/(?<=\.)\s+/).filter(s => phrase.includes(s.trim()) || s.includes(phrase));
  assert.deepEqual(added(common, 5, t5), added(helpers, 5, t5));
});

test('25: противоречащих фраз нет в rules/ и skill/; «ждёт свою» — только с исключением; тексты Т1–Т11 на месте', async () => {
  const forbidden = ['не заменяет обязательные голоса', 'обязательные голоса не заменяет', 'Голоса team_change не заменяются', 'обязательный Codex не заменяется',
    'Недоступность доказывает только', 'Antigravity обязательны и не заменяются', 'в team_change голос совещательный.'];
  for (const file of [...files('rules'), ...files('skill')]) {
    const text = rules(file).replace(/\r\n/g, '\n');
    for (const phrase of forbidden) assert(!text.includes(phrase), file + ': ' + phrase);
    for (const m of text.matchAll(/ждёт свою/g))
      assert(text.slice(m.index, m.index + 200).split('\n')[0].includes('кроме слова пользователя «Antigravity отвалился»'), file + ': «ждёт свою» без исключения');
  }
  const common = rules('rules/common.md'), claude = rules('rules/claude.md'), grok = rules('rules/grok.md');
  assert(common.includes('- **Недоступность**: в team_change Codex и Antigravity обязательны; недоступен один — изменение ждёт.'));
  assert(common.includes('6. `team_change merge`: ПРИНЯТО Codex и Antigravity; решение Claude.'));
  for (const text of [common, claude, grok]) assert(!text.includes('Grok на место выпавшего'));
  assert.equal(grok.trim(), 'Grok выключен из связки 13.10.2026 словом пользователя');
  assert(claude.includes('Слово пользователя «X отвалился»') && claude.includes('сразу `team_word`'));
  assert(common.includes('Решение пользователя, затрагивающее несколько скиллов, — по клику на каждую карточку.'));
  assert(rules('rules/antigravity.md').includes('сверяет Codex, не пользователь') && rules('rules/antigravity.md').includes('перед переносом — копия файла'));
  const brief = rules('rules/brief.md');
  assert(brief.includes('в team_change Codex и Antigravity обязательны.'));
  for (const f of ['rules/helpers/codex-section.md', 'rules/helpers/antigravity-section.md']) {
    assert(rules(f).includes('Обязательные проверяющие — Codex и Antigravity (team_change)'));
    assert(!rules(f).includes('Grok — поиск'));
  }
  // Т8 во всех копиях: «только Antigravity» для литературного текста — с исключением по слову пользователя (Codex 603f2827 п. 4).
  let only = 0;
  for (const file of [...files('rules'), ...files('skill')]) for (const line of rules(file).replace(/\r\n/g, '\n').split('\n'))
    if (/только Antigravity/i.test(line)) { only++; assert(line.includes('«Antigravity отвалился»'), file + ': «только Antigravity» без исключения'); }
  assert(only >= 1, 'brief.md: строка о литературном тексте');
  assert(brief.includes('только Antigravity (кроме слова пользователя «Antigravity отвалился»: Claude или Codex)'));
});

test('К7: precheck — голоса по функции мест; системные задания без номера в добавленных строках уроков', async () => {
  const pc = lib('precheck'), file = path.join(RUN, 'design.md'); write(file, 'замысел');
  const d = sha('замысел'), s8 = d.slice(0, 8);
  const c = { name: 'x', request: 'r', requestMark: '#1', designFile: file, designHash: d, grokDesign: { job_id: 'g', designHash: d, status: 'done', decision: 'ПРИНЯТО' },
    designVotes: [{ who: 'antigravity', decision: 'ПРИНЯТО', designHash: d }, { who: 'user', replaces: 'codex', decision: 'ПРИНЯТО', designHash: d }],
    grokSlots: [{ id: 'slot-1', phase: 'design', seat: 'codex', designHash: d, job_id: 'gs' }] };
  assert.deepEqual(pc.designVoteWarnings(c), ['Codex не голосовал по замыслу ' + s8 + ': commit откажет — отправьте ему эту редакцию'], 'запись пользователя место не закрывает');
  c.designVotes.push({ who: 'grok', replaces: 'codex', job_id: 'gs', decision: 'НЕ ПРИНЯТО', designHash: d });
  assert.deepEqual(pc.designVoteWarnings(c), ['Codex не голосовал по замыслу ' + s8 + ': commit откажет — отправьте ему эту редакцию']);
  c.designVotes = c.designVotes.filter(v => v.who !== 'grok').concat({ who: 'grok', replaces: 'codex', job_id: 'gs', decision: 'ПРИНЯТО', designHash: d });
  assert.deepEqual(pc.designVoteWarnings(c), ['Codex не голосовал по замыслу ' + s8 + ': commit откажет — отправьте ему эту редакцию']);
  c.designVotes.push({ who: 'codex', decision: 'ПРИНЯТО', designHash: d });
  assert.deepEqual(pc.designVoteWarnings(c), []);
  c.systemic = [{ who: 'codex', job_id: '9af93e67-aaaa' }, { who: 'grok', job_id: '1523272e-bbbb' }];
  const diff = '@@ -1,0 +2,1 @@\n+Системное codex 9af93e67 — закрыто.\n';
  assert.deepEqual(pc.systemicWarnings(c, diff), []);
  const r = pc.precheck({ folder: RUN, designFile: null, lessonsDiff: diff, change: c });
  assert(!r.warnings.some(w => w.includes('1523272e-bbbb')));
});

async function main() {
  if (CASE !== undefined) {
    let code = 0;
    try { await tests[Number(CASE)][1](); }
    catch (e) { code = 1; console.error(e && e.stack || e); }
    process.exit(code);
  }
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, MOST_V18_CASE: String(i) }, encoding: 'utf8', timeout: 120000 });
    if (r.status === 0) console.log('ПРОЙДЕНО: ' + tests[i][0]);
    else { failed++; console.error('ПРОВАЛ: ' + tests[i][0] + '\n' + (r.stdout || '') + (r.stderr || '') + (r.error ? r.error.message : '')); }
  }
  console.log('Итого: пройдено ' + (tests.length - failed) + ', провалено ' + failed + ', пропущено 0');
  process.exitCode = failed ? 1 : 0;
}
main();
