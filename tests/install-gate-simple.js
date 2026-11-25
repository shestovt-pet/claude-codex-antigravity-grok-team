'use strict';
// install-gate-simple (слово пользователя 24.11.2026): одно определение «мёртвого поручения» (common/dead-jobs), финализация
// мёртвых, ворота установки только по живому, сводка без мёртвых. Плюс проверки по ревью Codex (п.1–8, улучшение) и
// Gemini (а–д) — у каждой проверки в названии номер замечания.
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-gate-'));
Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_NOTIFY: 'off', MOST_CLIENT: 'claude', MOST_JOB_ID: '' });
const dj = require('../common/dead-jobs'), kimi = require('../common/members-kimi'), live = require('../common/live-jobs'), locks = require('../common/locks');
const tests = [], test = (name, fn) => tests.push({ name, fn });
const H = 3600000, NOW = Date.now();
const iso = t => new Date(t).toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let seq = 0;
function fresh() { const s = path.join(RUN, 's' + (++seq)); fs.mkdirSync(s, { recursive: true }); return s; }
function card(state, store, j, mtime = NOW - 60000) {
  const dir = path.join(state, store); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, j.id + '.json'); fs.writeFileSync(f, JSON.stringify(j));
  fs.utimesSync(f, new Date(mtime), new Date(mtime)); return f;
}
function bundle(state, store, j, mtime = NOW - 60000, files = {}) {
  const dir = path.join(state, store, j.id); fs.mkdirSync(dir, { recursive: true });
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
  const f = path.join(dir, 'card.json'); fs.writeFileSync(f, JSON.stringify(j));
  fs.utimesSync(f, new Date(mtime), new Date(mtime)); return f;
}
function lock(state, entry, mtime = NOW - 60000) {
  const dir = path.join(state, 'locks', 'write'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, crypto.createHash('sha256').update(entry.folder).digest('hex').slice(0, 40) + '.json');
  fs.writeFileSync(f, JSON.stringify(entry)); fs.utimesSync(f, new Date(mtime), new Date(mtime)); return f;
}
const STORES = new Set(['claude-jobs', 'codex-jobs', 'deepseek-jobs', 'kimi-jobs', 'jobs']);
const c = (j, extra = {}) => ({ j, mtimeMs: NOW - 60000, store: 'codex-jobs', who: 'codex', ...extra });
// Таблица: pid 100 — жив с давних пор; 200 — номер занят процессом, запущенным минуту назад (после записи карточки).
const TABLE = new Map([[100, NOW - 10 * H], [200, NOW - 30000]]);
const ctx = (extra = {}) => ({ now: NOW, table: TABLE, stores: STORES, ...extra });
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const hashDir = d => { const h = crypto.createHash('sha256'); const walk = p => { for (const n of fs.readdirSync(p).sort()) { const f = path.join(p, n); if (fs.statSync(f).isDirectory()) walk(f); else h.update(f + fs.readFileSync(f)); } }; walk(d); return h.digest('hex'); };
const mtimes = d => { const out = []; const walk = p => { for (const n of fs.readdirSync(p).sort()) { const f = path.join(p, n); const st = fs.statSync(f); out.push(f + ':' + st.mtimeMs); if (st.isDirectory()) walk(f); } }; walk(d); return out.join('\n'); };

test('1 живость PID: переиспользованный номер не живой; Codex п.7 — без допуска SLACK, отметка записи номера, неизвестное время — «не проверено»', () => {
  assert.equal(dj.pidState(100, NOW - 60000, TABLE), true, 'запущен до записи — жив');
  assert.equal(dj.pidState(200, NOW - 60000, TABLE), 'reused', 'запущен после записи — номер занят другим');
  assert.equal(dj.pidState(300, NOW - 60000, TABLE), false, 'нет в таблице — мёртв');
  assert.equal(dj.pidState(100, NOW - 60000, new Map([[100, NaN]])), null, 'время неизвестно — не проверено (считается живым)');
  // Codex п.7: процесс запущен через 1 с после записи карточки — уже НЕ живой (прежний допуск 2 с признал бы живым).
  const T = new Map([[400, NOW - 59000]]);
  assert.equal(dj.pidState(400, NOW - 60000, T), 'reused', 'без допуска: запущен после записи — чужой');
  // Отметка записи номера раньше записи карточки: childStartedAt — граница; процесс запущен после неё — чужой.
  const j = { id: 'b', status: 'running', childPid: 400, childStartedAt: iso(NOW - 2 * H), startedAt: iso(NOW - 2 * H) };
  const a = dj.assess(c(j, { mtimeMs: NOW - 1000 }), ctx({ table: new Map([[400, NOW - H]]) }));
  assert.notEqual(a.kind, 'live', 'номер занят процессом, запущенным после записи номера: ' + JSON.stringify(a));
  assert.equal(dj.assess(c(j, { mtimeMs: NOW - 1000 }), ctx({ table: new Map([[400, NOW - 3 * H]]) })).kind, 'live');
  assert.equal(dj.assess(c(j, { mtimeMs: NOW - 1000 }), ctx({ table: new Map([[400, NaN]]) })).kind, 'live', 'неизвестное время запуска — живое');
});

test('2 оценка: needs_decision/write/без PID моложе суток не трогаются, неизвестный статус не закрывается', () => {
  const nd = (t, extra = {}, cx = {}) => c({ id: 'nd', status: 'needs_decision', write: true, owner: { pid: 100 }, pid: 300, startedAt: iso(t - H), finishedAt: iso(t), ...extra }, { mtimeMs: t, ...cx });
  assert.equal(dj.assess(nd(NOW - 2 * H), ctx()).kind, 'keep', 'needs_decision моложе суток — не трогать');
  assert.equal(dj.assess(nd(NOW - 2 * H, { stopConfirmed: { basis: 'слово установки', at: iso(NOW) } }, { mtimeMs: NOW }), ctx()).kind, 'keep', 'перезапись отметкой не молодит и не старит');
  assert.equal(dj.assess(nd(NOW - 25 * H), ctx()).kind, 'dead', 'needs_decision старше суток с мёртвым дочерним — мёртв');
  assert.equal(dj.assess(nd(NOW - 25 * H, { childPid: 500 }), ctx({ table: new Map([...TABLE, [500, NOW - 26 * H]]) })).kind, 'live', 'дочерний процесс жив — живое');
  assert.notEqual(dj.assess(nd(NOW - 25 * H, { childPid: 100 }), ctx()).kind, 'live', 'процесс запущен после последней записи карточки — не её дочерний');
  assert.equal(dj.assess(c({ id: 'np', status: 'running', startedAt: iso(NOW - 3 * H) }), ctx()).kind, 'keep', 'без PID моложе суток (окно запуска прошло)');
  assert.equal(dj.assess(c({ id: 'np2', status: 'running', startedAt: iso(NOW - 30 * H) }, { mtimeMs: NOW - 30 * H }), ctx()).kind, 'dead', 'без PID старше суток');
  assert.equal(dj.assess(c({ id: 'w', status: 'running', write: true, pid: 300, startedAt: iso(NOW - 3 * H) }), ctx()).kind, 'keep', 'write моложе суток');
  assert.equal(dj.assess(c({ id: 'nw', status: 'running', pid: 300, startedAt: iso(NOW - 3 * H) }), ctx()).kind, 'dead', 'без записи, процессы мертвы — мёртв сразу');
  assert.equal(dj.assess(c({ id: 'tw', status: 'cancelled', treeWarning: true, owner: { pid: 100 }, pid: 300, finishedAt: iso(NOW - 5 * H) }), ctx()).kind, 'dead', 'cancelled с treeWarning: дерево мертво');
  assert.equal(dj.assess(c({ id: 'ok', status: 'failed', pid: 300 }), ctx()).kind, 'clean', 'завершённая без флагов и без живого исполнителя');
  assert.equal(dj.assess(c({ id: 'un', status: 'weird', pid: 300, startedAt: iso(NOW - 90 * H) }), ctx()).kind, 'keep', 'неизвестный статус не закрывается');
});

test('Codex п.1 / Gemini б: живой исполнитель (включая agyPid) — живое ДО исключения terminal/lost и ДО правила «удалённый участник»', () => {
  // agyPid собирается и общим определением, и live-jobs.
  const agy = { id: 'agy-1', status: 'lost', agyPid: 100, agyStartedAt: iso(NOW - 9 * H), startedAt: iso(NOW - 9 * H) };
  assert.deepEqual(dj.childPids(agy), [100]); assert(live.cardPids(agy).includes(100), 'live-jobs.cardPids видит agyPid');
  const a = dj.assess(c(agy, { store: 'jobs', who: 'antigravity' }), ctx());
  assert.equal(a.kind, 'live', 'lost без флагов, но agy жив — живое: ' + JSON.stringify(a)); assert.equal(a.exec, true);
  assert.equal(dj.assess(c({ id: 'd', status: 'done', childPid: 100 }), ctx()).kind, 'live', 'done с живым исполнителем — живое');
  assert.equal(dj.assess(c({ id: 'd2', status: 'done', childPid: 200 }), ctx()).kind, 'clean', 'done, номер занят чужим — не живое');
  // Удалённый участник: сначала PID.
  assert.equal(dj.assess(c({ id: 'gt', status: 'running', pid: 100 }, { store: 'grok-jobs' }), ctx()).kind, 'live', 'удалённый участник с живым процессом — живое');
  assert.equal(dj.assess(c({ id: 'gl', status: 'lost', childPid: 100 }, { store: 'grok-jobs' }), ctx()).kind, 'live');
  const grok = dj.assess(c({ id: 'g', status: 'stop_unconfirmed', pid: 300, startedAt: iso(NOW - 900 * H) }, { store: 'grok-jobs', who: 'grok' }), ctx());
  assert.equal(grok.kind, 'dead'); assert(/удалён из связки/.test(grok.reason));
  // Ворота показывают живого исполнителя при любом статусе.
  const s = fresh();
  bundle(s, 'jobs', { ...agy, papka: 'E:\\w\\agy', from: 'claude' }, NOW - 60000);
  card(s, 'grok-jobs', { id: 'gr-live', status: 'lost', childPid: 100, folder: 'E:\\w\\g', from: 'claude' });
  const b = kimi.installationBlockers(s, ctx());
  assert.deepEqual(b.running.map(r => r.id).sort(), ['agy-1', 'gr-live'], JSON.stringify(b.running));
});

test('Codex п.2: очередь на ручной паузе и waiting_quota с будущим nextAttemptAt не закрываются через сутки; живой исполнитель очереди — в воротах', async () => {
  const s = fresh(), old = NOW - 30 * 24 * H;
  const paused = card(s, 'codex-jobs', { id: 'q-paused', status: 'queued', paused: true, owner: { pid: 300 }, startedAt: iso(old), createdAt: iso(old) }, old);
  const quota = card(s, 'kimi-jobs', { id: 'q-quota', status: 'waiting_quota', nextAttemptAt: iso(NOW + 5 * H), owner: { pid: 300 }, createdAt: iso(old) }, old);
  const grokQ = card(s, 'grok-jobs', { id: 'q-grok', status: 'queued', createdAt: iso(old) }, old);
  const qLive = card(s, 'deepseek-jobs', { id: 'q-live', status: 'queued', childPid: 100, folder: 'E:\\w\\q', from: 'claude', createdAt: iso(NOW - H) });
  const qOwner = card(s, 'deepseek-jobs', { id: 'q-owner', status: 'queued', owner: { pid: 100 }, createdAt: iso(NOW - H) });
  for (const f of [paused, quota]) assert.equal(dj.assess({ j: read(f), mtimeMs: old, store: path.basename(path.dirname(f)) }, ctx()).kind, 'keep');
  const before = [fs.readFileSync(paused, 'utf8'), fs.readFileSync(quota, 'utf8')];
  const r = await dj.finalize(s, ctx());
  assert.deepEqual(r.closed.map(x => x.id), ['q-grok'], 'закрыта только очередь удалённого участника: ' + JSON.stringify(r.closed));
  assert.deepEqual([fs.readFileSync(paused, 'utf8'), fs.readFileSync(quota, 'utf8')], before, 'ожидающие карточки не тронуты');
  assert.equal(read(grokQ).status, 'lost');
  const b = kimi.installationBlockers(s, ctx());
  assert.deepEqual(b.running.map(r => r.id), ['q-live'], 'очередь с живым исполнителем держит; с живым лишь сервером — нет');
  assert(fs.existsSync(qOwner) && fs.existsSync(qLive));
  assert.deepEqual((await live.running({ stateDir: s, table: TABLE })).map(r => r.id), ['q-live']);
});

test('Codex п.3: гонка — карточка изменилась, пока уборка ждала замок карточки адаптера; уборка её не трогает', async () => {
  const s = fresh(), old = NOW - 30 * H;
  const f = card(s, 'codex-jobs', { id: 'race-1', status: 'running', owner: { pid: 300 }, childPid: 300, startedAt: iso(old), folder: 'E:\\w\\r' }, old);
  // «Адаптер» держит тот же замок карточки, что servers/codex mutate ('codex_job', id).
  const held = await locks.waitLock('codex_job', 'race-1', { jobId: 'race-1' }, 3000, s);
  assert(held.ok, 'замок адаптера взят');
  const pending = dj.finalize(s, ctx());
  await sleep(400);
  // Под замком адаптер переводит карточку в running с новым живым исполнителем.
  const next = { ...read(f), childPid: 100, childStartedAt: iso(NOW - 9 * H), attempt: 2 };
  fs.writeFileSync(f, JSON.stringify(next));
  await held.release();
  const r = await pending;
  assert.equal(r.closed.length, 0, JSON.stringify(r));
  assert.equal(r.failed.length, 1); assert(/изменилась/.test(r.failed[0].error), r.failed[0].error);
  assert.deepEqual(read(f), next, 'новая запись адаптера не затёрта');
  // Пока уборка держит замок карточки, адаптер ждёт (его tryLock занят).
  const s2 = fresh();
  card(s2, 'claude-jobs', { id: 'race-2', status: 'running', childPid: 300, startedAt: iso(old) }, old);
  let busy = null;
  const r2 = await dj.finalize(s2, { ...ctx(), deps: { hook: async () => { const t = await locks.tryLock('claude_job', 'race-2', {}, s2); busy = !t.ok; if (t.ok) await t.release(); } } });
  assert.equal(busy, true, 'замок карточки claude_job занят уборкой на время записи');
  assert.deepEqual(r2.closed.map(x => x.id), ['race-2']);
});

test('Codex п.3: свежий running без номера процесса (окно запуска) — живое в воротах; после окна — нет', () => {
  const s = fresh();
  card(s, 'codex-jobs', { id: 'launch-1', status: 'running', owner: { pid: 300 }, folder: 'E:\\w\\l', from: 'claude', startedAt: iso(NOW - 2 * 60000) }, NOW - 2 * 60000);
  card(s, 'codex-jobs', { id: 'launch-2', status: 'running', owner: { pid: 300 }, startedAt: iso(NOW - 20 * 60000) }, NOW - 20 * 60000);
  const b = kimi.installationBlockers(s, ctx());
  assert.deepEqual(b.running.map(r => r.id), ['launch-1']);
  const a = dj.assess({ j: read(path.join(s, 'codex-jobs', 'launch-2.json')), mtimeMs: NOW - 20 * 60000, store: 'codex-jobs' }, ctx());
  assert.equal(a.kind, 'keep', 'после окна запуска без номера — моложе суток, не трогаем и не показываем');
});

test('Codex п.4 / Gemini в: нечитаемый замок — не обнуляет остальные, ворота дают технический отказ одной строкой, уборка ничего не закрывает', async () => {
  const s = fresh(), old = NOW - 30 * H;
  const good = lock(s, { folder: 'e:\\w\\good', jobId: 'x', instance: 'G1', pid: 300, since: iso(old) }, old);
  const bad = path.join(s, 'locks', 'write', 'bad.json'); fs.writeFileSync(bad, '{не json');
  const deadCard = card(s, 'codex-jobs', { id: 'dead-1', status: 'running', pid: 300, startedAt: iso(old) }, old);
  const rl = dj.readLocks(s);
  assert.equal(rl.locks.length, 1, 'читаемый замок прочитан'); assert.equal(rl.errors.length, 1, 'сбойный — ошибкой');
  assert.throws(() => kimi.installationBlockers(s, ctx()), e => e.code === 'GATE_INCOMPLETE' && /не удалось проверить/.test(e.message) && /повторите/.test(e.message) && !e.message.includes('\n'));
  const g = kimi.deployGate(s, { table: TABLE });
  assert(g.refusal && g.technical && /не удалось проверить/.test(g.refusal) && !g.refusal.includes('\n'), JSON.stringify(g));
  await assert.rejects(() => kimi.assertNoJobs(s, { table: TABLE }), /не удалось проверить/);
  await assert.rejects(() => live.running({ stateDir: s, table: TABLE }), /не удалось проверить/);
  const before = hashDir(s);
  const r = await dj.finalize(s, ctx());
  assert(r.skipped && r.closed.length === 0 && r.locks.length === 0, JSON.stringify(r));
  assert.equal(hashDir(s), before, 'при неполном снимке ничего не закрыто');
  // Нечитаемая карточка — то же самое.
  fs.unlinkSync(bad); fs.writeFileSync(path.join(s, 'codex-jobs', 'broken.json'), '   ');
  assert.throws(() => kimi.installationBlockers(s, ctx()), /не удалось проверить/);
  // Починили — всё снова работает, замок мёртвого владельца снимается.
  fs.unlinkSync(path.join(s, 'codex-jobs', 'broken.json'));
  const r2 = await dj.finalize(s, ctx());
  assert.deepEqual(r2.closed.map(x => x.id), ['dead-1']); assert(!fs.existsSync(good)); assert.equal(read(deadCard).status, 'lost');
  // Gemini д: нет каталога locks/write — замков нет, не ENOENT.
  const s3 = fresh(); assert.deepEqual(dj.readLocks(s3), { locks: [], errors: [] });
});

test('Codex п.4 / Gemini а: пробельный вывод PowerShell, мусор, номер, отсутствующий в ответе CIM', () => {
  assert.deepEqual(dj.parsePs('  \r\n  '), [], 'пробельный вывод — пустой список');
  assert.deepEqual(dj.parsePs(''), []);
  assert.throws(() => dj.parsePs('Get-CimInstance : ошибка'), 'мусор — исключение');
  // Пробельный ответ без самого процесса проверки — ответ неполон (исключение), не «все исчезли».
  assert.throws(() => dj.fromPs('  ' + String.fromCharCode(13, 10), [process.pid]), /неполный ответ/);
  const self = { ProcessId: 999999, Start: new Date(NOW - 2 * H).toISOString() };
  const gone = 2147480000;
  const r = dj.fromPs(JSON.stringify([self]), [process.pid, gone], 999999);
  assert.deepEqual(r.missing, [process.pid], 'существующий, но не попавший в ответ — на повторный запрос'); assert(!r.map.has(gone));
  // tableSync: первый ответ пробельный (неполон) → повтор; номер есть только во втором ответе на «пропавших» — время из него.
  const start = new Date(NOW - H).toISOString(), me = { ProcessId: process.pid, Start: start };
  let calls = 0;
  const t = dj.tableSync([process.pid], { run: () => { calls++; return calls === 1 ? '   ' : JSON.stringify([me]); } });
  assert.equal(t.get(process.pid), Date.parse(start)); assert(!t.incomplete);
  // Номер, которого нет в двух полных ответах (завершён, объект удерживается чужим дескриптором), — не идущий процесс.
  // Родительский процесс существует (process.kill его видит), но в обоих полных ответах его нет — считается не идущим.
  let n2 = 0;
  const T2 = dj.tableSync([process.ppid], { run: () => { n2++; return JSON.stringify([me]); } });
  assert(!T2.has(process.ppid) && !T2.incomplete && n2 === 2, 'два полных ответа без номера — не идущий');
  // Пробельный вывод дважды и мусор дважды — снимок неполон (ни ложного «живого», ни ложного «мёртвого»).
  for (const out of ['  ' + String.fromCharCode(13, 10) + ' ', 'garbage']) {
    const bad = dj.tableSync([process.pid], { run: () => out });
    assert(bad.incomplete && /не прочитана/.test(bad.incomplete), String(bad.incomplete));
  }
  const bad = dj.tableSync([process.pid], { run: () => 'garbage' });
  const s = fresh();
  card(s, 'codex-jobs', { id: 'any', status: 'running', pid: process.pid, startedAt: iso(NOW - 30 * H) }, NOW - 30 * H);
  assert.throws(() => kimi.installationBlockers(s, { table: bad, stores: STORES }), /не удалось проверить/);
});

test('Codex п.5: migration_conflict не закрывается автоматически', async () => {
  const s = fresh(), old = NOW - 30 * 24 * H;
  const f = card(s, 'codex-jobs', { id: 'mc-1', status: 'migration_conflict', owner: { pid: 300 }, childPid: 300, startedAt: iso(old) }, old);
  assert.equal(dj.assess({ j: read(f), mtimeMs: old, store: 'codex-jobs' }, ctx()).kind, 'keep');
  const before = fs.readFileSync(f, 'utf8');
  const r = await dj.finalize(s, ctx());
  assert.equal(r.closed.length, 0); assert.equal(fs.readFileSync(f, 'utf8'), before);
  assert(!dj.CLOSABLE.includes('migration_conflict') && dj.CLOSABLE.every(x => !['queued', 'waiting_quota'].includes(x)));
});

test('Codex п.6: Antigravity — готовый результат с верным хешем восстанавливается как done, иначе lost', async () => {
  const s = fresh(), old = NOW - 30 * H, text = 'итог задания\n';
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const ok = bundle(s, 'jobs', { id: 'agyok_000001', status: 'running', owner: { pid: 300, instance: 'i' }, agyPid: 300, papka: 'E:\\w\\a', startedAt: iso(old) }, old,
    { 'result.txt': text, 'meta.json': JSON.stringify({ hash, words: 2, finishedAt: iso(old + 60000), durationSec: 60 }) });
  const bad = bundle(s, 'jobs', { id: 'agybad_00002', status: 'running', owner: { pid: 300 }, agyPid: 300, startedAt: iso(old) }, old,
    { 'result.txt': text, 'meta.json': JSON.stringify({ hash: 'f'.repeat(64) }) });
  const dry = await dj.finalize(s, { ...ctx(), apply: false });
  assert.deepEqual(dry.recovered.map(x => x.id), ['agyok_000001']); assert.deepEqual(dry.closed.map(x => x.id), ['agybad_00002']);
  const r = await dj.finalize(s, ctx());
  assert.deepEqual(r.recovered.map(x => x.id), ['agyok_000001']); assert.deepEqual(r.closed.map(x => x.id), ['agybad_00002']);
  const a = read(ok); assert.equal(a.status, 'done'); assert.equal(a.resultHash, hash); assert(/восстановлено уборкой/.test(a.recovered));
  assert.equal(read(bad).status, 'lost');
  // Адаптер пользуется той же процедурой.
  const src = fs.readFileSync(path.join(__dirname, '..', 'servers', 'antigravity', 'index.js'), 'utf8');
  assert(src.includes('require("../../common/agy-recover").committedMeta(jobDir(id))') && src.includes('require("../../common/agy-recover").recoveredFields('));
});

test('Codex п.7: одно определение живости для сводки и ворот — один снимок на запрос', async () => {
  const snap = { list: () => ({ jobs: [] }) };
  const p1 = dj.requestContext(snap), p2 = dj.requestContext(snap);
  assert.strictEqual(p1, p2, 'один снимок на объект запроса');
  await p1;
  const s = fresh(), old = NOW - 30 * H;
  const files = [
    card(s, 'codex-jobs', { id: 'a', status: 'running', pid: 200, startedAt: iso(old) }, old),
    card(s, 'codex-jobs', { id: 'b', status: 'running', pid: 100, startedAt: iso(old) }, old),
    card(s, 'jobs', { id: 'c', status: 'lost', agyPid: 100, startedAt: iso(old) }, old),
  ];
  const sv = dj.survey(s, ctx());
  for (const f of files) {
    const j = { ...read(f), cardFile: f };
    const viaSummary = dj.assessJob(j, ctx()).kind;
    const viaGate = [...sv.live.map(x => [x.c.file, 'live']), ...sv.dead.map(x => [x.c.file, 'dead'])].find(([ff]) => ff === f)?.[1] || 'clean';
    assert.equal(viaSummary, viaGate, f);
  }
  for (const file of ['summary.js', 'team.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'common', file), 'utf8');
    assert(src.includes("require('./dead-jobs').requestContext(snapshot)") && src.includes("require('./dead-jobs').assessJob(j, "), file + ' пользуется общим снимком');
    assert(!src.includes('table: null, stores: null'), file + ': нет отдельной оценки по process.kill');
  }
});

test('Codex п.8: предварительная проверка deployGate — только чтение; уборка — на пути установки, таблица строится один раз (Gemini г)', async () => {
  const s = fresh(), old = NOW - 30 * H;
  const f = card(s, 'codex-jobs', { id: 'dg-dead', status: 'running', pid: 300, startedAt: iso(old) }, old);
  lock(s, { folder: 'e:\\w\\dg', instance: 'D1', pid: 300, since: iso(old) }, old);
  const before = hashDir(s), times = mtimes(s);
  const g = kimi.deployGate(s, { table: TABLE });
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.equal(hashDir(s), before); assert.equal(mtimes(s), times, 'deployGate ничего не пишет');
  // Путь установки: resolveInstallWord закрывает мёртвое, таблицу процессов строит ОДИН раз (асинхронно), синхронную — ни разу.
  const orig = { a: dj.tableAsync, s: dj.tableSync };
  let asyncCalls = 0, syncCalls = 0;
  dj.tableAsync = async (...x) => { asyncCalls++; return TABLE; };
  dj.tableSync = (...x) => { syncCalls++; return TABLE; };
  try {
    const w = await require('../common/deploy').resolveInstallWord(s, {}, {});
    assert.deepEqual(w, {}, 'живого нет — без вопроса');
  } finally { dj.tableAsync = orig.a; dj.tableSync = orig.s; }
  assert.equal(asyncCalls, 1, 'таблица процессов построена один раз'); assert.equal(syncCalls, 0, 'повторной сборки нет');
  assert.equal(read(f).status, 'lost', 'на пути установки мёртвое закрыто');
  const team = fs.readFileSync(path.join(__dirname, '..', 'common', 'team.js'), 'utf8');
  const gateAt = team.indexOf("require('./members-kimi').deployGate("), lockedAt = team.indexOf('const deployed = await deployer.locked(');
  assert(gateAt > 0 && lockedAt > gateAt, 'deployGate — до замка операции, поэтому только чтение');
  const kd = fs.readFileSync(path.join(__dirname, '..', 'common', 'members-kimi.js'), 'utf8');
  const body = kd.slice(kd.indexOf('function deployGate('), kd.indexOf('async function assertNoJobs('));
  assert(!/finalize/.test(body.replace(/^\s*\/\/.*$/gm, '')), 'deployGate не вызывает finalize');
});

test('Codex (улучшение): сценарий на паузе держит свои карточки от недельной уборки; завершённый — нет', async () => {
  const s = fresh(), old = NOW - 10 * 24 * H;
  const keep = card(s, 'codex-jobs', { id: '11111111-1111-4111-8111-111111111111', status: 'lost', startedAt: iso(old) }, old);
  const gone = card(s, 'codex-jobs', { id: '22222222-2222-4222-8222-222222222222', status: 'lost', startedAt: iso(old) }, old);
  const free = card(s, 'codex-jobs', { id: '33333333-3333-4333-8333-333333333333', status: 'lost', startedAt: iso(old) }, old);
  const sc = (id, S) => { const d = path.join(s, 'scenarios', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(S)); };
  sc('sc-paused', { id: 'sc-paused', status: 'paused', sessions: { main: { jobId: '11111111-1111-4111-8111-111111111111', member: 'codex' } }, jobs: {} });
  sc('sc-done', { id: 'sc-done', status: 'done', sessions: { main: { jobId: '22222222-2222-4222-8222-222222222222', member: 'codex' } }, jobs: {} });
  const plan = require('../common/cards-autocleanup').plan(s, RUN, NOW);
  const del = new Set(plan.del.map(x => x.id));
  assert(!del.has('11111111-1111-4111-8111-111111111111'), 'сценарий на паузе держит карточку сеанса');
  assert(del.has('22222222-2222-4222-8222-222222222222') && del.has('33333333-3333-4333-8333-333333333333'), 'завершённый сценарий и свободная — удаляются');
  const r = require('../common/cards-autocleanup').run({ stateDir: s, repoRoot: RUN, now: NOW });
  assert.equal(r.removed, 2); assert(fs.existsSync(keep) && !fs.existsSync(gone) && !fs.existsSync(free));
});

function fixtureState() {
  const s = fresh(), old = NOW - 30 * H;
  const f = {
    reused: card(s, 'claude-jobs', { id: 'reused-1', status: 'running', owner: { pid: 200, instance: 'x' }, childPid: 300, folder: 'E:\\w\\a', startedAt: iso(old), from: 'claude' }, old),
    grok: card(s, 'grok-jobs', { id: 'grok-1', status: 'stop_unconfirmed', startedAt: iso(NOW - 900 * H) }, NOW - 900 * H),
    ndOld: card(s, 'deepseek-jobs', { id: 'nd-old', status: 'needs_decision', write: true, owner: { pid: 100 }, pid: 300, startedAt: iso(old), finishedAt: iso(old) }, old),
    ndYoung: card(s, 'deepseek-jobs', { id: 'nd-young', status: 'needs_decision', write: true, pid: 300, startedAt: iso(NOW - 3 * H), finishedAt: iso(NOW - 2 * H) }, NOW - 2 * H),
    lostFlag: card(s, 'kimi-jobs', { id: 'lost-flag', status: 'lost', stopUnconfirmed: { pid: 300 }, pid: 300, startedAt: iso(old) }, old),
    tree: card(s, 'codex-jobs', { id: 'tree-1', status: 'cancelled', treeWarning: true, pid: 300, startedAt: iso(old), finishedAt: iso(old) }, old),
    live: card(s, 'claude-jobs', { id: 'live-1', status: 'running', owner: { pid: 100 }, pid: 100, folder: 'E:\\w\\live', startedAt: iso(NOW - 600000), from: 'claude' }, NOW - 60000),
    done: card(s, 'codex-jobs', { id: 'done-1', status: 'done', pid: 300, startedAt: iso(old), finishedAt: iso(old) }, old),
  };
  const l = {
    deadOwner: lock(s, { folder: 'e:\\w\\a', jobId: 'reused-1', instance: 'L1', pid: 300, since: iso(old) }, old),
    deadOrphan: lock(s, { folder: 'e:\\w\\orphan', jobId: 'nope', instance: 'L2', pid: 200, since: iso(NOW - 5 * H) }, NOW - 5 * H),
    liveOwner: lock(s, { folder: 'e:\\w\\live', jobId: 'live-1', instance: 'L3', pid: 100, since: iso(NOW - 600000) }),
  };
  return { s, f, l };
}

test('3 финализация: мёртвые закрыты (причина, время, флаги сняты), замки мёртвых владельцев сняты, живое и молодое не тронуты', async () => {
  const { s, f, l } = fixtureState();
  const before = hashDir(s);
  const dry = await dj.finalize(s, { apply: false, ...ctx() });
  assert.equal(hashDir(s), before, 'холостой режим ничего не пишет');
  assert.deepEqual(dry.closed.map(x => x.id).sort(), ['grok-1', 'lost-flag', 'nd-old', 'reused-1', 'tree-1']);
  assert.deepEqual(dry.locks.map(x => x.instance).sort(), ['L1', 'L2']);
  const keepLive = fs.readFileSync(f.live, 'utf8'), keepYoung = fs.readFileSync(f.ndYoung, 'utf8'), keepDone = fs.readFileSync(f.done, 'utf8');
  const r = await dj.finalize(s, ctx());
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.deepEqual(r.closed.map(x => x.id).sort(), dry.closed.map(x => x.id).sort(), 'закрыто то же, что показано холостым прогоном');
  const re = read(f.reused);
  assert.equal(re.status, 'lost'); assert.equal(re.closedDead.label, 'закрыто: мёртвое'); assert.equal(re.closedDead.prevStatus, 'running');
  assert(/занят процессом/.test(re.closedDead.reason) && Date.parse(re.closedDead.at) > 0, JSON.stringify(re.closedDead));
  assert.equal(read(f.grok).status, 'lost'); assert.equal(read(f.ndOld).status, 'lost');
  const lf = read(f.lostFlag); assert.equal(lf.status, 'lost'); assert.equal(lf.stopUnconfirmed, undefined); assert.equal(lf.closedDead.prevFlags.stopUnconfirmed.pid, 300);
  const tr = read(f.tree); assert.equal(tr.status, 'cancelled', 'завершённый статус сохраняется'); assert.equal(tr.treeWarning, undefined);
  assert.equal(fs.readFileSync(f.live, 'utf8'), keepLive, 'живое не тронуто');
  assert.equal(fs.readFileSync(f.ndYoung, 'utf8'), keepYoung, 'needs_decision моложе суток не тронуто');
  assert.equal(fs.readFileSync(f.done, 'utf8'), keepDone, 'завершённое не тронуто');
  assert(!fs.existsSync(l.deadOwner) && !fs.existsSync(l.deadOrphan), 'замки мёртвых владельцев сняты');
  assert(fs.existsSync(l.liveOwner), 'замок живого владельца на месте');
  const again = await dj.finalize(s, ctx());
  assert.equal(again.closed.length + again.locks.length, 0, 'повтор ничего не находит');
  const plan = require('../common/cards-autocleanup').plan(s, RUN, Date.now() + 8 * 24 * H);
  const del = new Set(plan.del.map(x => x.id));
  for (const id of ['reused-1', 'grok-1', 'nd-old', 'lost-flag', 'tree-1']) assert(del.has(id), 'удалится через неделю: ' + id);
  assert(!del.has('live-1') && !del.has('nd-young'), 'живое и молодое не удаляются');
});

test('3а замок мёртвого владельца не снимается, если за время уборки его поручение ожило (повторная проверка связи под мьютексом)', async () => {
  const s = fresh(), old = NOW - 30 * H;
  const f = card(s, 'codex-jobs', { id: 'lk-1', status: 'cancelled', startedAt: iso(old), finishedAt: iso(old) }, old);
  const l = lock(s, { folder: 'e:\\w\\lk', jobId: 'lk-1', instance: 'K1', pid: 300, since: iso(old) }, old);
  const data = dj.load(s);
  // Между снимком и снятием поручение замка ожило (новый живой исполнитель, записан под замком адаптера).
  fs.writeFileSync(f, JSON.stringify({ id: 'lk-1', status: 'running', childPid: 100, childStartedAt: iso(NOW - 9 * H), startedAt: iso(NOW - 9 * H) }));
  const r = await dj.finalize(s, { ...ctx(), data });
  assert(fs.existsSync(l), 'замок не снят: ' + JSON.stringify(r));
  assert(r.failed.some(x => x.lock === 'K1'), JSON.stringify(r.failed));
});

test('4 ворота: только живое одной строкой и «подождать или прервать»; без живого — без слова', async () => {
  const { s } = fixtureState();
  const b = kimi.installationBlockers(s, ctx());
  assert.equal(b.running.length, 1, JSON.stringify(b)); assert.equal(b.running[0].id, 'live-1');
  assert.deepEqual(b.blockers, [], 'замок живого поручения не дублируется отдельной строкой');
  const text = kimi.refusalText(b, kimi.listHash(b), 'console');
  const lines = kimi.listText(b).split('\n');
  assert.equal(lines.length, 1, kimi.listText(b));
  assert(/^claude — папка E:\\w\\live, идёт .+, отправил claude$/.test(lines[0]), lines[0]);
  assert(/Подождать или прервать\?/.test(text), text);
  assert(!/lost|stop_unconfirmed|needs_decision|grok|перезагрузк|пропущено/.test(text), 'мёртвое не выводится: ' + text);
  await assert.rejects(() => kimi.assertNoJobs(s, { table: TABLE }), /Сейчас работает/);
  const g = kimi.deployGate(s, { table: TABLE });
  assert(g.refusal && /Сейчас работает/.test(g.refusal), JSON.stringify(g));
  assert.equal(kimi.deployGate(s, { table: TABLE, quote: 'прерывай', listHash: g.listHash }).ok, true);
  // Живое закончилось (процесса нет) — ворота пусты, слово не нужно; мёртвое при этом видно не было и не тронуто воротами.
  const empty = new Map();
  const g2 = kimi.deployGate(s, { table: empty });
  assert.equal(g2.ok, true, JSON.stringify(g2)); assert.equal(g2.word, undefined, 'слово не требуется');
  assert.equal(kimi.listText(g2.list), 'ничего не идёт');
  // Путь установки (resolveInstallWord): мёртвое закрывается, живого нет — без вопроса.
  assert.deepEqual(await require('../common/deploy').resolveInstallWord(s, {}, { table: empty }), {});
  const closed = read(path.join(s, 'claude-jobs', 'reused-1.json'));
  assert.equal(closed.closedDead && closed.status, 'lost', 'на пути установки мёртвое закрыто');
});

test('4а ворота: замок живого владельца без живой карточки — отдельной строкой; очередь без живого исполнителя установку не держит', () => {
  const s = fresh();
  lock(s, { folder: 'e:\\w\\held', jobId: 'gone', instance: 'L9', pid: 100, since: iso(NOW - H) });
  card(s, 'codex-jobs', { id: 'q1', status: 'queued', owner: { pid: 100 }, startedAt: iso(NOW - 60000) });
  const b = kimi.installationBlockers(s, ctx());
  assert.equal(b.running.length, 0, 'очередь не держит установку');
  assert.equal(b.blockers.length, 1); assert(/замок записи папки e:\\w\\held .*владелец жив/.test(b.blockers[0]), b.blockers[0]);
});

test('5 перезапуск: live-jobs.running — только живое', async () => {
  const { s } = fixtureState();
  const rows = await live.running({ stateDir: s, table: TABLE });
  assert.deepEqual(rows.map(r => r.id), ['live-1']);
  const team = fs.readFileSync(path.join(__dirname, '..', 'servers', 'team', 'index.js'), 'utf8');
  assert(team.includes("require('../../common/dead-jobs').schedule("), 'уборка при запуске сервера team и раз в сутки');
});

test('5а финализация в фоне и раз в сутки (schedule) с подставленной таблицей', async () => {
  const { s } = fixtureState();
  const r = await dj.finalizeAsync(s, ctx());
  assert.equal(r.closed.length, 5);
  const { s: s2 } = fixtureState();
  const first = await dj.schedule(s2, { ...ctx(), everyMs: 3600000 });
  assert.equal(first.closed.length, 5);
  const log = fs.readFileSync(path.join(s2, 'team', 'cleanup-log.jsonl'), 'utf8');
  assert(/"kind":"dead-jobs","closed":5,"recovered":0,"locks":2/.test(log), log);
});

test('5б отметки готовности на экземпляр (<server>.<pid>.json) — штатные, не «устаревшие»', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'common', 'release-drift.js'), 'utf8');
  assert(!src.includes('устаревших отметок готовности'), 'строки-счётчика в краткой сводке нет');
  assert(src.includes("replace(/\\.\\d+$/, '')"), 'номер экземпляра отбрасывается при сравнении с серверами');
});

test('Gemini (24.11, а): карточка, замок и состояние сценария с BOM читаются', async () => {
  const BOM = String.fromCharCode(0xFEFF), s = fresh(), old = NOW - 10 * 24 * H;
  const cf = card(s, 'codex-jobs', { id: 'bom-1', status: 'running', pid: 300, startedAt: iso(NOW - 3 * H) }, NOW - 2 * H);
  fs.writeFileSync(cf, BOM + fs.readFileSync(cf, 'utf8')); fs.utimesSync(cf, new Date(NOW - 2 * H), new Date(NOW - 2 * H));
  const lf = lock(s, { instance: 'i-bom', folder: path.join(RUN, 'bom-folder'), pid: 300, since: iso(NOW - 2 * H) });
  fs.writeFileSync(lf, BOM + fs.readFileSync(lf, 'utf8'));
  const data = dj.load(s);
  assert.deepEqual(data.errors, [], 'карточка с BOM читается: ' + data.errors.join('; '));
  assert.deepEqual(data.lockErrors, [], 'замок с BOM читается: ' + data.lockErrors.join('; '));
  assert.equal(data.cards.length, 1); assert.equal(data.cards[0].j.id, 'bom-1');
  assert.equal(data.locks.length, 1); assert.equal(data.locks[0].entry.instance, 'i-bom');
  // Недельная уборка: старая карточка с BOM читается (не «нечитаемая»), сценарий «done» с BOM не держит свою карточку.
  const s2 = fresh(), id = '44444444-4444-4444-8444-444444444444';
  const of = card(s2, 'codex-jobs', { id, status: 'lost', startedAt: iso(old) }, old);
  fs.writeFileSync(of, BOM + fs.readFileSync(of, 'utf8')); fs.utimesSync(of, new Date(old), new Date(old));
  const d = path.join(s2, 'scenarios', 'sc-bom'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'state.json'), BOM + JSON.stringify({ id: 'sc-bom', status: 'done', sessions: { main: { jobId: id, member: 'codex' } }, jobs: {} }));
  const p = require('../common/cards-autocleanup').plan(s2, RUN, NOW);
  assert.equal(p.counts.unreadable, 0, 'карточка с BOM не нечитаемая');
  assert(p.del.some(x => x.id === id), 'состояние сценария с BOM прочитано как «done» — карточку не держит');
});

test('Gemini (24.11, б): повторная оценка под замком не затирает переданное время (opts.now / ctx.now)', async () => {
  const LATER = NOW + 30 * H;
  const mk = s => card(s, 'codex-jobs', { id: 'nd-now', status: 'needs_decision', write: true, owner: { pid: 100 }, pid: 300, startedAt: iso(NOW - 3 * H), finishedAt: iso(NOW - 2 * H) }, NOW - 2 * H);
  // Сейчас карточка моложе суток (keep); по переданному времени (через 30 ч) — мёртвая и закрывается.
  const s = fresh(); mk(s);
  const r = await dj.finalize(s, ctx({ now: LATER }));
  assert.equal(r.failed.length, 0, 'ctx.now: ' + JSON.stringify(r.failed)); assert.equal(r.closed.length, 1);
  const s2 = fresh(); const f2 = mk(s2);
  const r2 = await dj.finalize(s2, { now: LATER, table: TABLE, stores: STORES });
  assert.equal(r2.failed.length, 0, 'opts.now: ' + JSON.stringify(r2.failed)); assert.equal(r2.closed.length, 1);
  assert.equal(read(f2).status, 'lost');
  // Без переданного времени — текущее: карточка моложе суток не трогается.
  const s3 = fresh(); const f3 = mk(s3);
  const r3 = await dj.finalize(s3, { table: TABLE, stores: STORES });
  assert.equal(r3.closed.length, 0); assert.equal(read(f3).status, 'needs_decision');
});

(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) try { await fn(); passed++; console.log('OK ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed); process.exitCode = failed ? 1 : 0;
  if (!failed) try { fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  setTimeout(() => process.exit(process.exitCode), 200).unref();
})();
