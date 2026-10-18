'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process');
const { RUN, write, json, run } = require('./team-v16-fixture');
const drift = require('../common/release-drift');
let seq = 0;
function fixture() {
  const root = path.join(RUN, 'git-' + (++seq)); fs.mkdirSync(root);
  const git = (...args) => {
    const r = cp.spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  write(path.join(root, '.gitignore'), 'state/\nlive/\n'); write(path.join(root, 'file.txt'), 'base');
  git('add', '.gitignore', 'file.txt'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD'), state = path.join(root, 'state');
  fs.mkdirSync(state); fs.mkdirSync(path.join(root, 'live'));
  const deploy = commit => json(path.join(root, 'live', 'deployed.json'), { commit, method: 'внешним сценарием', at: '2026-10-03T00:00:00Z' });
  const ready = commit => json(path.join(state, 'ready', 'team.json'), { release: path.join(root, 'live', commit), pid: process.pid });
  return { root, state, git, base, deploy, ready, lines: () => drift.lines(root, state).join('\n') };
}
const tests = [], test = (n, fn) => tests.push([n, fn]);
test('Р9: равен main — тихо', () => { const f = fixture(); f.deploy(f.base); f.ready(f.base); assert.equal(f.lines(), ''); });
test('Р9: предок main — ждёт установки без предупреждения', () => {
  const f = fixture(); f.deploy(f.base); f.ready(f.base);
  write(path.join(f.root, 'file.txt'), 'next'); f.git('add', 'file.txt'); f.git('commit', '-m', 'next');
  assert.equal(f.lines(), 'Работающая версия отстаёт от main, ждёт установки');
});
test('Р9: неизвестный объект git и отдельная ветка', () => {
  const f = fixture(); f.deploy('a'.repeat(40)); assert.match(f.lines(), /не из main: установлена внешним сценарием, 2026/);
  // commit-tree создаёт отдельного потомка базы без переключения рабочей ветки и индекса.
  const separate = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-p', f.base, '-m', 'separate');
  f.deploy(separate); assert.match(f.lines(), /не из main/);
});
test('Р9: ready расходится с записанной установкой', () => {
  const f = fixture(); f.deploy(f.base); f.ready('b'.repeat(40)); assert.match(f.lines(), /Серверы запущены не из записанной установки/);
});
test('Р9: нет deployed.json', () => {
  const f = fixture(); assert.match(f.lines(), /нет deployed.json/); f.ready(f.base);
  assert.match(f.lines(), /Серверы запущены не из записанной установки/);
});
test('Р9: изменённый и неотслеживаемый файлы; works и _handoff исключены', () => {
  const f = fixture(); f.deploy(f.base);
  write(path.join(f.root, 'file.txt'), 'changed'); write(path.join(f.root, 'новый.txt'), 'new');
  write(path.join(f.root, 'works', 'note.txt'), 'work'); write(path.join(f.root, '_handoff', 'note.txt'), 'handoff');
  assert.match(f.lines(), /несохранённые изменения кода: 2 файлов/);
});
test('Р9: результаты прогона исключены, отслеживаемые файлы и обычные новые исходники учтены', () => {
  const f = fixture(); f.deploy(f.base);
  for (const name of ['tests/windows-test-output-fixture.txt', 'tests/.tmp-run/result.txt', 'tests/.tmp-note.txt'])
    write(path.join(f.root, name), 'test output');
  assert.equal(f.lines(), '');
  for (const name of ['tests/windows-test-output-tracked.txt', 'tests/.tmp-tracked.js'])
    write(path.join(f.root, name), 'tracked');
  f.git('add', 'tests/windows-test-output-tracked.txt', 'tests/.tmp-tracked.js');
  f.git('commit', '-m', 'tracked test files'); f.deploy(f.git('rev-parse', 'HEAD'));
  write(path.join(f.root, 'tests/windows-test-output-tracked.txt'), 'changed');
  write(path.join(f.root, 'tests/.tmp-tracked.js'), 'changed');
  write(path.join(f.root, 'tests/new-test.js'), 'new source');
  write(path.join(f.root, 'tests/windows-test-output-not-a-log.js'), 'new source');
  assert.match(f.lines(), /несохранённые изменения кода: 4 файлов/);
});

test('Р9: чтение сводки не меняет списки и байты state/live', async () => {
  const f = fixture(); f.deploy(f.base); f.ready(f.base);
  const snapshot = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name); return e.isDirectory() ? snapshot(p) : [[p, fs.readFileSync(p).toString('base64')]];
  });
  const before = [snapshot(f.state), snapshot(path.join(f.root, 'live'))];
  f.lines(); f.lines();
  const team = new (require('../common/team').Team)(f.root, f.state);
  const text = await require('../common/summary').compact(team, 'Тестовый снимок квот');
  assert.match(text, /Последнее развёртывание/);
  assert.deepEqual([snapshot(f.state), snapshot(path.join(f.root, 'live'))], before);
});
test('Р9: team_status краткий и полный не обновляют поручения, этапы и установку', async () => {
  const f = fixture(); f.deploy(f.base); f.ready(f.base);
  process.env.CODEX_PATH = path.join(__dirname, 'fake-codex.js');
  process.env.MOST_CODEX_SESSIONS = path.join(RUN, 'empty-sessions');
  const globalState = require('../common/paths').stateDir;
  json(path.join(globalState, 'grok-jobs', 'status-pending.json'), { id: 'status-pending', status: 'running',
    startedAt: '2020-01-01T00:00:00Z', task: 'Тестовое поручение' });
  json(path.join(f.state, 'deploy-ops', 'old.json'), { id: 'old', status: 'перезапуск идёт',
    createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', pid: 99999999 });
  json(path.join(f.root, 'works', 'status-work.json'), { name: 'status-work', revision: 1, goal: 'цель', done_criteria: 'готово', next_step: 'проверить', reminders: [],
    stages: [{ id: 's', title: 'Итог', state: 'принят', weight: 100, rules_version: 15, level: 'обычный',
      version: 'status-version', author: { family: 'anthropic', model: 'claude' }, gate: { files: [], reasons: [] } }] });
  const snapshot = dir => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name); return e.isDirectory() ? snapshot(p) : [[p, fs.readFileSync(p).toString('base64')]];
  });
  const roots = [f.state, path.join(f.root, 'live'), path.join(f.root, 'works'), globalState], before = roots.map(snapshot);
  const team = new (require('../common/team').Team)(f.root, f.state);
  for (const full of [false, true]) {
    const text = await team.status(undefined, undefined, false, full);
    assert.doesNotMatch(text, /status-p/); assert.match(text, /status-work/); assert(!text.includes('карточка повреждена')); assert.deepEqual(roots.map(snapshot), before);
  }
});
run(tests);
