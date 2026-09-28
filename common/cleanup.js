'use strict';
// Уборка старых релизов, клонов и временных папок (team-v9 Р4). По умолчанию сухой прогон.
// Правило: всё, в чём нельзя убедиться, остаётся на месте с причиной.
const fs = require('fs'),
  path = require('path'),
  os = require('os');
const DAY = 24 * 3600000;
const HEX = /^[0-9a-f]{40}$/;
// Путь в тексте настроек или командной строке: обратные косые (в том числе экранированные) → «/», без учёта регистра.
const slash = (t) => t.replace(/\\+/g, '/').toLowerCase();
const refersTo = (text, np) => new RegExp(np.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[/"\'\\s;,]|$)').test(text);
const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// Процессы node.exe: [{ pid, exe, cmd }]; cmd === null — командная строка недоступна.
function windowsProcesses() {
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const out = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
  if (!out) return [];
  return [].concat(JSON.parse(out)).map((p) => ({ pid: p.ProcessId, exe: p.ExecutablePath || null, cmd: p.CommandLine || null }));
}
function posixProcesses() {
  const out = require('child_process').execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').filter((l) => /\bnode\b/.test(l)).map((l) => { const m = l.trim().match(/^(\d+)\s+(.*)$/); return { pid: Number(m[1]), exe: null, cmd: m[2] }; });
}

function defaults(root) {
  const configs = () => {
    // Плюс настройки, которые записала последняя установка (deployed.json), и их .prev (team-v10, случай Codex 30).
    let installed = [];
    try { installed = JSON.parse(fs.readFileSync(path.join(root, 'live', 'deployed.json'), 'utf8')).configs || []; } catch {}
    const files = [...require('./deploy').configPaths(), ...require('./client-configs').paths().map((p) => p.file), ...installed];
    return [...new Set(files.flatMap((f) => [f, f + '.prev']))];
  };
  return {
    root,
    liveDir: path.join(root, 'live'),
    workDir: path.join(root, '.work'),
    tempDir: os.tmpdir(),
    changesDir: path.join(require('./paths').stateDir, 'team', 'changes'),
    logFile: path.join(require('./paths').stateDir, 'team', 'cleanup-log.jsonl'),
    now: Date.now(),
    processes: process.platform === 'win32' ? windowsProcesses : posixProcesses,
    configFiles: configs,
    pendingDeploy: () => require('./deploy-ops').list(root).find((op) => !require('./deploy-ops').terminal.includes(op.status)),
    hasLiveJobs: (work) => require('./work-owner').hasLiveJobs(work),
    folderJobs: (folder) => liveJobsInFolder(folder),
    selfRelease: path.resolve(__dirname, '..'),
    git: (cwd, args) => require('./team-git').git(cwd, args, { recoverIndex: false }),
  };
}

const age = (d, p) => d.now - fs.lstatSync(p).mtimeMs;
// Живые поручения Codex и Antigravity, чья папка внутри клона, даже без связи с работой (team-v10, случай Codex 39).
const LIVE = ['running', 'queued', 'waiting_quota', 'delivery_unclear', 'cancelling', 'stop_unconfirmed', 'migration_conflict'];
function liveJobsInFolder(folder) {
  const stores = require('./team-store'), inside = (p) => { const r = path.relative(norm(folder), norm(p)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  const found = [];
  // Все помощники; папка есть в карточках Codex (folder) и Antigravity (papka), у Grok её нет.
  for (const who of ['codex', 'antigravity', 'grok']) {
    const { jobs, errors } = stores.list(who, false);
    if (errors.length) throw Error('поручения не прочитаны: ' + errors[0]);
    for (const j of jobs) if (LIVE.includes(j.status) && [j.folder, j.papka].some((f) => f && inside(f))) found.push(who + ' ' + j.id);
  }
  return found;
}
// Путь можно удалять, только если он прямой потомок parent, а ни он, ни каталоги от base до него не ссылки и не junction.
function safeChild(parent, p, base = parent) {
  if (norm(path.dirname(p)) !== norm(parent)) return 'не прямой потомок ' + parent;
  const rel = path.relative(base, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'вне корня ' + base;
  let cur = base;
  for (const part of ['', ...rel.split(path.sep)]) {
    cur = part ? path.join(cur, part) : cur;
    if (fs.lstatSync(cur).isSymbolicLink()) return 'ссылка или junction: ' + cur;
  }
  if (norm(fs.realpathSync(p)) !== norm(p)) return 'настоящий путь отличается';
  return null;
}

// Командная строка: абсолютные пути из аргументов (в том числе после «=»), приведённые к виду c:/a/b без «.» и «..».
// Относительный путь со служебным каталогом (servers, live) — неопределённость.
const winAbs = /^[a-z]:[\\/]/i;
const normAny = (t) => (winAbs.test(t) ? path.win32.normalize(t) : path.posix.normalize(t)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
function cmdPaths(cmd) {
  const abs = [], relative = [];
  for (const raw of cmd.match(/"[^"]*"|'[^']*'|\S+/g) || []) {
    for (const part of raw.replace(/^["']|["']$/g, '').split('=')) {
      if (!part) continue;
      if (winAbs.test(part) || part.startsWith('/') || part.startsWith('\\\\')) abs.push(normAny(part));
      // Путь — только с разделителем; одно слово вроде web_search = "live" путём не считается (Grok 697c29c5).
      else if (/[\\/]/.test(part) && /(^|[\\/])(servers|live)([\\/]|$)/i.test(part)) relative.push(part);
    }
  }
  return { abs, relative };
}

// Пути в тексте настроек (JSON, TOML): строки в кавычках после снятия экранирования; абсолютные приводятся к виду c:/a/b
// без «.» и «..» (Codex 0ec0ed7e); относительные со служебным каталогом (servers, live) — неопределённость.
function configPaths(raw) {
  const abs = [], relative = [];
  for (const [, dq, sq] of raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
    // Строка в двойных кавычках раскрывается как в JSON/TOML (в том числе \uXXXX, замечание Antigravity muk26x2d).
    let value = sq;
    if (dq !== undefined) { try { value = JSON.parse('"' + dq + '"'); } catch { value = dq.replace(/\\(["\\/])/g, '$1'); } }
    for (const part of value.split(/[=;,]+/).map((x) => x.trim())) {
      if (!part) continue;
      if (winAbs.test(part) || part.startsWith('/') || part.startsWith('\\\\')) abs.push(normAny(part));
      // Путь — только с разделителем; одно слово вроде web_search = "live" путём не считается (Grok 697c29c5).
      else if (/[\\/]/.test(part) && /(^|[\\/])(servers|live)([\\/]|$)/i.test(part)) relative.push(part);
    }
  }
  return { abs, relative };
}

// Что держит релизы сейчас: имя каталога → причина; blocked — чего не удалось проверить.
function releaseState(d, dirs) {
  const keep = new Map(), blocked = [];
  const mark = (name, why) => { if (!keep.has(name)) keep.set(name, why); };
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(d.liveDir, 'deployed.json'), 'utf8')).commit;
    if (cur) mark(cur, 'текущий релиз (deployed.json)');
  } catch (e) { blocked.push('deployed.json не прочитан: ' + e.message); }
  try {
    const merged = fs.readdirSync(d.changesDir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(d.changesDir, f), 'utf8')))
      .filter((c) => c.status === 'слито' && c.mergedAt && c.candidate)
      .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
    for (const [i, c] of merged.slice(0, 2).entries()) mark(c.candidate, i ? 'предыдущий принятый релиз' : 'последний принятый релиз');
  } catch (e) { blocked.push('журнал изменений не прочитан: ' + e.message); }
  // Настройки Claude, гостей и их .prev (откат).
  const texts = [];
  try {
    for (const f of d.configFiles()) {
      if (!fs.existsSync(f)) continue;
      try {
        const raw = fs.readFileSync(f, 'utf8'), c = configPaths(raw);
        if (c.relative.length) blocked.push('в настройках ' + f + ' относительный путь: ' + c.relative[0].slice(0, 120));
        texts.push({ f, t: slash(raw), abs: c.abs });
      } catch (e) { blocked.push('настройки ' + f + ' не прочитаны: ' + e.message); }
    }
  } catch (e) { blocked.push('список настроек не получен: ' + e.message); }
  let procs = [];
  try { procs = d.processes(); } catch (e) { blocked.push('процессы не прочитаны: ' + e.message); }
  const parsed = [];
  for (const p of procs) {
    if (!p.cmd) { blocked.push('у node.exe PID ' + p.pid + ' недоступна командная строка'); continue; }
    const c = cmdPaths(p.cmd);
    if (c.relative.length) blocked.push('у node.exe PID ' + p.pid + ' относительный путь: ' + c.relative[0].slice(0, 120));
    parsed.push({ pid: p.pid, abs: [...c.abs, ...(p.exe ? [normAny(p.exe)] : [])] });
  }
  try {
    const op = d.pendingDeploy();
    if (op) blocked.push('идёт установка ' + op.id);
  } catch (e) { blocked.push('операции установки не прочитаны: ' + e.message); }
  // Релиз, из которого работает сама уборка (сервер команды), не удаляется (team-v10, случай Codex 32).
  if (d.selfRelease && norm(path.dirname(d.selfRelease)) === norm(d.liveDir)) mark(path.basename(d.selfRelease), 'из него работает сервер команды');
  for (const n of dirs) {
    const np = norm(path.join(d.liveDir, n));
    const cfg = texts.find((x) => refersTo(x.t, np) || x.abs.some((a) => a === np || a.startsWith(np + '/')));
    if (cfg) mark(n, 'на него указывают настройки ' + cfg.f);
    const pr = parsed.find((x) => x.abs.some((a) => a === np || a.startsWith(np + '/')));
    if (pr) mark(n, 'занят процессом PID ' + pr.pid);
  }
  return { keep, blocked };
}

function releasePlan(d, plan) {
  const names = fs.readdirSync(d.liveDir);
  for (const n of names.filter((n) => /^\.archive-.*\.tar$/.test(n))) {
    const p = path.join(d.liveDir, n);
    const why = () => (age(d, p) < DAY ? 'архив моложе 24 часов' : null), now = why();
    if (now) plan.keep.push({ path: p, reason: now });
    else plan.remove.push({ path: p, kind: 'архив', reason: 'архив старше 24 часов', parent: d.liveDir, recheck: why });
  }
  const dirs = names.filter((n) => HEX.test(n) || n.startsWith('.stale-'));
  const { keep, blocked } = releaseState(d, dirs);
  for (const n of dirs) {
    const p = path.join(d.liveDir, n);
    if (keep.has(n)) plan.keep.push({ path: p, reason: keep.get(n) });
    else if (blocked.length) plan.keep.push({ path: p, reason: 'не удалось проверить: ' + blocked.join('; ') });
    else plan.remove.push({ path: p, kind: n.startsWith('.stale-') ? 'отброшенный релиз' : 'релиз', reason: 'ни настройки, ни процессы, ни откат на него не указывают', parent: d.liveDir,
      recheck: () => { const s = releaseState(d, [n]); return s.keep.get(n) || (s.blocked.length ? 'не удалось проверить: ' + s.blocked.join('; ') : null); } });
  }
  plan.blocked.push(...blocked);
}

// Почему клон нельзя удалять (null — можно).
function cloneWhy(d, p, c, mainHash) {
  if (c.status !== 'слито') return 'изменение «' + c.status + '»';
  try { if (c.work && d.hasLiveJobs(c.work)) return 'у работы есть живые поручения'; } catch (e) { return 'поручения не проверены: ' + e.message; }
  try {
    const dirty = d.git(p, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)
      // Исключение — только неотслеживаемые результаты прогона; правка любого отслеживаемого файла запрещает удаление.
      .filter((l) => !/^\?\? tests\/(\.tmp-|windows-test-output-[^/]*\.txt$)/.test(l));
    if (dirty.length) return 'несохранённые изменения: ' + dirty.slice(0, 3).join(', ');
    const head = d.git(p, ['rev-parse', 'HEAD']).trim(), main = mainHash || d.git(d.root, ['rev-parse', 'main']).trim();
    d.git(d.root, ['merge-base', '--is-ancestor', head, main]);
    // team-v10, случай Codex 40: работа в других локальных ветках или в stash — клон остаётся.
    if (d.git(p, ['stash', 'list']).trim()) return 'в клоне есть stash';
    // \r снимается: на Windows git может вернуть CRLF (замечание Antigravity mukctdxq).
    for (const ref of d.git(p, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads']).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
      const [sha, name] = ref.split(' ');
      try { d.git(d.root, ['merge-base', '--is-ancestor', sha, main]); } catch { return 'ветка ' + name + ' клона не слита в main'; }
    }
  } catch (e) { return 'коммиты клона не найдены в main или git недоступен: ' + e.message.split('\n')[0]; }
  try { const jobs = d.folderJobs ? d.folderJobs(p) : []; if (jobs.length) return 'живые поручения в папке клона: ' + jobs.join(', '); }
  catch (e) { return 'поручения по папке не проверены: ' + e.message; }
  return null;
}
const card = (d, n) => JSON.parse(fs.readFileSync(path.join(d.changesDir, n + '.json'), 'utf8'));

function clonePlan(d, plan) {
  if (!fs.existsSync(d.workDir)) return;
  const mainHash = d.git(d.root, ['rev-parse', 'main']).trim();
  for (const n of fs.readdirSync(d.workDir)) {
    const p = path.join(d.workDir, n);
    if (!fs.lstatSync(p).isDirectory()) { plan.keep.push({ path: p, reason: 'не каталог клона' }); continue; }
    let c;
    try { c = card(d, n); } catch { plan.keep.push({ path: p, reason: 'нет карточки изменения' }); continue; }
    const why = cloneWhy(d, p, c, mainHash);
    if (why) { plan.keep.push({ path: p, reason: why }); tmpPlan(d, p, c, plan); }
    else plan.remove.push({ path: p, kind: 'клон', reason: 'слито, всё в main, живых поручений нет', parent: d.workDir,
      recheck: () => { try { return cloneWhy(d, p, card(d, n)); } catch (e) { return 'карточка не прочитана: ' + e.message; } } });
  }
}

// Неотслеживаемые tests/.tmp-* старше суток в оставляемых клонах, не участвующих в идущем изменении.
function tmpWhy(d, clone, n) {
  let c;
  try { c = card(d, path.basename(clone)); } catch (e) { return 'карточка не прочитана'; }
  if (!['слито', 'закрыто без слияния'].includes(c.status)) return 'изменение «' + c.status + '»';
  try { if (c.work && d.hasLiveJobs(c.work)) return 'у работы есть живые поручения'; } catch { return 'поручения не проверены'; }
  let tracked;
  try { tracked = d.git(clone, ['ls-files', '--', 'tests/' + n]).trim(); } catch { return 'git недоступен'; }
  if (tracked) return 'отслеживается git';
  if (age(d, path.join(clone, 'tests', n)) < DAY) return 'моложе 24 часов';
  return null;
}
function tmpPlan(d, clone, c, plan) {
  if (!['слито', 'закрыто без слияния'].includes(c.status)) return;
  const dir = path.join(clone, 'tests');
  if (!fs.existsSync(dir)) return;
  try { if (c.work && d.hasLiveJobs(c.work)) return; } catch { return; }
  for (const n of fs.readdirSync(dir).filter((n) => n.startsWith('.tmp-'))) {
    const p = path.join(dir, n), why = tmpWhy(d, clone, n);
    if (why) plan.keep.push({ path: p, reason: why });
    else plan.remove.push({ path: p, kind: 'временные файлы тестов', reason: 'не отслеживается, старше 24 часов', parent: dir, base: d.workDir, recheck: () => tmpWhy(d, clone, n) });
  }
}

function tempPlan(d, plan) {
  for (const n of fs.readdirSync(d.tempDir).filter((n) => n.startsWith('most-part2-'))) {
    const p = path.join(d.tempDir, n), why = () => (age(d, p) < DAY ? 'моложе 24 часов' : null), now = why();
    if (now) plan.keep.push({ path: p, reason: now });
    else plan.remove.push({ path: p, kind: 'временная папка', reason: 'старше 24 часов', parent: d.tempDir, recheck: why });
  }
}

function makePlan(d) {
  const plan = { remove: [], keep: [], blocked: [] };
  releasePlan(d, plan);
  clonePlan(d, plan);
  tempPlan(d, plan);
  return plan;
}

function cleanup({ root, apply = false, owner = null }, deps = {}) {
  const d = { ...defaults(root), ...deps };
  const pending = d.pendingDeploy();
  if (pending) throw Error('Идёт установка ' + pending.id + '; уборка отложена.');
  const plan = makePlan(d);
  const removed = [], failed = [];
  if (apply) {
    for (const x of plan.remove) {
      try {
        // Все условия этого пути проверяются заново непосредственно перед его удалением.
        const why = x.recheck();
        if (why) { failed.push({ ...x, reason: 'повторная проверка: ' + why }); continue; }
        const bad = safeChild(x.parent, x.path, x.base);
        if (bad) { failed.push({ ...x, reason: bad }); continue; }
        fs.rmSync(x.path, { recursive: true, force: false, maxRetries: 3 });
        removed.push(x);
        d.afterRemove?.(x);
      } catch (e) { failed.push({ ...x, reason: e.message }); }
    }
  } else {
    for (const x of plan.remove) { const bad = safeChild(x.parent, x.path, x.base); if (bad) { plan.keep.push({ path: x.path, reason: bad }); x.skip = true; } }
    plan.remove = plan.remove.filter((x) => !x.skip);
  }
  if (apply) {
    // След для разбора «кто и что удалил» (замечание Antigravity muk0tbov).
    try {
      fs.mkdirSync(path.dirname(d.logFile), { recursive: true });
      fs.appendFileSync(d.logFile, JSON.stringify({ at: new Date().toISOString(), owner, removed: removed.map((x) => x.path),
        failed: failed.map((x) => ({ path: x.path, reason: x.reason })) }) + '\n');
    } catch (e) { failed.push({ path: d.logFile, reason: 'журнал уборки не записан: ' + e.message }); }
  }
  return { plan, removed, failed, apply, owner };
}

function cleanupText(r) {
  const line = (x) => '- ' + x.path + ' — ' + x.reason;
  const rows = [(r.apply ? 'Уборка выполнена' : 'Уборка — сухой прогон, ничего не удалено') + (r.owner ? ' · ' + r.owner : '') + (r.apply ? '.' : '. Удалить: team_change cleanup с apply: true.')];
  if (r.apply) {
    rows.push('Удалено ' + r.removed.length + ':', ...r.removed.map(line));
    if (r.failed.length) rows.push('Не удалено ' + r.failed.length + ':', ...r.failed.map(line));
  } else rows.push('Удалю ' + r.plan.remove.length + ':', ...r.plan.remove.map(line));
  rows.push('Оставлю ' + r.plan.keep.length + ':', ...r.plan.keep.map(line));
  if (r.plan.blocked.length) rows.push('Релизы не удаляются: ' + r.plan.blocked.join('; '));
  return rows.join('\n');
}

module.exports = { cleanup, cleanupText, makePlan, safeChild, windowsProcesses, cmdPaths, configPaths };
