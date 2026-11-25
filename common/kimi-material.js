'use strict';
// Политика голоса: обнаружение изменений в точках сверки, не запрет записи.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { sha, POLICY } = require('./kimi-launch');
const RULES = ['node_modules на любой глубине', '.git/objects', 'внешние gitdir/commondir worktree'];
const NOTE = 'Обнаружение, не запрет: совпадение покрываемого состояния в точках сверки. Исключены node_modules, Git objects и внешние gitdir/commondir worktree. Нет песочницы ОС; запись вне покрытия, изменение с восстановлением, сеть, ACL, NTFS streams и подмена журналов не контролируются.';
const binding = job => Object.fromEntries(['task', 'scopeTask', 'work', 'stage', 'stageId', 'folder'].map(k => [k, job[k] ?? null]));
const inside = (a, b) => { const r = path.relative(a, b); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
function canonical(file) {
  const absolute = path.resolve(file); let cursor = absolute;
  while (!fs.existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) throw Error('Недоступный путь: ' + file); cursor = parent; }
  return path.join(fs.realpathSync(cursor), path.relative(cursor, absolute));
}
function noLink(file) {
  const s = fs.lstatSync(file);
  if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw Error('Неподдерживаемый тип/reparse point: ' + file);
  if (path.resolve(fs.realpathSync(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw Error('Подмена пути/reparse point: ' + file);
  return s;
}
function snapshot(root) {
  const entries = {}, excluded = [];
  function walk(file, rel) {
    const parts = rel.split('/');
    if (parts.includes('node_modules') || parts.some((p, i) => p === 'objects' && parts[i - 1] === '.git')) { excluded.push(file); return; }
    const s = noLink(file);
    if (s.isDirectory()) {
      entries[rel] = { type: 'directory' };
      for (const n of fs.readdirSync(file).sort()) walk(path.join(file, n), rel ? rel + '/' + n : n);
    } else entries[rel] = { type: 'file', sha256: sha(fs.readFileSync(file)) };
  }
  walk(root, ''); const st = fs.lstatSync(root); return { root, identity: { dev: st.dev, ino: st.ino }, entries, excluded };
}
function git(root) {
  const marker = path.join(root, '.git'); if (!fs.statSync(root).isDirectory() || !fs.existsSync(marker)) return null;
  const excluded = [];
  if (noLink(marker).isFile()) {
    const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(marker, 'utf8')); if (!m) throw Error('Неизвестный .git-файл.');
    const gd = canonical(path.resolve(root, m[1].trim())); excluded.push(gd);
    const common = path.join(gd, 'commondir');
    if (fs.existsSync(common)) excluded.push(canonical(path.resolve(gd, fs.readFileSync(common, 'utf8').trim())));
  }
  function run(args) {
    const r = cp.spawnSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    if (r.error || r.status !== 0) throw Error('Не удалось проверить Git: ' + (r.error?.message || r.stderr));
    return { stdout: r.stdout, exit: r.status, sha256: sha(r.stdout) };
  }
  return { head: run(['rev-parse', 'HEAD']), status: run(['status', '--porcelain=v1', '--untracked-files=all']), excluded };
}
function diff(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a.entries), ...Object.keys(b.entries)]))
    if (JSON.stringify(a.entries[k]) !== JSON.stringify(b.entries[k])) out.push(path.join(a.root, k));
  return out;
}
function roots(job) {
  const candidates = [job.folder, ...(job.material || [])].map(x => typeof x === 'string' ? x : x.path || x.file);
  if (candidates.some(x => !x || !path.isAbsolute(x))) throw Error('Материал: нужны абсолютные доступные пути.');
  for (const file of candidates) {
    const parts = path.resolve(file).split(/[\\/]/);
    if (parts.includes('node_modules') || parts.some((p, i) => p === 'objects' && parts[i - 1] === '.git')) throw Error('Обязательный материал находится в исключённой области: ' + file);
  }
  const real = candidates.map(x => { noLink(x); return canonical(x); }).sort();
  return [...new Set(real)].filter((x, i, all) => !all.some((y, j) => j !== i && inside(y, x)));
}
function locations(job, covered) {
  const state = require('./paths').stateDir;
  const work = canonical(process.env.MOST_KIMI_WORK_ROOT || path.join(state, 'kimi-work'));
  const temp = canonical(process.env.MOST_KIMI_TEMP_ROOT || path.join(state, 'kimi-temp'));
  const cards = canonical(path.join(state, 'kimi-jobs'));
  const locations = [work, temp, cards];
  for (let i = 0; i < locations.length; i++) for (const other of [...covered, ...locations.slice(i + 1)])
    if (inside(locations[i], other) || inside(other, locations[i])) throw Error('Корни Kimi пересекаются с материалом/хранилищем: настройте MOST_KIMI_WORK_ROOT и MOST_KIMI_TEMP_ROOT.');
  // team-v56 А2: продолжение переиспользует прежнюю служебную папку сеанса (sessionCwd) — новая папка незаметно не
  // создаётся, контекст --session сохраняется. Она должна лежать под корнем work (как executionFolder исходного сеанса).
  if (job.sessionCwd) {
    const reuse = canonical(job.sessionCwd);
    if (!inside(work, reuse)) throw Error('Служебная папка продолжаемого сеанса вне корня work Kimi.');
    return { executionFolder: reuse, tempFolder: path.join(temp, job.id) };
  }
  return { executionFolder: path.join(work, job.id), tempFolder: path.join(temp, job.id) };
}
function copy(snap, dest) {
  for (const [rel, entry] of Object.entries(snap.entries)) {
    const target = path.join(dest, rel);
    if (entry.type === 'directory') fs.mkdirSync(target, { recursive: true });
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(snap.root, rel), target, fs.constants.COPYFILE_EXCL); }
  }
}
// team-v56 А1: профиль запуска (agent-file) кладётся в служебную executionFolder ДО снимка executionBefore — иначе
// он выглядел бы новым файлом и ломал сверку копий. Байты/SHA профиля уже в карточке; имя файла — profile.name.
function writeProfile(folder, profile) {
  if (!profile) return null;
  const profileFile = path.join(folder, profile.name); fs.writeFileSync(profileFile, profile.text, { encoding: 'utf8', flag: 'wx' }); return profileFile;
}
// team-v56 А3: проектный MCP-конфиг пишется в служебную executionFolder ДО снимка executionBefore (как и профиль),
// чтобы он не выглядел новым файлом в сверке копий. Для роли «проверка»/выключенного sends mcp=null — ничего не пишется.
function writeMcp(folder, mcp) {
  if (!mcp || mcp.policy !== 'project') {
    // team-v56 Н2 (ревью Gemini-А): при policy 'none' в переиспользуемой sessionCwd удаляем устаревший .kimi-code/mcp.json
    // прежнего запуска (со старым MOST_JOB_ID), чтобы он не оставался на диске.
    try { fs.unlinkSync(path.join(folder, '.kimi-code', 'mcp.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return null;
  }
  return require('./kimi-mcp').write(folder, mcp);
}
// cache-622 (Б1): материал — по общему порогу (prompt-order.inlineLimit, MOST_INLINE_MATERIAL_CHARS, 300 000 знаков):
// до порога текстом, выше — строкой «Материал в файле: <путь>» на том же месте. Путь — копия в служебной папке поручения
// (cwd Kimi), доступная CLI; файл пишется ДО снимка executionBefore, поэтому сверка копий его не считает новым.
function materialPart(job, folder) {
  if (!job.textFile) return [];
  const text = fs.readFileSync(job.textFile, 'utf8');
  const copyPath = path.join(folder, 'most-kimi-material-' + job.id + '.txt');
  const m = require('./prompt-order').material({ textFile: copyPath }, { readFile: () => text });
  if (!m.inline) fs.writeFileSync(copyPath, text, { encoding: 'utf8', flag: 'wx' });
  return [m.lines.join('\n')];
}
function prepare(job, bundle, profile, mcp) {
  // team-v59 (A4): поручение БЕЗ записи (чтение/проверка/совет/текст) НЕ берёт замок папки — несколько таких поручений Kimi
  // в одной папке идут параллельно в любом количестве. Сверка «до/после» привязана к поручению: каждое снимает материал на
  // СВОЮ служебную копию (mapping/executionBefore ниже) и сверяет именно её; вызывающий копий не делает. Снимок оригинала
  // остаётся обнаружением (не запретом) — при параллельном писателе его изменения видны как различие (политика «обнаружение,
  // не запрет», NOTE). Замок остаётся только у писателя (prepareWrite): два писателя в одну папку — второй отказ.
  const covered = roots(job), loc = locations(job, covered), held = [];
  try {
    const before = covered.map(root => ({ snapshot: snapshot(root), git: git(root) }));
    fs.mkdirSync(loc.executionFolder, { recursive: true }); fs.mkdirSync(loc.tempFolder, { recursive: true });
    // team-v56 А2: при продолжении служебная папка переиспользуется — чтобы копии и снимок не конфликтовали с прежним
    // запуском, материал этого запуска кладём в отдельную поддиректорию run-<jobId>; input остаётся в корне executionFolder.
    const copyRoot = job.sessionCwd ? path.join(loc.executionFolder, 'run-' + job.id) : loc.executionFolder;
    if (job.sessionCwd) fs.mkdirSync(copyRoot, { recursive: true });
    const mapping = before.map((s, i) => ({ original: s.snapshot.root, copy: path.join(copyRoot, 'material', String(i), path.basename(s.snapshot.root)) }));
    for (let i = 0; i < before.length; i++) {
      copy(before[i].snapshot, mapping[i].copy);
      if (diff(before[i].snapshot, snapshot(mapping[i].copy)).length || diff(before[i].snapshot, snapshot(covered[i])).length || JSON.stringify(before[i].git) !== JSON.stringify(git(covered[i]))) throw Error('Материал изменился при копировании.');
    }
    // cache-622 (М1): порядок ради кэша префикса — постоянная шапка → материал → вложения → задача → меняющееся (карта
    // копий: в путях служебная папка поручения и run-<jobId>). Напоминание об ответе — в постоянной шапке, не в конце.
    const input = ['Отдельное поручение. Только чтение: не изменяй файлы и не запускай Git в копии. Обращайся к копиям материалов по карте (она в конце поручения); история и зависимости не скопированы. Ответ по-русски; вердикт ревью — последняя строка.', NOTE,
      ...materialPart(job, loc.executionFolder),
      // team-v63 (п.20): вложения `files` идут из отдельного файла (.attach.txt), а НЕ вклеены в job.task — карточка не раздута.
      ...require('./attachments').promptTail(job), 'Поручение:\n' + job.task,
      'Карта оригинал → копия:\n' + JSON.stringify(mapping, null, 2)].join('\n\n');
    const inputFile = path.join(loc.executionFolder, 'most-kimi-task-' + job.id + '.md'); fs.writeFileSync(inputFile, input, { encoding: 'utf8', flag: 'wx' });
    const profileFile = job.sessionCwd ? null : writeProfile(loc.executionFolder, profile);
    const mcpConfig = writeMcp(loc.executionFolder, mcp);
    const executionBefore = snapshot(copyRoot);
    const manifest = { policy: POLICY, binding: binding(job), coveredRoots: covered, mapping, before, executionBefore, copyRoot, inputFile, inputSha256: sha(input), taskSha256: sha(job.task), textSha256: sha(job.textFile ? fs.readFileSync(job.textFile) : ''), ...loc };
    const manifestFile = path.join(bundle, 'material-before.json'); const serialized = JSON.stringify(manifest, null, 2); fs.writeFileSync(manifestFile, serialized, { flag: 'wx' });
    return { manifest, held, fields: { ...loc, inputFile, inputSha256: sha(input), ...(profileFile ? { profileFile } : {}), ...(mcpConfig ? { mcpConfigFile: mcpConfig.file, mcpConfigSha256: mcpConfig.sha256 } : {}), materialManifestFile: manifestFile, materialManifestHash: sha(serialized), reviewPolicyVersion: POLICY,
      readOnlyCheck: { status: 'pending', coveredRoots: covered, excluded: { rules: RULES, paths: before.flatMap(s => [...s.snapshot.excluded, ...(s.git?.excluded || [])]) }, note: NOTE } } };
  } catch (e) { for (const l of held.reverse()) l.release(); throw e; }
}
function verify(prepared, bundle) {
  const { manifest: m } = prepared, differences = [], errors = [], after = []; let executionAfter;
  try {
    for (const s of m.before) { const now = { snapshot: snapshot(s.snapshot.root), git: git(s.snapshot.root) }; after.push(now); differences.push(...diff(s.snapshot, now.snapshot)); if (JSON.stringify(s.snapshot.identity) !== JSON.stringify(now.snapshot.identity)) differences.push(s.snapshot.root + ': подмена корня'); if (JSON.stringify(s.git) !== JSON.stringify(now.git)) differences.push(s.snapshot.root + ': HEAD/status/excluded'); }
    executionAfter = snapshot(m.copyRoot || m.executionFolder); differences.push(...diff(m.executionBefore, executionAfter));
    if (sha(fs.readFileSync(m.inputFile)) !== m.inputSha256) differences.push(m.inputFile);
  } catch (e) { errors.push(e.message); }
  const manifestFile = path.join(bundle, 'material-after.json'); const serialized = JSON.stringify({ after, executionAfter, differences, errors }, null, 2); fs.writeFileSync(manifestFile, serialized);
  return { status: errors.length ? 'unknown' : differences.length ? 'violation' : 'passed', differences, errors, manifestFile, manifestHash: sha(serialized),
    gitHeadBefore: m.before.map(s => s.git?.head || null), gitStatusBefore: m.before.map(s => s.git?.status || null), gitHeadAfter: after.map(s => s.git?.head || null), gitStatusAfter: after.map(s => s.git?.status || null) };
}
// team-v56 А1: подготовка писателя. Общий write-lock держится для реального целевого folder (и материала); копий в
// песочницу НЕ делается — писатель правит оригиналы по карте абсолютных путей, cwd остаётся служебной папкой.
// Снимок до/после даёт writeCheck: изменённые файлы, ошибки чтения и неполноту покрытия (изменения — не нарушение).
function prepareWrite(job, bundle, profile, mcp) {
  const covered = roots(job), loc = locations(job, covered), held = [];
  try {
    for (const root of covered) { const l = require('./write-lock').acquire(root, { jobId: job.id, writer: true }); if (!l.ok) throw Error('Целевая папка занята писателем или остановка прежнего дерева не подтверждена.'); held.push(l); }
    const before = covered.map(root => ({ snapshot: snapshot(root), git: git(root) }));
    fs.mkdirSync(loc.executionFolder, { recursive: true }); fs.mkdirSync(loc.tempFolder, { recursive: true });
    // cache-622 (М1): постоянная шапка → материал → вложения → задача → меняющееся (целевые пути).
    const input = ['Отдельное поручение с правом записи. Правь только файлы по карте целевых путей (она в конце поручения); cwd — служебная папка моста, не проект. Ответ по-русски; итог — последняя строка.',
      job.fullAccess ? 'Разрешён запуск названных в поручении программ (Bash); точная программа — контракт поручения.' : 'Запуск программ (Bash) запрещён профилем.', NOTE,
      ...materialPart(job, loc.executionFolder),
      // team-v63 (п.20): вложения `files` из отдельного файла (.attach.txt), не вклеены в job.task.
      ...require('./attachments').promptTail(job), 'Поручение:\n' + job.task,
      'Целевые пути (абсолютные):\n' + JSON.stringify(covered, null, 2)].join('\n\n');
    const inputFile = path.join(loc.executionFolder, 'most-kimi-task-' + job.id + '.md'); fs.writeFileSync(inputFile, input, { encoding: 'utf8', flag: 'wx' });
    // team-v56 А2: продолжение не передаёт профиль заново (CLI запрещает --agent-file с --session); режим доступа не повышается.
    const profileFile = job.sessionCwd ? null : writeProfile(loc.executionFolder, profile);
    const mcpConfig = writeMcp(loc.executionFolder, mcp);
    const manifest = { policy: POLICY, mode: 'write', binding: binding(job), coveredRoots: covered, targets: covered, before, inputFile, inputSha256: sha(input), taskSha256: sha(job.task), textSha256: sha(job.textFile ? fs.readFileSync(job.textFile) : ''), ...loc };
    const manifestFile = path.join(bundle, 'material-before.json'); const serialized = JSON.stringify(manifest, null, 2); fs.writeFileSync(manifestFile, serialized, { flag: 'wx' });
    return { manifest, held, write: true, fields: { ...loc, inputFile, inputSha256: sha(input), ...(profileFile ? { profileFile } : {}), ...(mcpConfig ? { mcpConfigFile: mcpConfig.file, mcpConfigSha256: mcpConfig.sha256 } : {}), materialManifestFile: manifestFile, materialManifestHash: sha(serialized), reviewPolicyVersion: POLICY,
      writeCheck: { status: 'pending', mode: 'write', coveredRoots: covered, targets: covered, changed: [], errors: [], excluded: { rules: RULES, paths: before.flatMap(s => [...s.snapshot.excluded, ...(s.git?.excluded || [])]) }, note: NOTE } } };
  } catch (e) { for (const l of held.reverse()) l.release(); throw e; }
}
// Сверка писателя: изменения разрешены (не провал), фиксируются списком; ошибки чтения/подмена корня дают unknown.
function writeCheck(prepared, bundle) {
  const { manifest: m } = prepared, changed = [], errors = [], after = [];
  try {
    for (const s of m.before) {
      const now = { snapshot: snapshot(s.snapshot.root), git: git(s.snapshot.root) }; after.push(now);
      changed.push(...diff(s.snapshot, now.snapshot));
      if (JSON.stringify(s.snapshot.identity) !== JSON.stringify(now.snapshot.identity)) errors.push(s.snapshot.root + ': подмена корня');
    }
    if (sha(fs.readFileSync(m.inputFile)) !== m.inputSha256) errors.push(m.inputFile + ': поручение изменено');
  } catch (e) { errors.push(e.message); }
  const manifestFile = path.join(bundle, 'material-after.json'); const serialized = JSON.stringify({ after, changed, errors }, null, 2); fs.writeFileSync(manifestFile, serialized);
  return { status: errors.length ? 'unknown' : 'passed', changed, errors, manifestFile, manifestHash: sha(serialized),
    gitHeadBefore: m.before.map(s => s.git?.head || null), gitHeadAfter: after.map(s => s.git?.head || null) };
}
module.exports = { materialPart, RULES, NOTE, binding, snapshot, git, diff, roots, locations, prepare, verify, prepareWrite, writeCheck, canonical, inside };
