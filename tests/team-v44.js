'use strict';
// team-v44: закрытие карточек «нужно решение» словом пользователя; надпись о паузе; напоминание только в team_status/team_work.
// Все файлы и состояние — в отдельной тестовой папке; живые профили не читаются и не меняются.
const assert = require('assert'), fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
delete process.env.MOST_JOB_ID;
const f = require('./team-v16-fixture');
const state = path.join(f.root, 'state'), root = f.root, base = path.resolve(__dirname, '..');
Object.assign(process.env, {
  MOST_TEST_BOOT_AT: '2000-01-01T00:00:00Z', MOST_TEST_KEEP: '1',
  MOST_CODEX_CONFIG: path.join(root, 'clients/codex.toml'), MOST_AGY_MCP_CONFIG: path.join(root, 'clients/agy.json'),
  MOST_AGY_CONFIG: path.join(root, 'clients/permissions.json'), MOST_DSH_CONFIG: path.join(root, 'clients/dsh.yml'),
  MOST_CODEX_RULES: path.join(root, 'clients/codex.md'), MOST_AGY_RULES: path.join(root, 'clients/agy.md'),
  MOST_DSH_RULES: path.join(root, 'clients/dsh.md'),
  CODEX_PATH: path.join(__dirname, 'fake-codex.js'), DSH_PATH: path.join(__dirname, 'fake-codex.js'),
});
const members = require('../common/members'), registry = require('../common/members-store').create(state);
const locks = require('../common/locks'), cleanup = require('../common/cleanup'), words = require('../common/user-word');
const live = require('../common/live-jobs'), { Team } = require('../common/team'), team = new Team(root);
const close = a => team.word({ action: 'close', quote: 'Закрыть', ...a });
const meta = { action: 'pause', who: 'claude', reason: 'проверка team-v44', quote: 'проверяю' };
const change = (fn, phase = 'B') => registry.update(registry.read().rev, fn, meta, { phase });
change(n => { const m = n.members.find(m => m.id === 'deepseek'); Object.assign(m.roles, { receives: true, sends: true, writer: true, voter: true }); });
let seq = 0;
const dead = () => ({ instance: crypto.randomUUID(), pid: 2147483000 });
function card(extra = {}, who = 'codex', id = 'v44-' + String(++seq).padStart(8, '0')) {
  const dir = path.join(state, who === 'antigravity' ? 'jobs' : who + '-jobs');
  const file = path.join(dir, id + '.json');
  const j = { id, status: 'needs_decision', write: true, owner: dead(),
    startedAt: new Date().toISOString(), folder: f.project, work: 'work-' + id, ...extra };
  f.json(file, j);
  return { file, j, id, text: () => fs.readFileSync(file, 'utf8'), read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const count = () => words.lines().length;
const BASE = 'd4398b2e0574f465bd508177dc23e848c7f7eb2d';
const tests = [], test = (name, fn) => tests.push([name, fn]);
// Публичная копия без истории: закреплённый коммит BASE отсутствует — проверки отката через git show BASE:…
// неприменимы (приватную историю ради теста не хранят) и помечаются пропущенными (замысел team-v47, разд. 13.2).
const hasBase = (() => { try { cp.execFileSync('git', ['show', BASE + ':common/format.js'], { cwd: base, stdio: 'ignore', windowsHide: true }); return true; } catch { return false; } })();
const skipNoBase = () => { if (!hasBase) throw Object.assign(Error('неприменимо к публичной копии без истории: коммит ' + BASE + ' отсутствует'), { __skip: true }); };
const hold = require('../common/restart-hold'), realProcesses = hold.processTableAsync;
const processRow = (pid, startedAt = null) => ({ pid, ppid: 0, startedAt });
const emptySnapshot = async () => [processRow(process.pid)];
hold.processTableAsync = emptySnapshot;
// Модуль по содержимому базы d4398b2e (закреплена, не HEAD) — для проверок отката на старый код.
function baseModule(name) {
  const Module = require('module'), file = path.join(base, 'common', name + '.js');
  const source = cp.execFileSync('git', ['show', BASE + ':common/' + name + '.js'], { cwd: base, encoding: 'utf8' });
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(source, file);
  return m.exports;
}
function serverHarness(who) {
  const Module = require('module'), file = path.join(base, 'servers', who, 'index.js');
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  // Якорь по началу строки (team-v62 добавил вложенный `  (async () => {` внутрь бутстрапа — без `\n` срез резал его посередине).
  const source = fs.readFileSync(file, 'utf8'), end = source.lastIndexOf('\n(async () => {');
  assert(end > 0);
  m._compile(source.slice(0, end) + '\nexecute = async (j, l) => { if (l) await l.release(); };\nmodule.exports = { send, list, load };', file);
  return m.exports;
}

test('П1: needs_decision закрывается — cancelled + closedByWord, папка свободна, строка сводки исчезает', async () => {
  // install-gate-simple: needs_decision старше суток видно в сводке, пока жив процесс поручения (иначе это мёртвое).
  const c = card({ status: 'needs_decision', pid: process.pid, startedAt: new Date(Date.now() - 25 * 3600000).toISOString() }, 'codex');
  assert(live.holdsFolder(c.read(), 'codex'), 'до закрытия папка held');
  const before = require('../common/summary');
  assert.match(await before.compact(team, 'Квоты: тест', undefined, { budget: 100000 }), /нужно решение/);
  const n = count();
  assert.match(await close({ job_ids: [c.id, c.id.slice(0, 8), c.id] }), /закрыто/);
  assert.equal(count(), n + 1);
  const j = c.read();
  assert.equal(j.status, 'cancelled');
  assert.equal(j.closedByWord.basis, 'слово пользователя');
  assert.equal(j.closedByWord.quote, 'Закрыть');
  assert.equal(j.closedByWord.prev_status, 'needs_decision');
  assert.equal(j.closedByWord.prev_stopUnconfirmed, null);
  assert.equal(j.closedByWord.prev_stopConfirmed, null);
  assert.deepEqual(j.closedByWord.pids, live.cardPids(c.j));
  assert(!Object.hasOwn(j, 'stopUnconfirmed'));
  assert.deepEqual(words.lines().at(-1).job_ids, [c.id]);
  assert(!live.holdsFolder(j, 'codex'), 'после закрытия папка свободна');
  assert(!(await before.compact(team, 'Квоты: тест', undefined, { budget: 100000 })).includes('нужно решение по'));
});

test('П1: stop_unconfirmed + write + мёртвый владелец закрывается; stopUnconfirmed перенесён; dashboard показывает «отменено»', async () => {
  const c = card({ status: 'stop_unconfirmed', stopUnconfirmed: { pid: 2147483001 }, write: true }, 'codex');
  const n = count();
  assert.match(await close({ job_ids: [c.id] }), /закрыто/);
  assert.equal(count(), n + 1);
  const j = c.read();
  assert.equal(j.status, 'cancelled');
  assert.equal(j.closedByWord.prev_status, 'stop_unconfirmed');
  assert.deepEqual(j.closedByWord.prev_stopUnconfirmed, { pid: 2147483001 });
  assert(!Object.hasOwn(j, 'stopUnconfirmed'));
  // Показ dashboard для закрытой карточки — «отменено», не «остановка не подтверждена».
  const dash = require('../tools/dashboard/lib/data').getJob('codex', c.id);
  assert.equal(dash.status, 'cancelled');
  assert.equal(dash.status_label, 'ОТМЕНЕНО');
});

test('П1: повтор — «уже закрыто словом», запись слова не дублируется', async () => {
  const c = card({ status: 'needs_decision' }, 'deepseek'), n = count();
  assert.match(await close({ job_ids: [c.id] }), /закрыто/);
  const wordId = c.read().closedByWord.word_id;
  assert.match(await close({ job_ids: [c.id] }), /уже закрыто словом/);
  assert.equal(count(), n + 1);
  assert.equal(c.read().closedByWord.word_id, wordId);
  assert.match(await team.word({ action: 'list' }), new RegExp(wordId));
  assert.match(await team.word({ action: 'list' }), /закрытие словом/);
});

// team-v59: слово владельца закрывает running/queued/waiting_quota (closedByWord); данные-состояния переноса остаются отказом.
for (const [status, forced, expected] of [
  ['running', true], ['queued', true], ['waiting_quota', true],
  ['migration_conflict', false, 'конфликт миграции требует разбора'],
  ['applying', false, 'перенос ещё не завершён'],
]) test('П1: статус ' + status + (forced ? ': слово владельца закрывает' : ': отказ (целостность переноса)'), async () => {
  const a = card({ status: 'needs_decision', stopUnconfirmed: { pid: 2147483001 } }), b = card({ status, stopUnconfirmed: { pid: 2147483002 } }), n = count();
  const before = [a.text(), b.text()];
  const text = await close({ job_ids: [a.id, b.id] });
  if (forced) {
    assert.match(text, /закрыто/); assert.match(text, /мог остаться работать/);
    assert.equal(count(), n + 1); assert(a.read().closedByWord && b.read().closedByWord);
  } else {
    assert.equal(text.split('\n')[1], b.id + ': ' + expected);
    assert.deepStrictEqual([a.text(), b.text()], before);
    assert.equal(count(), n); assert(!a.read().closedByWord); assert(!b.read().closedByWord);
  }
});

// team-v59: слово владельца закрывает карточку при живом/неизвестном владельце и «возможно живом»/неустановленном PID.
for (const kind of ['alive', 'self', 'unknown', 'missing', 'apply', 'pid']) test('П1: слово владельца закрывает по процессу/владельцу: ' + kind, async () => {
  const saved = locks.ownerState;
  const c = card(kind === 'missing' ? { owner: null } : kind === 'self' ? { owner: locks.owner() } : kind === 'apply' ? { apply: { owner: locks.owner() } } : kind === 'pid' ? { childPid: 23456 } : {});
  if (kind === 'alive' || kind === 'unknown') locks.ownerState = async () => kind;
  if (kind === 'pid') hold.processTableAsync = async () => [processRow(process.pid), processRow(23456)];
  try {
    f.json(c.file, { ...c.j, stopUnconfirmed: { pid: 2147483001 } });
    const n = count();
    const text = await close({ job_ids: [c.id] });
    assert.match(text, /закрыто словом владельца/); assert.match(text, /мог остаться работать/);
    assert.equal(count(), n + 1); assert(c.read().closedByWord && c.read().closedByWord.basis === 'слово пользователя');
  } finally { locks.ownerState = saved; hold.processTableAsync = emptySnapshot; }
});

test('П1: НЕЧЕГО — done, applied или failed без флага отклоняет весь набор, журнал слов без изменений', async () => {
  const yes = card({ status: 'needs_decision' }), done = card({ status: 'done', write: true }), failed = card({ status: 'failed', write: true }), applied = card({ status: 'applied', write: true });
  const before = [done, failed, applied].map(c => c.text()), n = count();
  const text = await close({ job_ids: [yes.id, done.id, failed.id, applied.id] });
  assert.match(text, /нечего закрывать/);
  assert.equal(count(), n); assert(!yes.read().closedByWord);
  assert.deepEqual([done.text(), failed.text(), applied.text()], before);
});

test('П1: не найденный номер и доступ гостя/поручения/запасного режима — отказ', async () => {
  const c = card({ status: 'needs_decision' }), n = count();
  assert.match(await close({ job_ids: ['missing-v44'] }), /не найдено/);
  assert.equal(count(), n); assert(!c.read().closedByWord);
  // Чат участника (codex) без доказанного ОТПЕЧАТКА чата (нет state\ready\team.json) и поручение — отказ по подлинности;
  // слово владельца снимает только в подлинном чате (chat-origin доказанного происхождения отпечаток не заменяет).
  for (const [mode, expected] of [
    ['guest', 'Гостю это действие запрещено: поручение-сеанс этого не делает: слово, поручения и перенос — только из чата; не могу подтвердить, что это чат (запись основного сервера (state\\ready\\team.json) не прочитана), — скажи это в чате Codex.'],
    ['job', /из поручения запрещено|Гостю это действие запрещено/],
  ]) {
    if (mode === 'guest') process.env.MOST_CLIENT = 'codex';
    if (mode === 'job') process.env.MOST_JOB_ID = 'parent';
    try {
      await assert.rejects(close({ job_ids: [c.id] }), { message: expected });
      assert.equal(count(), n); assert(!c.read().closedByWord);
    } finally {
      process.env.MOST_CLIENT = 'claude'; delete process.env.MOST_JOB_ID;
    }
  }
});
// team-v58 (task10, обновление устаревшего подслучая fallback): запасной режим чат не ограничивает (замысел §2). Проверяем оба
// положения: доказанный чат закрывает карточку словом и в активном режиме; поручение в том же режиме — отказ.
test('П1: запасной режим не ограничивает чат — доказанный чат закрывает словом, поручение — отказ', async () => {
  const c = card({ status: 'needs_decision' }), n = count();
  await words.append({ kind: 'record', who_down: 'claude', quote: 'Claude отвалился', recorded_by: 'codex', owner: 'fallback-test' });
  try {
    assert(words.mode().active, 'запасной режим активен');
    // Доказанный чат (claude, MOST_TEST_CHAT_ORIGIN=proven): закрытие словом проходит и в активном режиме.
    assert.match(await close({ job_ids: [c.id] }), /закрыто/);
    assert(c.read().closedByWord, 'карточка закрыта доказанным чатом в запасном режиме');
    // Поручение в том же активном режиме — отказ.
    const c2 = card({ status: 'needs_decision' }); process.env.MOST_JOB_ID = 'parent';
    try { await assert.rejects(close({ job_ids: [c2.id] }), /запрещено/); assert(!c2.read().closedByWord); }
    finally { delete process.env.MOST_JOB_ID; }
  } finally {
    await words.append({ kind: 'return', who_down: 'claude', quote: 'Claude вернулся', recorded_by: 'claude' });
  }
});

test('П1: конкуренция с продолжением — оба порядка, полный номер и префикс', async () => {
  const cx = serverHarness('codex'), ds = serverHarness('deepseek');
  const cj = card({ status: 'needs_decision', threadId: 'thread', write: false }, 'codex', 'v44-comp-' + Date.now());
  const dj = card({ status: 'needs_decision', write: false }, 'deepseek', 'v44-dcom-' + Date.now());
  // (а) close держит замок очереди → continue_id (полным и префиксом) получает «возобновляется», нового поручения нет.
  for (const [h, j, kind] of [[cx, cj, 'codex_queue'], [ds, dj, 'deepseek_queue']]) {
    const held = await locks.tryLock(kind, j.id, {});
    assert(held.ok);
    try {
      for (const cid of [j.id, j.id.slice(0, 8)]) {
        await assert.rejects(h.send({ folder: f.project, task: 'Продолжить', write: false, continue_id: cid }), /возобновляется/);
      }
    } finally { await held.release(); }
  }
  // (б) продолжение держит замок очереди → close отклоняет набор, closedByWord не появляется.
  for (const [j, kind] of [[cj, 'codex_queue'], [dj, 'deepseek_queue']]) {
    const held = await locks.tryLock(kind, j.id, {});
    assert(held.ok);
    try {
      await assert.rejects(close({ job_ids: [j.id] }), /поручение продолжается/);
      assert(!j.read().closedByWord);
    } finally { await held.release(); }
  }
  // Закрытая карточка: продолжение — «закрыто словом пользователя», нового поручения нет.
  await close({ job_ids: [cj.id, dj.id] });
  await assert.rejects(cx.send({ folder: f.project, task: 'Продолжить', write: false, continue_id: cj.id }), /закрыто словом пользователя/);
  await assert.rejects(ds.send({ folder: f.project, task: 'Продолжить', write: false, continue_id: dj.id }), /закрыто словом пользователя/);
});

test('П1: частичный сбой записи второй карточки — повтор дозакрывает тем же word_id', async () => {
  const a = card({ status: 'needs_decision' }), b = card({ status: 'needs_decision' }), c = card({ status: 'needs_decision' });
  const n = count(), tg = require('../common/team-git'), saved = tg.atomic;
  tg.atomic = (file, text) => { if (file === b.file) throw Error('пробный сбой'); return saved(file, text); };
  let message = '';
  try { await assert.rejects(close({ job_ids: [a.id, b.id, c.id], quote: 'Закрыть три' }), e => { message = e.message; return true; }); }
  finally { tg.atomic = saved; }
  // П1 п. 6: ответ называет закрытые и оставшиеся номера и слово.
  assert.match(message, /Сбой записи карточки/); assert.match(message, /Повторите/);
  assert(message.includes(a.id + ': закрыто'), message); assert(message.includes(b.id + ': сбой записи'), message);
  assert(message.includes(c.id + ': не закрыто'), message); assert.match(message, /Слово: word-/);
  assert.equal(count(), n + 1); assert(a.read().closedByWord); assert(!b.read().closedByWord); assert(!c.read().closedByWord);
  const id = a.read().closedByWord.word_id;
  assert(message.includes('Слово: ' + id));
  assert.match(await close({ job_ids: [c.id, b.id, a.id], quote: 'Закрыть три' }), /закрыто/);
  assert.equal(count(), n + 1); assert.equal(b.read().closedByWord.word_id, id); assert.equal(c.read().closedByWord.word_id, id);
});

test('П1: файлы в папке поручения не меняются', async () => {
  const file = path.join(f.project, 'v44-file.txt'); f.write(file, 'содержимое до');
  const c = card({ status: 'needs_decision' }, 'codex');
  await close({ job_ids: [c.id] });
  assert.equal(fs.readFileSync(file, 'utf8'), 'содержимое до');
});

test('П1: откат — format.js базы показывает «ОТМЕНЕНО», codex_send базы не отказывает по stopUnconfirmed', () => {
  skipNoBase();
  const c = card({ status: 'stop_unconfirmed', stopUnconfirmed: { pid: 2147483001 }, write: true }, 'codex');
  return close({ job_ids: [c.id] }).then(() => {
    const j = c.read();
    assert.equal(j.status, 'cancelled'); assert(!Object.hasOwn(j, 'stopUnconfirmed'));
    const text = baseModule('format').format('Codex', j, '');
    assert.match(text, /ОТМЕНЕНО/); assert(!text.includes('ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА'));
    const src = cp.execFileSync('git', ['show', BASE + ':servers/codex/index.js'], { cwd: base, encoding: 'utf8' });
    assert.match(src, /current\.stopUnconfirmed\)\s*throw Error\(\s*'В этой папке есть поручение с неподтверждённой остановкой/);
  });
});

test('П2: pauseNote — обе фазы × ручная/неручная; текст в сводке и в списке совпадает', async () => {
  const who = 'codex';
  for (const [phase, kind, expected] of [['B', 'manual', 'исключён из кворума и приёма'], ['B', 'quota', 'не действует в B'], ['A', 'manual', 'в А не влияет на исполнение'], ['A', 'quota', 'в А не влияет на исполнение']]) {
    change(n => { const m = n.members.find(x => x.id === who); m.state = 'paused'; m.pause = { kind, scope: 'participant', since: new Date().toISOString(), until: null, next_probe: null }; }, phase);
    try {
      const m = members.all().find(x => x.id === who);
      assert.equal(members.pauseNote(m), expected);
      assert(members.describe(true).includes(expected));
      const summary = await require('../common/summary').compact({ root, state: path.join(state, 'team'), works: () => [] }, 'Квоты: тест', undefined, { budget: 1000 });
      assert(summary.includes(expected), summary);
    } finally {
      change(n => { const m = n.members.find(x => x.id === who); m.state = 'active'; m.pause = null; }, phase);
    }
  }
});

test('П3: напоминание только в team_status/team_work через publicTransport', async () => {
  const owner = 'v44-owner';
  f.json(path.join(root, 'works', 'v44-work.json'), { name: 'v44-work', title: 'Работа v44', owner, created_at: new Date(Date.now() - 16 * 60000).toISOString(), stages: [{ state: 'идёт', weight: 100 }] });
  const pub = require('../common/public-transport');
  const sent = [], transport = pub.publicTransport({ send: async m => sent.push(m) });
  transport.onmessage = async m => {
    await transport.send({ id: m.id, result: { content: [{ type: 'text', text: require('../common/format').format('Команда', {}, 'тело') }] } });
  };
  const last = () => sent.at(-1).result.content[0].text;
  await transport.onmessage({ id: 1, method: 'tools/call', params: { name: 'team_status', arguments: { owner } } });
  assert.match(last(), /⚠ Статус пользователю/);
  await transport.onmessage({ id: 2, method: 'tools/call', params: { name: 'codex_result', arguments: { owner } } });
  assert(!last().includes('⚠ Статус пользователю'));
  await transport.onmessage({ id: 3, method: 'tools/call', params: { name: 'deepseek_result', arguments: { owner } } });
  assert(!last().includes('⚠ Статус пользователю'));
  await transport.onmessage({ id: 4, method: 'tools/call', params: { name: 'antigravity_result', arguments: { owner } } });
  assert(!last().includes('⚠ Статус пользователю'));
  await transport.onmessage({ id: 5, method: 'tools/call', params: { name: 'team_work', arguments: { owner } } });
  assert.match(last(), /⚠ Статус пользователю/);
  await transport.onmessage({ id: 6, method: 'tools/call', params: { name: 'team_rules', arguments: { owner } } });
  assert(!last().includes('⚠ Статус пользователю'));
  await transport.onmessage({ id: 7, method: 'tools/call', params: { name: 'team_word', arguments: { owner } } });
  assert(!last().includes('⚠ Статус пользователю'));
  await transport.onmessage({ id: 8, method: 'tools/call', params: { name: 'team_status' } });
  assert(!last().includes('⚠ Статус пользователю'));
  sent.length = 0;
  await Promise.all([
    transport.onmessage({ id: 10, method: 'tools/call', params: { name: 'team_status', arguments: { owner } } }),
    transport.onmessage({ id: 11, method: 'tools/call', params: { name: 'codex_result', arguments: { owner } } }),
  ]);
  const byId = Object.fromEntries(sent.map(m => [m.id, m.result.content[0].text]));
  assert.match(byId[10], /⚠ Статус пользователю/);
  assert(!byId[11].includes('⚠ Статус пользователю'));
  // Запасной путь format без транспорта: без имени инструмента и для чужого инструмента — ни своей, ни встроенной строки.
  const { context } = require('../common/request-context'), fmt = require('../common/format').format;
  const embedded = '⚠ Статус пользователю не отправлялся 99 мин — встроенная\nтело';
  for (const store of [{ owner }, { owner, tool: 'codex_result' }, { owner, tool: 'team_rules' }]) {
    assert(!context.run(store, () => fmt('Команда', {}, 'тело')).includes('⚠ Статус пользователю'), JSON.stringify(store));
    assert(!context.run(store, () => fmt('Команда', {}, embedded)).includes('⚠ Статус пользователю'), JSON.stringify(store));
  }
  for (const tool of ['team_status', 'team_work']) {
    assert.match(context.run({ owner, tool }, () => fmt('Команда', {}, 'тело')), /⚠ Статус пользователю/);
    assert.match(context.run({ owner, tool }, () => fmt('Команда', {}, embedded)), /встроенная/);
  }
});

for (const status of ['cancelling', 'cancel_requested', 'delivery_unclear', 'done', 'applied'])
test('v55 close: ' + status + ' без потери результата и с подтверждением остановки', async () => {
  const c = card({ status, stopUnconfirmed: { pid: 2147483001 }, result: 'ответ', finishedAt: '2026-01-02T00:00:00Z' });
  const wl = require('../common/write-lock'), folder = path.join(f.project, c.id); fs.mkdirSync(folder);
  f.json(c.file, { ...c.j, folder }); assert(wl.acquire(folder, { jobId: c.id }).ok);
  fs.mkdirSync(path.join(state, 'codex-jobs', c.id)); // Плоская карточка рядом с рабочей папкой без card.json.
  const completed = ['done', 'applied'].includes(status);
  const expected = completed ? 'остановка подтверждена; результат сохранён' : 'закрыто';
  assert.equal((await close({ job_ids: [c.id] })).split('\n')[0], c.id + ': ' + expected);
  const j = c.read();
  assert.equal(j.status, completed ? status : 'cancelled'); assert.equal(!!j.closedByWord, !completed);
  assert(j.stopConfirmed); assert(!Object.hasOwn(j, 'stopUnconfirmed')); assert.equal(j.result, c.j.result); assert.equal(j.finishedAt, c.j.finishedAt);
  assert.equal(j.stopConfirmed.prev_status, status);
  const next = wl.acquire(folder, { jobId: c.id + '-next' }); assert(next.ok);
  try { const before = c.text(), n = count(); await close({ job_ids: [c.id] }); assert.equal(c.text(), before); assert.equal(count(), n); assert(!wl.acquire(folder).ok); }
  finally { next.release(); }
});
test('v55 close: чужой PID исключён по времени; неизвестный agyPid снимается словом владельца', async () => {
  const a = card({ childPid: 23456, childStartedAt: '2026-01-01T00:00:10Z', startedAt: '2026-01-01T00:00:00Z' });
  const b = card({ agyPid: 23457 }), n = count();
  hold.processTableAsync = async () => [processRow(process.pid), processRow(23456, '2026-01-01T00:01:00Z'), processRow(23457)];
  try {
    // team-v59: a с чужим PID закрывается штатно; b с неустановленным agyPid — словом владельца (прежде блокировал пакет).
    const text = await close({ job_ids: [a.id, b.id] });
    assert.match(text, /закрыто/); assert.equal(count(), n + 1);
    assert(a.read().stopConfirmed.evidence.processes.some(p => p.pid === 23456 && p.state === 'foreign'));
    assert(b.read().closedByWord, 'неизвестный agyPid закрыт словом владельца');
  } finally { hold.processTableAsync = emptySnapshot; }
});

f.run(tests).finally(() => { hold.processTableAsync = realProcesses; });
