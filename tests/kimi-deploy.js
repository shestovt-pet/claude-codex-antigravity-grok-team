'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), assert = require('assert/strict');
const h = require('./fake-kimi'), f = h.setup(), members = require('../common/members'), migration = require('../common/members-kimi'), launch = require('../common/kimi-launch');
const source = path.resolve(__dirname, '..'); let seq = 0;
const meta = { action: 'test', who: 'claude', reason: 'проверка' };
let latestLegacy;
function legacy() {
  const state = path.join(f.root, 'legacy-' + ++seq); fs.mkdirSync(state);
  const roster = require('../common/members-default')(); roster.members = roster.members.filter(m => m.id !== 'kimi');
  const text = JSON.stringify(roster); fs.writeFileSync(path.join(state, 'members.json'), text); fs.writeFileSync(path.join(state, 'members.json.last-good'), text);
  fs.writeFileSync(path.join(state, 'members-log.jsonl'), JSON.stringify({ action: 'init', rev: 0, at: new Date().toISOString(), who: 'system', before: null, after: roster }) + '\n'); latestLegacy = state; return state;
}
const self = () => ({ pid: process.pid, ppid: process.ppid, name: 'node.exe', cmd: '"' + process.execPath + '" "' + __filename + '"', startedAt: '2026-01-01T00:00:00Z' });
// team-v57 (ред.6): время загрузки в проверке установки — через внутреннюю зависимость bootAt (не через MOST_TEST_BOOT_AT).
// По умолчанию 0 (детерминированно, без обращения к PowerShell): карточки, записанные позже 0, по перезагрузке не проходят.
function deps(extra = {}) { const roster = require('../common/members-store').create(latestLegacy).read({ initialize: false }), target = migration.installTarget(latestLegacy, roster, source); return { proof: { sourceRegistryRev: roster.rev, sourceRegistryHash: migration.digest(roster), targetRoster: target, targetRegistryHash: migration.digest(target) }, processTable: async () => [self()], hold: { fingerprint: pid => ({ pid, startedAt: new Date().toISOString() }) }, bootAt: () => 0, ...extra }; }
function git(root, ...args) { const r = cp.spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
// team-v56 А5/И1: валидный артефакт живой приёмки А3, привязанный к хешам кандидата (migration.acceptanceBinding): CLI
// (реальный бинарник-фикстура, cliSha256≠null), профили с MCP-инструментами, implHash реализации, mcpTools и ссылки на
// настоящие завершённые карточки Kimi (jobs). Самодельный JSON без этих карточек приёмку не даёт.
let kimiBinSet = false, kimiBin;
function ensureKimiBinary() {
  if (kimiBinSet) return;
  kimiBin = path.join(f.root, 'kimi-fixture.bin'); fs.writeFileSync(kimiBin, 'FAKE-KIMI-BINARY-V56');
  f.store.update(f.store.read().rev, n => { n.members.find(m => m.id === 'kimi').adapter_params.path = kimiBin; }, meta);
  kimiBinSet = true;
}
// team-v56 К3 (ревью Kimi 1 круг 3): фикстуры воспроизводят НАСТОЯЩИЙ формат следов моста (не минимальные заглушки):
//  — поручение-родитель Kimi в kimi-jobs с delegations/outgoingVerified (как пишет common() сервера Kimi);
//  — дочерние карточки исходящих в codex-jobs: from='kimi', parentJob=родитель (как пишет servers/codex send/finish);
//  — запись входящих дирижёру в inbox: автор-поручение Kimi, ответ (как пишет common/inbox.save).
// Возвращает ссылки: send/result — исходящее поручение Kimi (done с читаемым результатом); cancel_child — отменённый
// потомок Kimi (cancelled + stopConfirmed); team_ask — отвеченный запрос дирижёру.
// team-v56 Л1/Л2 (ревью Kimi круг 4 → круг 5, М1): родитель-Kimi привязан к текущей приёмке — cli.sha256/implHash из
// acceptanceBinding(b), startedAt не раньше начала приёмки; result подтверждён отметкой ВЫДАЧИ готового результата потомка
// его родителю, которую сервер-получатель пишет в карточку ПОТОМКА (resultDeliveries { to, at ≥ finishedAt, sha }).
const childDelivery = (parent, childFin, text) => [{ to: parent, at: new Date(Date.parse(childFin) + 1000).toISOString(), sha256: launch.sha(text) }];
function acceptanceJobs(state, b) {
  const parent = 'acc-kimi-' + (++seq), childSend = 'kimi-child-send-' + (++seq), childCancel = 'kimi-child-cancel-' + (++seq), ask = 'acc-ask-' + (++seq);
  const childFin = new Date(Date.now() - 5000).toISOString(), parentFin = new Date().toISOString(), parentStart = new Date(Date.now() - 30000).toISOString();
  const kd = path.join(state, 'kimi-jobs', parent); fs.mkdirSync(kd, { recursive: true });
  fs.writeFileSync(path.join(kd, 'card.json'), JSON.stringify({ id: parent, status: 'done', from: 'claude', folder: f.folder, write: true, role: 'совет',
    mcpPolicy: 'project', mcpServers: ['codex'], outgoingVerified: true, outgoingCount: 2, delegations: [childSend, childCancel],
    cli: { path: 'kimi', sha256: b.cliSha256 }, implHash: b.implHash,
    startedAt: parentStart, finishedAt: parentFin, exitCode: 0, resultFile: parent + '.result.txt', resultSha256: 'x', voteEligible: false,
    stopConfirmed: { basis: 'процесс завершён; дерево отсутствует', at: parentFin } }));
  fs.writeFileSync(path.join(kd, parent + '.result.txt'), 'итог приёмочного исполнения Kimi');
  const cd = path.join(state, 'codex-jobs'); fs.mkdirSync(cd, { recursive: true });
  const childText = 'результат исходящего поручения Kimi';
  fs.writeFileSync(path.join(cd, childSend + '.result.txt'), childText);
  fs.writeFileSync(path.join(cd, childSend + '.json'), JSON.stringify({ id: childSend, status: 'done', from: 'kimi', parentJob: parent, threadId: 't',
    finishedAt: childFin, exitCode: 0, resultFile: childSend + '.result.txt', resultDeliveries: childDelivery(parent, childFin, childText) }));
  fs.writeFileSync(path.join(cd, childCancel + '.json'), JSON.stringify({ id: childCancel, status: 'cancelled', from: 'kimi', parentJob: parent,
    stopReason: 'cancel', finishedAt: childFin, stopConfirmed: { basis: 'процесс завершён; дерево отсутствует', at: childFin } }));
  const idir = path.join(state, 'inbox'); fs.mkdirSync(idir, { recursive: true });
  fs.writeFileSync(path.join(idir, ask + '.json'), JSON.stringify({ id: ask, at: new Date().toISOString(), status: 'answered',
    text: 'вопрос дирижёру из приёмки', refs: [], work: null, author: { kind: 'job', id: parent, member: 'kimi', from: 'claude' }, answer: 'ответ дирижёра', deadline: null }));
  return { send: childSend, result: childSend, team_ask: ask, cancel_child: childCancel };
}
function writeAcceptance(state, patch = {}) {
  ensureKimiBinary();
  const b = migration.acceptanceBinding();
  fs.writeFileSync(migration.acceptanceFile(state), JSON.stringify({ status: 'passed', send: true, result: true, team_ask: true, cancel_child: true,
    policy: b.policy, roles: b.roles, profileShas: b.profileShas, cliSha256: b.cliSha256, implHash: b.implHash, mcpTools: b.mcpTools,
    startedAt: new Date(Date.now() - 60000).toISOString(), jobs: acceptanceJobs(state, b), at: new Date().toISOString(), ...patch }));
}
h.run([
  ['v55: поручение до миграции/раннего return не меняет hold, claims и миграцию', async () => {
    // team-v56 А5: строгий барьер assertNoJobs использует installationBlockers → live.cards (не узкий running()).
    const live = require('../common/live-jobs'), running = live.running, cardsOrig = live.cards;
    const job = state => {
      const dir = path.join(state, 'codex-jobs', 'v55-running'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'result.txt'), 'рабочая папка без card.json');
      fs.writeFileSync(dir + '.json', JSON.stringify({ id: 'v55-running', status: 'running', startedAt: new Date().toISOString() }));
    };
    // Без нового состояния; прежнее complete (ранний return); прежнее pending; гонка до begin под job_start.
    for (const mode of ['first', 'unsupported', 'complete', 'pending', 'race', 'race-old']) {
      const state = legacy(), d = deps(); let stops = 0, scans = 0, held = false, released = false;
      // team-v57 (ред.6): время загрузки в проверке установки подставляется ТОЛЬКО через внутреннюю зависимость deps.bootAt
      // (не через MOST_TEST_BOOT_AT). Загрузка заведомо раньше записи живой карточки — карточка не проходит по перезагрузке.
      d.bootAt = () => Date.parse('2000-01-01T00:00:00Z'); d.stop = async () => { stops++; };
      if (['complete', 'pending'].includes(mode)) {
        const op = await migration.install(state, source, deps());
        if (mode === 'complete') await migration.complete(state, op, async () => {}, deps());
      }
      if (mode === 'race-old') {
        fs.writeFileSync(path.join(state, 'restart-hold.json'), JSON.stringify({ id: 'old', runId: 'old', executor: { pid: 777, startedAt: '2020-01-01T00:00:00Z' } }));
        fs.writeFileSync(path.join(state, 'kimi-migration.json'), JSON.stringify({ status: 'complete' }));
      }
      const watch = ['restart-hold.json', 'kimi-migration.json', 'members.json', 'members.json.last-good', 'members-log.jsonl'];
      const bytes = () => watch.map(n => { const p = path.join(state, n); return fs.existsSync(p) ? fs.readFileSync(p).toString('hex') : null; });
      const claims = () => fs.existsSync(path.join(state, 'restart-claims')) ? fs.readdirSync(path.join(state, 'restart-claims')).map(n => [n, fs.readFileSync(path.join(state, 'restart-claims', n)).toString('hex')]) : [];
      const before = bytes(), beforeClaims = claims();
      if (mode.startsWith('race')) d.hold = { ...d.hold, waitLock: async (...args) => {
        assert.equal(args[0], 'job_start'); assert.equal(args[1], 'all');
        const l = await require('../common/locks').waitLock(...args); assert(l.ok); held = true; job(state);
        return { ...l, release: async () => { held = false; released = true; await l.release(); } };
      } };
      else job(state);
      live.cards = options => { scans++; if (mode.startsWith('race') && scans === 2) assert(held); return cardsOrig(options); };
      try {
        await assert.rejects(migration.install(state, mode === 'unsupported' ? f.root : source, d), /идут поручения: codex v55-runn/);
        assert.equal(stops, 0); assert.deepEqual(bytes(), before); assert.deepEqual(claims(), beforeClaims);
        if (mode.startsWith('race')) { assert.equal(scans, 2); assert(released); }
      } finally { live.cards = cardsOrig; live.running = running; }
    }
  }],
  ['defaults A: paused/manual, не активен, но сервер/схемы/сканирование присутствуют', () => {
    assert(members.paused('kimi')); assert.equal(members.paused(undefined), false); assert.equal(members.paused('missing'), false);
    assert(!members.active().some(m => m.id === 'kimi')); assert(!members.requiredVoters().some(m => m.id === 'kimi'));
    assert(members.installedServers.includes('kimi')); assert(members.knownSeatIds.includes('kimi')); assert(members.knownVoterFamilies.includes('moonshot')); assert(members.scanIds.includes('kimi')); assert(members.recipientPaused('kimi'));
  }],
  ['A→B→C: пауза остаётся; resume возвращает, чужие исторические права не меняются', () => {
    for (const phase of ['B', 'C', 'A']) {
      f.store.update(f.store.read().rev, () => {}, meta, { phase }); assert(members.paused('kimi')); assert(members.installedServers.includes('kimi'));
      f.active(); assert(members.active().some(m => m.id === 'kimi')); assert(members.requiredVoters().some(m => m.id === 'kimi')); assert(!members.recipientPaused('kimi')); f.active(false);
    }
    assert(!members.effective(members.get('deepseek')).roles.receives); assert(members.get('codex').roles.sends);
  }],
  ['миграция expected_rev, before/журнал, идемпотентность; removed не воскресает', () => {
    const state = legacy(), store = require('../common/members-store').create(state); assert.throws(() => migration.apply(state, 99), /Редакция/);
    assert(migration.apply(state, 0)); const now = store.read(); assert.equal(now.phase, 'A'); assert.equal(now.members.find(m => m.id === 'kimi').state, 'paused');
    assert(!migration.apply(state, now.rev)); assert(store.history().some(e => e.action === 'team-v56-kimi' && !e.before.members.some(m => m.id === 'kimi')));
    store.update(now.rev, n => { n.members.find(m => m.id === 'kimi').state = 'removed'; }, meta); assert(!migration.apply(state)); assert.equal(store.read().members.find(m => m.id === 'kimi').state, 'removed');
    const masks = store.read().members.find(m => m.id === 'antigravity').mcp_allow; assert(migration.MASKS.every(m => masks.includes(m))); assert(!masks.includes('kimi/kimi_cancel'));
  }],
  ['журнал с kimi-cli запрещает старый rollback после удаления из снимка', () => {
    const state = legacy(), store = require('../common/members-store').create(state); migration.apply(state);
    store.update(store.read().rev, n => { n.members = n.members.filter(m => m.id !== 'kimi'); }, meta);
    assert(migration.recorded(state)); const old = path.join(f.root, 'old'); fs.mkdirSync(path.join(old, 'common'), { recursive: true }); fs.writeFileSync(path.join(old, 'common/members-store.js'), '// old');
    assert.throws(() => require('../common/members-rollback').assert(state, [old]), /kimi-cli/); assert.doesNotThrow(() => require('../common/members-rollback').assert(state, [source]));
    migration.apply(state); assert(!store.read().members.some(m => m.id === 'kimi'));
  }],
  ['сбой шагов stop/migrate: hold переживает смерть установщика; восстановление новым кодом', async () => {
    for (const fault of ['kimi-stop', 'kimi-migrate']) {
      const state = legacy(), d = deps({ hook: name => { if (name === fault) throw Error('test fault'); } });
      await assert.rejects(() => migration.install(state, source, d), /restart-hold сохранён/);
      assert(migration.pending(state)); const hold = require('../common/restart-hold'); assert.equal(hold.resolved(state, { fingerprint: () => null }), false);
      assert.throws(() => hold.assertAdmitted(state, {}), /Миграция Kimi/);
      const op = await migration.install(state, source, deps()); assert(op); assert.equal(require('../common/members-store').create(state).read().members.find(m => m.id === 'kimi').state, 'paused');
      let ready = false; await migration.complete(state, op, async () => { ready = true; }, deps()); assert(ready); assert(!migration.pending(state));
    }
  }],
  ['сбой после миграции/готовности не освобождает hold; аварийная пауза сохраняет историю', async () => {
    const state = legacy(), op = await migration.install(state, source, deps()); const store = require('../common/members-store').create(state);
    const history = store.history().length;
    await assert.rejects(() => migration.complete(state, op, async () => { throw Error('ready failure'); }, deps()), /ready failure/); assert(migration.pending(state));
    migration.emergencyPause(state); assert(store.history().length >= history); assert(store.read().members.filter(m => m.id !== 'kimi').every(m => m.state === 'active'));
    await migration.complete(state, op, async () => {}, deps()); assert(!migration.pending(state));
  }],
  ['неподтверждённое дерево старого сервера блокирует публикацию', async () => {
    const state = legacy(), p = { pid: 777, ppid: 1, name: 'node.exe', cmd: 'node fixture.js', startedAt: '2026-01-01T00:00:00Z' }; fs.mkdirSync(path.join(state, 'restart-servers')); fs.writeFileSync(path.join(state, 'restart-servers/777.json'), JSON.stringify({ process: p }));
    await assert.rejects(() => migration.install(state, source, deps({ processTable: async () => [self(), p], stop: async () => {} })), /Остановка старых деревьев/);
    assert(!require('../common/members-store').create(state).read().members.some(m => m.id === 'kimi'));
  }],
  ['целевой снимок включает v46, сохраняет фазу; сбой после активации и аварийная пауза допускают повтор', async () => {
    const state = legacy(), store = require('../common/members-store').create(state);
    migration.apply(state); store.update(store.read().rev, n => { const k = n.members.find(m => m.id === 'kimi'); k.state = 'active'; k.pause = null; }, meta);
    const d = deps(), op = await migration.install(state, source, d);
    const target = store.read({ initialize: false });
    assert.equal(migration.digest(target), migration.digest(d.proof.targetRoster));
    assert.equal(target.phase, op.before.phase);
    assert.equal(require('../common/members-v46').apply(state, 'forward'), false, 'после Kimi нет отдельной штатной ревизии v46');
    const activation = migration.activation(state, target, source);
    if (activation.rev !== target.rev) store.update(target.rev, n => { n.members = activation.members; }, meta, { phase: activation.phase });
    assert.equal(store.read().phase, require('../common/install-phase').phase);
    migration.failed(state, op, Error('config1 fault'));
    const paused = store.read({ initialize: false }); assert.equal(paused.members.find(m => m.id === 'kimi').state, 'paused'); assert(paused.rev > target.rev);
    const resumed = await migration.install(state, source, deps());
    assert.equal(migration.digest(store.read({ initialize: false })), migration.digest(paused));
    await migration.complete(state, resumed, async () => {}, deps()); assert(!migration.pending(state));
  }],
  ['фазовый after фиксируется до update; сбой до или после записи допускает точный повтор', async () => {
    for (const published of [false, true]) {
      const state = legacy(), store = require('../common/members-store').create(state), op = await migration.install(state, source, deps());
      const current = store.read(), next = migration.activation(state, current, source);
      assert(next.rev > current.rev);
      if (published) store.update(current.rev, n => { n.members = next.members; }, meta, { phase: next.phase });
      migration.failed(state, op, Error('phase fault'));
      const resumed = await migration.install(state, source, deps()), now = store.read(), wanted = migration.activation(state, now, source);
      if (wanted.rev !== now.rev) store.update(now.rev, n => { n.members = wanted.members; }, meta, { phase: wanted.phase });
      await migration.complete(state, resumed, async () => {}, deps()); assert(!migration.pending(state));
      assert.equal(store.read().phase, require('../common/install-phase').phase);
    }
  }],
  ['чужая правка после публикации не становится допустимым after операции', async () => {
    const state = legacy(), op = await migration.install(state, source, deps()), store = require('../common/members-store').create(state);
    store.update(store.read().rev, n => { n.members.find(m => m.id === 'codex').specialization += ' changed'; }, meta);
    await assert.rejects(() => migration.complete(state, op, async () => {}, deps()), /не соответствует операции/);
    await assert.rejects(() => migration.install(state, source, deps()), /не результат данной миграции/);
    assert(migration.pending(state));
  }],
  ['отсутствующий реестр: обрыв init или публикации target восстанавливается из точного журнала', async () => {
    for (const failAt of [1, 2]) {
      const state = path.join(f.root, 'empty-' + ++seq); fs.mkdirSync(state); latestLegacy = state;
      const d = deps(); d.proof.sourceRegistryAbsent = true;
      const rename = fs.renameSync; let count = 0;
      fs.renameSync = (from, to) => { if (to === path.join(state, 'members.json.last-good') && ++count === failAt) throw Error('injected publish fault'); return rename(from, to); };
      try { await assert.rejects(() => migration.install(state, source, d), /injected publish fault/); } finally { fs.renameSync = rename; }
      assert(migration.pending(state));
      const saved = JSON.parse(fs.readFileSync(path.join(state, 'kimi-migration.json'), 'utf8'));
      const store = require('../common/members-store').create(state);
      assert.equal(migration.digest(store.history()[0].after), migration.digest(saved.before));
      const op = await migration.install(state, source, deps());
      await migration.complete(state, op, async () => {}, deps()); assert(!migration.pending(state));
      assert.equal(migration.digest(store.read({ initialize: false })), migration.digest(op.targetRoster));
    }
  }],
  ['сбой записи complete или снятия hold оставляет восстановимую операцию', async () => {
    for (const fault of ['complete', 'abort']) {
      const state = legacy(), op = await migration.install(state, source, deps());
      const atomic = require('../common/team-git').atomic; let thrown = false;
      if (fault === 'complete') require('../common/team-git').atomic = (file, text) => { if (!thrown && file === path.join(state, 'kimi-migration.json') && JSON.parse(text).status === 'complete') { thrown = true; throw Error('injected complete fault'); } return atomic(file, text); };
      try { await assert.rejects(() => migration.complete(state, op, async () => {}, fault === 'abort' ? deps({ hold: { waitLock: async () => ({ ok: false }) } }) : deps()), /complete fault|замок запуска/); }
      finally { require('../common/team-git').atomic = atomic; }
      assert(migration.pending(state)); assert.equal(require('../common/restart-hold').resolved(state, { fingerprint: () => null }), false);
      const resumed = await migration.install(state, source, deps());
      await migration.complete(state, resumed, async () => {}, deps()); assert(!migration.pending(state));
    }
  }],
  ['team и гостевые серверы без restart-маркеров обнаруживаются по команде, другой root сохраняется', async () => {
    const state = legacy(), root = path.dirname(state), stopped = [];
    const row = (pid, folder, name) => ({ pid, ppid: 1, name: 'node.exe', startedAt: '2026-01-01T00:00:00Z', cmd: '"' + process.execPath + '" "' + path.join(folder, 'live', 'a'.repeat(40), 'servers', name, 'index.js') + '"' });
    let rows = [self(), row(701, root, 'team'), row(702, root, 'codex'), row(703, path.join(path.dirname(f.root), 'unrelated-' + seq), 'team')];
    await migration.stopServers(state, { processTable: async () => rows, stop: async pid => { stopped.push(pid); rows = rows.filter(p => p.pid !== pid); } });
    assert.deepEqual(stopped, [701, 702]); assert(rows.some(p => p.pid === 703));
  }],
  ['повторно открытый сервер и неполный снимок не дают публиковать реестр', async () => {
    const state = legacy(), old = { pid: 711, ppid: 1, name: 'node.exe', startedAt: '2026-01-01T00:00:00Z', cmd: 'node "' + path.join(path.dirname(state), 'live', 'a'.repeat(40), 'servers/team/index.js') + '"' };
    let rows = [self(), old];
    await assert.rejects(() => migration.install(state, source, deps({ processTable: async () => rows, stop: async () => { rows = [self(), { ...old, pid: 712 }]; } })), /Остановка старых деревьев/);
    assert(!migration.recorded(state));
    for (const broken of [[], [{ ...self(), cmd: null }], [self(), { pid: 713, ppid: 1, name: 'node.exe', cmd: 'node servers/team/index.js', startedAt: old.startedAt }]])
      await assert.rejects(() => migration.stopServers(state, { processTable: async () => broken }), /снимок|команда|команды|команда\/отпечаток|Относительная/);
  }],
  ['последняя проверка перед migrate замечает новый сервер после успешного stop', async () => {
    const state = legacy(), fresh = { pid: 721, ppid: 1, name: 'node.exe', startedAt: '2026-01-01T00:00:00Z', cmd: 'node "' + path.join(path.dirname(state), 'live', 'a'.repeat(40), 'servers/team/index.js') + '"' };
    let spawned = false;
    await assert.rejects(() => migration.install(state, source, deps({ processTable: async () => spawned ? [self(), fresh] : [self()], hook: name => { if (name === 'kimi-migrate') spawned = true; } })), /Остановка старых деревьев/);
    assert(!migration.recorded(state));
  }],
  ['A→B: финальная проба обновляет состав marker; повтор без миграции сохраняет метку', async () => {
    const root = path.join(f.root, 'phase-marker'), state = path.join(root, 'state'); fs.mkdirSync(root);
    const store = require('../common/members-store').create(state), initial = require('../common/members-default')();
    initial.members = initial.members.filter(m => m.id !== 'kimi'); store.read({ initialRoster: initial });
    const expected = members.serversForInstall(migration.installTarget(state, store.read(), source));
    const fixture = require('./fixtures/team-v43/fixture'), release = fixture.release(root, 'b'.repeat(40), { servers: expected, installPhase: 'B', installed: false });
    fixture.write(path.join(release, 'servers/deepseek/index.js'), '// подставной сервер');
    const config = path.join(root, 'config.json'); fixture.json(config, {});
    const marker = path.join(release, 'probe-ok.json'), original = JSON.parse(fs.readFileSync(marker, 'utf8')); assert(!original.servers.includes('deepseek'));
    let probes = 0;
    const dep = { probe: async () => { probes++; }, kimi: { processTable: async () => [self()], hold: { fingerprint: pid => ({ pid, startedAt: new Date().toISOString() }) } } };
    const deploy = require('../common/deploy'), options = { root, release, configs: [config] };
    await deploy.configure(options, dep);
    assert(probes > 0); assert.equal(store.read().phase, 'B'); assert(!migration.pending(state));
    const installed = fs.readFileSync(marker, 'utf8'); assert(JSON.parse(installed).servers.includes('deepseek'));
    const count = probes;
    await deploy.configure(options, dep); // Включает verifiedRelease на уже установленной фазе B.
    assert.equal(probes, count); assert.equal(fs.readFileSync(marker, 'utf8'), installed);
    const op = JSON.parse(fs.readFileSync(path.join(state, 'kimi-migration.json'), 'utf8'));
    assert.equal(op.targetRoster.phase, 'A'); assert.equal(op.activationRoster.phase, 'B');
  }],
  ['техническая MCP-проба Kimi на паузе не запускает CLI', async () => {
    const c = await h.client(f); try { assert.equal((await c.listTools()).tools.length, 4); const r = await c.callTool({ name: 'kimi_status', arguments: {} }); assert.match(h.text(r), /квота неизвестна/); assert(!fs.existsSync(process.env.MOST_KIMI_WORK_ROOT)); } finally { await c.close(); }
  }],
  ['маски и подключения входящего сервера динамические, формата клиента Kimi нет', () => {
    const agy = require('../common/agy-tools'); for (const name of ['kimi_send', 'kimi_result', 'kimi_status']) assert(agy.allowed({ name }, ['kimi/' + name])); assert(agy.forbidden({ name: 'kimi_send' }, []));
    assert(!require('../common/member-clients').all().some(c => c.id === 'kimi'));
    const yaml = require('../common/dsh-config').render('', source, f.root, process.execPath); assert.match(yaml, /serverName: kimi|"serverName":\s*"kimi"/);
  }],
  ['А5/И2/И3: без приёмки нет ни writer, ни sends; приёмка даёт права и снимает исходную паузу; поздняя/ручная пауза сохраняется; смена CLI отзывает права', () => {
    // 1) И2 (ревью Kimi 2): БЕЗ живой приёмки А3 миграция НЕ включает ни writer, ни sends; Kimi остаётся на паузе.
    const state = legacy(), store = require('../common/members-store').create(state), before = store.read().rev;
    assert(migration.apply(state, before));
    let k = store.read().members.find(m => m.id === 'kimi');
    assert.equal(k.roles.writer, false, 'writer выключен до приёмки'); assert.equal(k.roles.sends, false, 'sends выключен до приёмки');
    assert.equal(k.roles.voter, true); assert.equal(k.roles.receives, true);
    assert.equal(k.state, 'paused'); assert.equal(k.pause.kind, 'manual');
    assert(!migration.apply(state, store.read().rev), 'идемпотентно без приёмки');
    const t0 = migration.installTarget(state, store.read(), source).members.find(m => m.id === 'kimi');
    assert.equal(t0.roles.writer, false); assert.equal(t0.roles.sends, false); assert.equal(t0.state, 'paused');
    // 2) Появилась живая приёмка А3 (привязана к хешам кандидата) → миграция включает writer+sends и снимает исходную паузу,
    // кладя в журнал основание (id/rev события-основания).
    writeAcceptance(state);
    assert(migration.apply(state, store.read().rev), 'приёмка даёт изменение: writer+sends + активность');
    k = store.read().members.find(m => m.id === 'kimi');
    assert.equal(k.roles.writer, true, 'writer включён после приёмки'); assert.equal(k.roles.sends, true, 'sends включён после приёмки');
    assert.equal(k.state, 'active', 'исходная пауза снята'); assert.equal(k.pause, null);
    const ev = store.history().at(-1); assert(ev.pauseRemovalBasis && Number.isInteger(ev.pauseRemovalBasis.rev), 'основание снятия паузы в журнале');
    assert(!migration.apply(state, store.read().rev), 'идемпотентно после активации');
    // 3) Поздняя ручная пауза (после авто-добавления Kimi) сохраняется: приёмка её не снимает, но права-способности включаются.
    const state2 = legacy(), store2 = require('../common/members-store').create(state2);
    assert(migration.apply(state2, store2.read().rev));
    store2.update(store2.read().rev, n => { const m = n.members.find(x => x.id === 'kimi'); m.state = 'paused'; m.pause = { kind: 'manual', scope: 'participant', since: new Date(Date.now() + 1000).toISOString(), until: null, next_probe: null }; }, { action: 'team_word', who: 'user', reason: 'ручная пауза Kimi' });
    writeAcceptance(state2); migration.apply(state2, store2.read().rev);
    const k2 = store2.read().members.find(m => m.id === 'kimi');
    assert.equal(k2.state, 'paused', 'поздняя ручная пауза сохранена, несмотря на приёмку'); assert.equal(k2.roles.sends, true, 'sends как способность всё же включён');
    // 3b) И3 (ревью Codex 6): Kimi ДОБАВЛЕН вручную (не авто-миграцией) сразу на паузе — приёмка его не активирует НИКОГДА.
    const state3b = legacy(), store3b = require('../common/members-store').create(state3b);
    store3b.update(store3b.read().rev, n => { n.members.push(migration.member()); }, { action: 'team_word', who: 'user', reason: 'ручное добавление Kimi на паузе' });
    writeAcceptance(state3b);
    migration.apply(state3b, store3b.read().rev);
    const k3b = store3b.read().members.find(m => m.id === 'kimi');
    assert.equal(k3b.state, 'paused', 'ручной добавленный Kimi приёмкой не активируется (не авто-миграция)');
    assert.equal(migration.originalPauseRemovable(store3b).ok, false, 'ручное добавление — пауза не снимается');
    // 4) И1: непривязанная/поддельная приёмка (probe, чужая версия, неполные шаги, cliSha256=null/чужой, implHash/mcpTools/jobs) активацию не даёт.
    const state3 = legacy(), store3 = require('../common/members-store').create(state3);
    assert(migration.apply(state3, store3.read().rev));
    for (const bad of [{ probe: true }, { policy: 'kimi-material-v0' }, { team_ask: false }, { roles: { writer: true, sends: false } },
        { cliSha256: null }, { cliSha256: '0'.repeat(64) }, { implHash: 'подделка' }, { mcpTools: [] }, { profileShas: {} }, { jobs: {} }, { jobs: { send: 'нет-карточки', result: 'нет', team_ask: 'нет', cancel_child: 'нет' } }]) {
      writeAcceptance(state3, bad); assert(!migration.apply(state3, store3.read().rev), 'непривязанная приёмка не активирует: ' + JSON.stringify(bad));
      assert.equal(store3.read().members.find(m => m.id === 'kimi').state, 'paused');
      assert.equal(migration.acceptance(state3), null, 'acceptance() отвергает: ' + JSON.stringify(bad));
    }
    // 4a) К3 (ревью Kimi 1 круг 3): каждая ссылка привязана к фактической операции по следам моста (from/parentJob/delegations,
    // завершение+результат, отмена+stopConfirmed, inbox-ответ). Корректный набор — действителен; реюз и посторонняя карточка — нет.
    writeAcceptance(state3); assert(migration.acceptance(state3), 'корректный набор ссылок приёмки действителен');
    const good = JSON.parse(fs.readFileSync(migration.acceptanceFile(state3), 'utf8')).jobs;
    // Одна завершённая карточка во всех полях — недействительна: result(done)/cancel_child(cancelled)/team_ask(inbox) различимы по роли.
    writeAcceptance(state3, { jobs: { send: good.result, result: good.result, team_ask: good.result, cancel_child: good.result } });
    assert.equal(migration.acceptance(state3), null, 'одна карточка во все поля — недействительна');
    // Посторонняя завершённая карточка независимого ревью Kimi (своё поручение, from=claude, без делегаций) — не исходящее Kimi.
    const revId = 'acc-review-' + (++seq), rd = path.join(state3, 'kimi-jobs', revId); fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, revId + '.result.txt'), 'ПРИНЯТО');
    fs.writeFileSync(path.join(rd, 'card.json'), JSON.stringify({ id: revId, status: 'done', from: 'claude', voteEligible: true, outgoingVerified: true, delegations: [], finishedAt: new Date().toISOString(), exitCode: 0, resultFile: revId + '.result.txt' }));
    writeAcceptance(state3, { jobs: { ...good, send: revId } });
    assert.equal(migration.acceptance(state3), null, 'посторонняя завершённая карточка ревью в поле send — недействительна');
    // 4a') Л1 (ревью Kimi круг 4): ссылки привязаны к ТЕКУЩЕЙ приёмке (CLI/реализация/время начала). Патчим карточку
    // родителя приёмки и проверяем, что каждая развязка делает приёмку null.
    writeAcceptance(state3); assert(migration.acceptance(state3), 'корректный набор с привязкой и следом действителен');
    const recL = JSON.parse(fs.readFileSync(migration.acceptanceFile(state3), 'utf8'));
    const cFile = path.join(state3, 'codex-jobs', recL.jobs.send + '.json'), cOrig = fs.readFileSync(cFile, 'utf8');
    const childOfSend = JSON.parse(cOrig);
    const pFile = path.join(state3, 'kimi-jobs', childOfSend.parentJob, 'card.json'), pOrig = fs.readFileSync(pFile, 'utf8');
    const patchParent = patch => { const pc = JSON.parse(pOrig); Object.assign(pc, patch); fs.writeFileSync(pFile, JSON.stringify(pc)); };
    patchParent({ cli: { path: 'kimi', sha256: '0'.repeat(64) } }); assert.equal(migration.acceptance(state3), null, 'Л1: операция при другой привязке CLI недействительна');
    patchParent({ implHash: 'подделка' }); assert.equal(migration.acceptance(state3), null, 'Л1: операция при другой реализации недействительна');
    patchParent({ startedAt: new Date(Date.parse(recL.startedAt) - 1000).toISOString() }); assert.equal(migration.acceptance(state3), null, 'Л1: операция до начала приёмки недействительна');
    fs.writeFileSync(pFile, pOrig); assert(migration.acceptance(state3), 'восстановленная привязка снова действительна');
    // 4a'') Л2 (ревью круг 5, М1): result действителен ТОЛЬКО по отметке ВЫДАЧИ готового результата этому родителю в карточке
    // ПОТОМКА (resultDeliveries { to, at ≥ finishedAt, sha }). Патчим карточку потомка и проверяем сценарии замечания.
    const childFin = childOfSend.finishedAt, parentId = childOfSend.parentJob;
    const childSha = launch.sha(fs.readFileSync(path.join(state3, 'codex-jobs', childOfSend.resultFile), 'utf8'));
    const patchChild = dels => { const cc = JSON.parse(cOrig); cc.resultDeliveries = dels; fs.writeFileSync(cFile, JSON.stringify(cc)); };
    const goodAt = new Date(Date.parse(childFin) + 1000).toISOString();
    // Ранний вызов «ещё работает»/ошибка/нет повторного запроса → отметки выдачи нет → недействительна.
    patchChild([]); assert.equal(migration.acceptance(state3), null, 'Л2: потомок завершён, но готовый результат родителю не выдан — недействительна');
    patchChild(undefined); assert.equal(migration.acceptance(state3), null, 'Л2: без отметки выдачи — недействительна');
    // Выдано ДРУГОМУ родителю → недействительна.
    patchChild([{ to: 'иной-родитель', at: goodAt, sha256: childSha }]); assert.equal(migration.acceptance(state3), null, 'Л2: результат выдан другому родителю — недействительна');
    // Выдача раньше завершения потомка → недействительна.
    patchChild([{ to: parentId, at: new Date(Date.parse(childFin) - 1000).toISOString(), sha256: childSha }]); assert.equal(migration.acceptance(state3), null, 'Л2: выдача раньше finishedAt потомка — недействительна');
    // sha не совпадает с текущим результатом карточки (результат заменён позже) → недействительна.
    patchChild([{ to: parentId, at: goodAt, sha256: '0'.repeat(64) }]); assert.equal(migration.acceptance(state3), null, 'Л2: sha отметки не совпадает с результатом карточки — недействительна');
    // Готовый результат выдан этому родителю после завершения потомка, sha совпадает → действительна.
    patchChild([{ to: parentId, at: goodAt, sha256: childSha }]); assert(migration.acceptance(state3), 'Л2: результат выдан родителю после завершения потомка — действительна');
    fs.writeFileSync(cFile, cOrig); assert(migration.acceptance(state3), 'восстановленная отметка выдачи снова действительна');
    // 4b) И1а: нет CLI (identity бросает) → приёмка недействительна при любом содержимом файла.
    writeAcceptance(state3);
    const prevPath = f.store.read().members.find(m => m.id === 'kimi').adapter_params.path;
    f.store.update(f.store.read().rev, n => { n.members.find(m => m.id === 'kimi').adapter_params.path = path.join(f.root, 'нет-такого-cli.bin'); }, meta);
    try { assert.equal(migration.acceptance(state3), null, 'без CLI приёмка недействительна'); }
    finally { f.store.update(f.store.read().rev, n => { n.members.find(m => m.id === 'kimi').adapter_params.path = prevPath; }, meta); }
    // 5) И2-матрица: смена CLI инвалидирует приёмку → ранее включённые writer/sends отзываются.
    const state5 = legacy(), store5 = require('../common/members-store').create(state5);
    assert(migration.apply(state5, store5.read().rev)); writeAcceptance(state5); assert(migration.apply(state5, store5.read().rev));
    let k5 = store5.read().members.find(m => m.id === 'kimi');
    assert.equal(k5.roles.writer, true); assert.equal(k5.roles.sends, true); assert.equal(k5.state, 'active');
    const otherBin = path.join(f.root, 'kimi-other.bin'); fs.writeFileSync(otherBin, 'OTHER-KIMI-BINARY');
    f.store.update(f.store.read().rev, n => { n.members.find(m => m.id === 'kimi').adapter_params.path = otherBin; }, meta);
    try {
      assert.equal(migration.acceptance(state5), null, 'приёмка недействительна при смене CLI');
      assert(migration.apply(state5, store5.read().rev), 'смена CLI меняет снимок (отзыв прав)');
      k5 = store5.read().members.find(m => m.id === 'kimi');
      assert.equal(k5.roles.writer, false, 'writer отозван при смене CLI'); assert.equal(k5.roles.sends, false, 'sends отозван при смене CLI');
    } finally { f.store.update(f.store.read().rev, n => { n.members.find(m => m.id === 'kimi').adapter_params.path = kimiBin; }, meta); }
  }],
  ['А5 барьер installationBlockers: старые завершённые карточки Codex/Claude/DeepSeek без stopConfirmed не блокируют; флаги/статусы/lost/сирота блокируют', () => {
    const state = legacy();
    const save = (store, id, card, resultText) => { const dir = path.join(state, store); fs.mkdirSync(dir, { recursive: true }); if (resultText !== undefined && card.resultFile) fs.writeFileSync(path.join(dir, card.resultFile), resultText); fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, ...card })); };
    // Положительные фикстуры: штатно завершённые done без нового атрибута stopConfirmed — проходят. team-v56 И6: resultFile
    // создаётся реальным читаемым файлом (а не просто непустой строкой); DeepSeek — с результатом попытки (inline).
    save('codex-jobs', 'codex-ok', { status: 'done', threadId: 't', finishedAt: new Date().toISOString(), exitCode: 0, resultFile: 'codex-ok.result.txt' }, 'итог Codex');
    save('claude-jobs', 'claude-k', { status: 'done', finishedAt: new Date().toISOString(), exitCode: 0, resultFile: 'claude-k.result.txt' }, 'итог Claude');
    save('deepseek-jobs', 'dsk-done', { status: 'done', sessionId: 's', finishedAt: new Date().toISOString(), exitCode: 0, result: 'r' });
    let b = migration.installationBlockers(state); assert.equal(b.running.length, 0); assert.deepEqual(b.blockers, [], b.blockers.join(';'));
    // Отрицательные парные: удержание папки, неподтверждённая остановка, активный статус, неизвестный статус.
    save('codex-jobs', 'codexhld', { status: 'done', holdsFolder: true });
    assert(migration.installationBlockers(state).blockers.some(x => x.includes('codexhld')), 'holdsFolder');
    save('claude-jobs', 'cl-uncnf', { status: 'done', stopUnconfirmed: { pid: 999999 } });
    assert(migration.installationBlockers(state).blockers.some(x => x.includes('cl-uncnf')), 'stopUnconfirmed');
    save('codex-jobs', 'codex-nd', { status: 'needs_decision', startedAt: new Date().toISOString() });
    assert(migration.installationBlockers(state).running.some(r => r.id === 'codex-nd'), 'needs_decision');
    save('deepseek-jobs', 'ds-weird', { status: 'застрял' });
    assert(migration.installationBlockers(state).blockers.some(x => x.includes('ds-weird') && x.includes('неизвестный статус')), 'unknown status');
    // team-v56 (ревью Kimi №8/Codex №3): «голый» done без признаков завершения своего адаптера — блокируется (id в
    // сообщении усечён до 8 знаков, поэтому идентификаторы фикстур берём длиной 8).
    save('codex-jobs', 'codxbare', { status: 'done' });
    assert(migration.installationBlockers(state).blockers.some(x => x.includes('codxbare') && x.includes('без подтверждённого завершения')), 'done без завершения Codex');
    save('deepseek-jobs', 'dsnoresx', { status: 'done', sessionId: 's', finishedAt: new Date().toISOString(), exitCode: 0 });
    assert(migration.installationBlockers(state).blockers.some(x => x.includes('dsnoresx') && x.includes('без подтверждённого завершения')), 'done без результата DeepSeek');
    // team-v56 И6 (ревью Kimi 4): done с resultFile, которого нет на диске, — блокер; resultFile=каталог — блокер.
    save('codex-jobs', 'cdxnofil', { status: 'done', threadId: 't', finishedAt: new Date().toISOString(), exitCode: 0, resultFile: 'missing.txt' });
    assert(migration.installationBlockers(state).blockers.some(x => x.includes('cdxnofil') && x.includes('без подтверждённого завершения')), 'done с отсутствующим resultFile');
    fs.mkdirSync(path.join(state, 'claude-jobs', 'as-dir.txt'), { recursive: true });
    save('claude-jobs', 'cldirres', { status: 'done', finishedAt: new Date().toISOString(), exitCode: 0, resultFile: 'as-dir.txt' });
    assert(migration.installationBlockers(state).blockers.some(x => x.includes('cldirres') && x.includes('без подтверждённого завершения')), 'done с resultFile-каталогом');
    // team-v56 И5 (ревью Gemini-А 2): lost с действующим подтверждением остановки — допустимо (не «неизвестный статус»);
    // без подтверждения — блокер.
    save('deepseek-jobs', 'lostconf', { status: 'lost', stopConfirmed: { basis: 'процесс завершён; дерево отсутствует' } });
    const bl = migration.installationBlockers(state).blockers;
    assert(!bl.some(x => x.includes('lostconf')), 'lost с подтверждением остановки не блокирует: ' + bl.filter(x => x.includes('lostconf')).join(';'));
    save('claude-jobs', 'lostopen', { status: 'lost', startedAt: new Date().toISOString() });
    assert(migration.installationBlockers(state).blockers.some(x => x.includes('lostopen') && x.includes('lost без подтверждённой остановки')), 'lost без подтверждения блокирует');
  }],
  ['А5 барьер: замок записи без карточки блокирует при любом владельце (мёртвый/живой/непроверяемый); замок при терминальной карточке — неснятое удержание', () => {
    const wl = require('../common/write-lock'), paths = require('../common/paths'), crypto = require('crypto');
    const lockDir = wl.dir(); fs.mkdirSync(lockDir, { recursive: true });
    const folder = paths.canon(f.root), inst = crypto.randomUUID(), lf = wl.entryFile(folder + '-orphan-fix');
    fs.writeFileSync(lf, JSON.stringify({ folder, instance: inst, pid: 999999, jobId: 'orphan-nocard', since: new Date().toISOString() }));
    try { const b = migration.installationBlockers(f.state); assert(b.blockers.some(x => x.includes('осиротевший замок') && x.includes(inst)), b.blockers.join(';')); }
    finally { fs.unlinkSync(lf); }
    // team-v56 (ревью Kimi №8/Codex №3): замок без карточки — необъяснённое удержание и блокирует независимо от того, жив
    // ли владелец. Прежнее ожидание «живой владелец не сирота» было неверным разрешением (в окне lock→card установка
    // могла бы остановить сервер и оставить новый сиротский замок).
    const lf2 = wl.entryFile(folder + '-alive-fix'), instAlive = crypto.randomUUID();
    fs.writeFileSync(lf2, JSON.stringify({ folder, instance: instAlive, pid: process.pid, jobId: 'alive-nocard', since: new Date().toISOString() }));
    try { assert(migration.installationBlockers(f.state).blockers.some(x => x.includes('осиротевший замок') && x.includes(instAlive)), 'живой владелец без карточки блокирует (необъяснённое удержание)'); }
    finally { fs.unlinkSync(lf2); }
    // team-v56 И4 / team-v57 (ред.5): замок при ТЕРМИНАЛЬНОЙ карточке done/failed/cancelled — неснятое удержание, блокер.
    // А статус stop_confirmed — это слово пользователя на карточке: его замок НЕ мешает (passedByCardWord) — проверяем отдельно.
    const explDir = path.join(f.state, 'codex-jobs'); fs.mkdirSync(explDir, { recursive: true });
    fs.writeFileSync(path.join(explDir, 'expl-done.result.txt'), 'итог');
    for (const status of ['done', 'failed', 'cancelled']) {
      const cid = 'explt-' + status.slice(0, 3);
      fs.writeFileSync(path.join(explDir, cid + '.json'), JSON.stringify({ id: cid, status, threadId: 't', finishedAt: new Date().toISOString(), exitCode: 0, resultFile: 'expl-done.result.txt' }));
      const lf3 = wl.entryFile(folder + '-expl-' + status), instExpl = crypto.randomUUID();
      fs.writeFileSync(lf3, JSON.stringify({ folder, instance: instExpl, pid: process.pid, jobId: cid, since: new Date().toISOString() }));
      try { assert(migration.installationBlockers(f.state).blockers.some(x => x.includes('неснятый замок') && x.includes(instExpl) && x.includes(status)), 'замок при терминальной карточке (' + status + ') блокирует'); }
      finally { fs.unlinkSync(lf3); fs.unlinkSync(path.join(explDir, cid + '.json')); }
    }
    {
      const cid = 'explt-sc';
      fs.writeFileSync(path.join(explDir, cid + '.json'), JSON.stringify({ id: cid, status: 'stop_confirmed', finishedAt: new Date().toISOString() }));
      const lf3 = wl.entryFile(folder + '-expl-sc'), instSc = crypto.randomUUID();
      fs.writeFileSync(lf3, JSON.stringify({ folder, instance: instSc, pid: process.pid, jobId: cid, since: new Date().toISOString() }));
      try { const b = migration.installationBlockers(f.state); assert(!b.blockers.some(x => x.includes(instSc)) && b.passedByCardWord.some(p => p.instance === instSc), 'замок при карточке stop_confirmed (слово) не мешает (ред.5)'); }
      finally { fs.unlinkSync(lf3); fs.unlinkSync(path.join(explDir, cid + '.json')); }
    }
    fs.unlinkSync(path.join(explDir, 'expl-done.result.txt'));
    // team-v57 (ред.5) полный список: замок при идущей карточке — отдельная причина (не «сирота», а «при идущей карточке»);
    // живой владелец без слова и без перезагрузки держит.
    fs.writeFileSync(path.join(explDir, 'run-lock.json'), JSON.stringify({ id: 'run-lock', status: 'running', startedAt: new Date().toISOString() }));
    const lf4 = wl.entryFile(folder + '-run-fix'), instRun = crypto.randomUUID();
    fs.writeFileSync(lf4, JSON.stringify({ folder, instance: instRun, pid: process.pid, jobId: 'run-lock', since: new Date().toISOString() }));
    try { assert(migration.installationBlockers(f.state).blockers.some(x => x.includes(instRun) && x.includes('идущей')), 'замок при идущей карточке — отдельная причина полного списка'); }
    finally { fs.unlinkSync(lf4); fs.unlinkSync(path.join(explDir, 'run-lock.json')); }
    // team-v57 (ред.5): карточка 'lost' со СЛОВОМ пользователя (stopConfirmed.basis) проходит, и её замок записи тоже НЕ мешает
    // (замок при карточке, закрытой словом, не блокирует — слово владельца перекрывает проверку без условий). Без замка — тоже
    // не блокирует. Замок попадает в passedByCardWord с основанием.
    fs.writeFileSync(path.join(explDir, 'lostlk1.json'), JSON.stringify({ id: 'lostlk1', status: 'lost', stopConfirmed: { basis: 'процесс завершён; дерево отсутствует' } }));
    assert(!migration.installationBlockers(f.state).blockers.some(x => x.includes('lostlk1')), 'lost со stopConfirmed без замка не блокирует');
    const lfL = wl.entryFile(folder + '-lostlk1'), instL = crypto.randomUUID();
    fs.writeFileSync(lfL, JSON.stringify({ folder, instance: instL, pid: process.pid, jobId: 'lostlk1', since: new Date().toISOString() }));
    try {
      const bL = migration.installationBlockers(f.state);
      assert(!bL.blockers.some(x => x.includes(instL)), 'замок при карточке lost со словом пользователя НЕ блокирует (ред.5)');
      assert(bL.passedByCardWord.some(p => p.kind === 'lock' && p.instance === instL), 'замок при карточке со словом — в passedByCardWord');
    }
    finally { fs.unlinkSync(lfL); fs.unlinkSync(path.join(explDir, 'lostlk1.json')); }
  }],
  ['team-v57 (ред.5) слово на карточке БЕЗ условий на PID снимает карточку с барьера; пустой basis словом не считается', () => {
    const ops = require('../common/deploy-ops');
    const state = legacy();
    const boot = '2026-06-01T00:00:00Z', after = new Date('2026-12-01T00:00:00Z');
    const put = (store, id, card, mtime) => {
      const dir = path.join(state, store); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, id + '.json'); fs.writeFileSync(file, JSON.stringify({ id, ...card }));
      if (mtime !== undefined) fs.utimesSync(file, mtime, mtime);
      return id;
    };
    const word = { basis: 'слово пользователя', at: after.toISOString() };
    const run = () => migration.installationBlockers(state, { bootAt: () => Date.parse(boot) });
    const blocks = (b, id) => b.running.some(r => r.id === id) || b.blockers.some(x => x.includes(id));
    assert.equal(ops.alive(4), null, 'нужен непроверяемый положительный PID (alive===null)');
    // ПРОХОДЯТ по слову на карточке. Запись ПОЗЖЕ загрузки — чтобы доказать, что проходят именно по слову, не по перезагрузке.
    // Без каких-либо условий на PID: живой (process.pid), непроверяемый (4), мёртвый (999999) и вовсе без PID.
    const pWord = [
      put('codex-jobs', 'w_nd', { status: 'needs_decision', stopConfirmed: word }, after),
      put('claude-jobs', 'w_su', { status: 'stop_unconfirmed', stopUnconfirmed: { pid: 999999 }, stopConfirmed: word }, after),
      put('codex-jobs', 'w_runa', { status: 'running', pid: process.pid, stopConfirmed: word }, after), // живой PID — всё равно проходит
      put('codex-jobs', 'w_runu', { status: 'running', pid: 4, stopConfirmed: word }, after), // непроверяемый PID — проходит
      put('codex-jobs', 'w_cing', { status: 'cancelling', holdsFolder: true, pid: process.pid, stopConfirmed: word }, after),
      put('deepseek-jobs', 'w_cxl', { status: 'cancelled', treeWarning: true, pid: process.pid, stopConfirmed: word }, after),
      put('deepseek-jobs', 'w_fail', { status: 'failed', treeWarning: true, stopConfirmed: word }, after),
      put('codex-jobs', 'w_hold', { status: 'needs_decision', holdsFolder: true, stopConfirmed: word }, after),
      put('codex-jobs', 'w_lost', { status: 'lost', pid: process.pid, stopConfirmed: word }, after),
      put('codex-jobs', 'w_sc', { status: 'stop_confirmed', holdsFolder: true }, after), // статус stop_confirmed — слово по статусу (флаг снимается им же)
    ];
    // Пустой/пробельный basis словом не считается — блокирует как раньше.
    put('codex-jobs', 'e_run', { status: 'running', stopConfirmed: { basis: '   ' } }, after);
    put('codex-jobs', 'e_lost', { status: 'lost', stopConfirmed: { basis: '' } }, after);
    const b = run();
    for (const id of pWord) {
      assert(!blocks(b, id), 'слово на карточке снимает с барьера: ' + id + ' — ' + b.blockers.filter(x => x.includes(id)).join('|'));
      assert(b.passedByCardWord.some(p => p.kind === 'card' && p.id === id), id + ' — в passedByCardWord');
    }
    assert(b.running.some(r => r.id === 'e_run'), 'пустой basis (пробелы) словом не считается — running');
    assert(b.blockers.some(x => x.includes('e_lost') && x.includes('lost без подтверждённой')), 'пустой basis словом не считается — lost блокирует');
  }],
  ['team-v57 (ред.5) перезагрузка снимает карточку без слова по времени записи; границы boot/mtime; неизвестный статус и неполный done — только общим словом', () => {
    const state = legacy();
    const boot = '2026-06-01T00:00:00Z', before = new Date('2026-01-01T00:00:00Z'), after = new Date('2026-12-01T00:00:00Z');
    const bootMs = Date.parse(boot);
    const put = (store, id, card, mtime) => {
      const dir = path.join(state, store); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, id + '.json'); fs.writeFileSync(file, JSON.stringify({ id, ...card }));
      if (mtime !== undefined) fs.utimesSync(file, mtime, mtime);
      return id;
    };
    const run = (bt = () => Date.parse(boot)) => migration.installationBlockers(state, { bootAt: bt });
    const blocks = (b, id) => b.running.some(r => r.id === id) || b.blockers.some(x => x.includes(id));
    // Записаны РАНЬШЕ загрузки, без слова — проходят по перезагрузке.
    const pBoot = [
      put('codex-jobs', 'r_run', { status: 'running' }, before),
      put('claude-jobs', 'r_su', { status: 'stop_unconfirmed' }, before),
      put('codex-jobs', 'r_lost', { status: 'lost' }, before),
      put('codex-jobs', 'r_q', { status: 'queued' }, before),
    ];
    put('codex-jobs', 'o_after', { status: 'running' }, after); // записана позже загрузки — держит
    put('codex-jobs', 'o_mt0', { status: 'running' }, 0); // время записи 0 (сбой stat) — держит
    put('grok-jobs', 'o_hist', { status: 'running', createdAt: '2026-01-01T00:00:00Z' }, after); // историческая без слова позже загрузки — держит
    put('codex-jobs', 'o_weird', { status: 'застрял' }, before); // неизвестный статус раньше загрузки — держит (перезагрузкой не снимается)
    put('codex-jobs', 'o_dinc', { status: 'done', finishedAt: after.toISOString(), exitCode: 0 }, before); // неполный done раньше загрузки — держит
    // mtimeMs === bootAt (равенство загрузке) — НЕ позже записи, держит.
    put('codex-jobs', 'o_eq', { status: 'running' }, new Date(bootMs));
    let b = run();
    for (const id of pBoot) {
      assert(!blocks(b, id), 'перезагрузка снимает: ' + id);
      assert(b.passedByReboot.some(p => p.kind === 'card' && p.id === id), id + ' — в passedByReboot');
    }
    assert(b.running.some(r => r.id === 'o_after'), 'запись позже загрузки — идёт');
    assert(b.running.some(r => r.id === 'o_mt0'), 'время записи 0 — идёт');
    assert(b.running.some(r => r.id === 'o_hist'), 'историческая без слова позже загрузки — идёт');
    assert(b.blockers.some(x => x.includes('o_weird') && x.includes('неизвестный статус')), 'неизвестный статус раньше загрузки — держит');
    assert(b.blockers.some(x => x.includes('o_dinc')), 'неполный done раньше загрузки — держит');
    assert(b.running.some(r => r.id === 'o_eq'), 'mtimeMs === bootAt — не позже записи, держит');
    // bootAt не число (NaN) / Infinity — ни одна карточка не проходит по перезагрузке.
    for (const bt of [() => NaN, () => Infinity]) { const bn = run(bt); for (const id of pBoot) assert(blocks(bn, id), 'bootAt ' + bt() + ': перезагрузка не действует, держит ' + id); }
  }],
  ['team-v57 (ред.6) MOST_TEST_BOOT_AT в проверке установки НЕ действует: подмена и собственный getter времени загрузки', () => {
    const state = legacy(); const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
    const card = new Date('2026-06-01T00:00:00Z'); // запись живой running-карточки
    const file = path.join(d, 'live-run.json'); fs.writeFileSync(file, JSON.stringify({ id: 'live-run', status: 'running', startedAt: card.toISOString() }));
    fs.utimesSync(file, card, card);
    const env = process.env.MOST_TEST_BOOT_AT;
    try {
      // MOST_TEST_BOOT_AT ПОЗЖЕ записи карточки: если бы проверка его читала, карточка прошла бы «по перезагрузке».
      process.env.MOST_TEST_BOOT_AT = '2026-12-01T00:00:00Z';
      // Проверка без тестовой зависимости MOST_TEST_BOOT_AT не действует; настоящее время загрузки подменяем через deps.bootAt
      // на заведомо более РАННЕЕ, чем запись карточки (иначе результат зависит от машины): карточка остаётся идущей.
      const b = migration.installationBlockers(state, { bootAt: () => Date.parse('2026-01-01T00:00:00Z') });
      assert(b.running.some(r => r.id === 'live-run'), 'MOST_TEST_BOOT_AT не пропускает живую карточку — держит как идущую');
      assert(!b.passedByReboot.some(p => p.id === 'live-run'), 'карточка НЕ в passedByReboot (env не действует)');
      // Собственный getter проверки установки не читает MOST_TEST_BOOT_AT (в отличие от live.bootAt).
      assert.notEqual(migration.installBootAt(), Date.parse('2026-12-01T00:00:00Z'), 'installBootAt() игнорирует MOST_TEST_BOOT_AT');
      assert.equal(require('../common/live-jobs').bootAt(), Date.parse('2026-12-01T00:00:00Z'), 'live.bootAt() по-прежнему читает MOST_TEST_BOOT_AT');
    } finally { if (env === undefined) delete process.env.MOST_TEST_BOOT_AT; else process.env.MOST_TEST_BOOT_AT = env; }
  }],
  ['team-v57 (ред.7) без слова отказ: незавершённая admission без карточки и активная reservation сеанса — и раньше, и позже загрузки (перезагрузкой не снимаются)', () => {
    const state = legacy(), admDir = require('../common/job-admission').dir(state); fs.mkdirSync(admDir, { recursive: true });
    const before = new Date('2026-01-01T00:00:00Z'), after = new Date('2026-12-01T00:00:00Z'), boot = () => Date.parse('2026-06-01T00:00:00Z');
    const put = (name, rec, mtime) => { const f = path.join(admDir, name); fs.writeFileSync(f, JSON.stringify(rec)); fs.utimesSync(f, mtime, mtime); };
    for (const [tag, mtime] of [['before', before], ['after', after]]) {
      put('session-' + tag + '.json', { jobId: 'sess-' + tag, status: 'active' }, mtime);
      put('adm-' + tag + '.json', { jobId: 'adm-' + tag, committed: false }, mtime);
    }
    const b = migration.installationBlockers(state, { bootAt: boot });
    for (const tag of ['before', 'after']) {
      assert(b.blockers.some(x => x.includes('reservation сеанса') && x.includes('sess-' + tag) && x.includes('active')), 'активная reservation (' + tag + ' загрузки) блокирует без слова');
      assert(b.blockers.some(x => x.includes('admission') && x.includes('adm-' + tag)), 'незавершённая admission (' + tag + ' загрузки) блокирует без слова');
    }
    assert(!b.passedByReboot.length, 'admission/reservation перезагрузкой не снимаются');
    // Общее слово перекрывает их (как и любые находки): входят в overriddenByWord.blockers.
    const o = migration.listHash(b); assert.match(o, /^[a-f0-9]{64}$/);
  }],
  ['team-v57 (ред.5) замки: брошенный (мёртвый владелец + запись раньше загрузки) не мешает; живой/непроверяемый/после загрузки/недоступное время держат; замок при карточке со словом проходит', () => {
    const wl = require('../common/write-lock'), paths = require('../common/paths'), crypto = require('crypto'), ops = require('../common/deploy-ops');
    fs.mkdirSync(wl.dir(), { recursive: true });
    const folder = paths.canon(f.root);
    const boot = '2026-06-01T00:00:00Z', before = new Date('2026-01-01T00:00:00Z'), after = new Date('2026-12-01T00:00:00Z');
    const explDir = path.join(f.state, 'codex-jobs'); fs.mkdirSync(explDir, { recursive: true });
    const putCard = (id, card) => fs.writeFileSync(path.join(explDir, id + '.json'), JSON.stringify({ id, ...card }));
    const mkLock = (tag, extra, mtime) => {
      const inst = crypto.randomUUID(), lf = wl.entryFile(folder + tag);
      fs.writeFileSync(lf, JSON.stringify({ folder, instance: inst, since: new Date().toISOString(), ...extra }));
      if (mtime !== undefined) fs.utimesSync(lf, mtime, mtime);
      return { inst, lf };
    };
    const word = { basis: 'слово пользователя' };
    const cardIds = ['L_done', 'L_lost', 'L_word', 'L_reboot'];
    putCard('L_done', { status: 'done', threadId: 't', finishedAt: after.toISOString(), exitCode: 0, resultFile: 'L_done.result.txt' });
    fs.writeFileSync(path.join(explDir, 'L_done.result.txt'), 'итог');
    putCard('L_lost', { status: 'lost', pid: 999999, stopConfirmed: word }); // карточка со словом
    putCard('L_word', { status: 'running', pid: process.pid, stopConfirmed: word }); // карточка со словом, живой владелец
    putCard('L_reboot', { status: 'running' }); fs.utimesSync(path.join(explDir, 'L_reboot.json'), before, before); // карточка прошла по перезагрузке (запись раньше загрузки)
    let bootFn = () => Date.parse(boot);
    const res = () => migration.installationBlockers(f.state, { bootAt: bootFn });
    const find = inst => res().blockers.find(x => x.includes(inst)) || '';
    const passedWord = inst => res().passedByCardWord.some(p => p.kind === 'lock' && p.instance === inst);
    const passedReboot = inst => res().passedByReboot.some(p => p.kind === 'lock' && p.instance === inst);
    const drop = L => { try { fs.unlinkSync(L.lf); } catch {} };
    try {
      let L;
      // Брошен (владелец мёртв + запись раньше загрузки) — не мешает: без карточки, при done, при карточке по перезагрузке.
      L = mkLock('-ab-orph', { pid: 999999, jobId: 'no-card-x' }, before); assert(!find(L.inst) && passedReboot(L.inst), 'брошенный замок без карточки не мешает (passedByReboot)'); drop(L);
      L = mkLock('-ab-done', { pid: 999999, jobId: 'L_done' }, before); assert(!find(L.inst), 'брошенный замок при done не мешает'); drop(L);
      L = mkLock('-ab-reboot', { pid: 999999, jobId: 'L_reboot' }, before); assert(!find(L.inst), 'брошенный замок при карточке по перезагрузке не мешает'); drop(L);
      // Замок при карточке СО СЛОВОМ — не мешает при ЛЮБОМ владельце (ред.5): живой владелец и запись позже загрузки.
      L = mkLock('-w-alive', { pid: process.pid, jobId: 'L_word' }, after); assert(!find(L.inst) && passedWord(L.inst), 'замок при карточке со словом (живой владелец) не мешает (passedByCardWord)'); drop(L);
      L = mkLock('-w-lost', { pid: process.pid, jobId: 'L_lost' }, after); assert(!find(L.inst) && passedWord(L.inst), 'замок при карточке lost со словом не мешает'); drop(L);
      // Держат: без карточки/при done/при карточке по перезагрузке — живой, непроверяемый, после загрузки, недоступное время.
      assert.equal(ops.alive(0), null, 'pid 0 непроверяем');
      L = mkLock('-o-alive', { pid: process.pid, jobId: 'no-card-y' }, before); assert(find(L.inst).includes('осиротевший замок'), 'живой владелец без карточки держит'); drop(L);
      L = mkLock('-o-unk', { pid: 0, jobId: 'no-card-z' }, before); assert(find(L.inst).includes('осиротевший замок'), 'непроверяемый владелец без карточки держит'); drop(L);
      L = mkLock('-o-after', { pid: 999999, jobId: 'no-card-w' }, after); assert(find(L.inst).includes('осиротевший замок'), 'мёртвый владелец, замок после загрузки держит'); drop(L);
      L = mkLock('-reb-alive', { pid: process.pid, jobId: 'L_reboot' }, before); assert(find(L.inst).includes('прошедшей по перезагрузке'), 'живой владелец при карточке по перезагрузке держит'); drop(L);
      L = mkLock('-d-after', { pid: 999999, jobId: 'L_done' }, after); { const m = find(L.inst); assert(m.includes('неснятый замок') && m.includes('done'), 'мёртвый владелец при done, замок после загрузки держит'); } drop(L);
      // Недоступное время записи замка (statSync → NaN) — держит.
      L = mkLock('-nan', { pid: 999999, jobId: 'L_reboot' }, before);
      { const fsMod = require('fs'), orig = fsMod.statSync;
        fsMod.statSync = (p, ...a) => { if (path.resolve(String(p)) === path.resolve(L.lf)) throw new Error('stat fail'); return orig(p, ...a); };
        try {
          const e = wl.entries(f.state).find(x => path.resolve(x.file) === path.resolve(L.lf));
          assert(Number.isNaN(e.mtimeMs), 'сбой statSync замка → mtimeMs NaN (не 0)');
          assert(find(L.inst).includes('прошедшей по перезагрузке'), 'недоступное время записи замка держит');
        } finally { fsMod.statSync = orig; } }
      drop(L);
      // bootAt не число — ни один замок не брошен.
      bootFn = () => NaN;
      L = mkLock('-nan-boot', { pid: 999999, jobId: 'no-card-nb' }, before);
      assert(find(L.inst).includes('осиротевший замок'), 'bootAt не число: мёртвый владелец + запись до загрузки держит'); drop(L);
    } finally {
      for (const id of cardIds) { try { fs.unlinkSync(path.join(explDir, id + '.json')); } catch {} }
      try { fs.unlinkSync(path.join(explDir, 'L_done.result.txt')); } catch {}
    }
  }],
  ['§5.4 после установки по слову карточки перекрытых поручений получают отметку остановки (слово установки; канал установки) — не числятся «идёт»/«отменяется»', () => {
    const state = legacy(); const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify({ id: 'run', status: 'running', startedAt: new Date().toISOString() }));
    fs.writeFileSync(path.join(d, 'canc.json'), JSON.stringify({ id: 'canc', status: 'cancelling', write: true, startedAt: new Date().toISOString() }));
    fs.writeFileSync(path.join(d, 'blk.json'), JSON.stringify({ id: 'blk', status: 'failed', holdsFolder: true, startedAt: new Date().toISOString() }));
    // Карточка, уже закрытая словом на карточке, отметку установки не получает (cardWord).
    fs.writeFileSync(path.join(d, 'done.json'), JSON.stringify({ id: 'done', status: 'running', stopConfirmed: { basis: 'слово пользователя' }, startedAt: new Date().toISOString() }));
    const before = migration.installationBlockers(state, { bootAt: () => 0 });
    assert(before.running.some(r => r.id === 'run'), 'run числится идущей до отметки');
    const w = { quote: 'Ставь', channel: 'codex', at: new Date().toISOString(), listHash: migration.listHash(before), running: before.running, blockers: before.blockers };
    const res = migration.markOverriddenStopped(state, w);
    for (const id of ['run', 'canc', 'blk']) assert(res.marked.includes(id), 'отмечена карточка ' + id);
    assert(!res.marked.includes('done'), 'карточка со словом на карточке не тронута');
    const read = id => JSON.parse(fs.readFileSync(path.join(d, id + '.json'), 'utf8'));
    for (const id of ['run', 'canc', 'blk']) { const j = read(id); assert.equal(j.stopConfirmed.basis, 'слово установки', id + ': основание — слово установки'); assert.equal(j.stopConfirmed.source, 'install-codex', id + ': источник — канал установки'); assert.equal(j.stopConfirmed.quote, 'Ставь'); }
    assert.equal(read('canc').status, 'needs_decision', 'отменявшаяся пишущая карточка — needs_decision (как stop_confirm)');
    // После отметки перекрытые карточки больше не числятся «идёт»/«отменяется» (установочный барьер их пропускает).
    const after = migration.installationBlockers(state, { bootAt: () => 0 });
    assert(!after.running.some(r => ['run', 'canc'].includes(r.id)), 'перекрытые не числятся идущими');
    assert(after.passedByCardWord.some(p => p.id === 'run'), 'run пропущена по слову на карточке');
    assert(!after.blockers.some(x => x.includes('blk')), 'blk больше не блокер');
  }],
  ['task10 д/§5.1: разметка перекрытых карточек словом установки НЕ считается новой записью при перезапуске (переход running→passedByCardWord)', () => {
    const state = legacy(); const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify({ id: 'run', status: 'running', startedAt: new Date().toISOString() }));
    fs.writeFileSync(path.join(d, 'canc.json'), JSON.stringify({ id: 'canc', status: 'cancelling', write: true, startedAt: new Date().toISOString() }));
    // Утверждённый (показанный пользователю) список: обе карточки в running.
    const approved = migration.installationBlockers(state, { bootAt: () => 0 });
    assert(approved.running.some(r => r.id === 'run') && approved.running.some(r => r.id === 'canc'), 'утверждённый список: обе идут');
    // deploy-ops.execute вызывает markOverriddenStopped ДО restart: перекрытые карточки получают stopConfirmed (слово установки).
    const w = { quote: 'Ставь', channel: 'codex', at: new Date().toISOString(), listHash: migration.listHash(approved), running: approved.running, blockers: approved.blockers };
    migration.markOverriddenStopped(state, w);
    // Свежий список к перезапуску: те же карточки теперь в passedByCardWord (слово установки), а не в running.
    const fresh = migration.installationBlockers(state, { bootAt: () => 0 });
    assert(fresh.passedByCardWord.some(p => p.id === 'run' && p.basis === 'слово установки'), 'run перешла в passedByCardWord словом установки');
    // НОВЫХ записей нет: тот же набор карточек, перекрытых словом ТЕКУЩЕЙ установки, перезапуск не отменяет.
    assert.deepEqual(migration.newRecords(fresh, approved), [], 'разметка словом установки — не новые записи (перезапуск идёт)');
  }],
  ['team-v57 (ред.5) полнота списка (все причины одной карточки + замок) и отпечаток listHash: показанный/возвращённый/записанный совпадают', () => {
    const wl = require('../common/write-lock'), paths = require('../common/paths'), crypto = require('crypto');
    const state = legacy();
    fs.mkdirSync(wl.dir(state), { recursive: true });
    const dir = path.join(state, 'codex-jobs'); fs.mkdirSync(dir, { recursive: true });
    // team-v57 (ред.6): ПОЛНЫЙ номер поручения (длиннее 8 знаков) — и в показанном списке, и в отпечатке.
    const fullId = 'multi-0123456789-full-number';
    fs.writeFileSync(path.join(dir, fullId + '.json'), JSON.stringify({ id: fullId, status: 'running', holdsFolder: true, treeWarning: true, startedAt: new Date().toISOString() }));
    const workDir = path.join(state, 'work'); fs.mkdirSync(workDir, { recursive: true });
    const folder = paths.canon(workDir), inst = crypto.randomUUID();
    const lf = path.join(wl.dir(state), crypto.createHash('sha256').update(folder).digest('hex').slice(0, 40) + '.json');
    fs.writeFileSync(lf, JSON.stringify({ folder, instance: inst, pid: process.pid, jobId: fullId, since: new Date().toISOString() }));
    const boot = () => 0; // загрузка заведомо не позже записи: карточка остаётся идущей, замок — живым
    const b = migration.installationBlockers(state, { bootAt: boot });
    // Карточка running + holdsFolder + treeWarning + живой замок = все четыре причины, без раннего выхода.
    assert(b.running.some(r => r.id === fullId), 'причина 1: running');
    assert(b.blockers.some(x => x.includes(fullId) && x.includes('удержание папки')), 'причина 2: holdsFolder');
    assert(b.blockers.some(x => x.includes(fullId) && x.includes('предупреждение по дереву')), 'причина 3: treeWarning');
    assert(b.blockers.some(x => x.includes(inst) && x.includes('идущей')), 'причина 4: замок при идущей карточке');
    // Отпечаток устойчив во времени (duration не входит) и совпадает при повторной сборке через паузу.
    const h1 = migration.listHash(b);
    cp.execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},5)']); // пауза
    const h2 = migration.listHash(migration.installationBlockers(state, { bootAt: boot }));
    assert.equal(h1, h2, 'отпечаток одинаков при повторной сборке того же состояния через паузу');
    assert.match(h1, /^[a-f0-9]{64}$/, 'отпечаток — sha256');
    // Полные номера в показанном списке + предупреждение об обрыве идущих поручений в начале.
    const text = migration.listText(b);
    assert(text.includes(fullId) && text.includes(inst), 'текст списка содержит ПОЛНЫЙ номер карточки и замок');
    const refusal = migration.refusalText(b, h1, 'claude');
    assert(refusal.includes('будут оборваны') && refusal.indexOf('будут оборваны') < refusal.indexOf(fullId), 'предупреждение об обрыве — в начале показанного списка');
    assert(refusal.includes(fullId), 'показанный список содержит полный номер');
    // Изменение причин меняет отпечаток.
    fs.writeFileSync(path.join(dir, fullId + '.json'), JSON.stringify({ id: fullId, status: 'running', startedAt: new Date().toISOString() }));
    assert.notEqual(migration.listHash(migration.installationBlockers(state, { bootAt: boot })), h1, 'изменение причин меняет отпечаток');
  }],
  ['team-v57 (ред.6/7) два поля записи: gatePassed всегда при непустых passedBy* (даже без находок); overriddenByWord только со словом; оба ДО первого изменяющего шага и сохраняются после сбоя', async () => {
    const opWrite = (state, body) => { const d = path.join(state, 'deploy-ops'); fs.mkdirSync(d, { recursive: true }); const file = path.join(d, 'op.json'); fs.writeFileSync(file, JSON.stringify({ id: 'op', status: 'запущена', ...body })); return file; };
    // (1) Находка не снимается словом на карточке (неизвестный статус): без слова — отказ; со словом — overriddenByWord и запись.
    {
      const state = legacy(); const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'blk.json'), JSON.stringify({ id: 'blk', status: 'застрял' }));
      const opFile = opWrite(state);
      await assert.rejects(() => migration.install(state, source, deps({ opFile })), /Установка не начата/, 'без слова — отказ');
      const op = await migration.install(state, source, deps({ opFile, word: '  перекрываю словом  ', channel: 'console' }));
      assert(op, 'со словом установка проходит');
      const rec = JSON.parse(fs.readFileSync(opFile, 'utf8'));
      assert.equal(rec.overriddenByWord.quote, 'перекрываю словом', 'слово записано (после trim)');
      assert.equal(rec.overriddenByWord.channel, 'console', 'канал записан');
      assert(rec.overriddenByWord.blockers.some(x => x.includes('blk')), 'перекрытый список записан в overriddenByWord.blockers');
      assert.match(rec.overriddenByWord.listHash, /^[a-f0-9]{64}$/, 'отпечаток записан');
      assert.equal(rec.gatePassed, undefined, 'пропущенного по слову на карточке/перезагрузке нет — gatePassed отсутствует');
    }
    // (2) gatePassed без общего слова и БЕЗ находок: единственная карточка со словом — running/blockers пусты, но gatePassed записан.
    {
      const state = legacy(); const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'wrun.json'), JSON.stringify({ id: 'wrun', status: 'running', stopConfirmed: { basis: 'слово пользователя' } }));
      const opFile = opWrite(state);
      const op = await migration.install(state, source, deps({ opFile }));
      assert(op, 'установка проходит без общего слова (мешающего не осталось)');
      const rec = JSON.parse(fs.readFileSync(opFile, 'utf8'));
      assert.equal(rec.overriddenByWord, undefined, 'общего слова нет — overriddenByWord отсутствует');
      assert(rec.gatePassed, 'gatePassed записан даже без находок');
      assert.match(rec.gatePassed.listHash, /^[a-f0-9]{64}$/, 'отпечаток в gatePassed');
      assert(rec.gatePassed.passedByCardWord.some(p => p.id === 'wrun'), 'passedByCardWord в gatePassed без общего слова');
    }
    // (2б) Оба поля сразу: находка (неизвестный статус) + пропущенная по слову карточка. Со словом пишутся gatePassed И overriddenByWord.
    {
      const state = legacy(); const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'blkx.json'), JSON.stringify({ id: 'blkx', status: 'застрял' }));
      fs.writeFileSync(path.join(d, 'wcard.json'), JSON.stringify({ id: 'wcard', status: 'running', stopConfirmed: { basis: 'слово пользователя' } }));
      const opFile = opWrite(state);
      const op = await migration.install(state, source, deps({ opFile, word: 'перекрываю', channel: 'claude' }));
      assert(op, 'со словом установка проходит');
      const rec = JSON.parse(fs.readFileSync(opFile, 'utf8'));
      assert.equal(rec.overriddenByWord.quote, 'перекрываю', 'overriddenByWord при находке');
      assert(rec.gatePassed.passedByCardWord.some(p => p.id === 'wcard'), 'gatePassed при пропущенной по слову карточке');
    }
    // (3) После сбоя на последующем шаге overriddenByWord остаётся в записи операции.
    {
      const state = legacy(); const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'blk2.json'), JSON.stringify({ id: 'blk2', status: 'застрял' }));
      const opFile = opWrite(state);
      await assert.rejects(() => migration.install(state, source, deps({ opFile, word: 'слово', channel: 'claude', hook: n => { if (n === 'kimi-migrate') throw Error('сбой шага migrate'); } })), /restart-hold сохранён/, 'сбой на шаге migrate');
      const rec = JSON.parse(fs.readFileSync(opFile, 'utf8'));
      assert.equal(rec.overriddenByWord.quote, 'слово', 'overriddenByWord сохранён после сбоя шага');
    }
    // (4) ИДУЩЕЕ поручение (без слова на карточке): слово перекрывает и барьер assertNoJobs, и проверку идущих поручений в
    // stopServers (другое место на пути установки, отказывавшее не глядя на слово). Без слова — отказ; со словом — установка
    // проходит ОБА места (step stop не падает «Перед миграцией нужно завершить поручения»).
    {
      const state = legacy(); const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'livejob.json'), JSON.stringify({ id: 'livejob', status: 'running', startedAt: new Date().toISOString() }));
      await assert.rejects(() => migration.install(state, source, deps({ opFile: opWrite(state) })), /идут поручения/, 'идущее поручение без слова — отказ');
      const op = await migration.install(state, source, deps({ opFile: opWrite(state), word: 'Ставь, поручение оборви', channel: 'claude' }));
      assert(op, 'со словом установка проходит мимо идущего поручения (barrier + stopServers)');
      const rec = JSON.parse(fs.readFileSync(op && path.join(state, 'deploy-ops', 'op.json'), 'utf8'));
      assert(rec.overriddenByWord.running.some(r => r.id === 'livejob'), 'идущее поручение перекрыто словом (overriddenByWord.running)');
    }
  }],
  ['team-v57 (ред.5) deployGate (канал Claude): без слова — отказ с отпечатком; верный отпечаток — слово; неверный/пустой отпечаток и пустое слово — отказ', () => {
    const bootAt = () => 0;
    const noFind = legacy();
    assert(migration.deployGate(noFind, { bootAt }).ok, 'без находок — разрешение без слова');
    const state = legacy(); const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'blk.json'), JSON.stringify({ id: 'blk', status: 'застрял' }));
    const h = migration.listHash(migration.installationBlockers(state, { bootAt }));
    const g0 = migration.deployGate(state, { bootAt });
    assert(g0.refusal && g0.refusal.includes(h) && g0.refusal.includes('list_hash'), 'без слова — отказ с полным списком и отпечатком');
    assert(g0.refusal.includes('будут оборваны'), 'отказ содержит предупреждение об обрыве идущих поручений');
    assert.throws(() => migration.deployGate(state, { quote: 'слово', bootAt }), /отпечаток/, 'слово без отпечатка — ошибка');
    const gStale = migration.deployGate(state, { quote: 'слово', listHash: 'deadbeef', bootAt });
    assert(gStale.refusal && gStale.stale, 'неверный отпечаток — отказ с новым списком');
    const gEmpty = migration.deployGate(state, { quote: '   ', listHash: h, bootAt });
    assert(gEmpty.refusal && !gEmpty.word, 'пустое слово — отказ');
    const gOk = migration.deployGate(state, { quote: '  слово пользователя  ', listHash: h, bootAt });
    assert.equal(gOk.word, 'слово пользователя', 'верный отпечаток + непустое слово — слово (после trim)');
    assert.equal(gOk.channel, 'claude', 'канал по умолчанию claude');
    // team-v57 (ред.8): слово принимается из чата ЛЮБОГО участника — channel несёт имя клиента-участника.
    for (const channel of ['codex', 'kimi', 'antigravity', 'deepseek']) {
      assert.equal(migration.deployGate(state, { quote: 'слово', listHash: h, channel, bootAt }).channel, channel, 'канал ' + channel);
      // Отказ без слова адресует чат (не консоль): просит передать quote с отпечатком.
      const r = migration.deployGate(state, { channel, bootAt });
      assert(r.refusal.includes('quote') && r.refusal.includes('list_hash'), 'отказ чату ' + channel + ' просит слово с отпечатком');
    }
  }],
  ['team-v57 (task9 п.1) утверждённый отпечаток идёт со словом до изменяющего шага: несовпадение — отказ «список изменился» (overriddenByWord не пишется); совпадение — перекрытие', async () => {
    const opWrite = state => { const dir = path.join(state, 'deploy-ops'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'op.json'); fs.writeFileSync(file, JSON.stringify({ id: 'op', status: 'запущена' })); return file; };
    const mkFinding = state => { const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'blk.json'), JSON.stringify({ id: 'blk', status: 'застрял' })); };
    // (1) неверный отпечаток со словом и находками — отказ, overriddenByWord НЕ записан (ничего не перекрыто).
    { const state = legacy(); mkFinding(state); const opFile = opWrite(state);
      await assert.rejects(() => migration.install(state, source, deps({ opFile, word: 'перекрываю', channel: 'claude', listHash: 'deadbeef' })), /список изменился/, 'неверный отпечаток — отказ');
      assert.equal(JSON.parse(fs.readFileSync(opFile, 'utf8')).overriddenByWord, undefined, 'при расхождении отпечатка overriddenByWord не записан'); }
    // (2) верный отпечаток — установка проходит, overriddenByWord записан.
    { const state = legacy(); mkFinding(state); const opFile = opWrite(state);
      const h = migration.listHash(migration.installationBlockers(state, { bootAt: () => 0 }));
      const op = await migration.install(state, source, deps({ opFile, word: 'перекрываю', channel: 'claude', listHash: h }));
      assert(op, 'верный отпечаток — установка проходит');
      assert.equal(JSON.parse(fs.readFileSync(opFile, 'utf8')).overriddenByWord.quote, 'перекрываю'); }
    // (3) список изменился между показом и изменяющим шагом (новое поручение) — старый отпечаток не совпал → отказ.
    { const state = legacy(); mkFinding(state); const opFile = opWrite(state);
      const hOld = migration.listHash(migration.installationBlockers(state, { bootAt: () => 0 }));
      fs.writeFileSync(path.join(state, 'codex-jobs', 'blk2.json'), JSON.stringify({ id: 'blk2', status: 'застрял' }));
      await assert.rejects(() => migration.install(state, source, deps({ opFile, word: 'перекрываю', channel: 'claude', listHash: hOld })), /список изменился/, 'новое поручение после показа — отказ'); }
  }],
  ['team-v57 (task9 п.2) отпечаток включает статус running и поля пропущенных записей: изменение каждого поля меняет отпечаток', () => {
    const wl = require('../common/write-lock'), paths = require('../common/paths'), crypto = require('crypto');
    const H = state => migration.listHash(migration.installationBlockers(state, { bootAt: () => 0 }));
    const put = (state, store, id, card) => { const d = path.join(state, store); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify({ id, ...card })); };
    const word = { basis: 'слово пользователя' };
    // (а) статус running-карточки: queued → running.
    { const s = legacy(); put(s, 'codex-jobs', 'c1', { status: 'queued', startedAt: new Date().toISOString(), folder: 'F', from: 'claude' }); const h1 = H(s);
      put(s, 'codex-jobs', 'c1', { status: 'running', startedAt: new Date().toISOString(), folder: 'F', from: 'claude' }); assert.notEqual(H(s), h1, 'статус queued→running меняет отпечаток'); }
    // (б) папка пропущенной по слову карточки.
    { const s = legacy(); put(s, 'codex-jobs', 'c2', { status: 'running', folder: 'F1', from: 'claude', stopConfirmed: word }); const h1 = H(s);
      put(s, 'codex-jobs', 'c2', { status: 'running', folder: 'F2', from: 'claude', stopConfirmed: word }); assert.notEqual(H(s), h1, 'папка пропущенной карточки меняет отпечаток'); }
    // (в) отправитель пропущенной по слову карточки.
    { const s = legacy(); put(s, 'codex-jobs', 'c3', { status: 'running', folder: 'F', from: 'claude', stopConfirmed: word }); const h1 = H(s);
      put(s, 'codex-jobs', 'c3', { status: 'running', folder: 'F', from: 'codex', stopConfirmed: word }); assert.notEqual(H(s), h1, 'отправитель пропущенной карточки меняет отпечаток'); }
    // (г) папка замка в passedByCardWord (замок при карточке со словом).
    { const s = legacy(); put(s, 'codex-jobs', 'lk', { status: 'running', stopConfirmed: word }); fs.mkdirSync(wl.dir(s), { recursive: true });
      const mk = folder => { const lf = path.join(wl.dir(s), crypto.createHash('sha256').update(folder).digest('hex').slice(0, 40) + '.json'); fs.writeFileSync(lf, JSON.stringify({ folder, instance: crypto.randomUUID(), pid: process.pid, jobId: 'lk', since: new Date().toISOString() })); return lf; };
      const lf1 = mk(path.join(s, 'w1')); const h1 = H(s); fs.unlinkSync(lf1);
      const lf2 = mk(path.join(s, 'w2')); assert.notEqual(H(s), h1, 'папка замка меняет отпечаток'); fs.unlinkSync(lf2); }
  }],
  ['team-v57 (task9 п.3, ревью Codex 3) нечитаемая карточка не прекращает сбор: ошибка чтения — отдельный блокер с путём, остальное перечисляется', () => {
    const state = legacy();
    const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'good.json'), JSON.stringify({ id: 'good', status: 'застрял' }));
    fs.writeFileSync(path.join(d, 'bad.json'), '{ это не json');
    const adm = require('../common/job-admission'); fs.mkdirSync(adm.dir(state), { recursive: true });
    fs.writeFileSync(path.join(adm.dir(state), 'am.json'), JSON.stringify({ jobId: 'am-job', committed: false }));
    const b = migration.installationBlockers(state, { bootAt: () => 0 });
    assert(b.blockers.some(x => x.includes('good') && x.includes('неизвестный статус')), 'валидная карточка перечислена несмотря на нечитаемую');
    assert(b.blockers.some(x => x.includes('ошибка чтения состояния') && x.includes('bad.json')), 'ошибка чтения — отдельный блокер с путём файла');
    assert(b.blockers.some(x => x.includes('am-job') && x.includes('постановка не завершена')), 'admission собрана независимо от нечитаемой карточки');
  }],
  ['§5.2 карточка с BOM читается устойчивым сбором (resilientCards) как обычная карточка', () => {
    const state = legacy();
    const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
    // Карточка с префиксом U+FEFF (BOM): PowerShell Out-File -Encoding utf8 пишет JSON с BOM. Снятие BOM — /^﻿/.
    fs.writeFileSync(path.join(d, 'bom.json'), Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(JSON.stringify({ id: 'bom', status: 'running', startedAt: new Date().toISOString() }), 'utf8')]));
    const res = migration.resilientCards(state);
    const card = res.cards.find(c => c.j && c.j.id === 'bom');
    assert(card, 'карточка с BOM собрана как обычная карточка (не ошибка)');
    assert.equal(card.j.status, 'running', 'поля карточки с BOM разобраны');
    assert(!res.errors.some(e => e.includes('bom.json')), 'карточка с BOM не попала в ошибки чтения');
    // Байтовая проверка: регулярное выражение снятия BOM в resilientCards содержит U+FEFF (/^﻿/).
    const src = fs.readFileSync(path.resolve(__dirname, '../common/members-kimi.js'), 'utf8');
    assert(/resilientCards[\s\S]*?replace\(\/\^\\uFEFF\/,/.test(src), 'снятие BOM записано как /^\\uFEFF/');
  }],
  ['team-v57 (task9 п.4, ревью Kimi 1) живая running-карточка со словом на карточке и живым PID, без общего слова, проходит assertNoJobs И stopServers', async () => {
    const state = legacy(); const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'livecard.json'), JSON.stringify({ id: 'livecard', status: 'running', pid: process.pid, startedAt: new Date().toISOString(), stopConfirmed: { basis: 'слово пользователя' } }));
    const b = migration.installationBlockers(state, { bootAt: () => 0 });
    assert(!b.running.length && !b.blockers.length, 'нет находок (карточка снята словом на карточке): ' + b.blockers.join('|'));
    assert(b.passedByCardWord.some(p => p.id === 'livecard'), 'карточка в passedByCardWord');
    const opFile = (() => { const dir = path.join(state, 'deploy-ops'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'op.json'); fs.writeFileSync(file, JSON.stringify({ id: 'op', status: 'запущена' })); return file; })();
    // install БЕЗ общего слова: assertNoJobs пропускает (gatePassed), stopServers (live-jobs.running) её идущей не считает.
    const op = await migration.install(state, source, deps({ opFile }));
    assert(op && op.status === 'migrated', 'установка прошла ВСЕ проверки без общего слова (barrier + stopServers)');
    assert(JSON.parse(fs.readFileSync(opFile, 'utf8')).gatePassed.passedByCardWord.some(p => p.id === 'livecard'), 'gatePassed записан');
  }],
  ['team-v57/§5.1 перезапуск сверяет список по НОВЫМ записям, не по полному равенству: совпадение — проходит; новое — отказ с новым списком; все завершились — не отказ', async () => {
    const restart = require('../common/restart');
    const holdDeps = { fingerprint: pid => ({ pid, startedAt: new Date().toISOString() }) };
    const state = legacy(); const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'a.json'), JSON.stringify({ id: 'a', status: 'running', startedAt: new Date().toISOString() }));
    const approved = migration.installationBlockers(state, { bootAt: () => 0 }), h = migration.listHash(approved);
    let launches = 0;
    // Неверный отпечаток и непустые находки — перезапуск отказывает до запуска сценария (launch не вызывается).
    await assert.rejects(restart.restart({ root: f.root, release: f.root, state, word: 'Ставь', wordListHash: 'deadbeef' }, { launch: async () => { launches++; }, bootAt: () => 0, hold: holdDeps }), /список установки пополнился|новые записи/, 'расхождение при непустых находках — отказ');
    assert.equal(launches, 0, 'при расхождении launch не вызван');
    // Верный отпечаток — проверка пройдена, доходит до запуска сценария (launch подменён — запуск не подтверждается).
    await assert.rejects(restart.restart({ root: f.root, release: f.root, state, word: 'Ставь', wordListHash: h }, { launch: async () => { launches++; }, waitMs: 50, bootAt: () => 0, hold: holdDeps }), /не подтверждён|не запущен/, 'верный отпечаток — проверка пройдена');
    assert.equal(launches, 1, 'верный отпечаток — launch вызван');
    // §5.1 «появилось новое — отказ с новым списком и отпечатком»: утверждён список approved (одна карточка a); к перезапуску
    // появилась НОВАЯ карточка b. Сверка по новым записям (wordList=approved) отказывает, в тексте — новая запись, полный список, отпечаток.
    fs.writeFileSync(path.join(d, 'b.json'), JSON.stringify({ id: 'b', status: 'running', startedAt: new Date().toISOString() }));
    const fresh = migration.installationBlockers(state, { bootAt: () => 0 });
    await assert.rejects(restart.restart({ root: f.root, release: f.root, state, word: 'Ставь', wordListHash: migration.listHash(approved), wordList: approved },
      { launch: async () => { launches++; }, bootAt: () => 0, hold: holdDeps }), e => { assert.match(e.message, /codex b|новые записи/); assert.match(e.message, new RegExp(migration.listHash(fresh)), 'в отказе — новый отпечаток'); assert(e.message.includes('Новый полный список'), 'в отказе — новый полный список'); return true; }, 'новая запись — отказ');
    assert.equal(launches, 1, 'при новой записи launch не вызван');
    // §5.1 «все утверждённые поручения завершились к перезапуску — не отказ»: свежий список пуст, хотя утверждённый отпечаток
    // непустой. Находок нет — перезапуск НЕ отказывает, доходит до запуска сценария.
    fs.unlinkSync(path.join(d, 'a.json')); fs.unlinkSync(path.join(d, 'b.json'));
    await assert.rejects(restart.restart({ root: f.root, release: f.root, state, word: 'Ставь', wordListHash: h, wordList: approved }, { launch: async () => { launches++; }, waitMs: 50, bootAt: () => 0, hold: holdDeps }), /не подтверждён|не запущен/, 'все завершились — проверка пройдена');
    assert.equal(launches, 2, 'все завершились — launch вызван (не отказ)');
  }],
  ['team-v58 доступ: team_change (все действия) открыт чату любого участника и в запасном режиме; поручение — отказ', () => {
    const access = require('../common/access');
    // fake-kimi.setup() ставит MOST_PROBE_ONLY=1 (режим legacy-пробы, где набор гостя урезан прежним списком).
    // Проверяем НОРМАЛЬНЫЙ режим — снимаем переменные пробы и восстанавливаем их в finally.
    const save = { cli: process.env.MOST_CLIENT, job: process.env.MOST_JOB_ID, auth: process.env.MOST_AUTHORITY, probe: process.env.MOST_PROBE_ONLY, pg: process.env.MOST_PROBE_GUEST };
    const restore = () => { for (const [k, v] of [['MOST_CLIENT', save.cli], ['MOST_JOB_ID', save.job], ['MOST_AUTHORITY', save.auth], ['MOST_PROBE_ONLY', save.probe], ['MOST_PROBE_GUEST', save.pg]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
    try {
      delete process.env.MOST_JOB_ID; delete process.env.MOST_AUTHORITY; delete process.env.MOST_PROBE_ONLY; delete process.env.MOST_PROBE_GUEST;
      // team-v58: чат любого участника связки, включая Kimi (пятая семья, в этой фикстуре на паузе) — получает полный набор
      // дирижёра независимо от паузы/фазы; team_change ведётся целиком.
      for (const client of ['codex', 'antigravity', 'deepseek', 'kimi']) {
        process.env.MOST_CLIENT = client;
        assert.equal(access.allowed('team', 'team_change'), true, client + ': team_change зарегистрирован');
        for (const action of ['deploy', 'merge', 'start', 'commit', 'list'])
          assert.doesNotThrow(() => access.guard('team', 'team_change', { action }), client + ': ' + action + ' открыт чату');
      }
      // Запасной режим (authority=user): чат участника ведёт team_change целиком (режим чат не ограничивает).
      process.env.MOST_CLIENT = 'codex'; process.env.MOST_AUTHORITY = 'user';
      assert.equal(access.allowed('team', 'team_change'), true, 'запасной режим: team_change доступен');
      for (const action of ['deploy', 'merge'])
        assert.doesNotThrow(() => access.guard('team', 'team_change', { action }), 'запасной режим: ' + action + ' открыт чату');
      delete process.env.MOST_AUTHORITY;
      // Поручение — deploy закрыт (в поручении человека нет): MOST_JOB_ID и клиент claude-print.
      process.env.MOST_CLIENT = 'claude'; process.env.MOST_JOB_ID = 'job-1';
      assert.equal(access.allowed('team', 'team_change'), false, 'MOST_JOB_ID: deploy закрыт');
      assert.throws(() => access.guard('team', 'team_change', { action: 'deploy' }), /запрещено/, 'поручение: deploy отказан');
      delete process.env.MOST_JOB_ID; process.env.MOST_CLIENT = 'claude-print';
      assert.equal(access.allowed('team', 'team_change'), false, 'claude-print: deploy закрыт');
      assert.throws(() => access.guard('team', 'team_change', { action: 'deploy' }), /запрещено/, 'claude-print: deploy отказан');
    } finally { restore(); }
  }],
  ['team-v57 (ред.5) консоль: resolveInstallWord спрашивает слово только при интерактивном вводе; пустой ввод/не терминал/MOST_JOB_ID/MOST_CLIENT — отказ; список изменился — спросить заново; --word отсутствует', async () => {
    const deploy = require('../common/deploy');
    const state = legacy(); const d = path.join(state, 'codex-jobs'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'blk.json'), JSON.stringify({ id: 'blk', status: 'застрял' }));
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const setTty = v => Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
    const envJob = process.env.MOST_JOB_ID, envCli = process.env.MOST_CLIENT;
    delete process.env.MOST_JOB_ID; delete process.env.MOST_CLIENT;
    try {
      // Нет находок — вопрос не задаётся.
      assert.deepEqual(await deploy.resolveInstallWord(legacy(), {}, { promptWord: async () => assert.fail('не должны спрашивать'), bootAt: () => 0 }), {}, 'без находок — слова не спрашивают');
      // Интерактивный непустой ввод — слово с каналом console.
      setTty(true);
      const w = await deploy.resolveInstallWord(state, {}, { promptWord: async () => '  перекрываю  ', print: () => {}, bootAt: () => 0 });
      // team-v57 (task9 п.1): консоль возвращает и отпечаток показанного списка (по которому дано слово) — он уходит в операцию.
      assert.equal(w.quote, 'перекрываю'); assert.equal(w.channel, 'console');
      assert.match(w.listHash, /^[a-f0-9]{64}$/, 'отпечаток показанного списка возвращён для записи в операцию');
      assert.equal(w.listHash, migration.listHash(migration.installationBlockers(state, { bootAt: () => 0 })), 'отпечаток = отпечаток показанного списка');
      // Пустой ввод — отказ.
      await assert.rejects(() => deploy.resolveInstallWord(state, {}, { promptWord: async () => '   ', print: () => {}, bootAt: () => 0 }), /Слово не введено/, 'пустой ввод — отказ');
      // Не терминал — вопрос не задаётся, отказ.
      setTty(false);
      await assert.rejects(() => deploy.resolveInstallWord(state, {}, { promptWord: async () => assert.fail('не спрашивать'), print: () => {}, bootAt: () => 0 }), /Интерактивный ввод недоступен/, 'не терминал — отказ без вопроса');
      // MOST_JOB_ID / MOST_CLIENT — вопрос не задаётся.
      setTty(true); process.env.MOST_JOB_ID = 'job-1';
      await assert.rejects(() => deploy.resolveInstallWord(state, {}, { promptWord: async () => assert.fail('не спрашивать'), print: () => {}, bootAt: () => 0 }), /Интерактивный ввод недоступен/, 'MOST_JOB_ID — отказ без вопроса');
      delete process.env.MOST_JOB_ID; process.env.MOST_CLIENT = 'claude';
      await assert.rejects(() => deploy.resolveInstallWord(state, {}, { promptWord: async () => assert.fail('не спрашивать'), print: () => {}, bootAt: () => 0 }), /Интерактивный ввод недоступен/, 'MOST_CLIENT — отказ без вопроса');
      delete process.env.MOST_CLIENT;
      // §5.3 (team-v58): для ЧАТА (нет deps.promptWord — вопрос с клавиатуры недоступен) при находках отказ идёт КАНАЛОМ
      // КЛИЕНТА через refusalText (новый список + отпечаток, «передайте слово quote с list_hash»), а НЕ консольным текстом
      // «Интерактивный ввод недоступен…». Так чат, у которого к запуску появились находки и слова ещё нет, получает список.
      setTty(false);
      await assert.rejects(() => deploy.resolveInstallWord(state, { wordChannel: 'codex' }, { bootAt: () => 0 }), e => {
        assert(!/Интерактивный ввод недоступен/.test(e.message), 'чат не получает консольный текст');
        assert.match(e.message, /Передайте слово пользователя \(quote\) с этим отпечатком \(list_hash\)/, 'чат получает refusalText каналом клиента');
        assert.match(e.message, new RegExp(migration.listHash(migration.installationBlockers(state, { bootAt: () => 0 }))), 'в отказе — отпечаток нового списка');
        return true;
      }, 'чат без promptWord — refusalText каналом клиента');
      // Чата без находок на первом шаге слово не спрашивают (находок нет — {}).
      assert.deepEqual(await deploy.resolveInstallWord(legacy(), { wordChannel: 'codex' }, { bootAt: () => 0 }), {}, 'чат без находок — {}');
      // Слово из Claude (options.word) пробрасывается без вопроса.
      assert.deepEqual(await deploy.resolveInstallWord(state, { word: '  слово  ', wordChannel: 'claude' }, { bootAt: () => 0 }), { quote: 'слово', channel: 'claude' }, 'слово Claude без вопроса');
      // Список изменился между показом и установкой — спросить заново (promptWord вызван дважды).
      setTty(true); let calls = 0;
      const w2 = await deploy.resolveInstallWord(state, {}, { print: () => {}, promptWord: async () => { calls++; if (calls === 1) fs.writeFileSync(path.join(d, 'blk2.json'), JSON.stringify({ id: 'blk2', status: 'застрял' })); return 'слово'; }, bootAt: () => 0 });
      assert.equal(calls, 2, 'изменение списка между показом и установкой — повторный вопрос');
      assert.equal(w2.channel, 'console');
      // team-v57 (task9 п.6, ревью Gemini 3): если за время ввода список изменился и находок больше нет — {} (слово не нужно).
      { const d2 = legacy(); const dir2 = path.join(d2, 'codex-jobs'); fs.mkdirSync(dir2, { recursive: true });
        const bf = path.join(dir2, 'blk.json'); fs.writeFileSync(bf, JSON.stringify({ id: 'blk', status: 'застрял' }));
        const r = await deploy.resolveInstallWord(d2, {}, { print: () => {}, promptWord: async () => { fs.unlinkSync(bf); return 'слово'; }, bootAt: () => 0 });
        assert.deepEqual(r, {}, 'находок не осталось за время ввода — слово не нужно, {}'); }
      // Параметр --word (и любой другой способ передать слово аргументом) отсутствует.
      assert.throws(() => require('../tools/deploy.js').parseArgs(['--word', 'x']), /Неизвестный параметр/, '--word не существует');
    } finally {
      setTty(false); if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      if (envJob === undefined) delete process.env.MOST_JOB_ID; else process.env.MOST_JOB_ID = envJob;
      if (envCli === undefined) delete process.env.MOST_CLIENT; else process.env.MOST_CLIENT = envCli;
    }
  }],
  ['team-v57 (ред.5) rules/common.md содержит правило владельца дословно', () => {
    const common = fs.readFileSync(path.join(source, 'rules/common.md'), 'utf8');
    assert(common.includes('Ничто и никогда не может изменить моего слова, кроме моего же слова. Любой замысел и задача должны развиваться вокруг наилучшей реализации моего слова.'), 'дословная цитата владельца');
    assert(common.includes('(пользователь, 17.11.2026)'), 'подпись и дата');
    assert(common.includes('Ревью оценивает реализацию слова'), 'следствие: ревью оценивает реализацию');
  }],
  ['локальная памятка ≤7579, урок CRLF, все обязательные документы содержат Kimi', () => {
    const brief = fs.readFileSync(path.join(source, 'rules/brief.md'), 'utf8'); assert(brief.length <= 7579, brief.length);
    const lesson = fs.readFileSync(path.join(source, 'lessons.md'), 'utf8'); assert(!/(?<!\r)\n/.test(lesson.slice(lesson.indexOf('## 96.'))));
    for (const file of ['rules/common.md', 'rules/claude.md', 'rules/roles.md', 'rules/fallback.md', 'rules/instructions.md', 'skill/helpers/SKILL.md', 'README.md', 'docs/architecture.md']) assert(fs.readFileSync(path.join(source, file), 'utf8').includes('Kimi'), file);
  }],
  ['нормативные документы не содержат старых отрицаний возможностей Kimi; подложенный абзац обнаруживается (А1–А3/А5)', () => {
    // team-v56: действующие нормативные разделы описывают Kimi как полноправного участника. Запрещённые старые формулировки
    // возможностей (а не история lessons/фикстуры) не должны встречаться. Отрицательная проверка подкладывает абзац в каждый вид документа.
    const DOCS = ['rules/common.md', 'rules/roles.md', 'rules/claude.md', 'skill/helpers/SKILL.md', 'README.md', 'docs/architecture.md'];
    const FORBIDDEN = ['sends=false/writer=false', 'sends=false, writer=false', 'Исходящих Kimi нет', 'Исходящие от Kimi не сделаны',
      'Только новые поручения без записи', 'write=true/full_access=true/continue_id отвергаются', 'Kimi не клиент и не отправитель', 'Чат-клиента Kimi и его MCP-профиля нет'];
    const scan = text => FORBIDDEN.filter(p => text.includes(p));
    for (const file of DOCS) { const found = scan(fs.readFileSync(path.join(source, file), 'utf8')); assert.equal(found.length, 0, file + ': ' + found.join(' | ')); }
    // Отрицательный контроль: подложенный старый абзац обнаруживается в каждом виде документа.
    for (const file of DOCS) { const poisoned = fs.readFileSync(path.join(source, file), 'utf8') + '\nИсходящих Kimi нет; Kimi не клиент и не отправитель.\n'; assert(scan(poisoned).length >= 1, file); }
    // Действующие документы утверждают полноправность: запись и исходящие Kimi присутствуют хотя бы в основных разделах.
    assert(fs.readFileSync(path.join(source, 'rules/common.md'), 'utf8').includes('полноправный участник'));
    assert(fs.readFileSync(path.join(source, 'skill/helpers/SKILL.md'), 'utf8').includes('sends=true, writer=true'));
  }],
  ['публичная выгрузка текущего дерева: обезличенные фикстуры и длина памятки', () => {
    const fixture = path.join(f.root, 'export-source'), target = path.join(f.root, 'public'); fs.mkdirSync(fixture);
    const tracked = git(source, 'ls-files', '-z').split('\0').filter(Boolean).filter(x => x !== '_antigravity_result.txt');
    const added = ['common/kimi-launch.js', 'common/kimi-material.js', 'common/kimi-review.js', 'common/members-kimi.js', 'servers/kimi/index.js', 'tests/kimi-server.js', 'tests/kimi-material.js', 'tests/kimi-votes.js', 'tests/kimi-deploy.js', 'tests/fake-kimi.js', ...fs.readdirSync(path.join(source, 'tests/fixtures/kimi')).map(x => 'tests/fixtures/kimi/' + x)];
    for (const file of new Set([...tracked, ...added])) { const dest = path.join(fixture, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(source, file), dest); }
    git(fixture, 'init', '-b', 'main'); git(fixture, 'add', '.'); git(fixture, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'isolated export fixture');
    const termsFile = path.join(f.root, 'terms.json'); fs.writeFileSync(termsFile, JSON.stringify({ userFolder: 'USER', replace: [['пользователя', 'пользователя'], ['пользователь', 'пользователь']], forbidden: ['KIMI_PRIVATE_' + 'FIXTURE_TOKEN'], allow: [] }));
    require('../tools/export-public').exportPublic({ root: fixture, target, holder: 'test', termsFile });
    assert(fs.readFileSync(path.join(target, 'rules/brief.md'), 'utf8').length <= 7587); assert(fs.existsSync(path.join(target, 'servers/kimi/index.js'))); assert(!fs.existsSync(path.join(target, '_antigravity_result.txt')));
    git(target, 'init', '-b', 'main'); git(target, 'add', '.'); git(target, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'isolated public fixture');
    console.log('PUBLIC_FIXTURE=' + target);
  }],
]);
