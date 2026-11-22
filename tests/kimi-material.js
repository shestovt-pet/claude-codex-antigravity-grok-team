'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), assert = require('assert/strict');
const h = require('./fake-kimi'), f = h.setup(), m = require('../common/kimi-material'); let seq = 0;
function project() { const dir = path.join(f.root, 'project-' + ++seq); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'data.txt'), 'ABCD'); return dir; }
function prepared(folder, extra = {}) { const id = 'material-' + ++seq, bundle = path.join(f.state, 'kimi-jobs', id); fs.mkdirSync(bundle, { recursive: true }); return { p: m.prepare({ id, folder, task: 'base aaa candidate bbb', ...extra }, bundle), bundle }; }
function release(p) { p.held.forEach(l => l.release()); }
function git(dir, ...args) { const r = cp.spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function repo() { const dir = project(); git(dir, 'init', '-b', 'main'); git(dir, 'add', '.'); git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'); return dir; }
h.run([
  ['SHA-256 ловит одинаковый размер и восстановленный mtime; ignored/untracked тоже покрыты', () => {
    const folder = repo(); fs.writeFileSync(path.join(folder, '.gitignore'), 'ignored.txt\n'); fs.writeFileSync(path.join(folder, 'ignored.txt'), 'ABCD');
    const { p, bundle } = prepared(folder); const file = path.join(folder, 'ignored.txt'), stat = fs.statSync(file); fs.writeFileSync(file, 'WXYZ'); fs.utimesSync(file, stat.atime, stat.mtime);
    const check = m.verify(p, bundle); assert.equal(check.status, 'violation'); assert(check.differences.includes(file)); release(p);
  }],
  ['добавление и исчезновение файла/каталога видны; ошибки чтения дают unknown', () => {
    const folder = project(), { p, bundle } = prepared(folder); fs.mkdirSync(path.join(folder, 'new')); fs.writeFileSync(path.join(folder, 'new', 'file'), 'x'); assert.equal(m.verify(p, bundle).status, 'violation'); release(p);
    const a = m.snapshot(folder), b = structuredClone(a); delete b.entries['data.txt']; assert(m.diff(a, b).length);
    const x = prepared(project()), original = fs.readFileSync;
    try { fs.readFileSync = function(file, ...rest) { if (file === path.join(x.p.manifest.coveredRoots[0], 'data.txt')) throw Error('EACCES test'); return original.call(this, file, ...rest); }; assert.equal(m.verify(x.p, x.bundle).status, 'unknown'); } finally { fs.readFileSync = original; release(x.p); }
  }],
  ['node_modules и Git objects исключены из хеша и копии, правила/пути видны', () => {
    const folder = repo(); fs.mkdirSync(path.join(folder, 'sub', 'node_modules'), { recursive: true }); fs.writeFileSync(path.join(folder, 'sub', 'node_modules', 'secret'), 'x');
    const { p, bundle } = prepared(folder); assert(p.fields.readOnlyCheck.excluded.paths.some(x => x.endsWith('node_modules'))); assert(p.fields.readOnlyCheck.excluded.paths.some(x => x.endsWith(path.join('.git', 'objects'))));
    const copy = p.manifest.mapping[0].copy; assert(!fs.existsSync(path.join(copy, 'sub', 'node_modules'))); assert(!fs.existsSync(path.join(copy, '.git', 'objects')));
    fs.writeFileSync(path.join(folder, 'sub', 'node_modules', 'secret'), 'y'); assert.equal(m.verify(p, bundle).status, 'passed'); release(p);
  }],
  ['обычная .git: HEAD, refs, packed-refs, index, config покрыты; грязная папка стабильна', () => {
    const folder = repo(); git(folder, 'pack-refs', '--all'); fs.writeFileSync(path.join(folder, 'dirty'), 'x');
    const { p, bundle } = prepared(folder), entries = p.manifest.before[0].snapshot.entries;
    for (const file of ['.git/HEAD', '.git/packed-refs', '.git/index', '.git/config']) assert(entries[file]);
    assert.equal(m.verify(p, bundle).status, 'passed'); fs.appendFileSync(path.join(folder, '.git/config'), '\n# changed\n'); assert.equal(m.verify(p, bundle).status, 'violation'); release(p);
  }],
  ['worktree: .git-файл покрыт; внешние gitdir/commondir исключены и не заперты', () => {
    const original = repo(), folder = path.join(f.root, 'worktree-' + ++seq); git(original, 'worktree', 'add', '-b', 'test', folder);
    const { p, bundle } = prepared(folder); assert.equal(p.manifest.before[0].snapshot.entries['.git'].type, 'file');
    const excluded = p.manifest.before[0].git.excluded; assert.equal(excluded.length, 2); assert(p.fields.readOnlyCheck.excluded.paths.includes(excluded[0]));
    assert.equal(fs.readFileSync(path.join(p.manifest.mapping[0].copy, '.git'), 'utf8'), fs.readFileSync(path.join(folder, '.git'), 'utf8'));
    const lock = require('../common/write-lock').acquire(excluded[0]); assert(lock.ok); lock.release(); assert.equal(m.verify(p, bundle).status, 'passed');
    // Новый HEAD при том же дереве: status не меняется, HEAD должен пойматься.
    git(folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'new head'); assert.equal(m.verify(p, bundle).status, 'violation'); release(p);
  }],
  ['ошибка git status не даёт снимок и голос', () => {
    const folder = repo(), run = cp.spawnSync;
    try { cp.spawnSync = (...args) => args[1]?.includes('status') ? { status: 1, stderr: 'test status failure' } : run(...args); assert.throws(() => prepared(folder), /Git/); } finally { cp.spawnSync = run; }
  }],
  ['A4: чтение не берёт замок папки — идёт параллельно с писателем и с другими чтениями', () => {
    // team-v59 (A4): поручение без записи больше не берёт эксклюзивный замок материала; читать рядом с писателем и несколько
    // чтений в одной папке одновременно — принимаются. Замок остаётся только у писателя (prepareWrite).
    const a = project(), b = project(), lock = require('../common/write-lock').acquire(b); assert(lock.ok, 'писатель держит замок b');
    const r = prepared(a, { material: [b] }); // чтение рядом с пишущим — принято, замка не держит
    assert.equal(r.p.held.length, 0, 'чтение не держит замок папки');
    const free = require('../common/write-lock').acquire(a); assert(free.ok, 'папка a не заперта чтением'); free.release();
    const r2 = prepared(a), r3 = prepared(a); // три чтения одной папки одновременно
    assert.equal(r2.p.held.length, 0); assert.equal(r3.p.held.length, 0);
    release(r.p); release(r2.p); release(r3.p); lock.release();
  }],
  ['корни из env и defaults; пересечение с оригиналом и карточками запрещено', () => {
    const folder = project(), loc = m.locations({ id: 'x' }, [folder]); assert(loc.executionFolder.startsWith(process.env.MOST_KIMI_WORK_ROOT));
    const old = process.env.MOST_KIMI_WORK_ROOT; process.env.MOST_KIMI_WORK_ROOT = folder; try { assert.throws(() => m.locations({ id: 'x' }, [folder]), /пересекаются/); } finally { process.env.MOST_KIMI_WORK_ROOT = old; }
    const a = process.env.MOST_KIMI_WORK_ROOT, b = process.env.MOST_KIMI_TEMP_ROOT; delete process.env.MOST_KIMI_WORK_ROOT; delete process.env.MOST_KIMI_TEMP_ROOT;
    try { assert.equal(m.locations({ id: 'x' }, [folder]).executionFolder, path.join(f.state, 'kimi-work/x')); assert.throws(() => m.locations({ id: 'x' }, [f.root]), /пересекаются/); } finally { process.env.MOST_KIMI_WORK_ROOT = a; process.env.MOST_KIMI_TEMP_ROOT = b; }
  }],
  ['junction в покрытии отказан; исключённый каталог не разыменован', () => {
    const folder = project(), target = project(), link = path.join(folder, 'link'); fs.symlinkSync(target, link, 'junction'); assert.throws(() => prepared(folder), /reparse/);
    const other = project(); fs.symlinkSync(target, path.join(other, 'node_modules'), 'junction'); const { p, bundle } = prepared(other); assert.equal(m.verify(p, bundle).status, 'passed'); release(p);
  }],
  ['внешний material и diff/text входят в снимок; восстановление между снимками — предел обнаружения', () => {
    const folder = project(), extra = path.join(f.root, 'diff.txt'); fs.writeFileSync(extra, 'base aaa candidate bbb\n-old\n+new');
    const { p, bundle } = prepared(folder, { material: [extra] }); assert.equal(p.manifest.coveredRoots.length, 2); assert(fs.readFileSync(p.manifest.inputFile, 'utf8').includes(JSON.stringify(extra)));
    const file = path.join(folder, 'data.txt'), bytes = fs.readFileSync(file); fs.writeFileSync(file, 'WXYZ'); fs.writeFileSync(file, bytes); assert.equal(m.verify(p, bundle).status, 'passed'); release(p);
  }],
]);
