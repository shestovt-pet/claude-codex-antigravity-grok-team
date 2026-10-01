'use strict';
// team-v9: самопроверка Claude (Р2), краткий ответ работы (Р3), уборка (Р4), чтение результата без этапа (Р7).
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v9-'));
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const json = (f, s) => write(f, JSON.stringify(s, null, 2));
Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_TEST_KEEP: '1', MOST_CLIENT: 'claude',
  MOST_NOTIFY: 'file:' + path.join(RUN, 'notifications.jsonl'), MOST_CLAUDE_CONFIGS: '[]',
  MOST_AGY_QUOTA_FILE: path.join(RUN, 'quota.json'), MOST_AGY_LOG_DIR: path.join(RUN, 'logs'),
  MOST_CODEX_CONFIG: path.join(RUN, 'absent.toml'), MOST_AGY_MCP_CONFIG: path.join(RUN, 'absent.json'), MOST_AGY_CONFIG: path.join(RUN, 'absent-permissions.json') });
const { git } = require('../common/team-git');
const pc = require('../common/precheck'), cl = require('../common/cleanup'), { Team } = require('../common/team');
const tests = [], test = (label, fn) => tests.push({ label, fn });
const OLD = new Date(Date.now() - 3 * 24 * 3600000);
function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']); git(dir, ['config', 'user.name', 'Тест']); git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
const commit = (dir, msg) => { git(dir, ['add', '-A']); git(dir, ['commit', '-m', msg]); return git(dir, ['rev-parse', 'HEAD']).trim(); };

test('Р2: замысел — описка номера редакции и черновик с повтором Р<n>', () => {
  const f = path.join(RUN, 'design-bad.md');
  write(f, '# Замысел «x», редакция 3\n\n## Решения (редакция 2)\nР1. Первое.\nР2. Второе.\n\n## Дополнение\nР2. Черновик второго.\nР3. Новое.\n\n## Опасные случаи\n1. Нет.\n\n## Живая проверка\nНе нужна.\n');
  const w = pc.checkDesign(f);
  assert.equal(w.length, 2, w.join('\n'));
  assert.match(w[0], /design-bad\.md:3: в заголовке «редакция 2», а в первой строке — «редакция 3»/);
  assert.match(w[1], /design-bad\.md:8: раздел черновика \(строка 7\) повторно определяет Р2, уже определённое в строке 5/);
});
test('Р2: замысел — допустимые случаи без предупреждений (код, цитата, новые Р в дополнении)', () => {
  const f = path.join(RUN, 'design-ok.md');
  write(f, '# Замысел «x», редакция 2\n\n## Решения (редакция 2)\nР1. Первое.\n```\n## Черновик\nР1. Пример в коде.\n```\n> ## Дополнение\n> Р1. Цитата.\n\n## Дополнение\nР2. Новое решение.\n\n## Опасные случаи\n1. Нет.\n\n## Живая проверка\nНе нужна.\n');
  assert.deepEqual(pc.checkDesign(f), []);
});
test('Р2: уроки — несуществующий тест и путь, нераспознанная проверка; верная ссылка без предупреждений', () => {
  const dir = repo(path.join(RUN, 'lessons-repo'));
  write(path.join(dir, 'lessons.md'), '# Уроки\n');
  write(path.join(dir, 'tests/sample.js'), "test('Р1: настоящий тест', () => {});\ntest('Р3: путь с «..» внутри', () => {});\n// test('Р8: в комментарии', () => {});\nconst s = \"test('Р7: в строке'\";\n" +
    "/*\ntest('Р5: в блочном комментарии', () => {});\n*/\nconst tpl = `\ntest('Р4: в шаблоне', () => {});\n`;\n");
  write(path.join(dir, 'rules/claude.md'), 'правила\n');
  const base = commit(dir, 'база');
  fs.appendFileSync(path.join(dir, 'lessons.md'),
    'Урок A. Где закрыто: rules/claude.md, common/нет-такого.js. Проверка: tests/sample.js — тест «Р1: настоящий тест», тест «Р3: путь с «..» внутри».\n' +
    'Урок B. Где закрыто: rules/claude.md. Проверка: tests/sample.js — тест «Р9: придуманный».\n' +
    'Урок C. Раньше жил в common/удалён.js. Где закрыто: rules/claude.md и маска `tests/.tmp-*`. Проверка: живая, ревью mujx4z5x.\n' +
    'Урок D. Где закрыто: rules/claude.md. Проверка: tests/нет.js.\n' +
    'Урок E. Где закрыто: rules/claude.md. Проверка: tests/sample.js — тест «Р8: в комментарии»; tests/sample.js — тест «Р7: в строке».\n' +
    'Урок F. Где закрыто: rules/claude.md. Проверка: tests/sample.js — тест «Р1: настоящий тест», тест «Р6: второй придуманный».\n' +
    'Урок G. Где закрыто: rules/claude.md. Проверка: tests/sample.js — тест «Р5: в блочном комментарии», тест «Р4: в шаблоне».\n');
  const diff = git(dir, ['diff', '-U0', base, '--', 'lessons.md']);
  const r = pc.checkLessons(dir, diff);
  assert.deepEqual(r.warnings, ['lessons.md:2: в «Где закрыто» нет пути common/нет-такого.js', 'lessons.md:3: в tests/sample.js нет теста «Р9: придуманный»', 'lessons.md:5: нет файла tests/нет.js', 'lessons.md:6: в tests/sample.js нет теста «Р8: в комментарии»', 'lessons.md:6: в tests/sample.js нет теста «Р7: в строке»', 'lessons.md:7: в tests/sample.js нет теста «Р6: второй придуманный»',
    'lessons.md:8: в tests/sample.js нет теста «Р5: в блочном комментарии»', 'lessons.md:8: в tests/sample.js нет теста «Р4: в шаблоне»']);
  assert.deepEqual(r.unrecognized, ['lessons.md:4: «Проверка» без ссылки на tests/…']);
  const team = new Team(RUN, path.join(RUN, 'state/team'));
  const design = path.join(RUN, 'design-ok.md');
  const text = team.precheck({ folder: dir, c: { base, designFile: design } });
  assert.match(text, /^Самопроверка: предупреждений 8\n/);
  assert.match(text, /Не распознано \(проверьте сами\):\n- lessons\.md:4/);
  git(dir, ['checkout', '--', 'lessons.md']);
  assert.match(team.precheck({ folder: dir, c: { base, designFile: design } }), /^Самопроверка: предупреждений нет\nОтпечаток кандидата: [0-9a-f]{40}$/);
});
test('Р1: отпечаток кандидата видит новые файлы, не видит журнал и tmp, индекс клона не трогает; commit сверяет его', async () => {
  const fpm = require('../common/fingerprint');
  const root = repo(path.join(RUN, 'fp-root'));
  write(path.join(root, 'a.txt'), 'a'); write(path.join(root, 'tests/windows-test-output-fp.txt'), 'журнал');
  write(path.join(root, 'tests/windows-test-output-other.txt'), 'чужой журнал'); write(path.join(root, 'tests/.tmp-v6-tracked.ps1'), 'исходник');
  write(path.join(root, '.gitignore'), 'tests/.tmp-*\n.work/\n'); git(root, ['add', '-f', 'tests/.tmp-v6-tracked.ps1']); const base = commit(root, 'база');
  const clone = path.join(root, '.work', 'fp'); git(root, ['clone', '-q', root, clone]);
  for (const [k, v] of [['user.name', 'Тест'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(clone, ['config', k, v]);
  git(clone, ['checkout', '-q', '-b', 'change/fp']);
  const clean = fpm.fingerprint(clone);
  write(path.join(clone, 'new.js'), 'один');
  const one = fpm.fingerprint(clone);
  assert.notEqual(one, clean);
  write(path.join(clone, 'new.js'), 'два');
  const two = fpm.fingerprint(clone);
  assert.notEqual(two, one, 'содержимое нового файла входит в отпечаток');
  write(path.join(clone, 'tests/windows-test-output-fp.txt'), 'новый журнал'); write(path.join(clone, 'tests/.tmp-run/x'), 'x');
  assert.equal(fpm.fingerprint(clone), two, 'журнал этого клона и неотслеживаемый tmp не входят');
  write(path.join(clone, 'tests/.tmp-v6-tracked.ps1'), 'правка исходника');
  const three = fpm.fingerprint(clone);
  assert.notEqual(three, two, 'правка отслеживаемого tests/.tmp-* входит в отпечаток');
  write(path.join(clone, 'tests/windows-test-output-other.txt'), 'правка чужого журнала');
  const four = fpm.fingerprint(clone);
  assert.notEqual(four, three, 'чужой отслеживаемый журнал — исходник');
  assert.equal(git(clone, ['diff', '--cached', '--name-only']).trim(), '', 'индекс клона не тронут');
  write(path.join(clone, 'tests/.tmp-new.ps1'), 'новый исходник'); git(clone, ['add', '-f', 'tests/.tmp-new.ps1']);
  const five = fpm.fingerprint(clone);
  assert.notEqual(five, four, 'новый tests/.tmp-*, добавленный в настоящий индекс, входит');
  write(path.join(clone, 'tests/.tmp-new.ps1'), 'правка нового исходника');
  const six = fpm.fingerprint(clone);
  assert.notEqual(six, five, 'правка нового отслеживаемого tests/.tmp-* меняет отпечаток');
  assert.equal(git(clone, ['diff', '--cached', '--name-only']).trim(), 'tests/.tmp-new.ps1', 'настоящий индекс не изменён отпечатком');
  json(path.join(RUN, 'fp-state/changes/fp.json'), { name: 'fp', owner: 'o', base, candidate: base, verdicts: [], status: 'открыто' });
  const team = new Team(root, path.join(RUN, 'fp-state'));
  await assert.rejects(team.change({ action: 'commit', name: 'fp', owner: 'o', message: 'кандидат', fingerprint: five }), /Содержимое изменилось после прогона тестов/);
  const out = await team.change({ action: 'commit', name: 'fp', owner: 'o', message: 'кандидат', fingerprint: six });
  assert.match(out, /^Кандидат: [0-9a-f]{40}[\s\S]*Самопроверка: [\s\S]*Отпечаток кандидата: /);
});
test('Р1/Р2: правила прогона, самопроверки и уборки', () => {
  const text = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.match(text('rules/grok.md'), /## Полный прогон тестов по поручению \(team-v9\)/);
  assert.match(text('rules/grok.md'), /node tools\/fingerprint\.js[\s\S]*node tests\/run\.js[\s\S]*оба отпечатка/);
  assert.match(text('rules/grok.md'), /Это вывод прогона, а не собственные записи Grok/);
  assert.match(text('rules/roles.md'), /полный прогон тестов Windows в клоне изменения/);
  assert.match(text('rules/roles.md'), /Когда пишет код, гоняет только свои новые и затронутые наборы; полный прогон тестов Windows делает Grok/);
  const claude = text('rules/claude.md');
  for (const re of [/team_change precheck name/, /commit fingerprint=<отпечаток после>/, /ПОЛНЫЙ sha256 замысла/, /team_change cleanup owner=<метка>/, /оставляет там `index\.lock` и временные объекты/])
    assert.match(claude, re);
  assert.match(text('rules/brief.md'), /`precheck` \(самопроверка\) → полный прогон тестов — Grok, отпечаток → `commit fingerprint=…`/);
  assert.match(text('tests/run.js'), /'team-v8\.js', 'team-v9\.js'/);
  assert.match(text('tests/run.js'), /'windows-test-output-' \+ path\.basename\(path\.resolve\(__dirname, '\.\.'\)\)/);
});
test('Р3: краткий ответ team_work и одно сообщение на несколько принятых этапов', async () => {
  const team = new Team(RUN, path.join(RUN, 'state/team'));
  const stages = [1, 2, 3].map(i => ({ title: 'Этап ' + i, weight: i === 3 ? 50 : 25, accept_criteria: 'Критерий ' + i, closes: 'Пункт ' + i, state: 'план' }));
  const created = await team.work({ owner: 'o', action: 'create', name: 'brief', title: 'Краткость', expected_revision: 0, goal: 'Цель длинная', done_criteria: 'Итог', next_step: 'Шаг 1', stages });
  assert.match(created, /Краткость \(brief\) · редакция 1\nПринято 0 % плана · этап 1 из 3 — Этап 1\nСледующий шаг: Шаг 1\nДля следующего обновления: expected_revision 1/);
  assert(!/Цель:|Сделано:|Критерий завершения:/.test(created), created);
  const accepted = stages.map((s, i) => i < 2 ? { ...s, state: 'принят', evidence: 'Доказательство ' + (i + 1), version: 'v1' } : s);
  require('./legacy-work')(team, 'brief');
  const before = fs.existsSync(path.join(RUN, 'notifications.jsonl')) ? fs.readFileSync(path.join(RUN, 'notifications.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
  const out = await team.work({ owner: 'o', action: 'update', name: 'brief', expected_revision: 1, next_step: 'Шаг 3', stages: accepted });
  assert.equal((out.match(/Сообщение пользователю/g) || []).length, 1, out);
  assert.match(out, /Принято 50 % плана · приняты этапы: этап 1 из 3 — Этап 1 · сделано: Доказательство 1 · это закрывает: Пункт 1; этап 2 из 3 — Этап 2 · сделано: Доказательство 2 · это закрывает: Пункт 2 · дальше: Шаг 3/);
  assert.match(out, /expected_revision 2/);
  const after = fs.readFileSync(path.join(RUN, 'notifications.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after - before, 1);
  assert.match(await team.work({ owner: 'o', action: 'get', name: 'brief' }), /Цель: Цель длинная\nСделано: Этап 1: Доказательство 1; Этап 2: Доказательство 2/);
});

// Поддельные корни уборки.
function cleanupFixture(name) {
  const base = path.join(RUN, name), root = repo(path.join(base, 'most'));
  write(path.join(root, 'README.md'), 'x'); write(path.join(root, 'tests/.tmp-v6-tracked.ps1'), 'x'); git(root, ['add', '-f', 'tests/.tmp-v6-tracked.ps1']);
  write(path.join(root, '.gitignore'), 'tests/.tmp-*\n.work/\nlive/\n'); let main = commit(root, 'main');
  const live = path.join(root, 'live'), work = path.join(root, '.work'), temp = path.join(base, 'temp'), changes = path.join(base, 'changes');
  const rel = {}; for (const k of ['cur', 'prev', 'cfg', 'bak', 'proc', 'exe', 'free']) { rel[k] = path.join(live, (k + '0'.repeat(40)).replace(/[^0-9a-f]/g, 'a').slice(0, 40)); fs.mkdirSync(path.join(rel[k], 'servers/team'), { recursive: true }); }
  rel.stale = path.join(live, '.stale-free-1'); fs.mkdirSync(rel.stale);
  json(path.join(live, 'deployed.json'), { commit: path.basename(rel.cur) });
  write(path.join(live, '.archive-old.tar'), 'x'); fs.utimesSync(path.join(live, '.archive-old.tar'), OLD, OLD);
  write(path.join(live, '.archive-new.tar'), 'x');
  const cfg = path.join(base, 'claude.json'), guest = path.join(base, 'guest.toml');
  write(cfg, JSON.stringify({ mcpServers: { team: { args: [path.join(rel.cfg, 'servers', 'team', 'index.js')] } } }));
  write(cfg + '.prev', JSON.stringify({ mcpServers: { team: { args: [path.join(rel.bak, 'servers', 'team', 'index.js')] } } }));
  const clone = (n, status, extra = {}) => {
    const dir = path.join(work, n); git(root, ['clone', '-q', root, dir]); git(dir, ['config', 'user.name', 'Тест']); git(dir, ['config', 'user.email', 'test@example.invalid']); git(dir, ['config', 'commit.gpgsign', 'false']);
    json(path.join(changes, n + '.json'), { name: n, status, work: extra.work || n, candidate: extra.candidate || main, mergedAt: extra.mergedAt });
    return dir;
  };
  json(path.join(changes, 'old-merge.json'), { name: 'old-merge', status: 'слито', candidate: path.basename(rel.prev), mergedAt: '2026-01-01T00:00:00Z' });
  json(path.join(changes, 'new-merge.json'), { name: 'new-merge', status: 'слито', candidate: path.basename(rel.cur), mergedAt: '2026-02-01T00:00:00Z' });
  const merged = clone('merged', 'слито');
  const dirty = clone('dirty', 'слито'); write(path.join(dirty, 'notes.txt'), 'важное');
  const ahead = clone('ahead', 'слито'); write(path.join(ahead, 'x.txt'), 'x'); commit(ahead, 'не в main');
  const busy = clone('busy', 'слито');
  const trackedTmp = clone('tracked-tmp', 'слито'); write(path.join(trackedTmp, 'tests/.tmp-v6-tracked.ps1'), 'правка');
  const staleMain = clone('stale-main', 'слито'); write(path.join(staleMain, 'y.txt'), 'y'); const head = commit(staleMain, 'слито в main');
  git(root, ['fetch', '-q', staleMain, 'HEAD']); git(root, ['merge', '-q', '--ff-only', 'FETCH_HEAD']); main = head;
  const linked = clone('linked', 'закрыто без слияния'); const outside = path.join(base, 'outside-tests'); write(path.join(outside, '.tmp-old/a'), 'x');
  fs.utimesSync(path.join(outside, '.tmp-old'), OLD, OLD); let linkMade = true;
  try { fs.symlinkSync(outside, path.join(linked, 'tests'), 'junction'); } catch { linkMade = false; }
  const closed = clone('closed', 'закрыто без слияния');
  write(path.join(closed, 'tests/.tmp-tracked/a.txt'), 'x'); git(closed, ['add', '-f', 'tests/.tmp-tracked/a.txt']); git(closed, ['commit', '-q', '-m', 'отслеживаемый tmp']);
  write(path.join(closed, 'tests/.tmp-old/a.txt'), 'x'); fs.utimesSync(path.join(closed, 'tests/.tmp-old'), OLD, OLD); fs.utimesSync(path.join(closed, 'tests/.tmp-tracked'), OLD, OLD);
  write(path.join(closed, 'tests/.tmp-new/a.txt'), 'x');
  const open = clone('open', 'открыто'); write(path.join(open, 'tests/.tmp-old/a.txt'), 'x'); fs.utimesSync(path.join(open, 'tests/.tmp-old'), OLD, OLD);
  fs.mkdirSync(path.join(work, 'no-card'));
  write(path.join(temp, 'most-part2-old/a'), 'x'); fs.utimesSync(path.join(temp, 'most-part2-old'), OLD, OLD);
  write(path.join(temp, 'most-part2-new/a'), 'x'); write(path.join(temp, 'other-old/a'), 'x');
  const deps = { liveDir: live, workDir: work, tempDir: temp, changesDir: changes, configFiles: () => [cfg, cfg + '.prev', guest, guest + '.prev'],
    processes: () => [{ pid: 11, exe: 'C:\\Program Files\\nodejs\\node.exe', cmd: '"node.exe" "' + path.join(rel.proc, 'servers', 'team', 'index.js') + '"' },
      { pid: 12, exe: path.join(rel.exe, 'node.exe'), cmd: 'node.exe index.js --flag' }, { pid: 13, exe: null, cmd: 'npx mcp-server-google-antigravity' }],
    pendingDeploy: () => null, hasLiveJobs: (w) => w === 'busy' };
  return { root, live, work, temp, rel, deps, linkMade, outside, clones: { merged, dirty, ahead, busy, closed, open, trackedTmp, staleMain, linked } };
}
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
test('Р4: сухой прогон ничего не удаляет и перечисляет причины', () => {
  const f = cleanupFixture('dry');
  const r = cl.cleanup({ root: f.root }, f.deps), text = cl.cleanupText(r);
  const removes = r.plan.remove.map(x => path.relative(f.root, x.path).replace(/\\/g, '/')).sort();
  assert.deepEqual(removes, ['../temp/most-part2-old', '.work/closed/tests/.tmp-old', '.work/merged', '.work/stale-main', 'live/.archive-old.tar', 'live/.stale-free-1', 'live/' + path.basename(f.rel.free)].sort());
  assert.match(text, /^Уборка — сухой прогон, ничего не удалено/);
  for (const x of r.plan.remove) assert(exists(x.path), x.path);
  const reason = p => r.plan.keep.find(x => x.path === p)?.reason || '';
  assert.match(reason(f.rel.cur), /текущий релиз|последний принятый/);
  assert.match(reason(f.rel.prev), /предыдущий принятый/);
  assert.match(reason(f.rel.cfg), /настройки/);
  assert.match(reason(f.rel.bak), /настройки .*\.prev/);
  assert.match(reason(f.rel.proc), /PID 11/);
  assert.match(reason(f.rel.exe), /PID 12/);
  assert.match(reason(f.clones.dirty), /несохранённые изменения/);
  assert.match(reason(f.clones.ahead), /не найдены в main/);
  assert.match(reason(f.clones.busy), /живые поручения/);
  assert.match(reason(f.clones.closed), /закрыто без слияния/);
  assert.match(reason(f.clones.open), /«открыто»/);
  assert.match(reason(path.join(f.clones.closed, 'tests/.tmp-tracked')), /отслеживается git/);
  assert.match(reason(path.join(f.work, 'no-card')), /нет карточки/);
  assert.match(reason(f.clones.trackedTmp), /несохранённые изменения: .*tests\/\.tmp-v6-tracked\.ps1/);
  if (f.linkMade) assert.match(reason(path.join(f.clones.linked, 'tests', '.tmp-old')), /ссылка или junction/);
  assert(!r.plan.keep.concat(r.plan.remove).some(x => x.path.includes(path.join('open', 'tests'))), 'tmp идущего изменения не трогается');
});
test('Р4: apply удаляет только разрешённое', () => {
  const f = cleanupFixture('apply');
  const log = path.join(f.root, 'cleanup-log.jsonl');
  const r = cl.cleanup({ root: f.root, apply: true, owner: 'cowork-test' }, { ...f.deps, logFile: log });
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  const entry = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  assert.equal(entry.owner, 'cowork-test'); assert.equal(entry.removed.length, 7);
  assert.equal(r.removed.length, 7);
  for (const x of r.removed) assert(!exists(x.path), x.path);
  for (const k of ['cur', 'prev', 'cfg', 'bak', 'proc', 'exe']) assert(exists(f.rel[k]), k);
  for (const k of ['dirty', 'ahead', 'busy', 'closed', 'open', 'trackedTmp', 'linked']) assert(exists(f.clones[k]), k);
  assert(!exists(f.clones.staleMain), 'слитый клон с устаревшей локальной main удаляется');
  assert(exists(path.join(f.outside, '.tmp-old')), 'через junction ничего не удалено');
  assert(exists(path.join(f.clones.closed, 'tests/.tmp-tracked')) && exists(path.join(f.clones.closed, 'tests/.tmp-new')));
  assert(exists(path.join(f.clones.dirty, 'notes.txt')) && exists(path.join(f.temp, 'most-part2-new')) && exists(path.join(f.temp, 'other-old')));
  assert(exists(path.join(f.live, '.archive-new.tar')));
  assert.match(cl.cleanupText(r), /^Уборка выполнена · cowork-test\.\nУдалено 7:/);
});
test('Р4: недоступная командная строка, относительный путь или непрочитанный источник — ни одного релиза', () => {
  for (const [label, patch] of [
    ['cmd null', { processes: () => [{ pid: 21, exe: 'node.exe', cmd: null }] }],
    ['относительный', { processes: () => [{ pid: 22, exe: 'node.exe', cmd: 'node servers\\team\\index.js' }] }],
    ['относительный с точкой', { processes: () => [{ pid: 23, exe: 'node.exe', cmd: 'node .\\servers\\team\\index.js' }] }],
    ['процессы', { processes: () => { throw Error('доступ запрещён'); } }],
  ]) {
    const f = cleanupFixture('blocked-' + label.replace(/\s/g, '-'));
    const r = cl.cleanup({ root: f.root, apply: true }, { ...f.deps, ...patch });
    assert(exists(f.rel.free) && exists(f.rel.stale), label);
    assert(r.plan.blocked.length, label);
    assert.match(cl.cleanupText(r), /Релизы не удаляются: /, label);
    assert(!exists(f.clones.merged), label + ': клоны и временные папки проверяются отдельно');
  }
});
test('Р4: путь процесса с точками узнаётся; повторная проверка — перед каждым удалением', () => {
  const f = cleanupFixture('dots');
  const dotted = f.live + path.sep + '.' + path.sep + path.basename(f.rel.free) + path.sep + 'servers' + path.sep + 'team' + path.sep + 'index.js';
  const up = f.live + path.sep + '..' + path.sep + 'live' + path.sep + path.basename(f.rel.stale) + path.sep + 'x.js';
  let first = true;
  const r = cl.cleanup({ root: f.root, apply: true }, { ...f.deps,
    processes: () => [{ pid: 31, exe: 'node.exe', cmd: '"node.exe" "' + dotted + '"' }, { pid: 32, exe: 'node.exe', cmd: 'node.exe --script=' + up }],
    afterRemove: () => { if (first) { first = false; write(path.join(f.clones.staleMain, 'late.txt'), 'появилось во время уборки'); } } });
  assert(exists(f.rel.free) && exists(f.rel.stale));
  assert.match(r.plan.keep.find(x => x.path === f.rel.free).reason, /PID 31/);
  assert.match(r.plan.keep.find(x => x.path === f.rel.stale).reason, /PID 32/);
  assert(exists(f.clones.staleMain), 'клон с новой правкой не удалён');
  assert.match(r.failed.find(x => x.path === f.clones.staleMain)?.reason || '', /повторная проверка: несохранённые изменения/);
});
test('Р4: путь в настройках с «..» узнаётся; относительный путь в настройках — ни одного релиза', () => {
  const f = cleanupFixture('cfg-dots');
  const cfg = path.join(path.dirname(f.root), 'dots.json');
  write(cfg, JSON.stringify({ mcpServers: { team: { command: 'C:\\Program Files\\nodejs\\node.exe', args: [f.live + path.sep + '..' + path.sep + 'live' + path.sep + path.basename(f.rel.free) + path.sep + 'servers' + path.sep + 'team' + path.sep + 'index.js'] } } }));
  const r = cl.cleanup({ root: f.root, apply: true }, { ...f.deps, configFiles: () => [cfg] });
  assert(exists(f.rel.free));
  assert.match(r.plan.keep.find(x => x.path === f.rel.free).reason, /настройки .*dots\.json/);
  const g = cleanupFixture('cfg-relative'), rel = path.join(path.dirname(g.root), 'rel.json');
  write(rel, JSON.stringify({ mcpServers: { team: { command: 'node', args: ['servers/team/index.js'] } } }));
  const r2 = cl.cleanup({ root: g.root, apply: true }, { ...g.deps, configFiles: () => [rel] });
  assert(exists(g.rel.free) && exists(g.rel.stale));
  assert.match(cl.cleanupText(r2), /Релизы не удаляются: .*в настройках .*rel\.json относительный путь/);
  // Слово без разделителя — не путь: настройка Codex web_search = "live" не должна выключать уборку (Grok 697c29c5).
  const h = cleanupFixture('cfg-word'), toml = path.join(path.dirname(h.root), 'config.toml');
  write(toml, 'model = "gpt"\nweb_search = "live"\n[mcp_servers.team]\nargs = [\'servers\']\n');
  const r3 = cl.cleanup({ root: h.root }, { ...h.deps, configFiles: () => [toml], processes: () => [{ pid: 41, exe: 'node.exe', cmd: 'node.exe --mode live' }] });
  assert.deepEqual(r3.plan.blocked, []);
  assert(r3.plan.remove.some(x => x.path === h.rel.free));
  // Путь, записанный в JSON через \uXXXX, тоже узнаётся (Antigravity muk26x2d).
  const u = cleanupFixture('cfg-unicode'), uj = path.join(path.dirname(u.root), 'u.json');
  const target = JSON.stringify(path.join(u.rel.free, 'servers', 'team', 'index.js')).slice(1, -1);
  write(uj, '{"args": ["\\u' + target.charCodeAt(0).toString(16).padStart(4, '0') + target.slice(1) + '"]}');
  const r4 = cl.cleanup({ root: u.root }, { ...u.deps, configFiles: () => [uj] });
  assert.match(r4.plan.keep.find(x => x.path === u.rel.free)?.reason || '', /настройки .*u\.json/);
});
test('Р4: идущая установка — отказ; ссылка или junction не удаляется', () => {
  const f = cleanupFixture('pending');
  assert.throws(() => cl.cleanup({ root: f.root }, { ...f.deps, pendingDeploy: () => ({ id: 'op-1' }) }), /Идёт установка op-1/);
  const target = path.join(f.root, 'outside'); fs.mkdirSync(target);
  const link = path.join(f.live, 'b'.repeat(40));
  try { fs.symlinkSync(target, link, 'junction'); } catch (e) { console.log('ПРОПУСК части про ссылку: ' + e.message); return; }
  const r = cl.cleanup({ root: f.root, apply: true }, f.deps);
  assert(exists(link) && exists(target));
  assert(!r.removed.some(x => x.path === link));
});
test('Р8: вердикт в парном выделении Markdown засчитывается, непарное — нет', () => {
  const stores = require('../common/team-store'), crypto = require('crypto'), base = 'a'.repeat(40), candidate = 'b'.repeat(40);
  for (const who of ['codex', 'antigravity']) for (const [last, decision, ok] of [
    ['**ПРИНЯТО**', 'ПРИНЯТО', true], ['*ПРИНЯТО*', 'ПРИНЯТО', true], ['__ПРИНЯТО__', 'ПРИНЯТО', true], ['_ПРИНЯТО_', 'ПРИНЯТО', true], ['_ПРИНЯТО', 'ПРИНЯТО', false],
    ['**НЕ ПРИНЯТО: 2 блокирующих**', 'НЕ ПРИНЯТО', true], ['ПРИНЯТО', 'ПРИНЯТО', true],
    ['**ПРИНЯТО', 'ПРИНЯТО', false], ['ПРИНЯТО**', 'ПРИНЯТО', false], ['**НЕ ПРИНЯТО**', 'ПРИНЯТО', false], ['**ПРИНЯТО**', 'НЕ ПРИНЯТО', false],
  ]) {
    const id = 'md-' + who + '-' + crypto.randomUUID().slice(0, 8), dir = path.join(stores.roots()[who], id), text = 'Замечания\n' + last;
    const file = who === 'codex' ? id + '.attempt-0.result.txt' : 'result.txt';
    write(path.join(dir, file), text); json(path.join(dir, 'meta.json'), { hash: crypto.createHash('sha256').update(text).digest('hex') });
    json(path.join(dir, 'card.json'), { id, status: 'done', mode: 'review', task: base + ' ' + candidate + ' #d17b3da7' });
    const run = () => stores.review(who, id, base, candidate, decision, '#d17b3da7');
    if (ok) assert.equal(run().reviewText, text, last); else assert.throws(run, /Последняя строка/, last);
  }
});
test('Р7: результат Antigravity читается без этапа, постановка без этапа по-прежнему отказывает', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'servers/antigravity/index.js')],
    env: { ...process.env, AGY_PATH: path.join(__dirname, 'fake-agy.js'), MOST_AGY_INPUT_FORMAT: 'legacy' }, stderr: 'pipe' });
  const client = new Client({ name: 'team-v9', version: '1' }); await client.connect(transport);
  const text = r => r.content.map(c => c.text || '').join('\n');
  try {
    const folder = path.join(RUN, 'agy'); fs.mkdirSync(folder);
    await new Team(RUN, path.join(RUN, 'state/team')).work({ owner: 'o', action: 'create', name: 'w', title: 'Р7', expected_revision: 0, goal: 'Цель', done_criteria: 'Итог', next_step: 'Шаг',
      stages: [{ title: 'Этап', weight: 100, accept_criteria: 'Критерий', state: 'идёт' }] });
    assert.match(text(await client.callTool({ name: 'antigravity_send', arguments: { folder, task: 'Напиши строку', work: 'w', owner: 'o' } })), /укажите этап/);
    const sent = text(await client.callTool({ name: 'antigravity_send', arguments: { folder, task: 'Напиши строку' } }));
    const id = /Задание (\S+) (?:запущено|в очереди)/.exec(sent)?.[1]; assert(id, sent);
    const result = text(await client.callTool({ name: 'antigravity_result', arguments: { id, work: 'w', owner: 'o', wait_sec: 1 } }));
    assert(!/укажите этап/.test(result), result);
  } finally { await client.close(); await transport.close(); }
});
(async () => {
  console.log('team-v9: ' + process.platform + ' ' + process.version + '; ' + RUN);
  let passed = 0, failed = 0;
  for (const t of tests) { try { await t.fn(); passed++; console.log('OK ' + t.label); } catch (e) { failed++; console.log('ПРОВАЛ ' + t.label + '\n' + e.stack); } }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0'); process.exitCode = failed ? 1 : 0;
})();
