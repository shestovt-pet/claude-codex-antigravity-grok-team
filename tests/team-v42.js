'use strict';
// Все файлы и состояние — в отдельной тестовой папке; живые профили не читаются и не меняются.
const assert = require('assert'), fs = require('fs'), path = require('path'), crypto = require('crypto');
delete process.env.MOST_JOB_ID;
const f = require('./team-v16-fixture');
const state = path.join(f.root, 'state'), root = f.root, base = path.resolve(__dirname, '..');
Object.assign(process.env, {
  MOST_TEST_BOOT_AT: '2000-01-01T00:00:00Z', MOST_TEST_KEEP: '1',
  MOST_CODEX_CONFIG: path.join(root, 'clients/codex.toml'), MOST_AGY_MCP_CONFIG: path.join(root, 'clients/agy.json'),
  MOST_AGY_CONFIG: path.join(root, 'clients/permissions.json'), MOST_DSH_CONFIG: path.join(root, 'clients/dsh.yml'),
  MOST_CODEX_RULES: path.join(root, 'clients/codex.md'), MOST_AGY_RULES: path.join(root, 'clients/agy.md'),
  MOST_DSH_RULES: path.join(root, 'clients/dsh.md'),
});
const members = require('../common/members'), registry = require('../common/members-store').create(state);
const locks = require('../common/locks'), cleanup = require('../common/cleanup'), words = require('../common/user-word');
const dsh = require('../common/dsh-config'), cc = require('../common/client-configs'), summary = require('../common/summary');
const deploy = require('../common/deploy'), { Team } = require('../common/team'), team = new Team(root);
const live = require('../common/live-jobs'), stop = a => team.word({ action: 'stop_confirm', quote: 'Можно снять', ...a });
const meta = { action: 'pause', who: 'claude', reason: 'проверка team-v42', quote: 'проверяю' };
const change = (fn, phase = 'B') => registry.update(registry.read().rev, fn, meta, { phase });
function pause(on = true) {
  change(n => { const m = n.members.find(m => m.id === 'codex'); m.state = on ? 'paused' : 'active';
    m.pause = on ? { kind: 'manual', scope: 'participant', since: new Date().toISOString(), until: null, next_probe: null } : null; });
}
change(n => { const m = n.members.find(m => m.id === 'deepseek'); Object.assign(m.roles, { receives: true, sends: true, writer: true, voter: true }); });
const release = path.join(root, 'live', 'a'.repeat(40));
let seq = 0;
const dead = () => ({ instance: crypto.randomUUID(), pid: 2147483000 });
function card(extra = {}, who = 'codex', id = 'v42-' + String(++seq).padStart(8, '0')) {
  const dir = path.join(state, who === 'antigravity' ? 'jobs' : who + '-jobs');
  const file = path.join(dir, id + '.json');
  const j = { id, status: 'stop_unconfirmed', stopUnconfirmed: { pid: 2147483001 }, owner: dead(),
    startedAt: new Date().toISOString(), folder: f.project, work: 'work-' + id, ...extra };
  f.json(file, j);
  return { file, j, id, text: () => fs.readFileSync(file, 'utf8'), read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const count = () => words.lines().length;
const tests = [], test = (name, fn) => tests.push([name, fn]);
const hold = require('../common/restart-hold'), realProcesses = hold.processTableAsync;
const processRow = (pid, startedAt = null) => ({ pid, ppid: 0, startedAt });
const emptySnapshot = async () => [processRow(process.pid)];
hold.processTableAsync = emptySnapshot;
function internal(name, exports) {
  const Module = require('module'), file = path.join(base, 'common', name + '.js'), m = new Module(file, module);
  m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8') + '\nObject.assign(module.exports, {' + exports + '});', file);
  return m.exports;
}
test('Пауза: состав установки сохраняется, отправка запрещена, снятие паузы без смены профилей', () => {
  const servers = [...members.installedServers], clients = members.installedClients.map(c => c.id);
  pause(); assert(!members.servers.includes('codex')); assert(members.scanIds.includes('codex'));
  assert.deepEqual([...members.installedServers], servers); assert.deepEqual(members.installedClients.map(c => c.id), clients);
  assert.throws(() => require('../common/access').guard('codex', 'codex_send', {}), /запрещает отправку/);
  assert.doesNotThrow(() => require('../common/access').guard('codex', 'codex_status', {}));
  assert.doesNotThrow(() => require('../common/access').guard('codex', 'codex_result', {}));
  const before = dsh.render('', release, root, process.execPath);
  pause(false); assert.doesNotThrow(() => require('../common/access').guard('codex', 'codex_send', {}));
  assert.equal(dsh.render('', release, root, process.execPath), before); pause();
});
test('Фазы A/B, эффективные роли, удалённые участники, отсутствие повторов серверов', () => {
  const snap = members.snapshot(), a = structuredClone(snap); a.phase = 'A';
  assert(!members.serversForInstall(a).includes('deepseek'));
  assert(members.serversForInstall(snap).includes('deepseek'));
  assert.equal(snap.members.map(members.effective).find(m => m.id === 'deepseek').roles.voter, true);
  a.members.find(m => m.id === 'codex').state = 'removed';
  assert(!members.serversForInstall(a).includes('codex'));
  a.members.push({ ...a.members.find(m => m.id === 'antigravity'), id: 'agy-copy' });
  assert.equal(members.serversForInstall(a).filter(n => n === 'antigravity').length, 1);
  change(n => { n.members.find(m => m.id === 'codex').state = 'removed'; });
  assert(!members.installedClients.some(c => c.id === 'codex'));
  pause();
});
test('Все профили и правила обновляются при паузе; clients без фильтра receives', () => {
  const claude = deploy.configFor({}, release, root, state);
  assert(claude.mcpServers.codex);
  assert(cc.block(cc.toml('', release, root, state, process.execPath)).parsed.root.mcp_servers.codex);
  assert(cc.jsonConfig({}, 'agy', release, root, state, process.execPath).mcpServers.codex);
  assert(dsh.connections(dsh.render('', release, root, process.execPath)).mcpServers.codex);
  assert(cc.paths().some(c => c.client === 'codex'));
  assert.match(require('../common/client-rules').body('codex'), /Codex/);
  change(n => { n.members.find(m => m.id === 'deepseek').roles.receives = false; });
  assert(members.installedClients.some(c => c.id === 'deepseek'));
  assert(!members.installedServers.includes('deepseek'));
  change(n => { n.members.find(m => m.id === 'deepseek').roles.receives = true; });
});
test('Проба и метка используют состав с паузой; allowLegacy сохраняется', async () => {
  const d = internal('deploy', 'probeWithSnapshot, verifiedRelease');
  fs.cpSync(path.join(base, 'common'), path.join(release, 'common'), { recursive: true });
  const target = require('../common/members-kimi').installTarget(state, registry.read(), release);
  for (const n of members.serversForInstall(target)) f.write(path.join(release, 'servers', n, 'index.js'), '');
  const isolated = path.join(root, 'probe'); fs.mkdirSync(isolated);
  const probes = [];
  await d.probeWithSnapshot(isolated, release, root, 'a'.repeat(40), { probe: async (file, env) => { probes.push([path.basename(path.dirname(file)), env.MOST_CLIENT]); } });
  assert(probes.some(([n, client]) => n === 'codex' && client === 'claude'));
  assert(probes.some(([n, client]) => n === 'team' && client === 'codex'));
  assert.equal(d.verifiedRelease(release).legacy, false);
  const marker = path.join(release, 'probe-ok.json'), value = JSON.parse(fs.readFileSync(marker));
  f.json(marker, { ...value, servers: ['team', 'antigravity'] });
  assert.throws(() => d.verifiedRelease(release), /Некорректная метка/);
  assert.equal(d.verifiedRelease(release, true).legacy, true);
  f.json(marker, value);
});
test('release-drift не считает готовность приостановленного устаревшей', () => {
  f.json(path.join(state, 'ready/codex.json'), { release });
  const cp = require('child_process'), saved = cp.spawnSync;
  cp.spawnSync = () => ({ status: 0, stdout: '' });
  try {
    // Модуль захватывает spawnSync при загрузке.
    const drift = internal('release-drift', '');
    assert(!drift.lines(root, state).some(l => /Устаревшая.*codex/.test(l)));
  } finally { cp.spawnSync = saved; }
});
test('Обе проверки перезапуска ждут приостановленный сервер', async () => {
  const restart = require('../common/restart');
  assert.match(restart.script({ runId: 'v42', log: 'test.log', release, state, close: false }), /foreach .*'codex'/);
  const info = { state: path.join(root, 'restart-state'), runId: 'v42', release, log: path.join(root, 'restart.log'), result: path.join(root, 'restart.json') };
  const startedAt = new Date(Date.now() - 5000).toISOString(), finishedAt = new Date().toISOString();
  f.write(info.log, 'итог v42 True'); f.json(info.result, { runId: info.runId, release, success: true, startedAt, finishedAt });
  for (const n of members.installedServers.filter(n => n !== 'codex')) f.json(path.join(info.state, 'ready', n + '.json'), { release, startedAt: finishedAt, pid: 1 });
  await assert.rejects(restart.waitForCompletion(info, { alive: () => true }), /ENOENT/);
  f.json(path.join(info.state, 'ready/codex.json'), { release, startedAt: finishedAt, pid: 1 });
  assert((await restart.waitForCompletion(info, { alive: () => true })).ready.some(r => r.name === 'codex'));
});
test('stop_confirm: запись, полные id, склеивание префикса, идемпотентность, список и down', async () => {
  const c = card({}, 'deepseek'), before = count(), down = require('../common/team-seats').down();
  const text = await stop({ job_ids: [c.id, c.id.slice(0, 8), c.id] });
  assert.match(text, /снято/);
  assert.equal(count(), before + 1); const j = c.read();
  assert(!Object.hasOwn(j, 'stopUnconfirmed'));
  const { stopConfirmed, ...actual } = j;
  const { stopUnconfirmed, ...expected } = c.j;
  assert.deepStrictEqual(actual, expected);
  assert.deepEqual(j.stopConfirmed.prev_stopUnconfirmed, c.j.stopUnconfirmed);
  assert.equal(j.stopConfirmed.quote, 'Можно снять'); assert.equal(j.stopConfirmed.basis, 'слово пользователя');
  assert.deepEqual(j.stopConfirmed.pids, live.cardPids(c.j));
  assert.deepEqual(words.lines().at(-1).job_ids, [c.id]);
  assert.match(await stop({ job_ids: [c.id] }), /уже подтверждено/); assert.equal(count(), before + 1);
  assert.match(await team.word({ action: 'list' }), new RegExp(j.stopConfirmed.word_id));
  assert.equal(words.read().length, 0); assert.equal(words.active('deepseek'), null);
  assert.deepEqual(require('../common/team-seats').down(), down);
});
test('Не найдено и неоднозначно между хранилищами, включая уже подтверждённую', async () => {
  const a = card({}, 'codex', 'ambig-v42-one'), b = card({ stopConfirmed: { basis: 'слово пользователя' } }, 'grok', 'ambig-v42-two');
  const n = count(), text = await stop({ job_ids: ['missing-v42', 'ambig-v42', a.id] });
  assert.match(text, /не найдено/); assert.match(text, /неоднозначно/); assert.match(text, /можно/);
  assert.equal(count(), n); assert(!a.read().stopConfirmed); assert(b.read().stopConfirmed);
  const same = card({}, 'deepseek', a.id);
  assert.match(await stop({ job_ids: [a.id] }), /неоднозначно/); assert(!same.read().stopConfirmed);
});
// team-v59: слово владельца форсирует running/queued/waiting_quota (карточка снимается словом); данные-состояния переноса
// (конфликт миграции, незавершённый перенос) словом не снимаются — отказ по-прежнему блокирует весь пакет.
for (const [status, forced, expected] of [
  ['running', true], ['queued', true], ['waiting_quota', true],
  ['migration_conflict', false, 'конфликт миграции требует разбора'],
  ['applying', false, 'перенос ещё не завершён'],
]) test('Статус ' + status + (forced ? ': слово владельца снимает' : ': отказ (целостность переноса)'), async () => {
  const a = card(), b = card({ status }), n = count();
  const before = [a.text(), b.text()];
  const text = await stop({ job_ids: [a.id, b.id] });
  if (forced) {
    assert.match(text, /снято/); assert.match(text, /мог остаться работать/);
    assert.equal(count(), n + 1); assert(a.read().stopConfirmed && b.read().stopConfirmed);
  } else {
    assert.equal(text.split('\n')[1], b.id + ': ' + expected); assert.equal(count(), n);
    assert.deepStrictEqual([a.text(), b.text()], before); assert(!a.read().stopConfirmed);
  }
});
// team-v59: слово владельца снимает карточку при живом/неизвестном владельце и «возможно живом»/неустановленном PID —
// отказ по аливости перекрыт (помечено словом, замок свободен, в ответе назван нераскрытый риск).
for (const kind of ['alive', 'self', 'unknown', 'missing', 'apply', 'pid']) test('Слово владельца снимает по процессу/владельцу: ' + kind, async () => {
  const saved = locks.ownerState;
  const c = card(kind === 'missing' ? { owner: null } : kind === 'self' ? { owner: locks.owner() } : kind === 'apply' ? { apply: { owner: locks.owner() } } : kind === 'pid' ? { childPid: 23456 } : {});
  if (kind === 'alive' || kind === 'unknown') locks.ownerState = async () => kind;
  if (kind === 'pid') hold.processTableAsync = async () => [processRow(process.pid), processRow(23456)];
  try {
    const n = count();
    const text = await stop({ job_ids: [c.id] });
    assert.match(text, /снято словом владельца/); assert.match(text, /мог остаться работать/);
    assert.equal(count(), n + 1); assert(c.read().stopConfirmed && c.read().stopConfirmed.basis === 'слово пользователя');
  }
  finally { locks.ownerState = saved; hold.processTableAsync = emptySnapshot; }
});
test('team-v61 (Codex №2): running со словом снимается; ОТКАЗ команды снимка слово владельца перекрывает (не блокирует)', async () => {
  const c = card({ status: 'running', owner: null, stopConfirmed: { basis: 'слово пользователя' } });
  assert.match(await stop({ job_ids: [c.id] }), /снято/); assert.equal(c.read().status, 'cancelled');
  hold.processTableAsync = async () => { throw Error('процессы недоступны'); };
  try {
    // team-v61: команда снимка (CIM/powershell) отказала — слово владельца не блокируется, действие выполняется, риск назван.
    const c2 = card();
    const t = await stop({ job_ids: [c2.id] });
    assert.match(t, /снято словом владельца/); assert.match(t, /мог остаться работать/);
    assert(c2.read().stopConfirmed);
    assert.match(await stop({ job_ids: ['absent-v42-only'] }), /не найдено/);
  } finally { hold.processTableAsync = emptySnapshot; }
});

test('Можно: stop_unconfirmed и завершённые статусы с stopUnconfirmed', async () => {
  const jobs = ['stop_unconfirmed', 'failed', 'cancelled', 'lost'].map(status => card({ status, stopUnconfirmed: status === 'stop_unconfirmed' ? undefined : { pid: 2147483001 } }));
  jobs.push(card({ status: 'needs_decision' }));
  assert.match(await stop({ job_ids: jobs.map(c => c.id) }), /снято/);
  assert(jobs.every(c => c.read().stopConfirmed));
  for (const c of jobs) {
    assert(!Object.hasOwn(c.read(), 'stopUnconfirmed'), c.j.status);
    assert.deepStrictEqual(c.read().stopConfirmed.prev_stopUnconfirmed, c.j.stopUnconfirmed ?? null);
  }
  assert.equal(jobs.at(-1).read().status, 'needs_decision');
});
test('Нечего подтверждать: все прочие states.js, включая migration_damaged; смешанный пакет записывается', async () => {
  const excluded = ['running', 'queued', 'waiting_quota', 'delivery_unclear', 'migration_conflict', 'cancelling', 'cancel_requested', 'applying', 'stop_unconfirmed'];
  const nothing = Object.keys(require('../common/states')).filter(s => !excluded.includes(s)).map(status => card({ status, stopUnconfirmed: undefined }));
  for (const status of ['migration_damaged', 'apply_unclear', 'stop_confirmed']) nothing.push(card({ status }));
  const yes = card(), already = card({ stopConfirmed: { basis: 'прежнее', word_id: 'old' }, stopUnconfirmed: undefined });
  const before = nothing.concat(already).map(c => c.text()), n = count();
  const text = await stop({ job_ids: [...nothing, already, yes].map(c => c.id) });
  assert.equal((text.match(/нечего подтверждать/g) || []).length, nothing.length);
  assert.match(text, /уже подтверждено/); assert.match(text, /снято/);
  assert.equal(count(), n + 1); assert(yes.read().stopConfirmed);
  assert.deepEqual(nothing.concat(already).map(c => c.text()), before);
  for (const c of nothing.filter(c => c.j.stopUnconfirmed))
    assert.deepStrictEqual(c.read().stopUnconfirmed, c.j.stopUnconfirmed, c.j.status);
});
test('Ошибка чтения любого хранилища отменяет вызов без записи', async () => {
  const c = card(), n = count(), bad = path.join(state, 'grok-jobs/broken-v42.json');
  f.write(bad, '{');
  try { await assert.rejects(stop({ job_ids: [c.id] }), /Не удалось проверить поручения/); assert.equal(count(), n); assert(!c.read().stopConfirmed); }
  finally { f.json(bad, { id: 'broken-v42', status: 'done', owner: dead() }); }
});
test('team-v61 (Codex №2): команда снимка процессов отказала — слово владельца выполняется, риск назван', async () => {
  const c = card(), n = count(); hold.processTableAsync = async () => { throw Error('Список процессов недоступен'); };
  try {
    const t = await stop({ job_ids: [c.id] });
    assert.match(t, /снято словом владельца/); assert.equal(count(), n + 1); assert(c.read().stopConfirmed);
  } finally { hold.processTableAsync = emptySnapshot; }
});
test('Все замки удерживаются до проверки; изменение карточки перед захватом повторно проверяется', async () => {
  const a = card(), b = card(), n = count(), saved = locks.waitLock, held = [], released = [];
  locks.waitLock = async (kind, id, ...args) => {
    const lock = await saved(kind, id, ...args); held.push(id);
    if (id === b.id) f.json(a.file, { ...a.j, status: 'running' });
    return { ...lock, release: async () => { released.push(id); await lock.release(); } };
  };
  // team-v59: a становится running при захвате — слово владельца его форсирует; оба замка захвачены и отпущены в порядке.
  try { assert.match(await stop({ job_ids: [b.id, a.id] }), /снято/); assert.equal(count(), n + 1);
    assert.deepEqual(held, [a.id, b.id]); assert.deepEqual(released, [b.id, a.id]); assert(a.read().stopConfirmed); }
  finally { locks.waitLock = saved; }
});
test('Сбой записи второй карточки: повтор дописывает тем же word_id', async () => {
  const a = card(), b = card(), n = count(), tg = require('../common/team-git'), saved = tg.atomic;
  tg.atomic = (file, text) => { if (file === b.file) throw Error('пробный сбой'); return saved(file, text); };
  try { await assert.rejects(stop({ job_ids: [a.id, b.id], quote: 'Снять обе' }), /Сбой записи карточки.*Повторите/); }
  finally { tg.atomic = saved; }
  assert.equal(count(), n + 1); assert(a.read().stopConfirmed); assert(!b.read().stopConfirmed);
  const id = a.read().stopConfirmed.word_id;
  assert.match(await stop({ job_ids: [b.id, a.id], quote: 'Снять обе' }), /снято/);
  assert.equal(count(), n + 1); assert.equal(b.read().stopConfirmed.word_id, id);
});
for (const [mode, expected] of [
  // Чат участника (codex) без доказанного ОТПЕЧАТКА чата (нет state\ready\team.json) — отказ по подлинности (jobProof);
  // доказанное происхождение (chat-origin) этот отпечаток не заменяет. Слово владельца снимает только в подлинном чате.
  ['guest', /Гостю это действие запрещено: .*не могу подтвердить, что это чат/],
  ['job', /из поручения запрещено|Гостю это действие запрещено/],
]) test('Доступ: ' + mode + ' отказывает без записи', async () => {
  const c = card(), n = count();
  if (mode === 'guest') process.env.MOST_CLIENT = 'codex';
  if (mode === 'job') process.env.MOST_JOB_ID = 'parent';
  try {
    await assert.rejects(stop({ job_ids: [c.id] }), { message: expected });
    assert.equal(count(), n); assert(!c.read().stopConfirmed);
  } finally {
    process.env.MOST_CLIENT = 'claude'; delete process.env.MOST_JOB_ID;
  }
});
// team-v58 (task10, обновление устаревшего подслучая fallback): запасной режим чат не ограничивает (замысел §2). Проверяем оба
// положения: доказанный чат проходит stop_confirm и в активном режиме; поручение в том же режиме — отказ (слово пишет только чат).
test('Запасной режим не ограничивает чат: доказанный чат проходит stop_confirm, поручение — отказ', async () => {
  const c = card(), n = count();
  await words.append({ kind: 'record', who_down: 'claude', quote: 'Claude отвалился', recorded_by: 'codex', owner: 'fallback-test' });
  try {
    assert(words.mode().active, 'запасной режим активен');
    // Доказанный чат (claude, MOST_TEST_CHAT_ORIGIN=proven): stop_confirm проходит даже в активном режиме.
    assert.match(await stop({ job_ids: [c.id] }), /снято/);
    assert(c.read().stopConfirmed, 'остановка подтверждена доказанным чатом в запасном режиме');
    assert.equal(count(), n + 2, 'записано слово о Claude и stop_confirm');
    // Поручение в том же активном режиме — отказ (слово владельца пишет только доказанный чат).
    const c2 = card(); process.env.MOST_JOB_ID = 'parent';
    try { await assert.rejects(stop({ job_ids: [c2.id] }), /запрещено/); assert(!c2.read().stopConfirmed); }
    finally { delete process.env.MOST_JOB_ID; }
  } finally {
    await words.append({ kind: 'return', who_down: 'claude', quote: 'Claude вернулся', recorded_by: 'claude' });
  }
});
test('Пауза: обе сводки и уборка видят остановку, подтверждение снимает её; needs_decision остаётся', async () => {
  pause(); const c = card({}, 'codex', 'visible-v42-card');
  card({ startedAt: '2026-01-01T00:00:00Z' }, 'codex', 'oldstop-v42-card');
  const decision = card({ status: 'needs_decision' }, 'codex', 'decision-v42-card');
  const owner = require('../common/work-owner');
  assert(owner.hasLiveJobs(c.j.work)); assert(cleanup.liveJobsInFolder(f.project).some(s => s.includes(c.id)));
  let compact = await summary.compact(team, '', undefined, { budget: 100000 });
  assert(compact.includes(c.id.slice(0, 8))); assert.match(compact, /остановка не подтверждена у/);
  let full = await team.status(undefined, undefined, false, true); assert.match(full, /visible-v42-card/);
  await stop({ job_ids: [c.id, decision.id] });
  compact = await summary.compact(team, '', undefined, { budget: 100000 });
  assert(!compact.includes(c.id.slice(0, 8))); assert.match(compact, /decision.*НУЖНО РЕШЕНИЕ/);
  full = await team.status(undefined, undefined, false, true);
  assert(!full.includes(c.id)); assert(full.includes(decision.id));
  assert(!owner.hasLiveJobs(c.j.work)); assert(!cleanup.liveJobsInFolder(f.project).some(s => s.includes(c.id)));
  assert(owner.hasLiveJobs(decision.j.work)); assert(cleanup.liveJobsInFolder(f.project).some(s => s.includes(decision.id)));
});
for (const status of ['queued', 'waiting_quota', 'needs_decision', 'delivery_unclear', 'migration_conflict']) test('Перезагрузка не освобождает папку: ' + status, async () => {
  const c = card({ status }, 'codex', 'reboot-' + status + '-v42'), owner = require('../common/work-owner');
  const boot = process.env.MOST_TEST_BOOT_AT;
  fs.utimesSync(c.file, new Date('2001-01-01'), new Date('2001-01-01'));
  process.env.MOST_TEST_BOOT_AT = '2002-01-01T00:00:00Z';
  try {
    assert.equal(live.confirmation(c.j, 'codex', fs.statSync(c.file).mtimeMs), 'reboot');
    assert(owner.hasLiveJobs(c.j.work)); assert(cleanup.liveJobsInFolder(f.project).some(x => x.includes(c.id)));
    const full = await team.status(undefined, undefined, false, true);
    assert(full.includes(c.id));
    const compact = await summary.compact(team, '', undefined, { budget: 100000 });
    if (status === 'waiting_quota') assert.match(compact, /Ждут квоту/);
    else assert(compact.includes(c.id.slice(0, 8)));
    const from = full.indexOf(' · поручение ' + c.id.slice(0, 8) + ' ·');
    assert(from >= 0);
    assert(!full.slice(from, full.indexOf('Дальше:', from)).includes('ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА'));
    assert(!compact.split('\n').some(line => line.includes(c.id.slice(0, 8)) && line.includes('ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА')));
  } finally { process.env.MOST_TEST_BOOT_AT = boot; }
});
for (const status of ['running', 'stop_unconfirmed']) for (const basis of ['reboot', 'слово пользователя']) test('Мёртвый ' + status + ' с записью требует решения после подтверждения: ' + basis, async () => {
  const c = card({ status, write: true, ...(basis === 'reboot' ? {} : { stopConfirmed: { basis } }) }, 'codex', (basis === 'reboot' ? 'boot' : 'word') + (status === 'running' ? 'run' : 'stop') + '-v42');
  const boot = process.env.MOST_TEST_BOOT_AT;
  if (basis === 'reboot') { fs.utimesSync(c.file, new Date('2001-01-01'), new Date('2001-01-01')); process.env.MOST_TEST_BOOT_AT = '2002-01-01T00:00:00Z'; }
  try {
    const compact = await summary.compact(team, '', undefined, { budget: 100000 });
    const full = await team.status(undefined, undefined, false, true);
    assert(compact.split('\n').some(line => line.includes(c.id.slice(0, 8)) && line.includes('НУЖНО РЕШЕНИЕ') && !line.includes('ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА')));
    const from = full.indexOf(' · поручение ' + c.id.slice(0, 8) + ' ·');
    assert(from >= 0);
    const view = full.slice(from, full.indexOf('Дальше:', from));
    assert(view.includes(c.id)); assert(view.includes('НУЖНО РЕШЕНИЕ')); assert(!view.includes('ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА'));
    assert(require('../common/work-owner').hasLiveJobs(c.j.work));
    assert(cleanup.liveJobsInFolder(f.project).some(x => x.includes(c.id)));
  } finally { process.env.MOST_TEST_BOOT_AT = boot; }
});
for (const status of ['running', 'cancelling', 'stop_unconfirmed']) for (const basis of ['reboot', 'word']) test('Без записи: подтверждённый ' + status + ' не держит папку и не виден: ' + basis, async () => {
  const c = card({ status, write: false, ...(basis === 'word' ? { stopConfirmed: { basis: 'слово пользователя' } } : {}) }, 'codex', 'ro-' + basis[0] + '-' + status + '-v42');
  const boot = process.env.MOST_TEST_BOOT_AT;
  if (basis === 'reboot') { fs.utimesSync(c.file, new Date('2001-01-01'), new Date('2001-01-01')); process.env.MOST_TEST_BOOT_AT = '2002-01-01T00:00:00Z'; }
  try {
    const before = c.text();
    assert(!require('../common/work-owner').hasLiveJobs(c.j.work));
    assert(!cleanup.liveJobsInFolder(f.project).some(x => x.includes(c.id)));
    const compact = await summary.compact(team, '', undefined, { budget: 100000 });
    const full = await team.status(undefined, undefined, false, true);
    assert(!compact.includes(c.id.slice(0, 8))); assert(!full.includes(c.id));
    assert.equal(c.text(), before);
  } finally { process.env.MOST_TEST_BOOT_AT = boot; }
});

test('Подтверждение не освобождает папку при живом или неизвестном PID владельца/исполнителя', () => {
  for (const status of ['running', 'cancelling', 'stop_unconfirmed']) for (const extra of [{ owner: locks.owner() }, { owner: { instance: 'unknown' } }, { owner: null }, { childPid: process.pid }]) {
    const c = card({ status, write: false, stopConfirmed: { basis: 'раньше' }, ...extra });
    assert(require('../common/work-owner').hasLiveJobs(c.j.work));
    assert(cleanup.liveJobsInFolder(f.project).some(x => x.includes(c.id)));
  }
});

test('Подтверждение → настоящий claim: частичные изменения остаются needs_decision', async () => {
  pause(false); const jobs = [];
  try {
    for (const status of ['running', 'cancelling', 'stop_unconfirmed']) {
      const name = 'claim-' + status.replace('_', '-') + '-v42', old = '2001-01-01T00:00:00Z';
      f.json(team.workFile(name), { ...f.fixture().w, name, owner: 'prior', revision: 1, reminders: [], heartbeat_at: old, updated_at: old });
      const c = card({ write: true, work: name }, 'codex', status + '-claim-v42'); jobs.push(c);
      assert.match(await stop({ job_ids: [c.id] }), /снято/);
      const confirmation = c.read().stopConfirmed;
      f.json(c.file, { ...c.read(), status });
      await assert.rejects(team.work({ action: 'claim', name, owner: 'next', expected_revision: 1 }), /Работа жива/);
      assert.equal(c.read().status, 'needs_decision'); assert.deepEqual(c.read().stopConfirmed, confirmation);
      assert.equal(JSON.parse(fs.readFileSync(team.workFile(name))).owner, 'prior');
      assert(require('../common/work-owner').hasLiveJobs(name));
      assert(cleanup.liveJobsInFolder(f.project).some(x => x.includes(c.id)));
    }
    const compact = await summary.compact(team, '', undefined, { budget: 100000 });
    const full = await team.status(undefined, undefined, false, true);
    for (const c of jobs) {
      assert(compact.includes(c.id.slice(0, 8) + ': НУЖНО РЕШЕНИЕ'));
      assert(full.includes('поручение ' + c.id.slice(0, 8) + ' · НУЖНО РЕШЕНИЕ'));
    }
  } finally { pause(); }
});

test('Claim без записи переводит мёртвое поручение в lost и передаёт работу', async () => {
  pause(false);
  try {
    const name = 'claim-read-v42', old = '2001-01-01T00:00:00Z';
    f.json(team.workFile(name), { ...f.fixture().w, name, owner: 'prior', revision: 1, reminders: [], heartbeat_at: old, updated_at: old });
    const c = card({ write: false, work: name }, 'codex', 'claimread-v42');
    await stop({ job_ids: [c.id] });
    await team.work({ action: 'claim', name, owner: 'next', expected_revision: 1 });
    assert.equal(c.read().status, 'lost'); assert.equal(JSON.parse(fs.readFileSync(team.workFile(name))).owner, 'next');
    assert(!require('../common/work-owner').hasLiveJobs(name));
    assert(!cleanup.liveJobsInFolder(f.project).some(x => x.includes(c.id)));
  } finally { pause(); }
});

test('Старые вычисляемые needs_decision и lost сворачиваются по вычисленному состоянию', async () => {
  const jobs = ['running', 'cancelling'].flatMap(status => [true, false].map(write => card({ status, write, startedAt: '2001-01-01T00:00:00Z' }, 'codex', 'old-' + status + '-' + write + '-v42')));
  const compact = await summary.compact(team, '', undefined, { budget: 100000 });
  for (const c of jobs) assert(!compact.includes(c.id.slice(0, 8)));
  assert.match(compact, /нужно решение по .*поручениям старше суток/);
  assert.match(compact, /остановка не подтверждена у .*поручений старше суток/);
});
const yaml = '# вне блока: сохранить  \n# most:begin (правит team_change deploy)\n' +
  '- insert:\n    - id: session-log-deepseek\n      name: logger\n      config:\n        text: "перенос \\\n          строки"\n    - id: mcp-most-team\n      name: old\n      config:\n        serverName: team\n        args: [old]\n' +
  '- id: ui-theme\n  config:\n    theme: dark\n# most:end\n# хвост  \n';
for (const eol of ['\n', '\r\n']) test('DSH: многострочный YAML, посторонние элементы, повтор и откат ' + JSON.stringify(eol), () => {
  const input = yaml.replaceAll('\n', eol), before = dsh.block(input);
  assert.equal(dsh.connections(input).mcpServers.team.args[0], 'old');
  const rendered = dsh.render(input, release, root, process.execPath), after = dsh.block(rendered);
  assert.equal(rendered.slice(0, after.from), input.slice(0, before.from));
  assert.equal(rendered.slice(after.to), input.slice(before.to));
  assert.deepEqual(after.entries.filter(e => !e.id.startsWith('mcp-most-')), before.entries.filter(e => !e.id.startsWith('mcp-most-')));
  assert.deepEqual(Object.keys(dsh.connections(rendered).mcpServers), [...members.installedServers]);
  assert.equal(dsh.render(rendered, release, root, process.execPath), rendered);
  assert.equal(dsh.restore(rendered, input), input); assert.equal(dsh.restore(input, rendered), rendered);
  assert.equal(dsh.restore('неверный\n# most:begin\n[', input), input);
  const changed = input.replace('# вне блока: сохранить', '# новое снаружи').replace('# хвост', '# новый хвост');
  assert.equal(dsh.restore(changed, rendered), rendered.replace('# вне блока: сохранить', '# новое снаружи').replace('# хвост', '# новый хвост'));
  const broken = changed.slice(0, changed.indexOf('- insert:')) + '[[[broken' + eol + changed.slice(changed.indexOf('# most:end'));
  const restored = dsh.restore(broken, input);
  assert(restored.startsWith('# новое снаружи')); assert(restored.includes('# новый хвост'));
  assert.equal(dsh.connections(restored).mcpServers.team.args[0], 'old');
  assert.equal(dsh.restore(rendered, 'без меток'), 'без меток');
  assert.equal(dsh.restore('без меток', input), input);
});
test('DSH: повреждённые метки, YAML и опасные теги отклоняются без записи', () => {
  for (const [input, expected] of [
    ['# most:begin\n- [\n# most:end\n', /^cordis\.patch\.yml не разобран, запись отменена:/],
    ['# most:end\n# most:begin\n', /^Повреждены метки DSH\.$/],
    [yaml + '# most:end\n', /^Повреждены метки DSH\.$/],
    ['# most:begin\n- !!js/function "function() { throw 1; }"\n# most:end\n', /^cordis\.patch\.yml не разобран, запись отменена:/],
  ]) {
    const saved = process.env.MOST_DSH_CONFIG, file = path.join(root, 'invalid.yml');
    process.env.MOST_DSH_CONFIG = file; f.write(file, input);
    try {
      const target = cc.paths().find(p => p.kind === 'dsh'); assert.equal(target.file, file);
      const snapshot = { ...deploy.snapshot(target.file), ...target };
      assert.throws(() => cc.plans([snapshot], release, root, state, process.execPath), { message: expected });
      assert.equal(fs.readFileSync(file, 'utf8'), input);
    } finally { process.env.MOST_DSH_CONFIG = saved; }
  }
});
test('DSH: построчный откат сохраняет правки вне блока; унаследованные подключения обновляются', () => {
  const old = dsh.render('# вне\n', release, root, process.execPath);
  const next = dsh.render(old, path.join(root, 'live', 'b'.repeat(40)), root, process.execPath);
  assert.equal(dsh.restore(next.replace('# вне', '# новая'), old), old.replace('# вне', '# новая'));
  const cfg = path.join(root, 'profile/cordis.patch.yml');
  f.json(path.join(root, 'profile/package.json'), { dsh: { profile: { bundles: ['bundle'] } } });
  f.json(path.join(root, 'profile/node_modules/bundle/package.json'), { dsh: { bundle: { patch: 'patch.yml' } } });
  f.write(path.join(root, 'profile/node_modules/bundle/patch.yml'), '- id: mcp-most-team\n');
  const result = dsh.block(dsh.render('', release, root, process.execPath, 'deepseek', cfg));
  assert(result.rows.some(r => r.id === 'mcp-most-team'));
  const patch = path.join(root, 'profile/node_modules/bundle/patch.yml');
  let rendered = dsh.render(yaml, release, root, process.execPath, 'deepseek', cfg);
  f.write(patch, '# сервер ушёл из пакета\n');
  rendered = dsh.render(rendered, release, root, process.execPath, 'deepseek', cfg);
  assert(dsh.block(rendered).rows.some(r => r.insert?.some(e => e.id === 'mcp-most-team')));
  assert(!dsh.block(rendered).rows.some(r => r.id === 'mcp-most-team'));
  f.write(patch, '- id: mcp-most-team\n');
  rendered = dsh.render(rendered, release, root, process.execPath, 'deepseek', cfg);
  assert(dsh.block(rendered).rows.some(r => r.id === 'mcp-most-team'));
  assert(!dsh.block(rendered).rows.some(r => r.insert?.some(e => e.id === 'mcp-most-team')));
  assert.equal(dsh.render(rendered, release, root, process.execPath, 'deepseek', cfg), rendered);
  assert.deepEqual(dsh.block(rendered).entries.filter(e => !e.id.startsWith('mcp-most-')), dsh.block(yaml).entries.filter(e => !e.id.startsWith('mcp-most-')));
});
test('DSH в сводке: нет файла, ошибка разбора, нет подключения и чужая установка различимы', () => {
  assert.match(summary.settings(), /dsh → файла нет/);
  f.write(process.env.MOST_DSH_CONFIG, '# most:begin\n- [\n# most:end\n');
  assert.match(summary.settings(), /dsh → файл не разобран:.*cordis/);
  f.write(process.env.MOST_DSH_CONFIG, '# most:begin\n- insert: []\n# most:end\n');
  assert.match(summary.settings(), /dsh\/team → подключение сервера отсутствует/);
  f.write(process.env.MOST_DSH_CONFIG, dsh.render('', path.join(root, 'other/live', 'c'.repeat(40)), path.join(root, 'other'), process.execPath));
  assert.match(summary.settings(), /dsh\/team → подключение указывает не на ту установку/);
  f.write(process.env.MOST_DSH_CONFIG, dsh.render('', root, root, process.execPath));
  assert(!summary.settings().includes('dsh/team → подключение сервера отсутствует')); // своё подключение без метки релиза
  f.write(process.env.MOST_DSH_CONFIG, dsh.render(yaml, release, root, process.execPath));
  assert(!summary.settings().includes('dsh/')); // исправные подключения не попадают в расхождения
});

test('Жёсткие ссылки извне: установка и доставка правил отказывают без изменения файлов', async () => {
  const config = path.join(root, 'linked-config.json'), rulesFile = path.join(root, 'linked-rules.md');
  f.write(config, '{}'); f.write(rulesFile, '## Связка ИИ\nстарые правила\n');
  fs.linkSync(config, path.join(root, 'config-upload-link'));
  fs.linkSync(rulesFile, path.join(root, 'rules-upload-link'));
  assert.equal(fs.statSync(config).nlink, 2); assert.equal(fs.statSync(rulesFile).nlink, 2);
  await assert.rejects(deploy.switchConfigs([{ ...deploy.snapshot(config), next: '{"new":true}' }]), /Жёсткие ссылки в настройках запрещены/);
  const result = await require('../common/client-rules').configure({ files: [{ file: rulesFile, role: 'codex' }] });
  assert.match(result.join('\n'), /отказ: Жёсткие ссылки в настройках запрещены/);
  assert.equal(fs.readFileSync(config, 'utf8'), '{}');
  assert.equal(fs.readFileSync(rulesFile, 'utf8'), '## Связка ИИ\nстарые правила\n');
});

test('Исчезнувшее при чтении хранилище — отказ всего вызова', async () => {
  const c = card(), n = count(), saved = fs.readdirSync, target = path.join(state, 'grok-jobs');
  fs.readdirSync = (file, ...args) => { if (file === target) throw Object.assign(Error('исчезло'), { code: 'ENOENT' }); return saved(file, ...args); };
  try {
    assert(!live.cards({ stateDir: state }).some(row => row.store === 'grok-jobs'));
    await assert.doesNotReject(live.running({ stateDir: state }));
    await assert.doesNotReject(live.staleRecords({ stateDir: state }));
    assert.doesNotThrow(() => live.unfinished({ stateDir: state }));
    await assert.rejects(stop({ job_ids: [c.id] }), /Не удалось проверить поручения/); assert.equal(count(), n); assert(!c.read().stopConfirmed);
  } finally { fs.readdirSync = saved; }
  const empty = path.join(root, 'empty-jobs-state'); fs.mkdirSync(empty);
  assert.deepEqual(await live.running({ stateDir: empty }), []);
});
test('Слово и карточки пишутся под замками всех четырёх исполнителей и журнала', async () => {
  const jobs = ['codex', 'deepseek', 'grok', 'antigravity'].map(who => card({}, who));
  const agy = jobs.at(-1), bundle = path.join(state, 'jobs', agy.id, 'card.json');
  // Отдельная карточка Antigravity в штатном каталоге, без второго совпадения id.
  f.json(agy.file, { ...agy.j, id: 'unused-' + agy.id });
  f.json(bundle, agy.j); agy.file = bundle;
  const saved = locks.tryLock, savedWait = locks.waitLock, acquired = [], held = new Set(), released = [];
  const track = (kind, l) => {
    if (!l.ok) return l;
    acquired.push(kind); held.add(kind);
    return { ...l, release: async () => { released.push(kind); held.delete(kind); await l.release(); } };
  };
  locks.tryLock = async (kind, key, ...args) => track(kind, await saved(kind, key, ...args));
  locks.waitLock = async (kind, key, ...args) => track(kind, await savedWait(kind, key, ...args));
  const tg = require('../common/team-git'), atomic = tg.atomic;
  tg.atomic = (file, text) => {
    if (jobs.some(c => c.file === file)) assert.deepEqual([...held].sort(), ['codex_job', 'deepseek_job', 'grok_job', 'job', 'team_words'].sort());
    return atomic(file, text);
  };
  try {
    assert.match(await stop({ job_ids: jobs.map(c => c.id).reverse() }), /снято/);
    assert.deepEqual(acquired, ['codex_job', 'deepseek_job', 'grok_job', 'job', 'team_words']);
    assert.deepEqual(released, acquired.slice().reverse());
    for (const c of jobs) assert(JSON.parse(fs.readFileSync(c.file)).stopConfirmed);
  } finally { locks.tryLock = saved; locks.waitLock = savedWait; tg.atomic = atomic; }
});
test('Занятый замок карточки: нет записей; после освобождения повтор проходит', async () => {
  const c = card(), n = count(), held = await locks.tryLock('codex_job', c.id), saved = locks.waitLock;
  assert(held.ok);
  locks.waitLock = (kind, id, info) => locks.tryLock(kind, id, info);
  try { await assert.rejects(stop({ job_ids: [c.id] }), /Карточка поручения занята/); assert.equal(count(), n); assert(!c.read().stopConfirmed); }
  finally { locks.waitLock = saved; await held.release(); }
  assert.match(await stop({ job_ids: [c.id] }), /снято/);
});
test('Сбой записи слова: карточка цела, все замки освобождены', async () => {
  const c = card(), n = count(), saved = fs.openSync;
  fs.openSync = (file, ...args) => { if (file === words.file()) throw Error('журнал недоступен'); return saved(file, ...args); };
  try { await assert.rejects(stop({ job_ids: [c.id] }), /журнал недоступен/); assert.equal(count(), n); assert(!c.read().stopConfirmed); }
  finally { fs.openSync = saved; }
  assert.match(await stop({ job_ids: [c.id] }), /снято/);
});
test('Нет допустимых карточек: слово не создаётся; чужая цитата не переиспользуется', async () => {
  const a = card({ status: 'migration_damaged', stopUnconfirmed: undefined }), b = card({ stopConfirmed: { basis: 'раньше' }, stopUnconfirmed: undefined }), n = count();
  const text = await stop({ job_ids: [a.id, b.id] }); assert.match(text, /нечего подтверждать/); assert.match(text, /уже подтверждено/); assert.equal(count(), n);
  const c = card(); await words.recordStopConfirmation([c.id], 'другая цитата');
  const prior = words.lines().at(-1).id;
  await stop({ job_ids: [c.id] }); assert.notEqual(c.read().stopConfirmed.word_id, prior);
});
test('Неверные параметры stop_confirm отвергаются без слова и карточек', async () => {
  const c = card(), n = count(), before = c.text();
  for (const [args, message] of [
    [{ job_ids: [] }, 'job_ids: нужны полные номера или префиксы от 8 знаков.'],
    [{ job_ids: ['short'] }, 'job_ids: нужны полные номера или префиксы от 8 знаков.'],
    [{ job_ids: [c.id], quote: ' ' }, 'Нужно слово пользователя дословно (quote).'],
    [{ job_ids: [123] }, 'job_ids: нужны полные номера или префиксы от 8 знаков.'],
  ]) await assert.rejects(stop(args), { message });
  assert.equal(count(), n); assert.equal(c.text(), before);
});

for (const status of ['cancelling', 'cancel_requested', 'delivery_unclear', 'done', 'applied']) for (const write of [false, true])
test('v55: мёртвый ' + status + ', write=' + write + ' сохраняет результат и снимает свой замок', async () => {
  const c = card({ status, write, result: 'частичный ответ', finishedAt: '2026-01-02T00:00:00Z', startedAt: '2026-01-01T00:00:00Z' });
  const wl = require('../common/write-lock'), folder = path.join(f.project, c.id); fs.mkdirSync(folder);
  f.json(c.file, { ...c.j, folder }); const lock = wl.acquire(folder, { jobId: c.id }); assert(lock.ok);
  assert.match(await stop({ job_ids: [c.id] }), /снято/);
  const j = c.read(); assert.equal(j.status, ['done', 'applied'].includes(status) ? status : write ? 'needs_decision' : 'cancelled');
  assert.equal(j.result, c.j.result); assert.equal(j.finishedAt, c.j.finishedAt); assert(!Object.hasOwn(j, 'stopUnconfirmed'));
  assert.equal(j.stopConfirmed.prev_status, status); assert.deepEqual(j.stopConfirmed.prev_stopUnconfirmed, c.j.stopUnconfirmed);
  const next = wl.acquire(folder, { jobId: c.id + '-next' }); assert(next.ok);
  try { await stop({ job_ids: [c.id] }); assert(!wl.acquire(folder).ok); } finally { next.release(); }
});
test('v55: повтор старого stopConfirmed дочищает флаг и замок, время решения не становится finishedAt', async () => {
  const c = card({ status: 'cancelling', stopConfirmed: { basis: 'прежнее', word_id: 'old' } });
  const wl = require('../common/write-lock'), folder = path.join(f.project, c.id); fs.mkdirSync(folder);
  f.json(c.file, { ...c.j, folder }); assert(wl.acquire(folder, { jobId: c.id }).ok);
  await stop({ job_ids: [c.id] }); const j = c.read();
  assert.equal(j.status, 'cancelled'); assert(!Object.hasOwn(j, 'stopUnconfirmed')); assert(!j.finishedAt);
  assert.equal(j.stopConfirmed.prev_stopConfirmed.word_id, 'old');
  const next = wl.acquire(folder, { jobId: c.id + '-next' }); assert(next.ok); next.release();
});
const clockAt = seconds => new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000).toISOString();
for (const [label, fields, birth, expected] of [
  ['child +5', { childPid: 23456, childStartedAt: clockAt(10) }, 15, 'possibly_alive'],
  ['child +5.001', { childPid: 23456, childStartedAt: clockAt(10), stopUnconfirmed: { pid: 23456 } }, 15.001, 'foreign'],
  ['начало -5', { pid: 23456 }, -5, 'possibly_alive'], ['начало -5.001', { pid: 23456 }, -5.001, 'foreign'],
  ['createdAt как нижняя граница', { startedAt: undefined, createdAt: clockAt(0), pid: 23456 }, -5.001, 'foreign'],
  ['очередь не верхняя граница', { pid: 23456 }, 100, 'possibly_alive'],
  ['поздний потомок', { childStartedAt: clockAt(10), observedPids: [23456] }, 100, 'possibly_alive'],
  ['finished +5', { observedPids: [23456], finishedAt: clockAt(100) }, 105, 'possibly_alive'],
  ['finished +5.001', { observedPids: [23456], finishedAt: clockAt(100) }, 105.001, 'foreign'],
  ['противоречивые даты', { childPid: 23456, childStartedAt: clockAt(-100) }, 100, 'unknown'],
  ['обратные часы даже внутри 5 с', { childPid: 23456, childStartedAt: clockAt(-1) }, 100, 'unknown'],
  ['неверная дата', { childPid: 23456, childStartedAt: 'broken' }, 100, 'unknown'],
  ['без границ', { startedAt: undefined, childPid: 23456 }, 100, 'unknown'],
  ['без CreationTime', { childPid: 23456, childStartedAt: clockAt(10) }, null, 'unknown'],
  ['agyPid без отпечатка', { agyPid: 23456 }, 100, 'possibly_alive'],
  ['владелец переиспользован', { owner: { instance: 'dead-v55', pid: 23456, startedAt: clockAt(-100) } }, 100, 'foreign'],
  ['владелец +5', { owner: { instance: 'dead-v55', pid: 23456, startedAt: clockAt(-100) } }, -95, 'possibly_alive'],
  ['владелец +5.001', { owner: { instance: 'dead-v55', pid: 23456, startedAt: clockAt(-100) } }, -94.999, 'foreign'],
  ['владелец не наследует начало поручения', { owner: { instance: 'dead-v55', pid: 23456, startedAt: clockAt(-100) } }, -101, 'possibly_alive'],
]) test('v55: границы PID — ' + label, async () => {
  const c = card({ startedAt: clockAt(0), ...fields }), n = count();
  hold.processTableAsync = async () => [processRow(process.pid), processRow(23456, birth === null ? null : clockAt(birth))];
  try {
    const text = await stop({ job_ids: [c.id] });
    // team-v59: 'foreign' — чужой PID, карточка остановлена штатно; 'possibly_alive'/'unknown' — слово владельца снимает
    // (прежде отказ): проверка checkStopped та же, но отказ по аливости перекрыт словом (назван нераскрытый риск).
    assert.match(text, /снято/); assert.equal(count(), n + 1);
    if (expected === 'foreign') { const e = c.read().stopConfirmed.evidence; assert.equal(e.toleranceMs, 5000); assert(e.processes.some(p => p.pid === 23456 && p.state === 'foreign' && p.excludedBy.length)); }
    else { assert.match(text, /снято словом владельца/); assert.match(text, /мог остаться работать/); }
  } finally { hold.processTableAsync = emptySnapshot; }
});
for (const rows of [null, [], [processRow(process.pid), processRow(process.pid)], [processRow(process.pid), { pid: 2 }]])
test('v55: неполный/неверный снимок не меняет пакет', async () => {
  const c = card(), before = c.text(), n = count(); hold.processTableAsync = async () => rows;
  try { await assert.rejects(stop({ job_ids: [c.id] }), /снимок процессов/); assert.equal(c.text(), before); assert.equal(count(), n); }
  finally { hold.processTableAsync = emptySnapshot; }
});
for (const nonempty of [false, true]) for (const flat of [false, true])
test('v55: папка без card.json, содержимое=' + nonempty + ', плоская=' + flat, async () => {
  const id = 'v55-folder-' + ++seq, dir = path.join(state, 'codex-jobs', id); fs.mkdirSync(dir);
  if (nonempty) f.write(path.join(dir, 'result.txt'), 'сохранённый файл');
  const c = flat ? card({}, 'codex', id) : card();
  for (const strictStores of [false, true]) assert.equal(live.cards({ stateDir: state, strictStores }).filter(c => c.j.id === id).length, flat ? 1 : 0);
  assert((await live.running({ stateDir: state })).some(r => r.id === c.id.slice(0, 8)));
  assert.match(await stop({ job_ids: [c.id] }), /снято/); if (nonempty) assert.equal(fs.readFileSync(path.join(dir, 'result.txt'), 'utf8'), 'сохранённый файл');
});
test('v55: битая/неверная card.json, EACCES и ENOENT плоской карточки остаются ошибками', async () => {
  const file = path.join(state, 'codex-jobs/v55-bad/card.json'), c = card(), read = fs.readFileSync;
  for (const value of ['{', 'null', '123']) {
    f.write(file, value);
    for (const strictStores of [false, true]) assert.throws(() => live.cards({ stateDir: state, strictStores }), /Не удалось проверить/);
  }
  f.json(file, { id: 'v55-bad', status: 'done' });
  for (const [target, code] of [[file, 'EACCES'], [c.file, 'ENOENT']]) {
    fs.readFileSync = (p, ...args) => { if (String(p) === target) throw Object.assign(Error(code), { code }); return read(p, ...args); };
    try { for (const strictStores of [false, true]) assert.throws(() => live.cards({ stateDir: state, strictStores }), new RegExp(code)); await assert.rejects(stop({ job_ids: [c.id] }), new RegExp(code)); }
    finally { fs.readFileSync = read; }
  }
});

f.run(tests).finally(() => { hold.processTableAsync = realProcesses; });

