'use strict';
// team-v18 (К3, К4, К8): место выпавшего Codex или Antigravity в team_change занимает настоящий Grok по слову пользователя.
// Номера в названиях — «Опасные случаи» замысла team-v18. Каждый случай — отдельный процесс со своей временной папкой
// состояния: журнал слов и хранилища поручений не смешиваются между случаями.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), crypto = require('crypto'), http = require('http');
const { spawnSync } = require('child_process');
const CASE = process.env.MOST_V18_CASE;
let RUN, STATE, server;
if (CASE !== undefined) {
  RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'most-v18-change-'));
  STATE = path.join(RUN, 'state');
  Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: STATE, MOST_CODEX_JOBS_DIR: path.join(STATE, 'codex-jobs'), MOST_CODEX_ARCHIVE_DIR: '',
    MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off', MOST_TEST_KEEP: '1', MOST_CLAUDE_CONFIGS: '[]', NODE_ENV: 'test',
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
const OLD = '2020-01-01T00:00:00.000Z', HOUR = 3600000, NAMES = { codex: 'Codex', antigravity: 'Antigravity' };
const other = who => who === 'codex' ? 'antigravity' : 'codex';

async function webhook() {
  if (server) return;
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, runUuid: 'run-' + crypto.randomUUID().slice(0, 8) })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/automations/webhook/test';
  process.env.MOST_GROK_TEST_URL = url;
  json(path.join(STATE, 'grok-webhook.json'), { url, key: 'test-key' });
}
async function fixture(label = 'a') {
  await webhook();
  const g = lib('team-git'), { Team } = lib('team');
  const root = path.join(RUN, 'repo-' + label);
  fs.mkdirSync(root);
  g.git(root, ['init', '-b', 'main']); g.git(root, ['config', 'user.email', 'test@example.invalid']); g.git(root, ['config', 'user.name', 'Тест']);
  write(path.join(root, '.gitignore'), '.work/\nstate/\nworks/\n'); write(path.join(root, 'file.txt'), 'база\n'); write(path.join(root, 'lessons.md'), '# Уроки\n');
  g.git(root, ['add', '-A']); g.git(root, ['commit', '-m', 'База']);
  const design = path.join(RUN, 'design-' + label + '.md');
  write(design, '# Замысел ' + label + '\n\n## Запрос\nСлово пользователя.\n\n## Код\nК1–К4.\n\n```\n## не раздел\n```\n\n## Опасные случаи\n1. Отказ.\n\n## Живая проверка\nНе нужна.\n');
  // Папка карточек — по умолчанию (state\team), как у сервера; имена изменений по метке различаются.
  const team = new Team(root), name = 'ch-' + label;
  await team.change({ action: 'start', name, request: 'Моего слова, что любой из связки отвалился, должно быть достаточно (' + label + ').', design_file: design });
  const folder = team.clone(name);
  g.git(folder, ['config', 'user.email', 'test@example.invalid']); g.git(folder, ['config', 'user.name', 'Тест']);
  return { root, team, folder, design, name, card: () => read(team.changeFile(name)), change: a => team.change({ name, ...a }) };
}
// Поручение-ревью Codex или Antigravity в хранилище; по умолчанию старое по времени, чтобы не считаться «успехом после слова».
function review(x, who, { phase = 'design', decision = 'ПРИНЯТО', status = 'done', startedAt = OLD, finishedAt, task, extra = {}, last } = {}) {
  const c = x.card(), roots = lib('team-store').roots(), id = who + '-' + crypto.randomUUID().slice(0, 8);
  const text = 'Ответ ' + id + '\n' + (last ?? (decision === 'ПРИНЯТО' ? 'ПРИНЯТО' : 'НЕ ПРИНЯТО: 1 блокирующих')) + '\n';
  const card = { id, status, startedAt, task: task ?? (c.requestMark + ' ' + (phase === 'design' ? c.designHash : c.base + ' ' + c.candidate)),
    write: false, mode: 'review', model: who === 'codex' ? 'gpt-6' : 'gemini-3.8-flash-high', ...extra };
  if (status === 'done' || finishedAt) card.finishedAt = finishedAt || startedAt;
  if (who === 'codex') {
    card.resultFile = id + '.result.txt';
    write(path.join(roots.codex, card.resultFile), text); json(path.join(roots.codex, id + '.json'), card);
  } else {
    const dir = path.join(roots.antigravity, id);
    write(path.join(dir, 'result.txt'), text); json(path.join(dir, 'meta.json'), { hash: sha(text) }); json(path.join(dir, 'card.json'), card);
  }
  return id;
}
const job = (who, id) => lib('team-store').list(who, false).jobs.find(j => j.id === id);
async function designAccepted(x, seats = ['codex', 'antigravity']) {
  for (const who of seats) await x.change({ action: 'design', who, decision: 'ПРИНЯТО', job_id: review(x, who) });
}
async function candidate(x) {
  await designAccepted(x);
  write(path.join(x.folder, 'file.txt'), 'кандидат\n'); write(path.join(x.folder, 'common/new.js'), "'use strict';\n");
  await x.change({ action: 'commit', message: 'Кандидат' });
  return x.card();
}
async function word(x, who, at) {
  if (at === undefined) return (await lib('user-word').record({ who_down: who, quote: (NAMES[who] || 'Grok') + ' отвалился' })).record;
  const r = { id: 'word-' + crypto.randomUUID(), at: iso(at), who_down: who, quote: who + ' отвалился', source: 'chat-claude', recorded_by: 'claude' };
  const file = lib('user-word').file();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(r) + '\n');
  return r;
}
async function slot(x, who, phase = 'design') {
  const out = await x.change({ action: 'grok_slot', slot: who, phase });
  return { out, s: x.card().grokSlots.filter(s => s.job_id).at(-1) };
}
// Подписанный проверенный ответ Grok (как после проверки HMAC в grok.refresh).
function answer(s, { decision = 'ПРИНЯТО', skip = [], extra = '' } = {}) {
  const dir = lib('team-store').roots().grok, card = read(path.join(dir, s.job_id + '.json'));
  const items = s.coverage.filter(e => !skip.includes(e)).map(e => '- ' + e + ': без замечаний').join('\n');
  const text = 'Ответ на ' + s.job_id + ', материал ' + card.materialHash + '\nЗамечаний нет. ' + extra + '\n\n## Покрытие\n' + items + '\n\n' +
    (decision === 'ПРИНЯТО' ? 'ПРИНЯТО' : 'НЕ ПРИНЯТО: 1 блокирующих') + '\nКОНТРОЛЬ ' + 'a'.repeat(64) + '\nКОНЕЦ ОТВЕТА\n';
  write(path.join(dir, s.job_id + '.result.txt'), text);
  json(path.join(dir, s.job_id + '.json'), { ...card, status: 'done', resultHash: sha(text), finishedAt: new Date().toISOString() });
}
function slotVote(x, s, decision = 'ПРИНЯТО') {
  const c = x.card();
  return x.change({ action: s.phase, who: 'grok', replaces: s.seat, job_id: s.job_id, decision, ...(s.phase === 'verdict' ? { base: c.base, candidate: c.candidate } : {}) });
}
async function verdict(x, who, decision = 'ПРИНЯТО') {
  const c = x.card();
  return x.change({ action: 'verdict', who, decision, base: c.base, candidate: c.candidate, job_id: who === 'claude' ? undefined : review(x, who, { phase: 'verdict', decision }) });
}
// Совещательный Grok по замыслу — проверенным ответом; по паре его закрывает поручение на месте выпавшего.
function grokDesign(x) {
  const c = x.card(), dir = lib('team-store').roots().grok, id = crypto.randomUUID();
  const text = 'ПРИНЯТО\nКОНТРОЛЬ ' + 'a'.repeat(64) + '\nКОНЕЦ ОТВЕТА\n';
  write(path.join(dir, id + '.result.txt'), text);
  json(path.join(dir, id + '.json'), { id, status: 'done', task: c.requestMark + ' ' + c.designHash, resultHash: sha(text), startedAt: OLD, finishedAt: OLD });
  c.grokDesign = { job_id: id, status: 'done', decision: 'ПРИНЯТО', designHash: c.designHash };
  json(x.team.changeFile(x.name), c);
}
const seat = (x, who, phase = 'design') => lib('team-seats').seat(x.card(), who, phase);

// team-v23: прежний механизм замены выключен; обязательные места и история сохраняются.
for (const who of ['codex', 'antigravity']) test('О3: слово о ' + who + ' не разрешает новый grok_slot', async () => {
  const x = await fixture(); await word(x, who);
  for (const phase of ['design', 'verdict']) await assert.rejects(x.change({ action: 'grok_slot', slot: who, phase }), /Grok выключен из связки/);
  assert(!x.card().grokSlots);
});
for (const phase of ['design', 'verdict']) test('О3: who=grok отклоняется, включая старое место, фаза ' + phase, async () => {
  const x = await fixture();
  for (const replaces of [undefined, 'codex', 'antigravity']) await assert.rejects(x.change({ action: phase, who: 'grok', replaces, job_id: 'old' }), /Grok выключен из связки/);
});
for (const decision of ['ПРИНЯТО', 'НЕ ПРИНЯТО']) test('О4: старое ' + decision + ' Grok не закрывает и не блокирует места', async () => {
  const x = await fixture(), c = x.card();
  c.grokSlots = ['codex', 'antigravity'].map(seat => ({ phase: 'design', seat, job_id: 'old-' + seat, designHash: c.designHash }));
  c.designVotes = c.grokSlots.map(s => ({ who: 'grok', replaces: s.seat, job_id: s.job_id, designHash: c.designHash, decision }));
  json(x.team.changeFile(x.name), c);
  for (const who of ['codex', 'antigravity']) { const s = lib('team-seats').seat(c, who, 'design'); assert(!s.closed && !s.blocked); }
  await assert.rejects(x.change({ action: 'commit', message: 'Не принят' }), /ворота замысла/);
  for (const who of ['codex', 'antigravity']) await x.change({ action: 'design', who, job_id: review(x, who), decision: 'ПРИНЯТО' });
  write(path.join(x.folder, 'file.txt'), 'кандидат');
  await x.change({ action: 'commit', message: 'Кандидат' });
  for (const who of ['codex', 'antigravity', 'claude']) await verdict(x, who);
  assert.match(await x.change({ action: 'merge' }), /Слито в main/);
});
for (const who of ['codex', 'antigravity']) test('Собственный отказ ' + who + ' остаётся блокирующим', async () => {
  const x = await fixture();
  await x.change({ action: 'design', who, job_id: review(x, who, { decision: 'НЕ ПРИНЯТО' }), decision: 'НЕ ПРИНЯТО' });
  const c = x.card(); c.designVotes.push({ who: 'grok', replaces: who, designHash: c.designHash, decision: 'ПРИНЯТО' }); json(x.team.changeFile(x.name), c);
  assert(lib('team-seats').seat(c, who, 'design').blocked);
  await assert.rejects(x.change({ action: 'commit', message: 'Нет' }), /ворота замысла/);
});
test('О4: незавершённые и повреждённые карточки старых мест не читаются', async () => {
  const x = await fixture(), c = x.card(); c.grokSlots = [{ phase: 'design', seat: 'codex', job_id: 'broken', designHash: c.designHash }];
  write(path.join(lib('team-store').roots().grok, 'broken.json'), '{');
  const seats = lib('team-seats'); assert.deepEqual(seats.slotPending(c, 'design'), []); assert.deepEqual(seats.slotRefusals(c, 'design'), []);
  assert(!lib('precheck').designVoteWarnings(c).some(t => t.includes('Grok')));
});

async function main() {
  if (CASE !== undefined) {
    let code = 0;
    try { await tests[Number(CASE)][1](); }
    catch (e) { code = 1; console.error(e && e.stack || e); }
    finally { if (server) server.close(); }
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
