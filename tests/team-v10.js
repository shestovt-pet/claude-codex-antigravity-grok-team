'use strict';
// team-v10: разделы замысла (Р1–Р2), возврат клона на ветку (Р3), уборка после установки (Р5), доп. защита уборки.
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v10-'));
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const json = (f, s) => write(f, JSON.stringify(s, null, 2));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_TEST_KEEP: '1', MOST_CLIENT: 'claude',
  MOST_NOTIFY: 'off', MOST_CLAUDE_CONFIGS: '[]', MOST_AGY_QUOTA_FILE: path.join(RUN, 'quota.json'), MOST_AGY_LOG_DIR: path.join(RUN, 'logs'),
  MOST_CODEX_CONFIG: path.join(RUN, 'absent.toml'), MOST_AGY_MCP_CONFIG: path.join(RUN, 'absent.json'), MOST_AGY_CONFIG: path.join(RUN, 'absent-permissions.json') });
delete process.env.MOST_AFTER_DEPLOY;
const { git } = require('../common/team-git');
const pc = require('../common/precheck'), cl = require('../common/cleanup'), ad = require('../common/after-deploy'), ops = require('../common/deploy-ops');
const { Team } = require('../common/team');
const tests = [], test = (label, fn) => tests.push({ label, fn });
const DAY = 24 * 3600000;
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.name', 'Тест'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(dir, ['config', k, v]);
  return dir;
}
const commit = (dir, msg) => { git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', msg]); return git(dir, ['rev-parse', 'HEAD']).trim(); };

test('Р2: precheck предупреждает без разделов «Опасные случаи» и «Живая проверка»', () => {
  const f = n => path.join(RUN, 'd-' + n + '.md');
  write(f('none'), '# Замысел, редакция 1\n\n## Решения\nР1. Одно.\n');
  write(f('one'), '# Замысел, редакция 1\n\n## Опасные случаи\n1. Нет.\n');
  write(f('both'), '# Замысел, редакция 1\n\n## Опасные случаи\n1. Нет.\n\n## Живая проверка\nНе нужна — нет живых данных.\n');
  write(f('fenced'), '# Замысел, редакция 1\n\n```\n## Опасные случаи\n```\n> ## Живая проверка\n');
  const w = n => pc.checkDesign(f(n));
  assert.deepEqual(w('none'), ['d-none.md: нет раздела «Опасные случаи»', 'd-none.md: нет раздела «Живая проверка»']);
  assert.deepEqual(w('one'), ['d-one.md: нет раздела «Живая проверка»']);
  assert.deepEqual(w('both'), []);
  assert.equal(w('fenced').length, 2, 'заголовок в коде или цитате не считается');
  assert.match(pc.precheckText(pc.precheck({ folder: RUN, designFile: path.join(RUN, 'нет.md'), lessonsDiff: '' })), /замысел не прочитан/);
});

// Изменение с клоном для Р3.
function changeFixture(name) {
  const root = repo(path.join(RUN, name, 'most')); write(path.join(root, 'a.txt'), 'a'); write(path.join(root, '.gitignore'), '.work/\n*.log\n');
  const base = commit(root, 'база');
  const clone = path.join(root, '.work', name); git(root, ['clone', '-q', root, clone]);
  for (const [k, v] of [['user.name', 'Тест'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(clone, ['config', k, v]);
  git(clone, ['checkout', '-q', '-b', 'change/' + name]);
  write(path.join(clone, 'b.txt'), 'b'); const cand = commit(clone, 'кандидат');
  const state = path.join(RUN, name, 'state');
  json(path.join(state, 'changes', name + '.json'), { name, owner: 'o', base, candidate: cand, verdicts: [], status: 'ожидает ревью' });
  return { root, clone, base, cand, team: new Team(root, state), state };
}
const detach = f => git(f.clone, ['checkout', '-q', '--detach', f.cand]);
const branch = f => git(f.clone, ['branch', '--show-current']).trim();

test('Р3: возврат отсоединённого HEAD на вершине ветки — только в commit, verdict, merge', async () => {
  const f = changeFixture('r3a');
  detach(f); write(path.join(f.clone, 'keep.log'), 'остаётся');
  await assert.rejects(f.team.change({ action: 'diff', name: 'r3a', owner: 'o' }), /другая ветка/);
  await assert.rejects(f.team.change({ action: 'precheck', name: 'r3a', owner: 'o' }), /другая ветка/);
  assert.equal(branch(f), '', 'diff и precheck не возвращают');
  const out = await f.team.change({ action: 'verdict', name: 'r3a', owner: 'o', who: 'claude', decision: 'ПРИНЯТО', base: f.base, candidate: f.cand, note: 'проверка' });
  assert.match(out, /^Рабочая копия была переключена на коммит [0-9a-f]{7} без ветки; возвращена на ветку change\/r3a, содержимое не менялось\.\nВердикт записан/);
  assert.equal(branch(f), 'change/r3a');
  assert.equal(git(f.clone, ['rev-parse', 'HEAD']).trim(), f.cand);
  assert.equal(fs.readFileSync(path.join(f.clone, 'keep.log'), 'utf8'), 'остаётся', 'игнорируемые файлы остаются');
  const again = await f.team.change({ action: 'verdict', name: 'r3a', owner: 'o', who: 'claude', decision: 'ПРИНЯТО', base: f.base, candidate: f.cand, note: 'снова' });
  assert(!/возвращена/.test(again), 'повторный вызов не сообщает о возврате');
});

test('Р3: отказ без возврата — другой коммит, другая ветка, нет ветки, грязный индекс, незавершённая операция', async () => {
  const cases = {
    'другой коммит': f => git(f.clone, ['checkout', '-q', '--detach', f.base]),
    'другая ветка': f => git(f.clone, ['checkout', '-q', '-b', 'чужая']),
    'нет ветки': f => { detach(f); git(f.clone, ['branch', '-q', '-D', 'change/' + f.name]); git(f.clone, ['tag', 'change/' + f.name, f.cand]); },
    'грязный файл': f => { detach(f); write(path.join(f.clone, 'a.txt'), 'правка'); },
    'новый файл в индексе': f => { detach(f); write(path.join(f.clone, 'c.txt'), 'c'); git(f.clone, ['add', 'c.txt']); },
    'незавершённая операция': f => { detach(f); write(path.join(f.clone, '.git', 'MERGE_HEAD'), f.base + '\n'); },
  };
  let i = 0;
  for (const [label, spoil] of Object.entries(cases)) {
    const name = 'r3b' + (i++), f = changeFixture(name); f.name = name;
    spoil(f);
    const before = git(f.clone, ['rev-parse', 'HEAD']).trim(), bb = branch(f);
    await assert.rejects(f.team.change({ action: 'verdict', name, owner: 'o', who: 'claude', decision: 'ПРИНЯТО', base: f.base, candidate: f.cand, note: 'x' }), /другая ветка/, label);
    assert.equal(git(f.clone, ['rev-parse', 'HEAD']).trim(), before, label); assert.equal(branch(f), bb, label);
  }
});

test('Р3: после возврата прочие ворота действуют, ответ сообщает о возврате', async () => {
  const f = changeFixture('r3c'); detach(f);
  await assert.rejects(f.team.change({ action: 'verdict', name: 'r3c', owner: 'o', who: 'claude', decision: 'ПРИНЯТО', base: f.base, candidate: f.base, note: 'x' }),
    /^Error: Рабочая копия была переключена на коммит [0-9a-f]{7} без ветки; возвращена на ветку change\/r3c, содержимое не менялось\.\n.*другой паре/s);
  assert.equal(branch(f), 'change/r3c', 'возврат выполнен, но вердикт по чужой паре отклонён');
});
test('Р3: ошибка переключения или неподтверждённый возврат — отказ без сообщения об успехе', async () => {
  const f = changeFixture('r3d'); detach(f);
  f.team.restoreGit = (dir, args) => { if (args[0] === 'symbolic-ref') throw Error('git: не удалось записать HEAD'); return git(dir, args); };
  await assert.rejects(f.team.change({ action: 'verdict', name: 'r3d', owner: 'o', who: 'claude', decision: 'ПРИНЯТО', base: f.base, candidate: f.cand, note: 'x' }),
    e => /не удалось записать HEAD/.test(e.message) && !/возвращена/.test(e.message));
  const g = changeFixture('r3e'); detach(g);
  g.team.restoreGit = (dir, args) => args[0] === 'branch' ? 'другая\n' : git(dir, args);
  await assert.rejects(g.team.change({ action: 'verdict', name: 'r3e', owner: 'o', who: 'claude', decision: 'ПРИНЯТО', base: g.base, candidate: g.cand, note: 'x' }),
    e => /возврат на change\/r3e не подтвердился/.test(e.message) && !/возвращена на ветку/.test(e.message));
});

// Уборка после установки.
function opFixture(name, op) {
  const root = path.join(RUN, name); fs.mkdirSync(path.join(root, 'live', 'rel'), { recursive: true });
  const file = path.join(root, 'state', 'deploy-ops', 'op-' + name + '.json');
  json(file, { id: 'op-' + name, root, release: path.join(root, 'live', 'rel'), status: 'завершено', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), message: 'Конфиги обновлены', restartEvidence: { ok: true }, ...op });
  let calls = 0;
  const opts = { root, stateDir: path.join(root, 'state'), cleanup: () => { calls++; return { removed: [1, 2], failed: [], plan: { keep: [1], blocked: [] } }; }, locked: async (r, fn) => fn() };
  return { root, file, opts, calls: () => calls, id: 'op-' + name };
}
test('Р5: уборка после установки один раз, только после «завершено»', async () => {
  const f = opFixture('p5a');
  const results = await Promise.all([1, 2, 3, 4].map(() => ad.afterDeploy(f.id, f.opts)));
  assert.equal(f.calls(), 1, results.join(' | '));
  const op = readJson(f.file);
  assert.equal(op.cleanup.state, 'готово'); assert.equal(op.cleanup.removed, 2);
  assert.equal(op.message, 'Конфиги обновлены'); assert.deepEqual(op.restartEvidence, { ok: true }, 'доказательства установки не потеряны');
  assert.match(await ad.afterDeploy(f.id, f.opts), /уже готово/);
  const halted = opFixture('p5halt', { cleanup: { state: 'идёт', started: new Date(Date.now() - 3600000).toISOString() } });
  assert.match(await ad.afterDeploy(halted.id, halted.opts), /прервана — автоматически не повторяется, нужна ручная уборка/); assert.equal(halted.calls(), 0);
  for (const status of ['откат', 'отказ', 'перезапуск не подтверждён', 'перезапуск не запущен', 'прервана', 'проба']) {
    const g = opFixture('p5s' + status.length + status[0], { status });
    assert.match(await ad.afterDeploy(g.id, g.opts), /уборки нет/, status); assert.equal(g.calls(), 0, status);
    assert(!readJson(g.file).cleanup, status);
  }
  const e = opFixture('p5err'); e.opts.cleanup = () => { throw Error('git недоступен'); };
  assert.match(await ad.afterDeploy(e.id, e.opts), /уборка: ошибка: git недоступен/);
  const op2 = readJson(e.file); assert.equal(op2.status, 'завершено', 'ошибка уборки не меняет итог установки'); assert.equal(op2.cleanup.state, 'ошибка');
});
test('Р5: ожидание конечного состояния установки и повтор при занятом замке', async () => {
  const f = opFixture('p5w', { status: 'перезапуск идёт', pid: process.pid });
  let t = 0; const opts = { ...f.opts, waitMs: 60000, pollMs: 10000, now: () => t, sleep: async ms => { t += ms; if (t >= 20000) ops.update(f.file, { status: 'завершено' }); } };
  assert.match(await ad.afterLatest(opts), /уборка: удалено 2/); assert.equal(f.calls(), 1);
  const g = opFixture('p5x', { status: 'перезапуск идёт', pid: process.pid });
  let u = 0; const gopts = { ...g.opts, waitMs: 60000, now: () => u, sleep: async ms => { u += ms; if (u >= 10000) ops.update(g.file, { status: 'перезапуск не подтверждён' }); } };
  assert.match(await ad.afterLatest(gopts), /уборки нет/); assert.equal(g.calls(), 0);
  const h = opFixture('p5y', { status: 'перезапуск идёт', pid: process.pid });
  assert.match(await ad.afterLatest({ ...h.opts, waitMs: 0 }), /повтор при следующей сводке/);
  const stale = opFixture('p5old', { status: 'перезапуск идёт', pid: process.pid, updatedAt: new Date(Date.now() - 2 * 3600000).toISOString() });
  let slept = 0; assert.match(await ad.afterLatest({ ...stale.opts, waitMs: 600000, sleep: async () => { slept++; } }), /старше часа и не завершена/);
  assert.equal(slept, 0, 'давняя незавершённая операция не ждётся');
  const busy = opFixture('p5z'); busy.opts.locked = async () => { throw Error('Репозиторий занят другой операцией.'); };
  assert.match(await ad.afterDeploy(busy.id, busy.opts), /отложена: Репозиторий занят/);
  assert(!readJson(busy.file).cleanup, 'при занятом замке поле не пишется — повтор возможен');
  busy.opts.locked = async (r, fn) => fn();
  assert.match(await ad.afterDeploy(busy.id, busy.opts), /уборка: удалено 2/);
});
test('Р5: контекст операции — чужой корень, нет релиза, старше часа, отключена', async () => {
  const a = opFixture('p5c1'); ops.update(a.file, { root: path.join(RUN, 'p5c1', 'чужой') });
  fs.mkdirSync(path.join(RUN, 'p5c1', 'чужой'));
  assert.match(await ad.afterDeploy(a.id, a.opts), /корень операции .* не совпадает/); assert.equal(a.calls(), 0);
  const s2 = opFixture('p5cs'); fs.mkdirSync(path.join(RUN, 'p5cs-другое'), { recursive: true });
  assert.match(await ad.afterDeploy(s2.id, { ...s2.opts, stateDir: path.join(RUN, 'p5cs-другое') }), /хранилище сервера .* не совпадает с хранилищем операции/); assert.equal(s2.calls(), 0);
  const b = opFixture('p5c2'); ops.update(b.file, { release: path.join(b.root, 'live', 'нет') });
  assert.match(await ad.afterDeploy(b.id, b.opts), /релиз операции не найден/); assert.equal(b.calls(), 0);
  const c = opFixture('p5c3'); const old = new Date(Date.now() - 2 * 3600000).toISOString();
  json(c.file, { ...readJson(c.file), updatedAt: old });
  assert.match(await ad.afterDeploy(c.id, c.opts), /старше часа/); assert.equal(c.calls(), 0);
  const d = opFixture('p5c4', { noCleanup: true });
  assert.equal(await ad.afterDeploy(d.id, d.opts), 'уборка: отключена'); assert.equal(d.calls(), 0);
  assert.equal(readJson(d.file).cleanup.state, 'отключена');
});
test('Р5: отключение уборки доходит до карточки операции; испорченная карточка — без уборки', async () => {
  const root = path.join(RUN, 'p5off'); fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  let t = 0; const out = await ops.start({ root, release: path.join(root, 'live', 'rel'), configs: [], restartClaude: false, cleanup: false },
    { launch: async () => 4242, alive: () => true, now: () => (t += 400000), sleep: async () => {} });
  assert.match(out, /не подтверждён/);
  const card = fs.readdirSync(path.join(root, 'state', 'deploy-ops')).find(n => n.endsWith('.json') && !n.endsWith('.pid.json'));
  assert.equal(readJson(path.join(root, 'state', 'deploy-ops', card)).noCleanup, true);
  const f = opFixture('p5bad'); write(f.file, '{ испорчено');
  assert.match(await ad.afterDeploy(f.id, f.opts), /карточка операции не прочитана/); assert.equal(f.calls(), 0);
});
test('Р5: строка уборки в сводке', () => {
  const now = Date.parse('2026-09-28T01:00:00Z');
  assert.equal(ops.cleanupLine({ state: 'отключена' }), 'уборка: отключена');
  assert.equal(ops.cleanupLine({ state: 'идёт', started: '2026-09-28T00:50:00Z' }, now), 'уборка: идёт');
  assert.equal(ops.cleanupLine({ state: 'идёт', started: '2026-09-28T00:10:00Z' }, now), 'уборка: прервана');
  assert.equal(ops.cleanupLine({ state: 'ошибка', reason: 'x' }), 'уборка: ошибка: x');
  assert.equal(ops.cleanupLine({ state: 'готово', removed: 0, failed: 0, blocked: [] }), 'уборка: удалено 0, не удалено 0');
  assert.equal(ops.cleanupLine({ state: 'готово', removed: 3, failed: 1, blocked: ['процессы не прочитаны'] }), 'уборка: удалено 3, не удалено 1 · релизы не удалялись: процессы не прочитаны');
  assert.equal(ops.cleanupLine(undefined), '', 'у старой операции строки уборки нет');
});
test('Р5: deploy без перезапуска вызывает уборку тем же вызовом, с перезапуском — нет', async () => {
  const deployer = require('../common/deploy'), saved = deployer.deploy, root = repo(path.join(RUN, 'p5d'));
  write(path.join(root, 'x'), 'x'); commit(root, 'm');
  const team = new Team(root, path.join(RUN, 'p5d-state'));
  let after = 0; team.afterDeploy = async () => { after++; return 'уборка: удалено 1, не удалено 0'; };
  try {
    deployer.deploy = async () => 'Установка op: завершено. Конфиги обновлены';
    assert.match(await team.change({ action: 'deploy', owner: 'o', commit: 'main' }), /завершено\. Конфиги обновлены\nуборка: удалено 1/);
    assert.equal(after, 1);
    await team.change({ action: 'deploy', owner: 'o', commit: 'main', restart_claude: true });
    assert.equal(after, 1, 'с перезапуском уборку делает новый сервер');
    deployer.deploy = async () => 'Результат установки не подтверждён, операция op идёт';
    await team.change({ action: 'deploy', owner: 'o', commit: 'main' });
    assert.equal(after, 1, 'без «завершено» уборки нет');
  } finally { deployer.deploy = saved; }
  const text = fs.readFileSync(path.join(ROOT, 'servers/team/index.js'), 'utf8');
  assert.match(text, /cleanup: z\.boolean\(\)\.optional\(\)/); assert.match(text, /team\.afterDeploy\(600000\)/);
});

// Дополнительная защита уборки.
function cleanFixture(name) {
  const base = path.join(RUN, name), root = repo(path.join(base, 'most'));
  write(path.join(root, 'r.txt'), 'x'); write(path.join(root, '.gitignore'), '.work/\nlive/\n'); const main = commit(root, 'main');
  const live = path.join(root, 'live'), work = path.join(root, '.work'), changes = path.join(base, 'changes'), temp = path.join(base, 'temp');
  fs.mkdirSync(live, { recursive: true }); fs.mkdirSync(temp, { recursive: true }); json(path.join(live, 'deployed.json'), { commit: 'c'.repeat(40) });
  const clone = n => { const dir = path.join(work, n); git(root, ['clone', '-q', root, dir]); for (const [k, v] of [['user.name', 'Т'], ['user.email', 't@e.invalid'], ['commit.gpgsign', 'false']]) git(dir, ['config', k, v]); json(path.join(changes, n + '.json'), { name: n, status: 'слито', work: n, candidate: main }); return dir; };
  fs.mkdirSync(changes, { recursive: true });
  const deps = { liveDir: live, workDir: work, tempDir: temp, changesDir: changes, configFiles: () => [], processes: () => [], pendingDeploy: () => null, hasLiveJobs: () => false, folderJobs: () => [], selfRelease: null, logFile: path.join(base, 'log.jsonl') };
  return { root, live, work, changes, temp, clone, deps, main };
}
const reason = (r, p) => r.plan.keep.find(x => x.path === p)?.reason || '';
test('Уборка: живые поручения всех помощников и нечитаемое хранилище', () => {
  const f = cleanFixture('c38'), c = f.clone('busy');
  const state = process.env.MOST_STATE_DIR;
  for (const status of ['running', 'queued', 'waiting_quota', 'delivery_unclear', 'cancelling', 'stop_unconfirmed', 'migration_conflict']) {
    for (const who of ['codex', 'antigravity', 'grok']) {
      const id = who + '-' + status;
      const card = who === 'codex' ? path.join(state, 'codex-jobs', id + '.json') : who === 'antigravity' ? path.join(state, 'jobs', id, 'card.json') : path.join(state, 'grok-jobs', id + '.json');
      json(card, { id, status, work: 'busy' });
      const wl = require('../common/work-owner').hasLiveJobs('busy');
      assert.equal(wl, true, who + ' ' + status);
      fs.rmSync(card);
    }
  }
  // Нечитаемое хранилище — настоящая испорченная карточка, а не подмена.
  write(path.join(state, 'codex-jobs', 'broken.json'), '{ испорчено');
  const { hasLiveJobs, folderJobs, ...deps } = f.deps;
  const r = cl.cleanup({ root: f.root }, deps);
  assert.match(reason(r, c), /поручения не проверены: Нельзя проверить поручения работы: .*broken\.json/);
  fs.rmSync(path.join(state, 'codex-jobs', 'broken.json'));
});
test('Уборка: поручение по папке клона без work, другие ветки и stash', () => {
  const f = cleanFixture('c39');
  const byFolder = f.clone('by-folder'), branches = f.clone('branches'), stash = f.clone('stash'), ok = f.clone('ok');
  const state = process.env.MOST_STATE_DIR;
  json(path.join(state, 'codex-jobs', 'fold.json'), { id: 'fold', status: 'running', folder: path.join(byFolder, 'sub') });
  json(path.join(state, 'jobs', 'agyfold', 'card.json'), { id: 'agyfold', status: 'queued', papka: path.join(ok, '..', 'ok-sibling') });
  git(branches, ['checkout', '-q', '-b', 'эксперимент']); write(path.join(branches, 'e.txt'), 'e'); commit(branches, 'эксперимент'); git(branches, ['checkout', '-q', 'main']);
  write(path.join(stash, 'r.txt'), 'правка'); git(stash, ['stash', '-q']);
  const { folderJobs, ...deps } = f.deps;
  const r = cl.cleanup({ root: f.root }, deps);
  assert.match(reason(r, byFolder), /живые поручения в папке клона: codex fold/);
  assert.match(reason(r, branches), /ветка эксперимент клона не слита в main/);
  assert.match(reason(r, stash), /в клоне есть stash/);
  assert(r.plan.remove.some(x => x.path === ok), 'соседняя папка с похожим именем не мешает');
  fs.rmSync(path.join(state, 'codex-jobs', 'fold.json')); fs.rmSync(path.join(state, 'jobs', 'agyfold'), { recursive: true });
});
test('Уборка: граница суток и время из будущего', () => {
  const f = cleanFixture('c41'), now = Date.now();
  const mk = (n, t) => { const p = path.join(f.temp, 'most-part2-' + n); write(path.join(p, 'a'), 'x'); fs.utimesSync(p, new Date(t), new Date(t)); return p; };
  const exact = mk('exact', now - DAY), younger = mk('younger', now - DAY + 60000), future = mk('future', now + DAY), older = mk('older', now - DAY - 60000);
  const r = cl.cleanup({ root: f.root }, { ...f.deps, now });
  const removes = r.plan.remove.map(x => x.path);
  assert(removes.includes(exact) && removes.includes(older), 'ровно сутки и старше — удаляются');
  assert.match(reason(r, younger), /моложе 24 часов/); assert.match(reason(r, future), /моложе 24 часов/);
});
test('Уборка: сервер не удаляет релиз, из которого работает, и настройки из deployed.json', () => {
  const f = cleanFixture('c32');
  const self = path.join(f.live, 'a'.repeat(40)), inCfg = path.join(f.live, 'b'.repeat(40)), inPrev = path.join(f.live, 'd'.repeat(40)), free = path.join(f.live, 'e'.repeat(40));
  for (const p of [self, inCfg, inPrev, free]) fs.mkdirSync(path.join(p, 'servers'), { recursive: true });
  const cfg = path.join(path.dirname(f.root), 'custom.json');
  write(cfg, JSON.stringify({ a: path.join(inCfg, 'servers', 'x.js') })); write(cfg + '.prev', JSON.stringify({ a: path.join(inPrev, 'servers', 'x.js') }));
  json(path.join(f.live, 'deployed.json'), { commit: 'c'.repeat(40), configs: [cfg] });
  const { configFiles, ...deps } = f.deps;
  const r = cl.cleanup({ root: f.root }, { ...deps, selfRelease: self });
  assert.match(reason(r, self), /из него работает сервер команды/);
  assert.match(reason(r, inCfg), /настройки .*custom\.json/); assert.match(reason(r, inPrev), /настройки .*custom\.json\.prev/);
  assert(r.plan.remove.some(x => x.path === free));
});
test('Уборка: объект, который не удалось удалить, считается в «не удалено» с причиной', () => {
  const f = cleanFixture('c43');
  const p = path.join(f.temp, 'most-part2-old'); write(path.join(p, 'a'), 'x'); const old = new Date(Date.now() - 2 * DAY); fs.utimesSync(p, old, old);
  const saved = fs.rmSync; let r;
  try { fs.rmSync = (x, o) => { if (x === p) throw Error('EBUSY: занят'); return saved(x, o); }; r = cl.cleanup({ root: f.root, apply: true }, f.deps); }
  finally { fs.rmSync = saved; }
  assert.equal(r.removed.length, 0); assert.equal(r.failed.length, 1); assert.match(r.failed[0].reason, /EBUSY/);
  assert.match(cl.cleanupText(r), /Не удалено 1:/); assert(exists(p));
});
test('Р1/Р4: правила живой проверки, опасных случаев и журнала прогона', () => {
  const text = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
  assert.match(text('rules/claude.md'), /## Меньше кругов ревью \(team-v10\)/);
  assert.match(text('rules/claude.md'), /раздел «## Опасные случаи»/); assert.match(text('rules/claude.md'), /раздел «## Живая проверка»/);
  assert.match(text('rules/grok.md'), /## Живая проверка до ревью \(team-v10\)/);
  assert.match(text('rules/grok.md'), /Журнал пишет только `tests\/run\.js`/); assert.match(text('rules/grok.md'), /не переключать ветки и коммиты/);
  assert.match(text('rules/common.md'), /ничего не переключают/); assert.match(text('rules/roles.md'), /живая проверка новой логики/);
  assert.match(text('tests/run.js'), /MOST_AFTER_DEPLOY = 'off'/); assert.match(text('tests/run.js'), /'team-v10\.js'/);
});
(async () => {
  console.log('team-v10: ' + process.platform + ' ' + process.version + '; ' + RUN);
  let passed = 0, failed = 0;
  for (const t of tests) { try { await t.fn(); passed++; console.log('OK ' + t.label); } catch (e) { failed++; console.log('ПРОВАЛ ' + t.label + '\n' + e.stack); } }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0'); process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(), 200).unref();
})();
