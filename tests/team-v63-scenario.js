'use strict';
// team-v63: вложения (п.1), уровень модели (п.3), продолжение сеанса (п.2), учёт объёма/времени (п.6), отметка лимита (п.5),
// и движок сценариев (п.4): 3 хода, параллельность, обход участника по лимиту, подъём после перезапуска посреди шага,
// stop/resume, права гостя-поручения (отказ), счётчик идущих сценариев для краткой сводки.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const att = require('../common/attachments'), usage = require('../common/usage'), qm = require('../common/quota-mark'), mc = require('../common/model-choice');
const scenario = require('../common/scenario');
const tests = [];
const T = (n, f) => tests.push([n, f]);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v63-sc-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────── п.1 вложения ─────────
T('вложения: размеченные блоки, срез строк, хеш, хвост подсказки', () => {
  const f = path.join(tmpRoot, 'm.txt'); fs.writeFileSync(f, 'a\nb\nc\nd');
  const d = att.read([f, { path: f, lines: '2-3' }]);
  assert(d.text.includes('----- вложение: ' + f + ' -----'), 'имя файла в блоке');
  assert(d.text.includes('b\nc') && d.names[1].includes('строки 2-3'), 'срез строк');
  assert.equal(d.hash.length, 64);
  const job = {}; att.attach(job, d, path.join(tmpRoot, 'at.txt'));
  assert.equal(job.attachmentsChars, d.chars);
  const tail = att.promptTail(job);
  assert.equal(tail[0], att.NOTE, 'строка «файлы открывать не нужно»');
  assert(tail[1].includes('a\nb\nc\nd'));
  assert.throws(() => att.read([path.join(tmpRoot, 'нет.txt')]), /не прочитать/);
  assert.throws(() => att.read(['relative.txt']), /абсолютн/);
});

// ───────── п.3 уровень модели ─────────
T('уровень модели fast/normal/strong задаёт конфигурацию, model сильнее', () => {
  for (const [level, model, effort] of [['fast', 'gpt-6.2-sol', 'medium'], ['normal', 'gpt-6.2-sol', 'high'], ['strong', 'gpt-6.2-astra', 'high']]) {
    assert.deepEqual(['class', 'model', 'effort'].map(k => mc.choose('codex', { task: 'x', level })[k]), ['уровень ' + level, model, effort]);
  }
  assert.equal(mc.choose('antigravity', { poruchenie: 'x', level: 'fast' }).model, 'gemini-4-hydrogen-low');
  assert.equal(mc.choose('deepseek', { task: 'x', level: 'fast' }).model, 'deepseek-flash');
  assert.equal(mc.choose('deepseek', { task: 'x', level: 'normal' }).model, 'deepseek-flash');
  assert.equal(mc.choose('deepseek', { task: 'x', level: 'strong' }).model, 'deepseek-v4-pro');
  assert.match(mc.line('codex', mc.choose('codex', { task: 'x', level: 'fast' })), /уровень задан поручением \(fast\)/);
  assert.equal(mc.choose('codex', { task: 'x', level: 'fast', model: 'gpt-6-luna' }).named, true, 'model сильнее level');
  // граница с уровнем ЭТАПА «высокий» не задета (не-код: остаётся hydrogen-high; код теперь neon-low — см. п.б ниже)
  assert.equal(mc.choose('antigravity', { poruchenie: 'ревью', rezhim: 'zamechaniya', fayl: 'замысел.md', level: 'высокий' }).model, 'gemini-4-hydrogen-high');
});

// ───────── п.б ревью кода/дифа у Antigravity → neon-low (откат hydrogen-high) ─────────
T('п.б: Antigravity ревью кода/дифа → neon-low с откатом hydrogen-high; прочее не затронуто', () => {
  const c = mc.choose('antigravity', { poruchenie: 'дай замечания', rezhim: 'zamechaniya', fayl: 'servers/team/index.js' });
  assert.equal(c.model, 'gemini-4-neon-low', 'ревью кода → neon-low');
  assert.equal(c.class, 'review_code');
  assert.equal(c.fallback, 'gemini-4-hydrogen-high', 'откат на прежний выбор, без отказа');
  assert.match(mc.line('antigravity', c), /neon-low.*review_code/, 'строка причины называет neon-low и класс');
  // роль проверка с код-темой в тексте — тоже neon-low
  assert.equal(mc.choose('antigravity', { poruchenie: 'проверь патч', role: 'проверка' }).model, 'gemini-4-neon-low');
  // не-код высокого этапа — прежний hydrogen-high; литературный текст — argon-high (не трогаем)
  assert.equal(mc.choose('antigravity', { poruchenie: 'оцени рассказ', rezhim: 'zamechaniya', level: 'высокий' }).model, 'gemini-4-hydrogen-high');
  assert.equal(mc.choose('antigravity', { poruchenie: 'напиши сцену', role: 'текст' }).model, 'gemini-4-argon-high');
  // прочие участники: ревью кода без изменений
  assert.equal(mc.choose('deepseek', { task: 'проверь метод', role: 'проверка' }).model, 'deepseek-flash');
  assert.equal(mc.choose('kimi', { task: 'проверь diff', role: 'проверка' }).model, 'kimi-code/k3.1-pro-highspeed');
});

// ───────── п.а mode=text без folder: служебная папка при ЛЮБОЙ роли ─────────
T('п.а: scratch-folder — mode=text (anyRole) берёт служебную папку даже для роли «проверка» без text', () => {
  const sf = require('../common/scratch-folder');
  // ДО (как у прочих адаптеров): роль «проверка» без text — служебная папка НЕ берётся (нужна явная).
  assert.equal(sf.scratchAllowed({ role: 'проверка', write: false }), false, 'без anyRole проверка без text — папка обязательна');
  // ПОСЛЕ (mode=text у Antigravity): при anyRole служебная папка берётся при любой роли.
  for (const role of ['текст', 'проверка', 'совет', undefined]) {
    assert.equal(sf.scratchAllowed({ role, write: false, anyRole: true }), true, 'anyRole разрешает роль ' + role);
    const a = { role, write: false, anyRole: true };
    const dir = sf.ensure(a);
    assert(dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory(), 'служебная папка создана для роли ' + role);
  }
  // запись (write) служебную папку по-прежнему не получает даже с anyRole
  assert.equal(sf.scratchAllowed({ role: 'совет', write: true, anyRole: true }), false, 'запись требует явную папку');
  // Antigravity mode=text без folder вызывает ensure с anyRole:true.
  const src = fs.readFileSync(path.join(__dirname, '..', 'servers', 'antigravity', 'index.js'), 'utf8');
  assert.match(src, /scratch-folder'\)\.ensure\(\{ role:[^}]*anyRole: true \}\)/, 'антигравити зовёт ensure с anyRole:true');
  assert.match(src, /file укажи полным путём \(абсолютным\)/, 'п.в.1: относительный file отклоняется');
});

// ───────── п.6 учёт объёма и времени ─────────
T('учёт: chars_in, chars_out, seconds, токены только когда CLI сообщил', () => {
  assert.equal(usage.charsIn({ task: 'abc', text: 'de' }, 10), 15);
  const c = { childStartedAt: '2020-01-01T00:00:00Z', finishedAt: '2020-01-01T00:00:03Z' };
  usage.finalize(c, { resultText: 'hi' }); assert.equal(c.chars_out, 2); assert.equal(c.seconds, 3);
  assert.deepEqual(usage.codexTokens({ usage: { input_tokens: 10, output_tokens: 5 } }), { tokens_in: 10, tokens_out: 5 });
  assert.equal(usage.codexTokens({}), null, 'без usage — поле не ставим');
});

// ───────── п.5 отметка «лимит исчерпан» ─────────
T('отметка лимита: держит 10 минут, снимается успехом и истечением окна', () => {
  const now = Date.now();
  const wq = t => ({ retryKind: 'quota', status: 'waiting_quota', lastQuotaAt: new Date(now - t).toISOString() });
  assert.equal(qm.blocked([wq(60000)], { now }).blocked, true);
  assert.equal(qm.blocked([wq(700000)], { now }).blocked, false, 'окно истекло');
  assert.equal(qm.blocked([wq(60000), { status: 'done', finishedAt: new Date(now - 10000).toISOString() }], { now }).blocked, false, 'поздний успех снял');
  assert.equal(qm.blocked([{ retryKind: 'quota', status: 'cancelled', lastQuotaAt: new Date(now - 60000).toISOString() }], { now }).blocked, false, 'снятая пользователем — не отметка');
});

// ───────── Фейковый раннер и крючок для сценария ─────────
function makeRunner(opts = {}) {
  const behavior = opts.behavior || {}; // member → 'ok'|'quota'|'fail'
  const blocked = new Set(opts.blocked || []);
  const pollsNeeded = opts.pollsNeeded || 1;
  const jobs = new Map(); let seq = 0;
  const rec = { started: [], maxConcurrent: 0, concurrent: 0 };
  return {
    rec, blocked,
    quotaBlocked: m => blocked.has(m),
    paused: () => false,
    async start({ member, key, task, continueId, files }) {
      const id = 'job' + (++seq);
      jobs.set(id, { member, key, task, continueId, files, polls: 0, status: behavior[member] || 'ok' });
      rec.started.push({ id, member, key, continueId: continueId || null, files: files || null });
      rec.concurrent++; rec.maxConcurrent = Math.max(rec.maxConcurrent, rec.concurrent);
      return { jobId: id };
    },
    async poll(id) {
      const j = jobs.get(id); if (!j) return { terminal: true, status: 'lost' };
      j.polls++;
      if (j.polls < pollsNeeded) return { terminal: false };
      rec.concurrent--;
      if (j.status === 'quota') return { terminal: true, status: 'quota', error: 'лимит', seconds: 1, chars_in: 100, chars_out: 0 };
      if (j.status === 'fail') return { terminal: true, status: 'failed', error: 'сбой', seconds: 1 };
      return { terminal: true, status: 'done', text: 'ответ ' + j.key, seconds: 2, chars_in: 100, chars_out: 50 };
    },
    async cancel() {},
    jobs,
  };
}
// Крючок «стол»: нечётные шаги — ведущий (session gm), чётные — три игрока параллельно. Всего 3 хода, затем done.
function tableHook(_St, payload) {
  const st = payload.state || { step: 0 };
  st.step += 1;
  if (st.step > 3) return { state: st, done: true, note: 'готово за 3 хода' };
  if (st.step % 2 === 1) return { state: st, note: 'ход ' + st.step + ': ведущий',
    send: [{ key: 'gm', member: 'codex', session: 'gm', level: 'strong', task: 'ход ' + st.step }] };
  return { state: st, note: 'ход ' + st.step + ': игроки', send: [
    { key: 'p1', members: ['kimi', 'codex'], session: 'p1', level: 'fast', task: 'игрок1', memory_file: path.join(tmpRoot, 'mem.txt') },
    { key: 'p2', member: 'codex', session: 'p2', task: 'игрок2' },
    { key: 'p3', member: 'codex', session: 'p3', task: 'игрок3' } ] };
}
function startScenario(id, extra = {}) {
  const dir = scenario.dirOf(tmpRoot, id); fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, 'scenario.json'); fs.writeFileSync(sf, JSON.stringify({ id, title: 'тест стол' }));
  fs.writeFileSync(path.join(tmpRoot, 'mem.txt'), 'память сценария');
  // Крючок обязателен в create; подставим фиктивные абсолютные пути (invokeHook всё равно инжектируем).
  const hook = { interp: process.execPath, script: sf };
  return scenario.create(tmpRoot, { scenarioFile: sf, hook, ...extra });
}

// ───────── п.2 продолжение сеанса: фейковый исполнитель помнит сеанс ─────────
T('продолжение сеанса: исполнитель помнит прошлые ходы по continue_id', async () => {
  startScenario('sc-memory');
  const memory = new Map(); // jobId → список ходов сеанса
  const runner = {
    quotaBlocked: () => false, paused: () => false, rec: { started: [] },
    async start({ continueId, task }) {
      const id = 'j' + (memory.size + 1);
      const prior = continueId ? (memory.get(continueId) || []) : [];
      const turns = [...prior, task];
      memory.set(id, turns);
      runner.rec.started.push({ id, continueId: continueId || null, remembered: prior.length });
      return { jobId: id };
    },
    async poll(id) { const t = memory.get(id); return { terminal: true, status: 'done', text: 'помню ходы: ' + t.join('|'), seconds: 1, chars_in: 10, chars_out: 20 }; },
    async cancel() {},
  };
  // Крючок-одиночка: один и тот же сеанс gm, 3 хода.
  function solo(_St, payload) { const st = payload.state || { step: 0 }; st.step += 1;
    if (st.step > 3) return { state: st, done: true };
    return { state: st, send: [{ key: 'gm', member: 'codex', session: 'gm', task: 'ход ' + st.step }] }; }
  const deps = { runner, invokeHook: solo, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 100 };
  const S = await scenario.drive(tmpRoot, 'sc-memory', deps);
  assert.equal(S.status, 'done');
  const starts = runner.rec.started;
  assert.equal(starts[0].remembered, 0, 'первый ход — без памяти');
  assert.equal(starts[2].remembered, 2, 'третий ход помнит два прошлых');
  assert(starts[1].continueId && starts[2].continueId, 'ходы 2 и 3 — продолжение');
});

// ───────── п.4 три хода, параллельность, обход участника по лимиту ─────────
T('сценарий: 3 хода, игроки параллельно, обход участника по отказу квоты', async () => {
  const S0 = startScenario('sc-table');
  const runner = makeRunner({ behavior: { kimi: 'quota' } }); // kimi не заблокирован заранее, но его поручение падает по квоте
  const deps = { runner, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 200 };
  const S = await scenario.drive(tmpRoot, 'sc-table', deps);
  assert.equal(S.status, 'done', 'сценарий завершился: ' + (S.error || ''));
  assert.equal(S.totals.steps, 3, 'три хода выполнено');
  // Обход: p1 стартовал на kimi (квота), затем на codex тем же ключом.
  const p1 = runner.rec.started.filter(s => s.key === 'p1');
  assert.deepEqual(p1.map(s => s.member), ['kimi', 'codex'], 'p1: kimi→codex');
  // Продолжение сеанса ведущего: на 3-м ходу gm продолжает прошлый gm (continueId не пуст).
  const gm = runner.rec.started.filter(s => s.key === 'gm');
  assert.equal(gm.length, 2); assert.equal(gm[0].continueId, null, 'первый ход gm — новый сеанс');
  assert(gm[1].continueId, 'второй ход gm — продолжение');
  // Журнал шагов на диске.
  const steps = fs.readFileSync(path.join(scenario.dirOf(tmpRoot, 'sc-table'), 'steps.jsonl'), 'utf8').trim().split('\n');
  assert.equal(steps.length, 3);
  assert(JSON.parse(steps[1]).results.length === 3, 'во втором шаге три поручения');
});

T('сценарий: обход участника с действующей отметкой лимита (не стартуем ему)', async () => {
  startScenario('sc-skip');
  const runner = makeRunner({ blocked: ['kimi'] }); // kimi заранее с действующей отметкой
  const deps = { runner, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 200 };
  const S = await scenario.drive(tmpRoot, 'sc-skip', deps);
  assert.equal(S.status, 'done');
  const p1 = runner.rec.started.filter(s => s.key === 'p1');
  assert.deepEqual(p1.map(s => s.member), ['codex'], 'p1 сразу на codex — kimi пропущен');
});

T('сценарий: параллельность игроков ограничена parallel', async () => {
  startScenario('sc-par', { parallel: 2 });
  const runner = makeRunner({ pollsNeeded: 2 }); // поручения живут два опроса — видно одновременность
  const deps = { runner, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 400 };
  const S = await scenario.drive(tmpRoot, 'sc-par', deps);
  assert.equal(S.status, 'done');
  assert(runner.rec.maxConcurrent <= 2, 'не более 2 одновременно: было ' + runner.rec.maxConcurrent);
});

// ───────── п.4 подъём после перезапуска посреди шага ─────────
T('сценарий: подъём после перезапуска посреди шага переотправляет поручения', async () => {
  startScenario('sc-restart');
  const runner1 = makeRunner({ pollsNeeded: 5 }); // поручения ещё идут
  const deps1 = { runner: runner1, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1 };
  await scenario.tick(tmpRoot, 'sc-restart', deps1); // шаг 1: gm разведён, ещё running
  let S = scenario.loadState(tmpRoot, 'sc-restart');
  await scenario.tick(tmpRoot, 'sc-restart', deps1);
  S = scenario.loadState(tmpRoot, 'sc-restart');
  assert(Object.values(S.jobs).some(j => j.status === 'running'), 'есть идущее поручение до «перезапуска»');
  // «Перезапуск»: новый раннер (прежние jobId неизвестны), оборванные → снова pending.
  require('../common/scenario-manager').repend(S); S.status = 'running'; scenario.saveState(tmpRoot, S);
  const runner2 = makeRunner();
  const deps2 = { runner: runner2, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 300 };
  const done = await scenario.drive(tmpRoot, 'sc-restart', deps2);
  assert.equal(done.status, 'done', 'после перезапуска довёл до конца');
  assert(runner2.rec.started.some(s => s.key === 'gm'), 'gm переотправлен новым раннером');
});

// ───────── п.4 stop/resume ─────────
T('сценарий: stop останавливает, resume продолжает', async () => {
  const mgr = require('../common/scenario-manager'); const access = require('../common/access');
  const origChat = access.chatSession; access.chatSession = () => true; // в тест-процессе прав чата нет — подставляем
  try {
  startScenario('sc-stopresume');
  const runner = makeRunner({ pollsNeeded: 3 });
  const deps = { runner, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1 };
  await scenario.tick(tmpRoot, 'sc-stopresume', deps); // шаг 1
  // stop (команда асинхронна: дожидается отмены идущих поручений перед записью stopped — п.6)
  await mgr.command({ action: 'stop', id: 'sc-stopresume' }, { stateDir: tmpRoot, deps });
  assert.equal(scenario.loadState(tmpRoot, 'sc-stopresume').status, 'stopped');
  // resume через менеджер (инжектируем deps, цикл доводит)
  const runner2 = makeRunner();
  const deps2 = { runner: runner2, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 300 };
  await mgr.command({ action: 'resume', id: 'sc-stopresume' }, { stateDir: tmpRoot, deps: deps2 });
  // дождёмся завершения фонового цикла (resume переводит в running под замком асинхронно — ждём терминал, а не транзит)
  for (let i = 0; i < 400 && !['done', 'failed'].includes(scenario.loadState(tmpRoot, 'sc-stopresume').status); i++) await sleep(5);
  assert.equal(scenario.loadState(tmpRoot, 'sc-stopresume').status, 'done');
  } finally { access.chatSession = origChat; }
});

// ───────── п.4 права гостя-поручения (отказ) и счётчик сводки ─────────
T('права: поручение-исполнитель (гость, не чат) получает отказ; доказанный чат — нет', async () => {
  const mgr = require('../common/scenario-manager'); const access = require('../common/access');
  const origChat = access.chatSession, origGuest = access.guest;
  try {
    access.chatSession = () => false; access.guest = () => true; // гость-поручение
    await assert.rejects(() => mgr.command({ action: 'start', scenario_file: 'x' }, { stateDir: tmpRoot }), /доказанный чат/);
    access.chatSession = () => true; access.guest = () => false; // дирижёр
    await assert.doesNotReject(() => mgr.command({ action: 'list' }, { stateDir: tmpRoot }));
  } finally { access.chatSession = origChat; access.guest = origGuest; }
});

T('краткая сводка: счётчик идущих сценариев', () => {
  // sc-table/sc-skip/sc-par/sc-restart/sc-stopresume завершены; заведём один running.
  startScenario('sc-live');
  assert(scenario.runningCount(tmpRoot) >= 1, 'есть идущий сценарий');
  assert.match(scenario.statusLine(scenario.loadState(tmpRoot, 'sc-live')), /Сценарий sc-live: running/);
});

// ───────── А: НАСТОЯЩИЙ путь отправки для ВСЕХ пяти участников + идемпотентность подъёма ─────────
T('А: раннер шлёт всем пяти участникам настоящим *_send; карточки помечены происхождением; подъём не задваивает', async () => {
  const { senderRunner } = require('../common/scenario-senders');
  const state = fs.mkdtempSync(path.join(tmpRoot, 'A-'));
  const folder = fs.mkdtempSync(path.join(tmpRoot, 'Af-'));
  const execByRid = new Map(); // rid → число «выполнений» (имитация идемпотентности сервера по request_id)
  // team-v63 (п.2): карточки Antigravity лежат комплектом <state>/jobs/<id>/card.json, остальных — плоско <state>/<member>-jobs/<id>.json.
  const jobsDir = m => path.join(state, m === 'antigravity' ? 'jobs' : m + '-jobs');
  const readCards = m => { const dir = jobsDir(m); try {
    if (m === 'antigravity') return fs.readdirSync(dir).map(d => { try { return JSON.parse(fs.readFileSync(path.join(dir, d, 'card.json'), 'utf8')); } catch { return null; } }).filter(Boolean);
    return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } }).filter(Boolean);
  } catch { return []; } };
  // Фейковый клиент вместо дочернего сервера: пишет НАСТОЯЩУЮ по форме карточку участника (from=claude), повтор того же
  // request_id возвращает ту же карточку без повторного выполнения (как admission сервера). Antigravity отвечает по-своему.
  async function clientFactory(member) {
    return { async callTool({ name, arguments: a }) {
      assert.equal(name, member + '_send');
      assert.equal(a.folder, folder); assert(a.request_id, 'передан request_id');
      let card = readCards(member).find(c => c && c.requestId === a.request_id);
      if (!card) {
        execByRid.set(a.request_id, (execByRid.get(a.request_id) || 0) + 1);
        const id = member + '-' + Math.random().toString(36).slice(2, 8);
        const dir = jobsDir(member);
        const bundleDir = member === 'antigravity' ? path.join(dir, id) : dir;
        fs.mkdirSync(bundleDir, { recursive: true });
        const rf = path.join(bundleDir, id + '.result.txt'); fs.writeFileSync(rf, 'ответ ' + member);
        card = { id, requestId: a.request_id, from: 'claude', status: 'done', folder: a.folder, role: a.role, model: member + '-m',
          seconds: 2, chars_in: (a.task || '').length, chars_out: 10, resultFile: rf, startedAt: new Date().toISOString() };
        fs.writeFileSync(path.join(bundleDir, member === 'antigravity' ? 'card.json' : id + '.json'), JSON.stringify(card));
      }
      const text = member === 'antigravity' ? 'Задание ' + card.id + ' запущено' : 'Номер поручения: ' + card.id + '\nID запроса: ' + a.request_id;
      return { content: [{ type: 'text', text }] };
    }, async close() {} };
  }
  const S = { id: 'A-scn', folder, by: 'codex-chat' };
  const runner = senderRunner(state, S, { clientFactory });
  const members = ['codex', 'deepseek', 'kimi', 'antigravity', 'claude'];
  const handles = {};
  for (const m of members) handles[m] = (await runner.start({ key: 'k-' + m, member: m, role: 'совет', task: 'задача', requestId: 'sc-A-s1-k' + m + '-' + m + '-a0' })).jobId;
  for (const m of members) { let p, n = 0; do { await sleep(2); p = await runner.poll(handles[m]); } while (!p.terminal && ++n < 50);
    assert.equal(p.status, 'done', m + ' done'); assert(p.memberJobId, m + ' memberJobId'); }
  // Все пять карточек помечены происхождением.
  for (const m of members) {
    const card = readCards(m).find(c => c.requestId.includes('k' + m));
    assert.equal(card.from, 'claude', m + ' from=чат(claude)');
    assert.equal(card.scenario, 'A-scn', m + ' scenario');
    assert.equal(card.scenarioKey, 'k-' + m, m + ' scenarioKey');
    assert.equal(card.scenarioBy, 'codex-chat', m + ' scenarioBy=запустивший чат');
  }
  assert.equal([...execByRid.values()].reduce((a, b) => a + b, 0), 5, 'ровно пять выполнений (по одному на участника)');
  // Подъём: повторная отправка тем же request_id (идемпотентно) НЕ выполняет поручение заново.
  const again = (await runner.start({ key: 'k-codex', member: 'codex', role: 'совет', task: 'задача', requestId: 'sc-A-s1-kcodex-codex-a0' })).jobId;
  let p2, n2 = 0; do { await sleep(2); p2 = await runner.poll(again); } while (!p2.terminal && ++n2 < 50);
  assert.equal(execByRid.get('sc-A-s1-kcodex-codex-a0'), 1, 'повтор request_id не задвоил выполнение');
  await runner.close();
});

// ───────── Б.3: antigravity — files и level в схеме ─────────
T('Б.3: antigravity_send принимает files (вложения) и level в схеме', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'servers', 'antigravity', 'index.js'), 'utf8');
  assert.match(src, /files: z\.array\(z\.union\(\[z\.string\(\), z\.object\(\{ path: z\.string\(\), lines: z\.string\(\)\.optional\(\) \}\)\]\)\)\.optional\(\)/, 'files в схеме most_poruchit');
  assert.match(src, /level: z\.enum\(\['fast', 'normal', 'strong'\]\)\.optional\(\)/, 'level в схеме');
  assert.match(src, /_att\.read\(files, \{ authorize:/, 'files читаются общим модулем attachments');
  assert.match(src, /mc\.choose\('antigravity', \{ task: classifyMaterial \? poruchenie \+ '\\n\\n' \+ classifyMaterial : poruchenie, rezhim, fayl, opora, role: agyRole, level \}\)/, 'level передан в выбор модели');
  // level доходит до модели antigravity.
  assert.equal(mc.choose('antigravity', { poruchenie: 'x', level: 'strong' }).model, 'gemini-4-hydrogen-high');
});

// ───────── п.г учёт хода сеанса: карточка шага берётся по memberJobId, а не «самая свежая» ─────────
T('п.г: sessionTurn шага сопоставляется по memberJobId (bridge считает ход верно; виноват сбор метрик)', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'g-'));
  // три хода ОДНОГО сеанса игрока p1: карточки с sessionTurn 1,2,3 и возрастающим startedAt (как их пишет сервер участника).
  const cards = [1, 2, 3].map((t, i) => ({ id: 'd' + t, sessionTurn: t, remembers: t > 1,
    startedAt: new Date(2020, 0, 1, 0, 0, i).toISOString(), scenario: 'g', scenarioKey: 'p1' }));
  for (const c of cards) fs.writeFileSync(path.join(dir, c.id + '.json'), JSON.stringify(c));
  const read = id => JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
  // steps.jsonl: p1 ходит на шагах 2,4,6, каждый со своим memberJobId (его пишет движок на каждый результат).
  const steps = [{ step: 2, memberJobId: 'd1' }, { step: 4, memberJobId: 'd2' }, { step: 6, memberJobId: 'd3' }];
  // ФИКС: точное сопоставление по memberJobId — sessionTurn совпадает с номером хода сеанса (1,2,3), первый ход помнит=false.
  assert.deepEqual(steps.map(s => read(s.memberJobId).sessionTurn), [1, 2, 3], 'по memberJobId — верный ход сеанса');
  assert.equal(read(steps[0].memberJobId).remembers, false, 'первый ход сеанса — ещё не помнит секрет');
  // СТАРАЯ эвристика (самая свежая карточка по scenario+key): p1 не стоит на нулевом глобальном шаге, поэтому бралась новейшая
  // карточка на КАЖДОМ ходу → первый ход игроков показывал sessionTurn=3 и remembers=true (ровно то, что в live-metrics.json).
  const byStart = cards.slice().sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  assert.deepEqual(steps.map(() => byStart[byStart.length - 1].sessionTurn), [3, 3, 3], 'старая эвристика путала ход');
  // Движок действительно кладёт memberJobId в steps.jsonl — данные для точного сопоставления есть.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'common', 'scenario.js'), 'utf8'), /memberJobId: r\.memberJobId/);
});

// ───────── п.в.2 findCodex: пустой/битый путь (null) не кэшируется на 5 минут ─────────
T('п.в.2: findCodex не запоминает «не найден» — после появления Codex находится сразу', () => {
  const team = require('../common/team');
  team._resetCodexCache();
  let calls = 0, path0 = null;
  const probe = () => { calls++; return path0; };
  // Codex ещё не найден: null НЕ кэшируется — каждый вызов зондирует заново.
  assert.equal(team.findCodex(probe), null);
  assert.equal(team.findCodex(probe), null);
  assert.equal(calls, 2, 'null не закэширован: зонд повторён');
  // Codex появился: следующий вызов находит путь (не держит старый null ещё 5 минут).
  path0 = 'C:/codex.exe';
  assert.equal(team.findCodex(probe), 'C:/codex.exe', 'после появления — найден сразу');
  assert.equal(calls, 3);
  // Найденный путь кэшируется: повтор не зондирует.
  assert.equal(team.findCodex(probe), 'C:/codex.exe');
  assert.equal(calls, 3, 'найденный путь закэширован');
  team._resetCodexCache();
});

// ───────── п.в.3 снимок процессов: допуск — свежий native; сводка — кэш ≤30с (не дефект) ─────────
T('п.в.3: допуск (capture) берёт свежий native-снимок; сводка (warnings) — кэшируемый (намеренно)', () => {
  const fallback = require('../common/fallback');
  const orig = fallback.processTable, calls = [];
  fallback.processTable = (fresh = false, opts = {}) => { calls.push({ fresh, native: !!opts.native });
    return [{ pid: process.pid, ppid: 0, name: 'node', startedAt: new Date().toISOString() }]; };
  try {
    require('../common/restart-hold').capture({ serverStartedAt: new Date().toISOString() });
    assert(calls.some(c => c.fresh === true && c.native === true), 'допуск/gating: свежий native-снимок');
  } finally { fallback.processTable = orig; }
  // Сводка (warnings → snapshotFingerprint) сознательно берёт кэшируемый снимок (fresh=false): один снимок на запрос ради
  // «сводки за секунды» (team-v60). Staleness ограничен 30 с и влияет только на предупреждающую строку, не на приём поручений.
  const src = fs.readFileSync(path.join(__dirname, '..', 'common', 'restart-hold.js'), 'utf8');
  assert.match(src, /snapshotFingerprint[\s\S]*?processTable\(false\)/, 'snapshotFingerprint: кэшируемый снимок (намеренно)');
  assert.match(src, /function capture[\s\S]*?processTable\(true, \{ native: true \}\)/, 'capture: свежий native-снимок');
});

// ───────── п.11 однозначность ключа + уникальность ключей шага ─────────
T('п.11: safeKey однозначен (кириллица/длина не схлопываются); повтор ключа send — отказ', async () => {
  assert.equal(scenario.safeKey('gm'), 'gm', 'чистый ASCII без хвоста');
  assert.notEqual(scenario.safeKey('ведущий'), scenario.safeKey('игрок'), 'кириллица не схлопывается в ____');
  assert.notEqual(scenario.safeKey('a'.repeat(50) + 'X'), scenario.safeKey('a'.repeat(50) + 'Y'), 'длина не схлопывается обрезкой');
  startScenario('sc-dupkey');
  function dup(_St, payload) { const st = payload.state || { step: 0 }; st.step += 1; if (st.step > 1) return { state: st, done: true };
    return { state: st, send: [{ key: 'x', member: 'codex', task: 'a' }, { key: 'x', member: 'codex', task: 'b' }] }; }
  const S = await scenario.drive(tmpRoot, 'sc-dupkey', { runner: makeRunner(), invokeHook: dup, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 50 });
  assert.equal(S.status, 'failed'); assert.match(S.error, /повторный ключ/);
});

// ───────── п.12 повторный start с идущим id — отказ ─────────
T('п.12: повторный create с id идущего сценария — отказ', () => {
  startScenario('sc-dup12');
  assert.throws(() => startScenario('sc-dup12'), /уже существует/);
});

// ───────── п.13 проверка id ─────────
T('п.13: id в status/stop/resume проверяется (без обхода ..\\..)', async () => {
  const mgr = require('../common/scenario-manager');
  await assert.rejects(() => mgr.command({ action: 'status', id: '../../etc' }, { stateDir: tmpRoot }), /Недопустимый id/);
  assert.equal(scenario.validId('sc-ok_1'), true);
  assert.equal(scenario.validId('../x'), false);
});

// ───────── п.14 parallel из файла ─────────
T('п.14: parallel из файла сценария — отрицательное/ноль/дробное отклоняется при старте', () => {
  const dir = scenario.dirOf(tmpRoot, 'sc-par-bad'); fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, 's.json'); const hook = { interp: process.execPath, script: sf };
  for (const bad of [0, -2, 1.5]) { fs.writeFileSync(sf, JSON.stringify({ id: 'sc-par-bad', parallel: bad })); assert.throws(() => scenario.create(tmpRoot, { scenarioFile: sf, hook }), /parallel/, 'parallel=' + bad); }
  fs.writeFileSync(sf, JSON.stringify({ id: 'sc-par-ok', parallel: 2 })); assert.doesNotThrow(() => scenario.create(tmpRoot, { scenarioFile: sf, hook }));
});

// ───────── п.9 подъём: тот же участник и request_id ─────────
T('п.9: подъём переотправляет тому же участнику тем же request_id', async () => {
  startScenario('sc-resume9');
  const deps = { runner: makeRunner({ pollsNeeded: 5 }), invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1 };
  await scenario.tick(tmpRoot, 'sc-resume9', deps); // шаг 1: gm разведён, ещё идёт
  let S = scenario.loadState(tmpRoot, 'sc-resume9');
  const rid = S.jobs.gm.requestId, mem = S.jobs.gm.member;
  assert(rid && mem, 'request_id и участник выбраны');
  require('../common/scenario-manager').repend(S); S.status = 'running'; scenario.saveState(tmpRoot, S);
  // Новый раннер (как после перезапуска) с долго идущими поручениями — чтобы gm после переотправки остался в S.jobs для сверки.
  const runner2 = makeRunner({ pollsNeeded: 5 });
  await scenario.tick(tmpRoot, 'sc-resume9', { runner: runner2, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1 });
  S = scenario.loadState(tmpRoot, 'sc-resume9');
  assert.equal(S.jobs.gm.requestId, rid, 'тот же request_id (идемпотентно)');
  assert.equal(S.jobs.gm.member, mem, 'тот же участник');
  assert(runner2.rec.started.some(s => s.key === 'gm' && s.member === mem), 'gm переотправлен тому же участнику');
});

// ───────── п.10 отмена прежней карточки при передаче ─────────
T('п.10: при передаче другому участнику прежняя карточка отменяется', async () => {
  startScenario('sc-cancel10');
  const cancelled = [];
  const runner = makeRunner({ behavior: { kimi: 'quota' } });
  runner.cancel = async (id, member) => cancelled.push({ id, member });
  const S = await scenario.drive(tmpRoot, 'sc-cancel10', { runner, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 200 });
  assert.equal(S.status, 'done');
  assert(cancelled.some(c => c.member === 'kimi'), 'квотная карточка kimi отменена при передаче другому');
});

// ───────── п.24 учёт неудачных попыток ─────────
T('п.24: неудачные попытки учтены отдельной строкой итога', async () => {
  startScenario('sc-fail24');
  const S = await scenario.drive(tmpRoot, 'sc-fail24', { runner: makeRunner({ behavior: { kimi: 'quota' } }), invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 200 });
  assert.equal(S.status, 'done');
  assert(S.totals.failed.attempts >= 1 && S.totals.failed.chars_in >= 100, 'секунды/знаки неудачной попытки учтены');
  assert.match(scenario.statusLine(S), /неудачных попыток/);
});

// ───────── п.6 commit не затирает внешнюю остановку ─────────
T('п.6: commit не затирает внешнюю остановку (stop окончателен)', () => {
  startScenario('sc-commit6');
  const S = scenario.loadState(tmpRoot, 'sc-commit6');
  const disk = scenario.loadState(tmpRoot, 'sc-commit6'); disk.status = 'stopped'; scenario.saveState(tmpRoot, disk);
  const after = scenario.commit(tmpRoot, { ...S, status: 'running' });
  assert.equal(after.status, 'stopped', 'running-снимок не затёр stopped');
  assert.equal(scenario.loadState(tmpRoot, 'sc-commit6').status, 'stopped');
});

// ───────── п.8 межпроцессный замок ─────────
T('п.8: при занятом межпроцессном замке сценария второй ведущий не вмешивается', async () => {
  const mgr = require('../common/scenario-manager'), locks = require('../common/locks');
  startScenario('sc-lock8');
  const held = await locks.tryLock('scenario', 'sc-lock8', { scenario: 'sc-lock8' }, tmpRoot);
  assert(held.ok, 'замок владельца взят');
  try {
    const runner = makeRunner();
    await mgr.launch(tmpRoot, 'sc-lock8', { runner, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1 });
    await sleep(40);
    assert.equal(runner.rec.started.length, 0, 'второй ведущий при занятом замке поручений не слал');
  } finally { await held.release(); }
});

// ───────── п.3 предел вызова не меньше предела поручения ─────────
T('п.3: client.callTool получает предел не меньше предела поручения', async () => {
  const { senderRunner } = require('../common/scenario-senders');
  const st = fs.mkdtempSync(path.join(tmpRoot, 'T3-'));
  let opts;
  async function clientFactory(member) { return { async callTool(params, _s, o) { opts = o;
    const dir = path.join(st, member + '-jobs'); fs.mkdirSync(dir, { recursive: true }); const id = 'c1';
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, requestId: params.arguments.request_id, status: 'done', from: 'claude' }));
    return { content: [{ type: 'text', text: 'Номер поручения: ' + id }] }; }, async close() {} }; }
  const runner = senderRunner(st, { id: 'T3', folder: tmpRoot }, { clientFactory });
  const h = (await runner.start({ key: 'k', member: 'codex', task: 'x', timeout_sec: 4000, requestId: 'sc-T3-1' })).jobId;
  let p, n = 0; do { await sleep(2); p = await runner.poll(h); } while (!p.terminal && ++n < 50);
  assert(opts && opts.timeout >= 4000 * 1000, 'предел ≥ предела поручения (4000 c)');
  assert(opts.timeout >= 30 * 60 * 1000, 'не меньше базового 30 мин');
  await runner.close();
});

// ───────── п.5 смерть дочернего сервера → провал (не ждём вечно) ─────────
T('п.5: упавший *_send (сервер участника умер) → поручение провалено, не висит', async () => {
  const { senderRunner } = require('../common/scenario-senders');
  const st = fs.mkdtempSync(path.join(tmpRoot, 'D5-'));
  async function clientFactory() { return { async callTool() { throw Error('child died'); }, async close() {} }; }
  const runner = senderRunner(st, { id: 'D5', folder: tmpRoot }, { clientFactory });
  const h = (await runner.start({ key: 'k', member: 'codex', task: 'x', requestId: 'sc-D5-1' })).jobId;
  let p, n = 0; do { await sleep(2); p = await runner.poll(h); } while (!p.terminal && ++n < 50);
  assert.equal(p.status, 'failed'); assert.match(p.error, /child died/);
  await runner.close();
});

// ───────── п.22 метка происхождения на ИДУЩЕЙ карточке ─────────
T('п.22: метка scenario ставится на идущую карточку (не только на готовую)', async () => {
  const { senderRunner } = require('../common/scenario-senders');
  const st = fs.mkdtempSync(path.join(tmpRoot, 'O-'));
  const jobsD = path.join(st, 'jobs');
  async function clientFactory() { return { async callTool({ arguments: a }) {
    const id = 'ag1', bd = path.join(jobsD, id); fs.mkdirSync(bd, { recursive: true });
    fs.writeFileSync(path.join(bd, 'card.json'), JSON.stringify({ id, requestId: a.request_id, from: 'claude', status: 'running' }));
    return { content: [{ type: 'text', text: 'Задание ' + id + ' запущено' }] }; }, async close() {} }; }
  const runner = senderRunner(st, { id: 'O-scn', folder: tmpRoot, by: 'codex-chat' }, { clientFactory });
  const h = (await runner.start({ key: 'k1', member: 'antigravity', task: 'x', requestId: 'sc-O-1' })).jobId;
  await sleep(5); const p = await runner.poll(h);
  assert.equal(p.terminal, false, 'карточка ещё идёт');
  const card = JSON.parse(fs.readFileSync(path.join(jobsD, 'ag1', 'card.json'), 'utf8'));
  assert.equal(card.scenario, 'O-scn', 'идущая карточка помечена scenario'); assert.equal(card.scenarioKey, 'k1');
  await runner.close();
});

// ───────── п.16 права гостя на вложения ─────────
T('п.16: вложения гостя без полного доступа — только из его папки поручения; владельцу/чату/full — без пределов', () => {
  const att = require('../common/attachments');
  const folder = fs.mkdtempSync(path.join(tmpRoot, 'g16-'));
  const inside = path.join(folder, 'a.txt'); fs.writeFileSync(inside, 'x');
  const outside = path.join(tmpRoot, 'out16.txt'); fs.writeFileSync(outside, 'y');
  const auth = att.guestAuthorizer({ guest: true, folder, fullAccess: false });
  assert.throws(() => att.read([outside], { authorize: auth }), /только файлы внутри папки/);
  assert.doesNotThrow(() => att.read([inside], { authorize: auth }));
  assert.equal(att.guestAuthorizer({ guest: true, folder, fullAccess: true }), null, 'полный доступ — без пределов');
  assert.equal(att.guestAuthorizer({ guest: false, folder }), null, 'владелец/доказанный чат — без пределов');
});

// ───────── п.18 барьер миграции взведён до connect ─────────
T('п.18: arm() есть в каждом сервере ДО server.connect (вызов не проскочит мимо барьера)', () => {
  const sm = require('../common/state-migration');
  sm.resetForTest(); assert.equal(sm.armedForTest(), false, 'после сброса барьер снят');
  // arm() взводит started ровно тогда, когда миграция применима (applicable); идемпотентен и не падает.
  assert.equal(sm.arm(), sm.applicable(), 'arm взводит ровно при применимой миграции');
  sm.arm(); sm.resetForTest();
  for (const s of ['team', 'claude', 'codex', 'deepseek', 'kimi', 'antigravity', 'grok']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'servers', s, 'index.js'), 'utf8');
    const iArm = src.indexOf("state-migration').arm()"), iConn = src.indexOf('server.connect(');
    assert(iArm > -1, s + ': есть вызов arm()');
    assert(iArm < iConn, s + ': arm() стоит ДО server.connect');
  }
});

// ───────── п.17 дочерний сервер идёт от имени запустившего чата и не мигрирует ─────────
T('п.17: сценарный дочерний сервер — MOST_CLIENT=запустивший чат, миграция у него не применима', () => {
  const sm = require('../common/state-migration');
  assert.equal(sm.applicable({ MOST_CLIENT: 'claude', MOST_SCENARIO_CHILD: '1' }), false, 'сценарный ребёнок не мигрирует');
  const src = fs.readFileSync(path.join(__dirname, '..', 'common', 'scenario-senders.js'), 'utf8');
  assert.match(src, /MOST_CLIENT: asClient/, 'клиент дочернего — запустивший чат (S.by), не жёстко claude');
  assert.match(src, /MOST_SCENARIO_CHILD: '1'/, 'сценарному ребёнку выставлен признак (миграцию пропускает)');
});

// ───────── п.20 Kimi: вложения в input, не в job.task ─────────
T('п.20: Kimi — вложения уходят в .attach.txt и input, а не вклеиваются в job.task', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'servers', 'kimi', 'index.js'), 'utf8');
  assert(!/a\.task = a\.task \+[^\n]*attachData\.text/.test(src), 'текст вложений НЕ вклеивается в a.task');
  assert.match(src, /attach\(job, attachData, path\.join\(path\.dirname\(file\(id\)\), id \+ '\.attach\.txt'\)\)/, 'вложения Kimi — в .attach.txt');
  assert.match(src, /\['files', attachData\?\.hash\]/, 'хеш вложений в admission (а не раздутый task)');
  const mat = fs.readFileSync(path.join(__dirname, '..', 'common', 'kimi-material.js'), 'utf8');
  assert.match(mat, /attachments'\)\.promptTail\(job\)/, 'input дополняется promptTail на сборке');
});

// ───────── п.21 пропавший файл вложения к запуску — явная ошибка ─────────
T('п.21: пропавший файл вложения к моменту запуска — явная ошибка поручения', () => {
  const att = require('../common/attachments');
  assert.deepEqual(att.promptTail({}), [], 'без вложений — пусто');
  assert.throws(() => att.promptTail({ attachFile: path.join(tmpRoot, 'нет-attach.txt') }), /пропали к моменту запуска/);
});

// ───────── п.23 сводка считает сценарные в решениях/остановках ─────────
T('п.23: сводка не выбрасывает сценарные из счётчиков решений/остановок', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'common', 'summary.js'), 'utf8');
  assert.match(src, /if \(j\.scenario\) \{ if \(status === 'needs_decision'\) decisions\+\+; if \(stopped\) stops\+\+; continue; \}/, 'сценарные учтены в счётчиках');
  assert(!/!j\.scenario && \(j\.stopUnconfirmed/.test(src), 'фильтр больше не выбрасывает сценарные целиком');
});

// ───────── п.19 отметка лимита действует и на продолжении ─────────
T('п.19: быстрый отказ по свежей отметке лимита действует и на continue_id (кроме force)', () => {
  for (const s of ['codex', 'deepseek', 'kimi', 'claude']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'servers', s, 'index.js'), 'utf8');
    assert(!/a\.force !== true && !a\.continue_id && !access\.guest\(\)/.test(src), s + ': проверка больше не пропускается при continue_id');
    assert.match(src, /a\.force !== true && !access\.guest\(\)/, s + ': общая проверка для нового и продолжения');
  }
});

// ═════════ Часть 5: остановка, подъём и отмена — тесты «до/после» по пунктам Б1–Б7 ═════════
const doneHook = (_S, p) => ({ state: p.state || {}, done: true });
const gmOnceHook = (_S, p) => { const st = p.state || { step: 0 }; st.step += 1; if (st.step > 1) return { state: st, done: true }; return { state: st, send: [{ key: 'gm', member: 'codex', task: 'ход' }] }; };

// ───────── Б6/Б1: намерение «sending» на диск ДО отправки; остановка перед вызовом — отправки нет ─────────
T('Б1/Б6: намерение sending на диск до отправки; stop во время clientFor → отправки нет', async () => {
  startScenario('sc-b6');
  let sends = 0, sawSending = false;
  const runner = { quotaBlocked: () => false, paused: () => false,
    async start({ notStopped, key }) {
      const d = scenario.loadState(tmpRoot, 'sc-b6');
      if (d.jobs[key] && d.jobs[key].status === 'sending') sawSending = true;        // Б6: намерение уже на диске
      const s = scenario.loadState(tmpRoot, 'sc-b6'); s.status = 'stopped'; scenario.saveState(tmpRoot, s); // stop во время clientFor
      if (notStopped && !notStopped()) return { stopped: true };                     // Б1: вызов НЕ делается
      sends++; return { jobId: 'j' + sends };
    },
    async poll() { return { terminal: false }; }, async cancel() { return { confirmed: true }; } };
  const deps = { runner, invokeHook: gmOnceHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1 };
  await scenario.tick(tmpRoot, 'sc-b6', deps); // крючок → gm pending
  await scenario.tick(tmpRoot, 'sc-b6', deps); // разводка: sending на диск, stop, notStopped=false → без отправки
  assert(sawSending, 'Б6: намерение sending записано на диск до ответа start');
  assert.equal(sends, 0, 'Б1: отправки после stop не было');
  const d = scenario.loadState(tmpRoot, 'sc-b6');
  assert.equal(d.status, 'stopped');
  assert.equal(d.jobs.gm.status, 'sending', 'поручение осталось sending — подъём переотправит его тем же request_id');
});

// ───────── Б1: убитый по stop крючок → на диске stopped (пишется через commit, не saveState) ─────────
T('Б1: stop во время крючка → stopped не превращается в failed', async () => {
  startScenario('sc-hookstop');
  const deps = { runner: makeRunner(), now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1,
    invokeHook: async () => { const s = scenario.loadState(tmpRoot, 'sc-hookstop'); s.status = 'stopped'; scenario.saveState(tmpRoot, s); throw Error('крючок убит'); } };
  const S = await scenario.tick(tmpRoot, 'sc-hookstop', deps);
  assert.equal(S.status, 'stopped', 'stopped не затёрт на failed');
  assert.equal(scenario.loadState(tmpRoot, 'sc-hookstop').status, 'stopped');
});

// ───────── Б1: stop из процесса, который сценарий не ведёт — пишет stopped и отменяет через свой раннер ─────────
T('Б1: stop из не ведущего процесса — stopped на диск, отмена через собственный раннер', async () => {
  const mgr = require('../common/scenario-manager'), access = require('../common/access');
  const origChat = access.chatSession; access.chatSession = () => true;
  try {
    startScenario('sc-stop2');
    const runner = makeRunner({ pollsNeeded: 50 });
    await scenario.tick(tmpRoot, 'sc-stop2', { runner, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1 });
    assert(Object.values(scenario.loadState(tmpRoot, 'sc-stop2').jobs).some(j => j.status === 'running'), 'есть идущее поручение');
    const cancels = [];
    const stopRunner = { quotaBlocked: () => false, paused: () => false, close: async () => {},
      async cancel(spec, member) { cancels.push({ spec, member }); return { confirmed: true, status: 'cancelled' }; } };
    const resp = await mgr.command({ action: 'stop', id: 'sc-stop2' }, { stateDir: tmpRoot, deps: { runner: stopRunner } });
    assert.equal(scenario.loadState(tmpRoot, 'sc-stop2').status, 'stopped', 'stopped записан');
    assert(cancels.length >= 1, 'отмена вызвана вызвавшим процессом');
    assert.match(resp, /отменены/, 'ответ подтверждает отмену (раннер подтвердил конечное состояние)');
  } finally { access.chatSession = origChat; }
});

// ───────── Б2: при занятом замке подъём НЕ трогает состояние (пишет только владелец) ─────────
T('Б2: занятый замок — второй процесс состояние не пишет (repend не применён)', async () => {
  const mgr = require('../common/scenario-manager'), locks = require('../common/locks');
  startScenario('sc-b2');
  let S = scenario.loadState(tmpRoot, 'sc-b2'); S.phase = 'running_jobs'; S.step = 1;
  S.jobs = { gm: { cmd: { key: 'gm', member: 'codex', task: 't' }, membersLeft: ['codex'], member: 'codex', jobId: 'old', status: 'running', requestId: 'sc-b2-s1-gm-codex-a0' } };
  scenario.saveState(tmpRoot, S);
  const held = await locks.tryLock('scenario', 'sc-b2', { scenario: 'sc-b2' }, tmpRoot);
  try {
    await mgr.launch(tmpRoot, 'sc-b2', { runner: makeRunner(), invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1 }, { prep: St => mgr.repend(St) });
    await sleep(50);
    assert.equal(scenario.loadState(tmpRoot, 'sc-b2').jobs.gm.status, 'running', 'repend НЕ применён без замка — состояние не тронуто');
  } finally { await held.release(); }
});

// ───────── Б2: сбой взятия замка — сценарий НЕ запускается, ошибка записана ─────────
T('Б2: сбой замка → не ведём без замка, ошибка в status', async () => {
  const mgr = require('../common/scenario-manager'), locks = require('../common/locks');
  startScenario('sc-b2err');
  let S = scenario.loadState(tmpRoot, 'sc-b2err'); S.phase = 'running_jobs'; S.step = 1;
  S.jobs = { gm: { cmd: { key: 'gm', member: 'codex', task: 't' }, membersLeft: ['codex'], member: 'codex', jobId: 'old', status: 'running', requestId: 'sc-b2err-s1-gm-codex-a0' } };
  scenario.saveState(tmpRoot, S);
  const orig = locks.tryLock; locks.tryLock = async () => { throw Error('канал замка недоступен'); };
  try {
    const runner = makeRunner();
    await mgr.launch(tmpRoot, 'sc-b2err', { runner, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1 }, { prep: St => mgr.repend(St) });
    await sleep(40);
    assert.equal(runner.rec.started.length, 0, 'без замка поручений не слал');
    assert.match(scenario.loadState(tmpRoot, 'sc-b2err').error || '', /замок/, 'ошибка замка записана и видна');
  } finally { locks.tryLock = orig; }
});

// ───────── Б4: осиротевшая карточка (владелец мёртв) → poll возвращает lost, не висит ─────────
T('Б4: осиротевшая running-карточка (владелец мёртв) → poll lost, не вечное ожидание', async () => {
  const { senderRunner } = require('../common/scenario-senders');
  const st = fs.mkdtempSync(path.join(tmpRoot, 'B4-'));
  const jobsD = path.join(st, 'jobs');
  async function clientFactory() { return { async callTool({ arguments: a }) {
    const id = 'ag1', bd = path.join(jobsD, id); fs.mkdirSync(bd, { recursive: true });
    // running-карточка с МЁРТВЫМ владельцем (чужой instance, несуществующий pid) — как после краша team
    fs.writeFileSync(path.join(bd, 'card.json'), JSON.stringify({ id, requestId: a.request_id, from: 'claude', status: 'running',
      owner: { instance: 'dead-instance-xyz', pid: 2, startedAt: new Date().toISOString() }, startedAt: new Date().toISOString() }));
    return { content: [{ type: 'text', text: 'Задание ' + id + ' запущено' }] }; }, async close() {} }; }
  const runner = senderRunner(st, { id: 'B4', folder: tmpRoot }, { clientFactory });
  const h = (await runner.start({ key: 'k', member: 'antigravity', task: 'x', requestId: 'sc-B4-1', resuming: true })).jobId;
  let p, n = 0; do { await sleep(5); p = await runner.poll(h); } while (!p.terminal && ++n < 120);
  assert.equal(p.terminal, true, 'poll завершился (не висит)');
  assert.equal(p.status, 'lost', 'осиротевшая карточка → lost');
  await runner.close();
});

// ───────── Б4/Б7: осиротевшая попытка при подъёме → одно повторное поручение ТОМУ ЖЕ участнику ─────────
T('Б4/Б7: подъём осиротевшей попытки → один повтор тому же участнику новой попыткой', async () => {
  startScenario('sc-b4e');
  let S = scenario.loadState(tmpRoot, 'sc-b4e'); S.phase = 'running_jobs'; S.step = 1;
  S.jobs = { gm: { cmd: { key: 'gm', member: 'codex', task: 't' }, membersLeft: ['codex'], member: 'codex', jobId: 'j0', status: 'running', requestId: 'sc-b4e-s1-gm-codex-a0' } };
  scenario.saveState(tmpRoot, S);
  require('../common/scenario-manager').repend(S); S.status = 'running'; scenario.saveState(tmpRoot, S); // как после подъёма: resume+resuming
  const starts = []; let lostOnce = true;
  const runner = { quotaBlocked: () => false, paused: () => false,
    async start(a) { starts.push({ member: a.member, key: a.key, requestId: a.requestId }); return { jobId: 'h' + starts.length }; },
    async poll() { if (lostOnce) { lostOnce = false; return { terminal: true, status: 'lost', error: 'осиротело' }; } return { terminal: true, status: 'done', text: 'x', seconds: 1, chars_in: 1, chars_out: 1 }; },
    async cancel() { return { confirmed: true }; } };
  const done = await scenario.drive(tmpRoot, 'sc-b4e', { runner, invokeHook: doneHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 80 });
  assert.equal(done.status, 'done', 'довёл до конца, не зависло');
  const gm = starts.filter(s => s.key === 'gm');
  assert.equal(gm.length, 2, 'ровно одно повторное поручение (подъём + одна повторная попытка)');
  assert(gm.every(s => s.member === 'codex'), 'повтор ТОМУ ЖЕ участнику');
  assert.equal(gm[0].requestId, 'sc-b4e-s1-gm-codex-a0', 'подъём — тот же request_id');
  assert.notEqual(gm[1].requestId, gm[0].requestId, 'повтор осиротевшей — новая попытка (новый request_id)');
});

// ───────── Б5: отмена без подтверждения → предупреждение (возможен двойной расход) ─────────
T('Б5: неподтверждённая отмена при передаче → предупреждение в статусе', async () => {
  startScenario('sc-b5');
  const runner = makeRunner({ behavior: { kimi: 'quota' } });
  runner.cancel = async () => ({ confirmed: false, id: 'card-kimi', status: 'cancelling' });
  const S = await scenario.drive(tmpRoot, 'sc-b5', { runner, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 200 });
  assert.equal(S.status, 'done', 'сценарий ПРОДОЛЖИЛ (передал следующему), не завис');
  assert(S.warnings && S.warnings.some(w => /не подтвердило остановку/.test(w)), 'предупреждение записано в состояние');
  assert.match(scenario.statusLine(S), /не подтвердило остановку/, 'предупреждение видно в статусе');
});

// ───────── Б3: два одновременных antigravity_send с одним request_id → одно задание ─────────
T('Б3: два одновременных antigravity_send с одним request_id → одно задание', async () => {
  const { senderRunner } = require('../common/scenario-senders');
  const st = fs.mkdtempSync(path.join(tmpRoot, 'B3-'));
  const jobsD = path.join(st, 'jobs');
  let created = 0; const gate = { held: false };
  // Имитация серверного замка запроса: проверка «есть ли карточка с этим request_id» и создание — под одним замком.
  async function clientFactory() { return { async callTool({ arguments: a }) {
    while (gate.held) await sleep(1); gate.held = true;
    try {
      let card = null;
      try { card = fs.readdirSync(jobsD).map(d => { try { return JSON.parse(fs.readFileSync(path.join(jobsD, d, 'card.json'), 'utf8')); } catch { return null; } }).filter(Boolean).find(c => c.requestId === a.request_id); } catch {}
      if (!card) { created++; const id = 'ag' + created, bd = path.join(jobsD, id); fs.mkdirSync(bd, { recursive: true });
        card = { id, requestId: a.request_id, from: 'claude', status: 'done', seconds: 1, chars_in: 1, chars_out: 1 };
        fs.writeFileSync(path.join(bd, 'card.json'), JSON.stringify(card)); fs.writeFileSync(path.join(bd, 'result.txt'), 'ok'); }
      return { content: [{ type: 'text', text: 'Задание ' + card.id + ' запущено' }] };
    } finally { gate.held = false; }
  }, async close() {} }; }
  const runner = senderRunner(st, { id: 'B3', folder: tmpRoot }, { clientFactory });
  const [h1, h2] = await Promise.all([
    runner.start({ key: 'k1', member: 'antigravity', task: 'x', requestId: 'sc-B3-dup' }),
    runner.start({ key: 'k2', member: 'antigravity', task: 'x', requestId: 'sc-B3-dup' }),
  ]);
  for (const h of [h1.jobId, h2.jobId]) { let p, n = 0; do { await sleep(3); p = await runner.poll(h); } while (!p.terminal && ++n < 60); }
  assert.equal(created, 1, 'одно задание на один request_id при двух одновременных отправках');
  // И в самом сервере antigravity: замок запроса + запасной поиск по requestId в карточке
  const agy = fs.readFileSync(path.join(__dirname, '..', 'servers', 'antigravity', 'index.js'), 'utf8');
  assert.match(agy, /tryLock\('agyreq'/, 'antigravity: замок запроса по request_id');
  assert.match(agy, /for \(const j of listJobs\(\)\) if \(j\.requestId === requestId/, 'запасной поиск карточки по requestId');
  await runner.close();
});

// ───────── Б6: падение между отправкой и записью → подъём без второго поручения другому участнику ─────────
T('Б6: падение между отправкой и записью → подъём переотправляет ТОМУ ЖЕ участнику', async () => {
  startScenario('sc-b6crash');
  let S = scenario.loadState(tmpRoot, 'sc-b6crash'); S.phase = 'running_jobs'; S.step = 1;
  // на диске после падения: намерение записано (sending) с выбранным участником и request_id, карточки ещё нет
  S.jobs = { p1: { cmd: { key: 'p1', members: ['kimi', 'codex'], task: 't' }, membersLeft: ['kimi', 'codex'], member: 'kimi', jobId: null, status: 'sending', requestId: 'sc-b6crash-s1-p1-kimi-a0' } };
  scenario.saveState(tmpRoot, S);
  require('../common/scenario-manager').repend(S); scenario.saveState(tmpRoot, S); // подъём: sending → pending, тот же участник/request_id
  const starts = [];
  const runner = { quotaBlocked: () => false, paused: () => false,
    async start(a) { starts.push({ member: a.member, key: a.key, requestId: a.requestId }); return { jobId: 'j' + starts.length }; },
    async poll() { return { terminal: true, status: 'done', text: 'x', seconds: 1, chars_in: 1, chars_out: 1 }; }, async cancel() { return { confirmed: true }; } };
  const done = await scenario.drive(tmpRoot, 'sc-b6crash', { runner, invokeHook: doneHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1, maxTicks: 50 });
  assert.equal(done.status, 'done');
  const p1 = starts.filter(s => s.key === 'p1');
  assert.equal(p1.length, 1, 'одна переотправка (не задвоил)');
  assert.equal(p1[0].member, 'kimi', 'ТОМУ ЖЕ участнику (kimi), не обход на codex');
  assert.equal(p1[0].requestId, 'sc-b6crash-s1-p1-kimi-a0', 'тот же request_id (идемпотентно)');
});

// ───────── Б7: resume на уже идущем сценарии — без новой попытки ─────────
T('Б7: resume на идущем сценарии → «уже идёт», без новой попытки', async () => {
  const mgr = require('../common/scenario-manager'), access = require('../common/access');
  const origChat = access.chatSession; access.chatSession = () => true;
  try {
    startScenario('sc-b7');
    const runner = makeRunner({ pollsNeeded: 100000 }); // поручения не завершаются — цикл идёт
    const deps = { runner, invokeHook: tableHook, now: Date.now, nowIso: scenario.nowIso, sleep, tickMs: 1 };
    mgr.launch(tmpRoot, 'sc-b7', deps); // ведём (token в active)
    for (let i = 0; i < 100 && !runner.rec.started.length; i++) await sleep(5);
    const before = runner.rec.started.length;
    assert(before >= 1, 'цикл начал слать поручения');
    const resp = await mgr.command({ action: 'resume', id: 'sc-b7' }, { stateDir: tmpRoot, deps });
    assert.match(resp, /уже ид[её]т/, 'resume на идущем отвечает «уже идёт»');
    await sleep(40);
    assert.equal(runner.rec.started.length, before, 'resume не добавил новых поручений (без новой попытки)');
    await mgr.command({ action: 'stop', id: 'sc-b7' }, { stateDir: tmpRoot, deps }); // остановим цикл
  } finally { access.chatSession = origChat; }
});

run();
async function run() {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('OK ' + n); }
    catch (e) { failed++; console.error('FAIL ' + n + '\n' + (e.stack || e.message)); }
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  console.log('Итого: пройдено ' + (tests.length - failed) + ', провалено ' + failed);
  process.exitCode = failed ? 1 : 0;
}
