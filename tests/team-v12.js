'use strict';
// team-v12: хвосты публикации — проверка npm без оболочки (Р1), своя запись (Р2), голоса по текущему замыслу (Р3),
// отпечаток без записи в клон (Р4), правила и порядок публикации (Р5–Р6).
const fs = require('fs'), path = require('path'), assert = require('assert'), os = require('os'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v12-'));
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const read = (f) => fs.readFileSync(f, 'utf8');
Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_TEST_KEEP: '1', MOST_CLIENT: 'claude',
  MOST_NOTIFY: 'off', MOST_CLAUDE_CONFIGS: '[]', MOST_AFTER_DEPLOY: 'off' });
const { git } = require('../common/team-git');
const own = require('../common/ownership'), pc = require('../common/precheck'), fp = require('../common/fingerprint');
const setupMod = require('../tools/setup');
const tests = [], test = (label, fn) => tests.push({ label, fn });
const H = 'a'.repeat(40);
function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.name', 'Тест'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(dir, ['config', k, v]);
  return dir;
}
const commit = (dir, msg = 'x') => { git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', msg]); return git(dir, ['rev-parse', 'HEAD']).trim(); };
const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
const files = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } }; walk(dir); return out.sort(); };

test('Р1 случаи 1–3: npm проверяется так же, как его использует установка, и без оболочки', () => {
  const src = read(path.join(ROOT, 'tools/setup.js'));
  assert(!/shell\s*[:,)]/.test(src) && !/npm\.cmd/.test(src), 'в setup нет вызовов с оболочкой и npm.cmd');
  const withCli = path.join(RUN, 'node-with-npm'), without = path.join(RUN, 'node-without-npm');
  write(path.join(withCli, 'node_modules/npm/bin/npm-cli.js'), ''); fs.mkdirSync(without, { recursive: true });
  const dir = path.join(RUN, 'zip'); fs.mkdirSync(dir, { recursive: true });
  const npm = (deps) => setupMod.checks(dir, { nodeVersion: '20.0.0', ...deps }).find((x) => x.name === 'npm');
  assert.equal(npm({ platform: 'win32', execPath: path.join(withCli, 'node.exe') }).ok, true, 'Windows: npm-cli.js рядом с node — найден, npm.cmd не нужен');
  const dirCli = path.join(RUN, 'node-dir-npm'); fs.mkdirSync(path.join(dirCli, 'node_modules/npm/bin/npm-cli.js'), { recursive: true });
  assert.equal(npm({ platform: 'win32', execPath: path.join(dirCli, 'node.exe') }).ok, false, 'папка вместо файла — не npm');
  const miss = npm({ platform: 'win32', execPath: path.join(without, 'node.exe') });
  assert.equal(miss.ok, false); assert.match(miss.text, /npm не найден — рядом с Node\.js нет npm: переустановите Node\.js/);
  assert.match(read(path.join(ROOT, 'common/deploy.js')), /node_modules\/npm\/bin\/npm-cli\.js/, 'установка использует тот же npm-cli.js');
  // Настоящий запуск проверок в отдельном процессе: в выводе нет предупреждения DEP0190.
  const r = cp.spawnSync(process.execPath, ['-e', "require(process.argv[1]).checks(process.argv[2], {})", path.join(ROOT, 'tools/setup.js'), dir], { encoding: 'utf8' });
  assert(!/DEP0190|not escaped/.test(r.stderr + r.stdout), r.stderr);
});

test('Р2 случаи 4–6: своя запись — live этого корня или его MOST_REPO_ROOT без путей наружу; ссылки раскрываются', () => {
  const root = path.join(RUN, 'root'), other = path.join(RUN, 'other');
  fs.mkdirSync(path.join(root, 'live', H, 'servers', 'team'), { recursive: true }); fs.mkdirSync(other, { recursive: true });
  const live = path.join(root, 'live', H, 'servers', 'team', 'index.js'); write(live, '');
  const env = { MOST_REPO_ROOT: root };
  assert(own.own({ command: 'node', args: [live] }, 'team', root));
  assert(own.own({ command: 'C:\\Program Files\\nodejs\\node.exe', args: [live], env }, 'team', root), 'путь node — не путь установки');
  assert(own.own({ command: 'node', env }, 'team', root), 'только env и node из PATH — своя (старые записи)');
  assert(!own.own({ command: 'node', args: [path.join(other, 'x.js')], env }, 'team', root), 'env этого корня, аргумент наружу — чужая (Grok f6194748)');
  assert(!own.own({ command: path.join(other, 'run.cmd'), env }, 'team', root), 'команда из другой папки — чужая');
  assert(!own.own({ command: 'node', env: { MOST_REPO_ROOT: other } }, 'team', root));
  try {
    link(root, path.join(RUN, 'root-link')); link(other, path.join(root, 'out'));
    assert(own.own({ args: [path.join(RUN, 'root-link', 'live', H, 'servers', 'team', 'index.js')] }, 'team', root), 'ссылка на этот корень — своя');
    assert(!own.own({ command: 'node', args: [path.join(root, 'out', 'x.js')], env }, 'team', root), 'переход каталога наружу — чужая');
    assert(!own.pointsInto({ command: 'node', args: [path.join(root, 'out', 'servers', 'most.js')] }, root), 'старая чистка не удаляет запись через переход наружу');
    assert(own.pointsInto({ command: 'node', args: [path.join(RUN, 'root-link', 'servers', 'most.js')] }, root));
    // Случай 16: корень сам задан ссылкой — те же ответы, что для настоящего пути.
    assert(own.own({ args: [live] }, 'team', path.join(RUN, 'root-link')));
    assert(own.own({ command: 'node', env: { MOST_REPO_ROOT: path.join(RUN, 'root-link') } }, 'team', root));
  } catch (e) { if (e.code !== 'EPERM') throw e; }
  // Codex 7c835105: противоречащие признаки — не наша запись, и старая чистка её не трогает.
  assert(!own.own({ args: [live], env: { MOST_REPO_ROOT: other } }, 'team', root), 'свой live, чужой env — чужая');
  assert(!own.own({ args: [live] }, 'grok', root), 'свой live с именем другого сервера — чужая');
  assert(!own.pointsInto({ command: 'node', args: [path.join(other, 'server.js')], env }, root), 'свой env, чужой путь — старая чистка не удаляет');
  assert(!own.pointsInto({ command: 'node', args: [path.join(root, 'servers', 'most.js')], env: { MOST_REPO_ROOT: other } }, root));
  assert(own.pointsInto({ command: 'node', args: [path.join(root, 'servers', 'most.js')] }, root));
  assert(!own.own({ command: 'node', args: ['C:\\most-other\\x.js'], env: { MOST_REPO_ROOT: 'C:\\most' } }, 'team', 'C:\\most'), 'соседний корень');
  assert(own.own({ command: 'D:\\nvm\\v20\\node.exe', args: ['C:\\most\\live\\' + H + '\\servers\\team\\index.js'] }, 'team', 'C:\\most'), 'node из nvm');
  // Строковые пути Windows по-прежнему: «..», слэши, регистр.
  assert(!own.pointsInto({ args: ['C:\\A\\..\\B\\servers\\most.js'] }, 'C:\\A'));
  assert(own.own({ args: ['c:/a/live/' + H + '/servers/team/index.js'] }, 'team', 'C:\\A'));
});

test('Р3 случаи 7, 20–24: самопроверка называет недостающие голоса по текущему замыслу', () => {
  const file = path.join(RUN, 'design.md'); write(file, 'замысел');
  const d = require('crypto').createHash('sha256').update('замысел').digest('hex'), old = 'e'.repeat(64);
  const c = { name: 'x', request: 'r', designFile: file, designHash: d, designVotes: [
    { who: 'codex', decision: 'ПРИНЯТО', designHash: old }, { who: 'antigravity', decision: 'ПРИНЯТО', designHash: d }],
    grokDesign: { job_id: 'g', designHash: old, decision: 'ПРИНЯТО' } };
  const s8 = d.slice(0, 8);
  assert.deepEqual(pc.designVoteWarnings(c), [
    'Codex не голосовал по замыслу ' + s8 + ': commit откажет — отправьте ему эту редакцию',
    'Grok не запрошен по замыслу ' + s8 + ': merge откажет — отправьте ему эту редакцию']);
  c.designVotes.push({ who: 'codex', decision: 'НЕ ПРИНЯТО', designHash: d });
  c.grokDesign = { job_id: 'g2', designHash: d, status: 'running' };
  assert.deepEqual(pc.designVoteWarnings(c), ['Codex: по замыслу ' + s8 + ' — НЕ ПРИНЯТО; commit откажет', 'Grok: ждём ответ по замыслу ' + s8 + ' (g2)']);
  c.designVotes.push({ who: 'user', replaces: 'codex', decision: 'ПРИНЯТО', designHash: d });
  c.grokDesign = { job_id: 'g3abcdefgh', designHash: d, status: 'done', decision: 'НЕ ПРИНЯТО' };
  assert.deepEqual(pc.designVoteWarnings(c), ['Grok: НЕ ПРИНЯТО по замыслу ' + s8 + ' — merge потребует абзац с «Где закрыто:» или «Отклонено:» для g3abcdef']);
  c.grokDesign = { job_id: 'g5abcdefgh', designHash: d, status: 'failed' };
  assert.deepEqual(pc.designVoteWarnings(c), ['Grok: отказ поручения по замыслу ' + s8 + ' — merge потребует абзац с «Отклонено:» или «Grok недоступен:» для g5abcdef']);
  c.grokDesign = { status: 'недоступен', designHash: d };
  assert.match(pc.designVoteWarnings(c)[0], /Grok недоступен по замыслу .*«Grok недоступен x:»/);
  c.grokDesign = { job_id: 'g4', designHash: d, status: 'done', decision: 'ПРИНЯТО' };
  assert.deepEqual(pc.designVoteWarnings(c), []);
  // Файл замысла изменён без вызова design: хеш из файла, карточка не сохраняется, все голоса по прежнему хешу — устаревшие.
  write(file, 'замысел, редакция 2');
  const w = pc.designVoteWarnings(c);
  assert.match(w[0], new RegExp('файл замысла изменён после записи: [0-9a-f]{8} вместо ' + s8));
  assert.equal(w.length, 4); assert.equal(c.designHash, d, 'карточка не изменена');
  write(file, 'замысел');
  assert.deepEqual(pc.designVoteWarnings({ ...c, designFile: path.join(RUN, 'нет.md') }), [pc.designVoteWarnings({ ...c, designFile: path.join(RUN, 'нет.md') })[0]]);
  assert.match(pc.designVoteWarnings({ ...c, designFile: path.join(RUN, 'нет.md') })[0], /файл замысла не прочитан .* голоса по замыслу не проверены/);
  assert.deepEqual(pc.designVoteWarnings({ name: 'старый формат' }), [], 'изменение без запроса и замысла');
  const team = read(path.join(ROOT, 'common/team.js'));
  assert.match(team, /lessonsDiff: diff, change: p\.c/);
  assert.match(team, /Сначала ворота замысла[^\n]*\n[^\n]*designVoteWarnings\(c\)/, 'ранний отказ commit называет недостающие голоса');
});

test('Р4 случаи 8–9: отпечаток прежний по значению и не создаёт файлов в .git клона', () => {
  const r = repo(path.join(RUN, 'fp'));
  write(path.join(r, 'a.txt'), 'a'); write(path.join(r, 'tests/.tmp-tracked.ps1'), 'src'); git(r, ['add', '-f', 'tests/.tmp-tracked.ps1']); commit(r);
  write(path.join(r, 'a.txt'), 'b'); write(path.join(r, 'new.txt'), 'n'); write(path.join(r, 'tests/.tmp-run/x'), 'вывод');
  write(path.join(r, 'tests/windows-test-output-fp.txt'), 'журнал');
  const before = files(path.join(r, '.git'));
  const v = fp.fingerprint(r);
  assert.deepEqual(files(path.join(r, '.git')), before, 'в .git клона ничего не появилось');
  assert.equal(fp.fingerprint(r), v, 'повтор — то же значение');
  // Прежний алгоритм на копии: тот же набор файлов → тот же хеш дерева.
  const copy = path.join(RUN, 'fp-copy'); fs.cpSync(r, copy, { recursive: true });
  const idx = path.join(RUN, 'fp-index'), env = { ...process.env, GIT_INDEX_FILE: idx };
  const g = (args) => cp.execFileSync('git', args, { cwd: copy, env, encoding: 'utf8' }).trim();
  g(['read-tree', 'HEAD']); g(['add', '-A', '--', '.', ':(exclude)tests/windows-test-output-fp-copy.txt', ':(exclude)tests/windows-test-output-fp.txt', ':(exclude)tests/.tmp-*']);
  g(['add', '-A', '-f', '--', 'tests/.tmp-tracked.ps1']);
  assert.equal(g(['write-tree']), v);
  const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('most-fingerprint-')).length;
  const n = leftovers();
  assert.throws(() => fp.fingerprint(path.join(RUN, 'не-репозиторий')));
  // Сбой внутри расчёта, когда временные индекс и папка объектов уже созданы: пустой репозиторий без HEAD.
  const empty = repo(path.join(RUN, 'fp-empty')); write(path.join(empty, 'x.txt'), 'x');
  assert.throws(() => fp.fingerprint(empty), /HEAD|read-tree|Command failed/);
  assert.equal(leftovers(), n, 'после ошибки временные папки удалены');
  // Codex d8da5f4e, случай 27: GIT_OBJECT_DIRECTORY и alternates заданы снаружи — объекты клона остаются доступны.
  const ext = path.join(RUN, 'fp-ext-objects'); fs.mkdirSync(ext);
  const saved = { o: process.env.GIT_OBJECT_DIRECTORY, a: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES };
  try {
    process.env.GIT_OBJECT_DIRECTORY = ext; process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = path.join(r, '.git', 'objects');
    assert.equal(fp.fingerprint(r), v, 'то же значение при внешних переменных');
  } finally { for (const [k, x] of [['GIT_OBJECT_DIRECTORY', saved.o], ['GIT_ALTERNATE_OBJECT_DIRECTORIES', saved.a]]) if (x === undefined) delete process.env[k]; else process.env[k] = x; }
  assert.deepEqual(fs.readdirSync(ext), [], 'во внешнюю папку объектов тоже ничего не записано');
  assert.deepEqual(files(path.join(r, '.git')), before);
});

test('Р6 случай 11: обновление публичной копии — новый коммит поверх опубликованного, удалённое исчезает, push без силы', () => {
  const hub = path.join(RUN, 'hub.git'); fs.mkdirSync(hub); git(hub, ['init', '-q', '--bare', '-b', 'main']);
  const first = repo(path.join(RUN, 'pub-first')); write(path.join(first, 'a.txt'), '1'); write(path.join(first, 'gone.txt'), 'x');
  const published = commit(first, 'первая'); git(first, ['push', '-q', hub, 'main']);
  // Новая выгрузка: a изменён, gone удалён, new добавлен; история — из «GitHub».
  const exp = path.join(RUN, 'export'); write(path.join(exp, 'a.txt'), '2'); write(path.join(exp, 'new.txt'), 'n');
  write(path.join(exp, '.gitignore'), 'tests/.tmp-*\n'); write(path.join(exp, 'tests/.tmp-v6-restart-parse.ps1'), 'исходник');
  cp.execFileSync('git', ['clone', '-q', '--no-checkout', hub, path.join(RUN, 'pub')]);
  fs.renameSync(path.join(RUN, 'pub', '.git'), path.join(exp, '.git'));
  git(exp, ['read-tree', 'HEAD']);
  git(exp, ['add', '-A', '-f', '.']);
  assert.deepEqual(git(exp, ['status', '--short']).trim().split('\n').map((l) => l.trim()).sort(),
    ['A  .gitignore', 'A  new.txt', 'A  tests/.tmp-v6-restart-parse.ps1', 'D  gone.txt', 'M  a.txt']);
  assert.deepEqual(git(exp, ['ls-files']).trim().split('\n').sort(), ['.gitignore', 'a.txt', 'new.txt', 'tests/.tmp-v6-restart-parse.ps1'], 'состав = выгрузка один в один');
  git(exp, ['-c', 'user.name=login', '-c', 'user.email=1+login@users.noreply.github.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'обновление']);
  assert.equal(git(exp, ['log', '-1', '--format=%an <%ae> / %cn <%ce>']).trim(), 'login <1+login@users.noreply.github.com> / login <1+login@users.noreply.github.com>');
  git(exp, ['push', '-q', 'origin', 'main']);
  const head = git(exp, ['rev-parse', 'HEAD']).trim();
  assert.equal(git(hub, ['rev-parse', 'main']).trim(), head);
  assert.equal(git(hub, ['rev-parse', 'main^']).trim(), published, 'родитель — прежний опубликованный');
  assert.deepEqual(git(hub, ['ls-tree', '-r', '--name-only', 'main']).trim().split('\n').sort(), ['.gitignore', 'a.txt', 'new.txt', 'tests/.tmp-v6-restart-parse.ps1']);
  // Ветка на GitHub сдвинулась — push без силы отклоняется.
  const racer = path.join(RUN, 'racer'); cp.execFileSync('git', ['clone', '-q', hub, racer]); write(path.join(racer, 'r.txt'), 'r');
  git(racer, ['add', '-A']); git(racer, ['-c', 'user.name=r', '-c', 'user.email=r@example.invalid', 'commit', '-q', '-m', 'чужое']); git(racer, ['push', '-q', 'origin', 'main']);
  write(path.join(exp, 'a.txt'), '3'); git(exp, ['add', '-A', '-f', '.']); git(exp, ['-c', 'user.name=login', '-c', 'user.email=1+login@users.noreply.github.com', 'commit', '-q', '-m', 'ещё']);
  assert.throws(() => cp.execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: exp, stdio: 'pipe' }), /rejected|fetch first/, 'отклонено без --force');
});

test('Р5–Р6: правила, README и порядок публикации', () => {
  const t = (f) => read(path.join(ROOT, f)).replace(/\s+/g, ' ');
  assert.match(t('rules/claude.md'), /## Подтверждения Grok Bot и публикация \(team-v12\)/);
  assert.match(t('rules/claude.md'), /Срок подтверждения истек/); assert.match(t('rules/claude.md'), /каждую редакцию отправляй всем троим/);
  assert.match(t('README.md'), /Всегда разрешать/); assert.match(t('README.md'), /docs\/publish\.md/);
  const p = t('docs/publish.md');
  for (const re of [/## Первая публикация/, /## Обновление опубликованной копии/, /git clone --no-checkout/, /без `--force`/, /users\.noreply\.github\.com/,
    /только после этого/i, /state\\public-export\.json/, /2e8a6260/, /git read-tree HEAD/, /git add -A -f \./, /один в один/, /Отклонён/]) assert.match(p, re);
  assert.match(t('lessons.md'), /## 56\. /); assert.match(t('lessons.md'), /## 57\. /); assert.match(t('lessons.md'), /Повтор 28\.09 ~02:00/);
  assert.match(read(path.join(__dirname, 'run.js')), /'team-v12\.js'/);
  assert.equal(require('../package.json').version, '0.5.7');
});

(async () => {
  console.log('team-v12: ' + process.platform + ' ' + process.version + '; ' + RUN);
  let passed = 0, failed = 0;
  for (const t of tests) { try { await t.fn(); passed++; console.log('OK ' + t.label); } catch (e) { failed++; console.log('ПРОВАЛ ' + t.label + '\n' + e.stack); } }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0'); process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(), 200).unref();
})();
