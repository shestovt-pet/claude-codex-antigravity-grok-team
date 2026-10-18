'use strict';
// Уборка старых релизов, клонов и временных папок (team-v9 Р4). По умолчанию сухой прогон.
// Правило: всё, в чём нельзя убедиться, остаётся на месте с причиной.
const fs = require('fs'),
  path = require('path'),
  os = require('os');
const { canon, canonMaybe } = require('./paths');
const { realOrGiven, spellings } = require('./path-compat');
const DAY = 24 * 3600000;
const HEX = /^[0-9a-f]{40}$/;
// Путь в тексте настроек или командной строке: обратные косые (в том числе экранированные) → «/», без учёта регистра.
const slash = (t) => t.replace(/\\+/g, '/').toLowerCase();
const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// Все процессы: [{ pid, sessionId, exe, cmd }]; cmd === null — командная строка недоступна.
function windowsProcesses() {
  const ps = '$ErrorActionPreference = \'Stop\'; Get-CimInstance Win32_Process | Select-Object ProcessId,SessionId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const out = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
  if (!out) throw Error('Список процессов не прочитан: пустой ответ.');
  return [].concat(JSON.parse(out)).map((p) => ({ pid: p.ProcessId, sessionId: p.SessionId, exe: p.ExecutablePath || null, cmd: p.CommandLine || null }));
}
function posixProcesses() {
  const out = require('child_process').execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').filter((l) => /^\s*\d+\s+/.test(l)).map((l) => { const m = l.trim().match(/^(\d+)\s+(.*)$/); return { pid: Number(m[1]), exe: null, cmd: m[2] }; });
}

function defaults(root, apply) {
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
    pendingDeploy: () => require('./deploy-ops').list(root, { reconcile: apply === true }).find((op) => !require('./deploy-ops').terminal.includes(op.status)),
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
  const stores = require('./team-store'), inside = p => { try { return refersTo(p, folder); } catch { return true; } };
  const found = [];
  // Все помощники; папка есть в карточках Codex (folder) и Antigravity (papka), у Grok её нет.
  for (const who of require('./members').helpers) {
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

// Командная строка: извлекаем абсолютные пути, затем сравниваем раскрытые пути.
// Относительный путь со служебным каталогом (servers, live) — неопределённость.
const winAbs = /^[a-z]:[\\/]/i;
const textOnlyPath = p => /^[\\/]{2}/.test(p);
const absoluteReference = p => winAbs.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p) || (process.platform !== 'win32' && p.startsWith('/'));
// Один разделитель на Windows: ключ без других разделителей либо путь от корня диска.
const driveRooted = p => process.platform === 'win32' && /^[\\/](?![\\/])/.test(p);
function collectPath(part, abs, relative) {
  if (!part) return;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(part)) {
    if (!/^file:\/\//i.test(part)) return;
    // file: проверяется как абсолютный путь; неверный адрес не теряется молча.
    part = require('url').fileURLToPath(part);
  }
  if (driveRooted(part)) {
    if (/[\\/]/.test(part.slice(1))) abs.push(part);
  } else if (absoluteReference(part)) abs.push(part);
  // Одно слово вроде web_search = "live" путём не считается.
  else if (/[\\/]/.test(part) && /(^|[\\/])(servers|live)([\\/]|$)/i.test(part)) relative.push(part);
}
function cmdPaths(cmd) {
  const abs = [], relative = [];
  for (const raw of cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []) {
    for (const part of raw.split('=').map(p => p.replace(/^["']|["']$/g, ''))) {
      collectPath(part, abs, relative);
    }
  }
  return { abs, relative };
}

// Пути в настройках JSON/TOML: снимаем экранирование, раскрываем только при сравнении.
// Относительные пути со служебным каталогом (servers, live) — неопределённость.
function configPaths(raw) {
  const abs = [], relative = [];
  for (const [, dq, sq] of raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
    // Строка в двойных кавычках раскрывается как в JSON/TOML (в том числе \uXXXX, замечание Antigravity muk26x2d).
    let value = sq;
    if (dq !== undefined) { try { value = JSON.parse('"' + dq + '"'); } catch { value = dq.replace(/\\(["\\/])/g, '$1'); } }
    for (const part of value.split(/[=;,]+/).map((x) => x.trim())) {
      collectPath(part, abs, relative);
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
  } catch (e) { blocked.push('журнал изменений не прочитан: ' + raceReason(e)); }
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
  const { parsed, blocked: processBlocked, uncheckedHiddenProcesses } = processState(d);
  blocked.push(...processBlocked);
  try {
    const op = d.pendingDeploy();
    if (op) blocked.push('идёт установка ' + op.id);
  } catch (e) { blocked.push('операции установки не прочитаны: ' + e.message); }
  // Релиз, из которого работает сама уборка (сервер команды), не удаляется (team-v10, случай Codex 32).
  if (d.selfRelease) {
    try { if (canon(path.dirname(d.selfRelease)) === canon(d.liveDir)) mark(path.basename(d.selfRelease), 'из него работает сервер команды'); }
    catch (e) { blocked.push('не удалось проверить собственный релиз: ' + raceReason(e)); }
  }
  for (const n of dirs) {
    const candidate = path.join(d.liveDir, n);
    try {
      canon(candidate);
      for (const x of texts) {
        if ((HEX.test(n) && x.t.includes(n)) || x.abs.some(a => refersTo(a, candidate))) mark(n, 'на него указывают настройки ' + x.f);
      }
      for (const x of parsed) {
        if ((HEX.test(n) && x.t.includes(n)) || x.abs.some(a => refersTo(a, candidate))) mark(n, 'занят процессом PID ' + x.pid);
      }
    } catch (e) { mark(n, 'не удалось проверить: ' + raceReason(e)); }
  }
  return { keep, blocked, uncheckedHiddenProcesses };
}

function releasePlan(d, plan) {
  const names = entries(plan, d.liveDir);
  for (const n of names.filter((n) => /^\.archive-.*\.tar$/.test(n))) {
    const p = path.join(d.liveDir, n);
    const why = () => (age(d, p) < DAY ? 'архив моложе 24 часов' : null), now = inspect(plan, p, why);
    if (now === undefined) continue;
    if (now) plan.keep.push({ path: p, reason: now });
    else plan.remove.push({ path: p, kind: 'архив', reason: 'архив старше 24 часов', parent: d.liveDir, recheck: why });
  }
  const dirs = names.filter((n) => HEX.test(n) || n.startsWith('.stale-'));
  const { keep, blocked, uncheckedHiddenProcesses } = releaseState(d, dirs);
  plan.uncheckedHiddenProcesses = uncheckedHiddenProcesses;
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
  const busy = processWhy(d, p); if (busy) return busy;
  const reason = cloneOtherWhy(d, p, c, mainHash);
  return reason ? { code: 'other', reason } : null;
}
function cloneOtherWhy(d, p, c, mainHash) {
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
  for (const n of entries(plan, d.workDir)) {
    const p = path.join(d.workDir, n);
    const st = inspect(plan, p, () => fs.lstatSync(p));
    if (!st) continue;
    if (!st.isDirectory()) { plan.keep.push({ path: p, reason: 'не каталог клона' }); continue; }
    let c;
    try { c = card(d, n); } catch (e) { plan.keep.push({ path: p, reason: 'нет карточки изменения: ' + raceReason(e) }); continue; }
    const why = cloneWhy(d, p, c, mainHash);
    if (why) { plan.keep.push({ path: p, reason: why.reason, code: why.code }); if (!['process_busy', 'processes_unread'].includes(why.code)) tmpPlan(d, p, c, plan); }
    else plan.remove.push({ path: p, kind: 'клон', reason: 'слито, всё в main, живых поручений нет', parent: d.workDir,
      recheck: () => { try { return cloneWhy(d, p, card(d, n))?.reason; } catch (e) { return 'карточка не прочитана: ' + raceReason(e); } } });
  }
}

// Неотслеживаемые tests/.tmp-* старше суток в оставляемых клонах, не участвующих в идущем изменении.
function tmpWhy(d, clone, n) {
  const p = path.join(clone, 'tests', n), busy = processWhy(d, p);
  if (busy) return busy.reason;
  try { const jobs = d.folderJobs ? d.folderJobs(clone) : []; if (jobs.length) return 'живые поручения в папке: ' + jobs.join(', '); }
  catch (e) { return 'не удалось проверить поручения: ' + e.message; }
  let c;
  try { c = card(d, path.basename(clone)); } catch (e) { return 'карточка не прочитана: ' + raceReason(e); }
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
  for (const n of entries(plan, dir).filter((n) => n.startsWith('.tmp-'))) {
    const p = path.join(dir, n), why = inspect(plan, p, () => tmpWhy(d, clone, n));
    if (why === undefined) continue;
    if (why) plan.keep.push({ path: p, reason: why });
    else plan.remove.push({ path: p, kind: 'временные файлы тестов', reason: 'не отслеживается, старше 24 часов', parent: dir, base: d.workDir, recheck: () => tmpWhy(d, clone, n) });
  }
}

function tempPlan(d, plan) {
  for (const n of entries(plan, d.tempDir).filter((n) => n.startsWith('most-part2-'))) {
    const p = path.join(d.tempDir, n), why = () => (age(d, p) < DAY ? 'моложе 24 часов' : null), now = why();
    if (now) plan.keep.push({ path: p, reason: now });
    else plan.remove.push({ path: p, kind: 'временная папка', reason: 'старше 24 часов', parent: d.tempDir, recheck: why });
  }
}

// Один снимок (включая ошибку) на фазу, общий для релизов, клонов и подпапок.
function processSnapshot(read) {
  let loaded = false, rows, error;
  return () => {
    if (!loaded) { loaded = true; try { rows = read(); } catch (e) { error = e; } }
    if (error) throw error;
    return rows;
  };
}
function makePlan(deps) {
  const d = { ...deps, processes: processSnapshot(deps.processes) };
  const plan = { remove: [], keep: [], blocked: [] };
  inspect(plan, d.liveDir, () => releasePlan(d, plan));
  inspect(plan, d.workDir, () => clonePlan(d, plan));
  inspect(plan, d.tempDir, () => tempPlan(d, plan));
  // Замыкания recheck используют второй, свежий и общий снимок.
  d.processes = processSnapshot(deps.processes);
  plan.recheckProcesses = () => { plan.uncheckedHiddenProcesses = processState(d).uncheckedHiddenProcesses; };
  return plan;
}

function cleanup({ root, apply = false, owner = null }, deps = {}) {
  root = realOrGiven(root);
  apply = apply === true;
  const d = { ...defaults(root, apply), ...deps };
  let pending;
  try { pending = d.pendingDeploy(); } catch (e) {
    if (apply) throw e;
    return { plan: { remove: [], keep: [{ path: root, reason: raceReason(e) }], blocked: [raceReason(e)] }, removed: [], failed: [], apply, owner };
  }
  if (pending) throw Error('Идёт установка ' + pending.id + '; уборка отложена.');
  const plan = makePlan(d);
  const removed = [], failed = [];
  if (apply) {
    if (plan.remove.length) plan.recheckProcesses();
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
    for (const x of plan.remove) {
      const bad = inspect(plan, x.path, () => safeChild(x.parent, x.path, x.base));
      if (bad === undefined) x.skip = true;
      else if (bad) { plan.keep.push({ path: x.path, reason: bad }); x.skip = true; }
    }
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
  if (r.plan.uncheckedHiddenProcesses) rows.push('не проверено процессов со скрытыми сведениями: ' + r.plan.uncheckedHiddenProcesses);
  rows.push('Оставлю ' + r.plan.keep.length + ':', ...r.plan.keep.map(line));
  if (r.plan.blocked.length) rows.push('Релизы не удаляются: ' + r.plan.blocked.join('; '));
  return rows.join('\n');
}


// Кандидат обязан существовать; внешняя ссылка может иметь ещё не созданный хвост.
// UNC, устройства и каналы сравниваем текстово: realpath мог бы открыть сеть/канал.
function textualReference(p) {
  let r = path.win32.normalize(p);
  // Префикс устройства у обычного дискового/UNC-пути снимается только текстово.
  if ((r.startsWith("\\\\?\\") || r.startsWith("\\\\.\\")) && winAbs.test(r.slice(4))) r = r.slice(4);
  else if (r.toLowerCase().startsWith("\\\\?\\unc\\")) r = "\\\\" + r.slice(8);
  return r.toLowerCase();
}
function refersTo(reference, candidate) {
  const target = canon(candidate);
  if (driveRooted(reference)) {
    const withoutDrive = p => slash(path.win32.normalize(p)).replace(/^[a-z]:/, '').replace(/\/+$/, '');
    const ref = withoutDrive(reference);
    return spellings(candidate).some(p => {
      const name = withoutDrive(p);
      return ref === name || ref.startsWith(name + '/');
    });
  }
  const ref = textOnlyPath(reference) ? textualReference(reference) : canonMaybe(reference);
  const r = path.relative(target, ref);
  return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r));
}
function processState(d) {
  const parsed = [], blocked = []; let uncheckedHiddenProcesses = 0;
  try {
    const rows = d.processes();
    const ownSession = rows.find(r => r.pid === process.pid)?.sessionId;
    for (const row of rows) {
      const c = cmdPaths(row.cmd || '');
      // Даже у процесса другого сеанса известный exe внутри кандидата защищает его.
      parsed.push({ pid: row.pid, t: (row.cmd || '').toLowerCase(), abs: [...c.abs, ...(row.exe && absoluteReference(row.exe) ? [row.exe] : [])] });
      if (!row.cmd) {
        // Без обоих полей сведения скрыты правами, независимо от сеанса (Grok 8959ded1).
        if (!row.exe || (Number.isInteger(ownSession) && Number.isInteger(row.sessionId) && row.sessionId !== ownSession)) uncheckedHiddenProcesses++;
        else blocked.push('процессы не прочитаны: у процесса PID ' + row.pid + ' недоступна командная строка (свой или неизвестный сеанс)');
      }
      if (c.relative.length) blocked.push('у процесса PID ' + row.pid + ' относительный путь: ' + c.relative[0].slice(0, 120));
    }
  } catch (e) { blocked.push('процессы не прочитаны: ' + raceReason(e)); }
  return { parsed, blocked, uncheckedHiddenProcesses };
}
function processWhy(d, p) {
  try {
    canon(p);
    const { parsed, blocked } = processState(d);
    for (const row of parsed) for (const ref of row.abs) {
      if (refersTo(ref, p)) return { code: 'process_busy', reason: 'занят процессом PID ' + row.pid };
    }
    if (blocked.length) return { code: 'processes_unread', reason: 'не удалось проверить: ' + blocked.join('; ') };
  } catch (e) { return { code: 'processes_unread', reason: 'не удалось проверить: процессы или пути не прочитаны: ' + raceReason(e) }; }
  return null;
}
const raceReason = e => e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'изменилось во время проверки' : 'не удалось проверить: ' + e.message;
function inspect(plan, p, fn) {
  try { return fn(); } catch (e) { plan.keep.push({ path: p, reason: raceReason(e) }); return undefined; }
}
function entries(plan, dir) { return inspect(plan, dir, () => fs.readdirSync(dir)) || []; }

module.exports = { cleanup, cleanupText, makePlan, safeChild, windowsProcesses, cmdPaths, configPaths, refersTo, processWhy, cloneWhy, tmpWhy, defaults, liveJobsInFolder };
