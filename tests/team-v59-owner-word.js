'use strict';
// team-v59: слово владельца моста перекрывает правило-отказ. Разделы 1–3 замысла и четыре опасных случая. Все данные
// изолированы фикстурой team-v16; Git ворот подменён (коммитов/слияний на диске нет). Происхождение чата — proven (раннер).
const assert = require('assert'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const BASE = 'a'.repeat(40), CANDIDATE = 'b'.repeat(40);
function teamHarness() {
  const g = require('../common/team-git');
  g.repository = () => {}; g.hash = () => BASE; g.clean = () => true;
  g.git = (_root, args) => args[0] === 'branch' ? 'main' : args[0] === 'rev-parse' ? CANDIDATE : '';
  const { Team } = require('../common/team');
  Team.prototype.pair = function (n) { return { c: JSON.parse(fs.readFileSync(this.changeFile(n))), folder: this.root, candidate: CANDIDATE }; };
  return Team;
}
if (process.argv.includes('--team-server')) {
  teamHarness();
  const { server } = require('../servers/team');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  server.connect(new StdioServerTransport()).catch(e => { console.error(e); process.exitCode = 1; });
} else {
  delete process.env.MOST_JOB_ID;
  const f = require('./team-v16-fixture');
  const { root, project, json } = f, state = path.join(root, 'state');
  const members = require('../common/members');
  const words = require('../common/user-word'), live = require('../common/live-jobs'), wl = require('../common/write-lock');
  const paths = require('../common/paths'), ops = require('../common/deploy-ops');
  const Team = teamHarness(), team = new Team(root);
  const hold = require('../common/restart-hold'); hold.processTableAsync = async () => [{ pid: process.pid, ppid: 0, startedAt: null }];
  // Отпечаток подлинности чата (jobProof): запись основного сервера team есть, среди предков его нет — гостевой чат
  // участника (codex/kimi/deepseek) проходит team_word. chat-origin подставлен раннером (MOST_TEST_CHAT_ORIGIN=proven).
  fs.mkdirSync(path.join(state, 'ready'), { recursive: true });
  fs.writeFileSync(path.join(state, 'ready', 'team.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), release: path.resolve(__dirname, '..') }));
  const tests = [], test = (n, fn) => tests.push([n, fn]); let seq = 0;
  const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  const client = c => { if (c === undefined) delete process.env.MOST_CLIENT; else process.env.MOST_CLIENT = c; };
  const withClient = async (c, fn) => { const prev = process.env.MOST_CLIENT; client(c); try { return await fn(); } finally { client(prev); } };

  function changeCard(opts = {}) {
    const name = 'ch-' + (++seq), designFile = path.join(project, name + '.md');
    fs.writeFileSync(designFile, 'замысел ' + name);
    const c = { name, base: BASE, candidate: CANDIDATE, status: 'ожидает ревью', requestMark: '#' + 'c'.repeat(8),
      designFile, designHash: f.sha('замысел ' + name), candidateDesignHash: f.sha('замысел ' + name), designVotes: [], verdicts: [], ...opts };
    json(team.changeFile(name), c);
    return c;
  }
  function card(extra = {}, who = 'codex', id = 'v59-' + String(++seq).padStart(8, '0')) {
    const dir = path.join(state, who === 'antigravity' ? 'jobs' : who + '-jobs');
    const file = path.join(dir, id + '.json');
    const j = { id, status: 'running', write: false, folder: project, startedAt: new Date().toISOString(),
      owner: { instance: crypto.randomUUID(), pid: 2147483000 }, ...extra };
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return { file, id, j, read: () => read(file) };
  }

  // ----- Раздел 1: слово вместо голосов (team_change) -----
  test('1a: verdict who=user replaces=<участник> закрывает место; merge проходит (без request — только verdict)', async () => {
    const c = changeCard();
    for (const who of members.seatIds) {
      const r = await team.change({ action: 'verdict', name: c.name, who: 'user', replaces: who, decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ', quote: 'сливай моим словом', base: BASE, candidate: CANDIDATE });
      assert.match(r, /перекрывает правило моста/); assert.match(r, /Закрыто словом владельца/);
    }
    const saved = read(team.changeFile(c.name));
    assert(saved.decisions.filter(d => d.kind === 'owner_word').length === members.seatIds.length, 'owner_word в истории');
    const out = await team.change({ action: 'merge', name: c.name });
    assert.match(out, /слито словом владельца: голоса/); assert.match(out, /ревью не было/); assert.match(out, /Слито в main/);
    assert(read(team.changeFile(c.name)).mergedByWord, 'в истории — слияние словом');
  });
  test('1b: replaces=all одним словом закрывает все места; merge без ревью', async () => {
    const c = changeCard();
    const r = await team.change({ action: 'verdict', name: c.name, who: 'user', decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ', quote: 'всё моим словом', base: BASE, candidate: CANDIDATE });
    assert.match(r, /все обязательные места/);
    assert.match(await team.change({ action: 'merge', name: c.name }), /Слито в main/);
  });
  test('1c: design who=user + verdict who=user — замысел и пара закрыты словом, merge проходит', async () => {
    const c = changeCard({ request: 'Запрос пользователя для проверки слова владельца в замысле.' });
    assert.match(await team.change({ action: 'design', name: c.name, who: 'user', decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ', quote: 'замысел моим словом' }), /замысел/);
    assert.match(await team.change({ action: 'verdict', name: c.name, who: 'user', decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ', quote: 'кандидат моим словом', base: BASE, candidate: CANDIDATE }), /Закрыто словом/);
    assert.match(await team.change({ action: 'merge', name: c.name }), /Слито в main/);
  });
  test('1d: слово перекрывает вердикт самого Claude (НЕ ПРИНЯТО) при replaces=all', async () => {
    const c = changeCard();
    await team.change({ action: 'verdict', name: c.name, who: 'claude', decision: 'НЕ ПРИНЯТО', base: BASE, candidate: CANDIDATE });
    await assert.rejects(team.change({ action: 'merge', name: c.name }), /слияние остановлено дирижёром/);
    await team.change({ action: 'verdict', name: c.name, who: 'user', decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ', quote: 'я решил сливать', base: BASE, candidate: CANDIDATE });
    assert.match(await team.change({ action: 'merge', name: c.name }), /Слито в main/);
  });
  test('1e: системное замечание, перекрытое словом, урока не требует (предупреждение)', async () => {
    const c = changeCard({ systemic: [{ who: 'codex', job_id: 'sys-0001' }] });
    await team.change({ action: 'verdict', name: c.name, who: 'user', decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ', quote: 'сливай всё', base: BASE, candidate: CANDIDATE });
    const out = await team.change({ action: 'merge', name: c.name });
    assert.match(out, /урок по системным замечаниям не записан/); assert.match(out, /Слито в main/);
  });

  test('1f: слово владельца ЗА ЗАМЫСЕЛ (phase=design) системное замечание по кандидату НЕ снимает — урок всё ещё нужен', async () => {
    const c = changeCard({ systemic: [{ who: 'codex', job_id: 'sysdes01' }] });
    const saved = read(team.changeFile(c.name));
    // Слово закрыло только замысел codex (phase=design по этой designHash). Системная находка по кандидату остаётся.
    saved.decisions = [{ kind: 'owner_word', phase: 'design', replaces: 'codex', designHash: saved.designHash,
      quote: 'замысел моим словом', word_id: 'wd-design-1', at: new Date().toISOString() }];
    json(team.changeFile(c.name), saved);
    await assert.rejects(team.change({ action: 'merge', name: c.name }), /системные замечания/);
    // А слово той же фазы (verdict, replaces=all) её снимает — merge проходит (контроль).
    await team.change({ action: 'verdict', name: c.name, who: 'user', decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ', quote: 'сливай всё', base: BASE, candidate: CANDIDATE });
    assert.match(await team.change({ action: 'merge', name: c.name }), /Слито в main/);
  });

  // ----- Опасные случаи 1, 3, 4 -----
  test('Опасный 1: из поручения verdict who=user — отказ (не доказанный чат), место не закрыто', async () => {
    const c = changeCard();
    process.env.MOST_JOB_ID = 'job-v59';
    try { await assert.rejects(team.change({ action: 'verdict', name: c.name, who: 'user', replaces: 'codex', decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ', quote: 'из поручения', base: BASE, candidate: CANDIDATE }), /запрещено/); }
    finally { delete process.env.MOST_JOB_ID; }
    assert(!(read(team.changeFile(c.name)).decisions || []).some(d => d.kind === 'owner_word'), 'слово из поручения место не закрыло');
  });
  test('Опасный 3: merge словом без единого ревью — явная пометка в ответе и истории', async () => {
    const c = changeCard();
    await team.change({ action: 'verdict', name: c.name, who: 'user', decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ', quote: 'без ревью', base: BASE, candidate: CANDIDATE });
    const out = await team.change({ action: 'merge', name: c.name });
    assert.match(out, /слито словом владельца.*заменены.*ревью не было/s);
    assert(read(team.changeFile(c.name)).mergedByWord.replaced.includes('all'));
  });
  test('Опасный 4: пустая/непустая-пробельная цитата — отказ с просьбой дать слово', async () => {
    const c = changeCard();
    for (const quote of ['', '   ']) await assert.rejects(team.change({ action: 'verdict', name: c.name, who: 'user', decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ', quote, base: BASE, candidate: CANDIDATE }), /цитаты/);
  });

  // ----- Раздел 2: слово вместо проверки остановки -----
  test('2a: stop_confirm форсирует running — карточка помечена словом, замок свободен, риск назван', async () => {
    const c = card({ status: 'running', write: false });
    const out = await team.word({ action: 'stop_confirm', quote: 'снимай моим словом', job_ids: [c.id] });
    assert.match(out, /снято словом владельца/); assert.match(out, /мог остаться работать/);
    const j = c.read();
    assert(j.stopConfirmed && j.stopConfirmed.basis === 'слово пользователя', 'отметка остановки словом');
    assert.equal(j.status, 'cancelled');
    // Проверка перед установкой такую карточку блокером не считает (members-kimi.installationBlockers).
    const b = require('../common/members-kimi').installationBlockers(state, { bootAt: () => NaN });
    assert(!b.running.some(r => r.id === c.id), 'форс-карточка не в списке идущих');
    assert(!b.blockers.some(x => String(x).includes(c.id)), 'форс-карточка не блокер');
  });
  test('2b: close форсирует running чужого чата — closedByWord + предупреждение + запись в журнале', async () => {
    const c = card({ status: 'running', write: true }, 'deepseek');
    const n = words.lines().length;
    const out = await withClient('kimi', () => team.word({ action: 'close', quote: 'закрой это поручение', job_ids: [c.id] }));
    assert.match(out, /закрыто словом владельца/); assert.match(out, /мог остаться работать/);
    const j = c.read();
    assert(j.closedByWord && j.closedByWord.basis === 'слово пользователя');
    assert.equal(j.status, 'cancelled');
    const rec = words.lines().slice(n).find(r => r.kind === 'job_close');
    assert(rec && rec.source === 'chat-kimi', 'запись закрытия из чата kimi в журнале');
  });
  test('2c: release_orphan снимает замок при ЖИВОМ владельце словом; риск назван', async () => {
    const dir = fs.realpathSync(project), instance = crypto.randomUUID(), job = 'orphan-' + crypto.randomUUID().slice(0, 8), cf = paths.canon(dir);
    fs.mkdirSync(wl.dir(), { recursive: true });
    fs.writeFileSync(wl.entryFile(cf), JSON.stringify({ folder: cf, jobId: job, instance, pid: process.pid, since: new Date().toISOString() }));
    assert.equal(ops.alive(process.pid), true, 'владелец жив');
    const out = await team.word({ action: 'release_orphan', lock_instance: instance, job_ids: [job], folder: dir, quote: 'сними замок моим словом' });
    assert.match(out, /Снят осиротевший замок/); assert.match(out, /был жив/); assert.match(out, /риск принят словом/i);
    assert(!wl.entries().some(e => e.entry.instance === instance), 'замок снят при живом владельце');
  });
  test('2d: после снятия словом новая запись в ту же папку не упирается в прежний замок', async () => {
    const c = card({ status: 'running', write: false, holdsFolder: true });
    await team.word({ action: 'stop_confirm', quote: 'снимай', job_ids: [c.id] });
    const b = require('../common/members-kimi').installationBlockers(state, { bootAt: () => NaN });
    assert(!b.blockers.some(x => String(x).includes(c.id) && /удержание папки/.test(String(x))), 'удержание папки снято словом');
  });

  // ----- Раздел 3: из чата любого участника -----
  test('3a: team_work close словом — из чата участника (codex) и в запасном режиме', async () => {
    const mk = () => { const name = 'w-' + (++seq), w = { name, title: 'Проверка', revision: 1, goal: 'ц', done_criteria: 'и', next_step: 'в', reminders: [],
      folder: path.join(project, 'nofolder'), stages: [{ id: 's1', title: 'Этап', state: 'идёт', weight: 100, accept_criteria: 'готово' }] };
      json(team.workFile(name), w); return name; };
    const w1 = mk();
    assert.match(await withClient('codex', () => team.work({ action: 'close', name: w1, expected_revision: 1, quote: 'закрой работу' })), /закрыто словом/);
    // В запасном режиме (authority=user): доказанный чат участника закрывает работу словом.
    const w2 = mk();
    const prev = process.env.MOST_AUTHORITY; process.env.MOST_AUTHORITY = 'user';
    try { assert.match(await withClient('antigravity', () => team.work({ action: 'close', name: w2, expected_revision: 1, quote: 'закрой и в режиме' })), /закрыто словом/); }
    finally { if (prev === undefined) delete process.env.MOST_AUTHORITY; else process.env.MOST_AUTHORITY = prev; }
    // Из поручения — отказ.
    const w3 = mk(); process.env.MOST_JOB_ID = 'job-close-v59';
    try { await assert.rejects(team.work({ action: 'close', name: w3, expected_revision: 1, quote: 'из поручения' }), /из поручения/); }
    finally { delete process.env.MOST_JOB_ID; }
  });
  test('3b: team_word record из чата kimi/deepseek пишется с источником chat-<клиент>', async () => {
    for (const c of ['kimi', 'deepseek', 'codex']) {
      const n = words.lines().length;
      const r = await withClient(c, () => team.word({ action: 'record', who_down: 'codex', quote: c + ' сказал: codex лёг' }));
      assert.match(r, /недоступен Codex/);
      const rec = words.lines().slice(n).find(x => x.kind === undefined || x.kind === 'record');
      assert(rec && rec.source === 'chat-' + c, 'источник chat-' + c);
    }
  });
  test('3c: team_word record «Claude отвалился» из чата kimi при АКТИВНОМ запасном режиме — participant-запись', async () => {
    // Активируем запасной режим напрямую (дирижёр codex), чтобы проверить именно запись participant от чата kimi.
    await words.append({ kind: 'record', who_down: 'claude', quote: 'Claude лёг', recorded_by: 'codex', owner: 'fallback-codex-abcd' });
    try {
      assert(words.mode().active, 'запасной режим активен');
      const n = words.lines().length;
      const r = await withClient('kimi', () => team.word({ action: 'record', who_down: 'claude', quote: 'и из kimi: Claude лёг' }));
      assert.match(r, /участник|дирижёр/);
      const rec = words.lines().slice(n).find(x => x.who_down === 'claude' && x.participant);
      assert(rec && rec.recorded_by === 'kimi', 'participant-запись kimi в активном режиме');
    } finally { await words.append({ kind: 'return', who_down: 'claude', quote: 'Claude вернулся', recorded_by: 'claude' }); }
  });
  test('3d: team_inbox — доказанный чат любого участника (codex), из поручения — отказ', async () => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const mcp = async env => {
      const transport = new StdioClientTransport({ command: process.execPath, args: [__filename, '--team-server'], stderr: 'pipe', env: { ...process.env, ...env } });
      const c = new Client({ name: 'v59', version: '1' }); await c.connect(transport);
      return { c, close: () => c.close() };
    };
    let s = await mcp({ MOST_CLIENT: 'codex', MOST_JOB_ID: undefined });
    try {
      const r = await s.c.callTool({ name: 'team_inbox', arguments: { action: 'list' } });
      assert(!r.isError, (r.content || []).map(x => x.text).join('\n'));
    } finally { await s.close(); }
    s = await mcp({ MOST_CLIENT: 'claude', MOST_JOB_ID: 'job-inbox-v59' });
    try {
      const r = await s.c.callTool({ name: 'team_inbox', arguments: { action: 'list' } }).catch(e => ({ isError: true }));
      assert(r.isError, 'из поручения team_inbox недоступен');
    } finally { await s.close(); }
  });

  f.run(tests);
}
