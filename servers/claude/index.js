'use strict';
const provenance = require('../../common/provenance');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  { randomUUID } = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { stateDir, canon } = require('../../common/paths'),
  locks = require('../../common/locks');
const { format } = require('../../common/format');
const { readCard, logFailure, guarded } = require('../../common/cards');
const access = require('../../common/access');
const restartHold = require('../../common/restart-hold');
let restartServer;
// Вызывается только под job_start: обработчики могут загрузиться до стартового цикла.
function admitExecution() {
  restartServer ||= restartHold.server(stateDir, 'claude');
  restartHold.assertAdmitted(stateDir, restartServer);
}
const VERSION = '0.5.9',
  dir = path.resolve(process.env.MOST_CLAUDE_JOBS_DIR || path.join(stateDir, 'claude-jobs'));
fs.mkdirSync(dir, { recursive: true });
const active = new Map(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let closing = false,
  scanning = false;

// team-v46: аргументы claude.exe, правила разрешений и обязательные флаги — в отдельном модуле для тестов.
const claudeArgs = require('../../common/claude-args');
const writeLock = require('../../common/write-lock');
const writeFolder = require('../../common/write-folder');

function adapterParams() {
  return require('../../common/members').all().find(m => m.id === 'claude')?.adapter_params || {};
}
function findClaude() {
  const p = adapterParams().exe;
  if (p) return fs.existsSync(p) ? p : null;
  if (process.env.CLAUDE_PATH) return fs.existsSync(process.env.CLAUDE_PATH) ? process.env.CLAUDE_PATH : null;
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'claude.exe' : 'claude'], { encoding: 'utf8', windowsHide: true });
    const first = out.trim().split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
  } catch {}
  const home = process.env.USERPROFILE || os.homedir();
  const candidate = path.join(home, '.local', 'bin', 'claude.exe');
  return fs.existsSync(candidate) ? candidate : null;
}
let cachedBinary = findClaude(), searchedAt = Date.now();
function currentBinary() {
  if (cachedBinary && fs.existsSync(cachedBinary)) return cachedBinary;
  if (cachedBinary || Date.now() - searchedAt >= 60000) { searchedAt = Date.now(); cachedBinary = findClaude(); }
  return cachedBinary;
}
// Фактический вывод `claude --help` кэшируется (повторная проба спустя более 60 с).
const helpText = require('../../common/version-cache')(() => {
  const bin = currentBinary();
  if (!bin) return null;
  try { return execFileSync(bin, ['--help'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).toString(); }
  catch { return null; }
});
function file(id) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw Error('Некорректный номер поручения.');
  const bundle = path.join(dir, id, 'card.json');
  const legacy = path.join(dir, id + '.json');
  return fs.existsSync(bundle) || !fs.existsSync(legacy) ? bundle : legacy;
}
function save(j) {
  const p = file(j.id),
    tmp = p + '.' + randomUUID() + '.tmp';
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    const fd = fs.openSync(tmp, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(j, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, p); break; }
      catch (e) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 8) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
      }
    }
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
function load(id) {
  const job = readCard(file(id));
  if (job.resultFile) job.resultFile = require('../../common/team-store').resultPath(job, dir);
  return job;
}
function list() { return require('../../common/team-store').list('claude', false).jobs; }
async function mutate(id, fn) {
  const l = await locks.waitLock('claude_job', id, { jobId: id }, 8000);
  if (!l.ok) throw Error('Карточка занята.');
  try {
    const j = load(id);
    const before = { ...j };
    if ((await fn(j)) !== false) { save(j); require('../../common/notify').transition('Claude-исполнитель', before, j); }
    return j;
  } finally { await l.release(); }
}
async function normalized(id) {
  let j = load(id);
  if (access.guest()) return j;
  if (['running', 'cancelling', 'stop_unconfirmed'].includes(j.status) && (await locks.ownerState(j.owner)) === 'dead')
    j = await mutate(id, async (c) => {
      if (!['running', 'cancelling', 'stop_unconfirmed'].includes(c.status) || (await locks.ownerState(c.owner)) !== 'dead') return false;
      c.status = c.write ? 'needs_decision' : 'lost';
      c.error = 'Владелец завершился. Проверьте частичный результат; остановка исполнителя не подтверждена.';
      c.stopUnconfirmed = { pid: c.childPid };
    });
  return j;
}
function reply(j, body, next = 'Проверьте результат.', error = false) {
  return { content: [{ type: 'text', text: format('Claude', j, body, next) }], ...(error ? { isError: true } : {}) };
}
function view(j, offset = 0) {
  let body = j.error || '';
  if (j.status === 'queued') body = access.queued;
  if (j.status === 'done' && (!j.resultFile || !fs.existsSync(j.resultFile)))
    throw Error('Файл подтверждённого результата недоступен.');
  if (j.resultFile && fs.existsSync(j.resultFile)) {
    const s = fs.readFileSync(j.resultFile, 'utf8');
    body += '\n' + s.slice(offset, offset + 24000);
    if (offset + 24000 < s.length)
      return reply(j, body, 'Вызовите claude_result: id ' + j.id + ', from_char ' + (offset + 24000) + '.');
  }
  const remaining = require('../../common/chain-deadline').remainingText(j);
  return reply(j, body + (remaining ? '\n' + remaining : ''),
    j.status === 'needs_decision' ? 'Проверьте изменения и решите, продолжать ли.'
      : j.status === 'running' ? 'Запросите claude_result с id ' + j.id + '.' : 'Проверьте результат.');
}
// Разовый сеанс Claude Code без памяти чата: задание — stdin, stdin закрывается.
function parseResult(text) {
  const t = (text || '').trim();
  if (!t) return null;
  try { const o = JSON.parse(t); if (o && typeof o.result === 'string') return o.result; } catch {}
  let found = null;
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim(); if (!s) continue;
    try { const e = JSON.parse(s); if (e?.type === 'result' && typeof e.result === 'string') found = e.result; } catch {}
  }
  return found;
}
// Файлы поручения: конфиг MCP (team и серверы других получателей, без claude) и настройки разрешений.
function taskFiles(job) {
  // Старые плоские карточки остаются читаемыми; их служебная папка скрыта от сканеров карточек.
  const d = path.basename(file(job.id)) === 'card.json' ? path.dirname(file(job.id)) : path.join(dir, '.' + job.id);
  fs.mkdirSync(d, { recursive: true });
  const mcpConfig = path.join(d, 'mcp-config.json');
  const settings = path.join(d, 'settings.json');
  const servers = require('../../common/members').installedServers.filter(n => n !== 'claude');
  const mcp = { mcpServers: {} };
  const env = require('../../common/fallback').jobEnv(job.id);
  for (const n of servers) {
    mcp.mcpServers[n] = {
      command: process.execPath,
      args: [path.join(__dirname, '..', n, 'index.js')],
      env: { ...env, MOST_REPO_ROOT: require('../../common/paths').repoRoot, MOST_STATE_DIR: stateDir },
    };
  }
  fs.writeFileSync(mcpConfig, JSON.stringify(mcp));
  fs.writeFileSync(settings, JSON.stringify(claudeArgs.settings(job)));
  return { mcpConfig, settings };
}
function fullAccessAllowed(card) {
  return card.fullAccess === true && card.write === true && ['текст', 'совет'].includes(card.role) &&
    card.from === 'claude' && !card.parentJob && !card.fallbackWord && !Object.hasOwn(card, 'fromChat');
}
function fullAccessRefusal(a) {
  if (!a.full_access) return null;
  if (access.guest()) return 'Гостю полный доступ Claude запрещён; изменения не выполнены.';
  if (a.write !== true) return 'Полный доступ требует write=true.';
  if (!['текст', 'совет'].includes(a.role)) return 'Для полного доступа явно укажите роль «текст» или «совет»; проверка остаётся в песочнице.';
  return writeFolder.refusal(a.folder, { fullAccess: true });
}
async function execute(job, folderLock) {
  const execution = await locks.tryLock('claude_execution', job.id, { jobId: job.id });
  if (!execution.ok) {
    if (folderLock) await folderLock.release();
    throw Error('Поручение уже выполняется.');
  }
  let writesBefore = null, formatBefore = null, formatResult = null;
  const textFormat = require('../../common/text-format');
  const formatDir = path.join(path.dirname(file(job.id)), job.id, 'format-before');
  function clearFormat() {
    try { textFormat.cleanup({ dir: formatDir }); }
    catch (e) { formatResult = { ...(formatResult || {}), formatCheck: 'неполная: ошибка уборки снимка: ' + e.message }; }
  }
  let child, buffer = '', errors = '', completed = false, finalText = null, done = false, timer, poll;
  function line(s) {
    try {
      const e = JSON.parse(s);
      if (Array.isArray(e.permission_denials)) job.permissionDenials = e.permission_denials;
      if (e.type === 'result' && typeof e.result === 'string') { finalText = e.result; completed = true; }
      if (e.type === 'tool_call') provenance.observe(job, 'claude', { toolNames: [e.tool] });
    } catch {}
  }
  async function finish(code, error) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(poll);
    if (buffer.trim()) line(buffer);
    if (!completed && buffer.trim()) { const r = parseResult(buffer); if (r !== null) { finalText = r; completed = true; } }
    let writes = [];
    try {
      if (job.write) {
        const after = {};
        try { writes = require('../../common/fallback').folderChanges(job.folder, writesBefore, after); }
        catch (e) { writes = null; after.errors = [{ path: '.', code: e.code || e.message }]; }
        try {
          if (!formatResult) formatResult = textFormat.compare(job.folder, formatBefore, writesBefore, writes, { errors: after.errors || [] });
        } catch (e) { formatResult = { formatCheck: 'ошибка проверки: ' + e.message, formatSuspicions: [] }; }
        clearFormat();
      }
      await mutate(job.id, (c) => {
        if (job.write && formatResult) Object.assign(c, formatResult);
        if (!writes) { c.writes = null; c.writesUnknown = 'список записанных файлов не составлен'; }
        else if (c.writes !== null) {
          const byPath = new Map((Array.isArray(c.writes) ? c.writes : []).map(e => [e.path, e]));
          for (const e of writes) byPath.set(e.path, e);
          c.writes = [...byPath.values()];
        }
        c.provenance = provenance.forJob(job, 'claude');
        c.permissionDenials = job.permissionDenials || [];
        c.finishedAt = new Date().toISOString();
        c.exitCode = code;
        const deadlines = require('../../common/chain-deadline');
        if (c.status === 'running' && (deadlines.parentTerminal(c) || deadlines.deadlinePassed(c))) {
          c.status = 'cancelling'; c.stopReason = deadlines.parentTerminal(c) ? 'parent' : 'timeout';
        }
        if (c.status === 'cancelling' || c.status === 'stop_unconfirmed') {
          if (finalText !== null) {
            c.lateResultFile = path.join(path.dirname(file(job.id)), job.id + '.late.result.txt');
            fs.writeFileSync(c.lateResultFile, finalText);
          }
          c.status = c.stopReason === 'cancel' ? 'cancelled' : c.write ? 'needs_decision' : 'failed';
          c.error = c.stopReason === 'timeout' ? 'Истёк предел времени. Проверьте частичный результат.'
            : c.stopReason === 'parent' ? 'Родитель завершился; поручение остановлено.'
            : c.stopReason === 'shutdown' ? 'Сервер остановлен. Проверьте частичный результат.'
            : 'Выполнение остановлено. Уже внесённые изменения сохраняются.';
        } else if (!error && code === 0 && completed && finalText !== null) {
          const out = path.join(path.dirname(file(job.id)), job.id + '.result.txt');
          fs.writeFileSync(out, finalText);
          c.resultFile = out;
          c.status = 'done';
          delete c.error;
        } else {
          c.status = c.write ? 'needs_decision' : 'failed';
          c.error = 'Claude-исполнитель не завершил поручение: ' + (error || errors || 'нет подтверждённого результата');
        }
        if (!c.treeWarning) delete c.stopUnconfirmed;
      });
    } finally {
      active.delete(job.id);
      await execution.release();
      if (folderLock) await folderLock.release();
    }
  }
  // Срок ребёнка: deadline абсолютный; если он истёк в очереди — отмена без запуска.
  if (require('../../common/chain-deadline').deadlinePassed(job)) {
    await mutate(job.id, c => { c.status = 'cancelled'; c.error = 'Срок родителя истёк, пока поручение ждало очереди; запуск отменён.'; c.finishedAt = new Date().toISOString(); });
    await execution.release();
    if (folderLock) await folderLock.release();
    return;
  }
  const availableHelp = helpText();
  const missing = claudeArgs.missingFlags(availableHelp);
  if (missing.length || !currentBinary() || availableHelp === null) {
    const reason = !currentBinary() ? 'не найден claude.exe'
      : availableHelp === null ? 'не удалось проверить флаги claude.exe (нет ответа на --help)'
      : 'нет обязательных флагов claude.exe: ' + missing.join(', ');
    await mutate(job.id, c => { c.status = 'failed'; c.error = 'Claude-исполнитель не запущен: ' + reason + '.'; c.finishedAt = new Date().toISOString(); });
    await execution.release();
    if (folderLock) await folderLock.release();
    return;
  }
  job.resultFile = path.join(path.dirname(file(job.id)), job.id + '.result.txt');
  const params = adapterParams();
  try {
    // Снимок файлов до записи и повторная проверка папки/полного доступа непосредственно перед запуском.
    if (job.write) {
      try {
        const before = require('../../common/fallback').folderStateDetailed(job.folder);
        writesBefore = before.state;
        formatBefore = textFormat.snapshot(job.folder, writesBefore, { dir: formatDir, errors: before.errors });
      } catch (e) { formatResult = { formatCheck: 'ошибка снимка: ' + e.message, formatSuspicions: [] }; }
    }
    job.fullAccessApplied = false;
    const folderRefusal = job.write ? writeFolder.refusal(job.folder, { client: job.from, guest: !!job.parentJob || job.from !== 'claude', fullAccess: fullAccessAllowed(job), owner: job.ownerLabel }) : null;
    if (folderRefusal) throw Error(folderRefusal);
    if (fullAccessAllowed(job)) {
      const refusal = writeFolder.refusal(job.folder, { fullAccess: true });
      if (refusal) throw Error(refusal);
    } else if (Object.hasOwn(job, 'fullAccess') && job.fullAccess !== false) {
      console.error('Claude: полный доступ карточки отклонён (значение, запись, роль или происхождение); запуск в песочнице.');
    }
  } catch (e) {
    clearFormat();
    try {
      await mutate(job.id, c => { c.status = 'failed'; c.error = e.message; c.fullAccessApplied = false; c.finishedAt = new Date().toISOString(); });
    } finally {
      await execution.release();
      if (folderLock) await folderLock.release();
    }
    return;
  }
  job.fullAccessApplied = fullAccessAllowed(job) && job.write;
  try {
    const files = taskFiles(job);
    await mutate(job.id, (c) => { c.fullAccessApplied = job.fullAccessApplied; c.resultFile = job.resultFile; });
    const args = claudeArgs.buildArgs(files, params, job, availableHelp);
    await mutate(job.id, c => { c.enabledTools = args[args.indexOf('--tools') + 1].split(','); });
    // Подготовка и ожидание замков тоже расходуют срок; после проверки до spawn нет await.
    if (require('../../common/chain-deadline').deadlinePassed(job)) {
      clearFormat();
      await mutate(job.id, c => { c.status = 'cancelled'; c.error = 'Срок поручения истёк до запуска.'; c.finishedAt = new Date().toISOString(); });
      await execution.release();
      if (folderLock) await folderLock.release();
      return;
    }
    child = spawn(currentBinary(), args, {
      cwd: job.folder,
      env: require('../../common/fallback').jobEnv(job.id),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    active.set(job.id, { child, job });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', guarded((d) => {
      buffer += d;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
    }));
    child.stderr.on('data', guarded((d) => (errors = (errors + d).slice(-6000))));
    child.stdin.on('error', () => {});
    child.on('error', guarded((e) => finish(null, e.message)));
    child.on('close', guarded((code) => finish(code)));
    await mutate(job.id, (c) => { c.childPid = child.pid; c.childStartedAt = new Date().toISOString(); });
    if (done) return;
    // Срок процесса при запуске = deadline − сейчас (если задан), иначе обычные 60 мин.
    const budget = require('../../common/chain-deadline').runtimeBudget(job, 'claude');
    timer = setTimeout(guarded(() => stop(job.id, 'timeout')), budget);
    poll = setInterval(guarded(function pollJob() {
      const j = load(job.id);
      if (require('../../common/chain-deadline').parentTerminal(j)) stop(job.id, 'parent').catch(logFailure);
      else if (j.status === 'cancelling') stop(job.id, j.stopReason).catch(logFailure);
    }), 200);
    child.stdin.end(['Это отдельное поручение пользователя через Claude. Не считай, что знаешь другие чаты.',
      job.fullAccessApplied
        ? 'Полный доступ: команды выполняются от имени пользователя без песочницы. Запускай только то, что названо в поручении; не изменяй файлы связки; удаления запрещены; каждое действие вне папки поручения перечисли в отчёте.'
        : job.write ? 'Изменения разрешены только в рамках поручения. Перечисли файлы и проверки.'
        : 'Только чтение. Не изменяй файлы.',
      'Не обходи ограничения. Отвечай по-русски.', job.task, job.textFile ? 'Материал в файле: ' + job.textFile : ''].join('\n'));
  } catch (e) {
    await finish(null, e.message);
  }
}
async function stop(id, reason = 'cancel') {
  const e = active.get(id);
  if (!e || e.stopping) return;
  e.stopping = true;
  let requested = false;
  try {
    await mutate(id, (c) => {
      if (!['running', 'cancelling', 'stop_unconfirmed'].includes(c.status)) return false;
      c.status = 'cancelling';
      c.cancellingAt ||= new Date().toISOString();
      c.stopReason = reason;
      requested = true;
    });
  } catch (error) { e.stopping = false; throw error; }
  if (!requested) { e.stopping = false; return; }
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill.exe', ['/PID', String(e.child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'pipe' });
    else process.kill(-e.child.pid, 'SIGKILL');
  } catch (err) {
    await mutate(id, (c) => { c.treeWarning = 'Остановка дерева процессов не подтверждена: ' + err.message; c.stopUnconfirmed = { pid: e.child.pid }; });
    try { e.child.kill('SIGKILL'); } catch {}
  }
  setTimeout(guarded(() => { if (active.has(id)) mutate(id, (c) => { c.status = 'stop_unconfirmed'; c.stopUnconfirmed = { pid: e.child.pid }; }).catch(logFailure); }), 3000).unref();
}
// team-v46 п.2: хранилище родителя для claude-print — store 'claude'.
function parentJob() { return require('../../common/job-identity').currentJob(); }
async function send(a) {
  if (a.continue_id !== undefined) throw Error('Claude-исполнитель не поддерживает продолжение (continue_id): создайте отдельное поручение.');
  access.guard('claude', 'claude_send', a);
  const refusal = fullAccessRefusal(a);
  if (refusal) throw Error(refusal);
  // Запись по поручению: дирижёр или пишущее поручение с writer по реестру; иначе — отказ.
  if (a.write && access.guest() && !(process.env.MOST_JOB_ID && require('../../common/members').canWrite(access.client()) && parentJob()?.write === true))
    throw Error('Запись Claude-исполнителя может просить только дирижёр Claude или пишущее поручение участника с writer=true.');
  const support = require('../../common/brief-support');
  const extra = support.text(support.support(a.folder, a.opora));
  if (extra) a.text = (a.text || '') + extra;
  if (!currentBinary() && !access.guest()) throw Error('Исполнитель Claude не найден. Укажите CLAUDE_PATH.');
  if (require('../../common/user-word').mode().active) throw Error('Claude-исполнитель недоступен в запасном режиме (Claude отвалился).');
  if (closing) throw Error('Сервер останавливается.');
  if (!path.isAbsolute(a.folder) || !fs.existsSync(a.folder) || !fs.statSync(a.folder).isDirectory())
    throw Error('Нужна абсолютная существующая папка.');
  // team-v46 п.5а: общее правило папок при постановке.
  if (a.write) {
    const fref = writeFolder.refusal(a.folder, { client: access.client(), guest: access.guest(), fullAccess: a.full_access === true, owner: a.owner });
    if (fref) throw Error(fref);
  }
  if (a.work && !a.stage) throw Error('Для работы укажите этап.');
  const folder = fs.realpathSync(a.folder),
    id = randomUUID();
  let folderLock = null;
  try {
    if (a.write) {
      folderLock = await writeLock.acquire(folder, { jobId: id });
      if (!folderLock.ok) throw Error(folderLock.needsDecision ? 'Нужно решение: остановка прежнего исполнителя не подтверждена; замок записи сохранён.' : 'В этой папке (или вложенной) уже идёт поручение с записью.');
    }
    if (!access.guest() && restartServer) restartHold.assertAdmitted(stateDir, restartServer, { early: true });
    await require('../../common/stage-gate').prepareJob(a, 'claude');
    const chainFields = require('../../common/job-chain').fields(a);
    const dl = require('../../common/chain-deadline').applyDeadline(chainFields, access.client(), 'claude');
    if (dl.error) throw Error(dl.error);
    const job = {
      id, folder, write: a.write, fullAccess: a.full_access === true,
      task: a.task,
      stage: a.stage, stageTitle: a.stageTitle, stageId: a.stageId, gateOrder: a.gateOrder, scopeTask: a.scopeTask, role: a.role, replaces: a.replaces, replacementEvidence: a.replacementEvidence,
      work: a.work,
      from: require('../../common/job-identity').memberId(access.client()) || access.client(),
      ...chainFields,
      status: access.guest() ? 'queued' : 'running',
      startedAt: new Date().toISOString(),
      owner: access.guest() ? null : locks.owner(),
      ownerLabel: a.owner,
      rev: require('../../common/members').rev(),
      quotaAttempts: 0,
      ...(dl.deadline ? { deadline: dl.deadline } : {}),
    };
    if (a.text !== undefined) { job.textFile = path.join(dir, id + '.input.txt'); fs.writeFileSync(job.textFile, a.text); }
    job.provenance = provenance.forJob(job, 'claude');
    if (access.guest()) save(job);
    else await restartHold.locked(stateDir, () => { admitExecution(); save(job); });
    if (access.guest()) return reply(job, access.queued);
    const lock = folderLock;
    folderLock = null;
    await execute(job, lock);
    return view(load(job.id));
  } finally {
    if (folderLock?.ok) await folderLock.release();
  }
}
async function queue() {
  if (access.guest() || scanning || closing) return;
  scanning = true;
  try {
    await require('../../common/progress').longRunning('Claude', list(), mutate);
    for (const j of list()) {
      if (['queued', 'waiting_quota'].includes(j.status) && require('../../common/chain-deadline').parentTerminal(j)) {
        await mutate(j.id, c => { if (!['queued', 'waiting_quota'].includes(c.status)) return false; c.status = 'cancelled'; c.stopReason = 'parent'; c.error = 'Родитель завершился; запуск отменён.'; c.finishedAt = new Date().toISOString(); });
        continue;
      }
      // team-v46 п.8: межпроцессная остановка идущих детей, чей родитель завершился досрочно.
      if (j.status === 'running' && j.parentJob && require('../../common/chain-deadline').parentTerminal(j)) {
        await mutate(j.id, c => { if (c.status !== 'running') return false; c.status = 'cancelling'; c.stopReason = 'parent'; });
        if (active.has(j.id)) await stop(j.id, 'parent');
        continue;
      }
      if (!['queued'].includes(j.status)) continue;
      let refusal;
      try { refusal = require('../../common/job-chain').queuedRefusal(j, undefined, 'claude'); } catch (e) { refusal = e.message; }
      if (refusal) {
        await mutate(j.id, c => { if (c.status !== 'queued') return false; c.status = 'failed'; c.error = refusal; c.finishedAt = new Date().toISOString(); });
        continue;
      }
      if (require('../../common/chain-deadline').deadlinePassed(j)) {
        await mutate(j.id, c => { if (c.status !== 'queued') return false; c.status = 'cancelled'; c.error = 'Срок родителя истёк, пока поручение ждало очереди; запуск отменён.'; c.finishedAt = new Date().toISOString(); });
        continue;
      }
      const l = await locks.tryLock('claude_queue', j.id, { jobId: j.id });
      if (!l.ok) continue;
      let folderLock = null;
      try {
        if (j.write) {
          folderLock = await writeLock.acquire(j.folder, { jobId: j.id });
          if (!folderLock.ok) { folderLock = null; continue; }
          const fref = writeFolder.refusal(j.folder, { client: j.from, guest: j.from !== 'claude', fullAccess: fullAccessAllowed(j), owner: j.ownerLabel });
          if (fref) {
            await mutate(j.id, c => { if (c.status !== 'queued') return false; c.status = 'failed'; c.error = fref; c.fullAccessApplied = false; c.finishedAt = new Date().toISOString(); });
            continue;
          }
        }
        let claimed = false;
        const c = await restartHold.locked(stateDir, () => mutate(j.id, (c) => {
          if (c.status !== 'queued') return false;
          let reason;
          try { reason = require('../../common/job-chain').queuedRefusal(c, undefined, 'claude'); } catch (e) { reason = e.message; }
          if (reason) { c.status = 'failed'; c.error = reason; c.finishedAt = new Date().toISOString(); return; }
          admitExecution();
          c.status = 'running';
          c.owner = locks.owner();
          delete c.finishedAt;
          claimed = true;
        }));
        if (claimed) { const lock = folderLock; folderLock = null; await execute(c, lock); }
      } catch (e) {
        if (e.code !== 'ENOENT' && !e.restartHold) throw e;
      } finally {
        if (folderLock) await folderLock.release();
        await l.release();
      }
    }
  } finally { scanning = false; }
}
const server = new McpServer({ name: 'claude', version: VERSION }, require('../../common/server-instructions').options('claude'));
function register(name, title, description, inputSchema, fn) {
  if (!access.allowed('claude', name)) return;
  server.registerTool(name, { title, description, inputSchema: require('../../common/schema').compatible(inputSchema) }, async (a) => {
    try {
      access.guard('claude', name, a);
      if (name === 'claude_send') {
        const refusal = fullAccessRefusal(a);
        if (refusal) throw Error(refusal);
      }
      return name === 'claude_send' ? await require('../../common/work-owner').withWork(a, () => fn(a)) : await fn(a);
    } catch (e) {
      let j = { id: a.id, status: 'failed' };
      try { if (a.id) j = { ...load(a.id), status: 'failed' }; } catch {}
      return reply(j, 'Ошибка: ' + require('../../common/errors').errorText(e), 'Исправьте причину и повторите запрос.', true);
    }
  });
}
register('claude_send', 'Поручить Claude-исполнителю', 'Начать отдельное разовое поручение Claude Code (отдельный сеанс, не чат). Запись — как у Codex; Bash — только с полным доступом от дирижёра.', {
  folder: z.string().describe('Абсолютная папка проекта.'),
  ...require('../../common/stage-schema').send,
  task: z.string().min(1).describe('Поручение.'),
  text: z.string().optional().describe('Материал для работы.'),
  write: z.boolean().default(false).describe('Разрешить изменения по поручению (Edit в папке поручения).'),
  full_access: z.boolean().default(false).describe('Полный доступ для запуска программ пользователя (Bash); только Claude-дирижёр, с записью и ролью текст или совет.'),
  continue_id: z.string().optional().describe('Номер предыдущего поручения.'),
  stage: z.string().optional().describe('Этап.'),
  owner: z.string().optional().describe('Метка сеанса владельца работы.'),
  work: z.string().optional().describe('Работа.'),
}, send);
register('claude_result', 'Результат Claude-исполнителя', 'Получить состояние и ответ, при необходимости частями.', {
  id: z.string().describe('Номер поручения.'),
  wait_sec: z.number().int().min(0).max(40).default(0).describe('Ожидание в секундах.'),
  from_char: z.number().int().min(0).default(0).describe('Начальный символ.'),
}, async ({ id, wait_sec, from_char }) => {
  const end = Date.now() + wait_sec * 1000;
  let j = await normalized(id);
  while (j.status === 'running' && Date.now() < end) { await sleep(100); j = await normalized(id); }
  return view(j, from_char);
});
register('claude_cancel', 'Отменить Claude-исполнителя', 'Остановить поручение.', { id: z.string().describe('Номер поручения.') }, async (a) => {
  const { id } = a;
  const j = await mutate(id, (c) => {
    if (require('../../common/job-cancel').cancelWaiting(c)) return;
    if (c.status === 'running') { c.status = 'cancelling'; c.cancellingAt ||= new Date().toISOString(); }
  });
  if (active.has(id)) await stop(id);
  return view(j);
});
register('claude_status', 'Состояние Claude-исполнителя', 'Проверить версии и поручения; счётчик поручений за 5 ч и сутки (счётчик расхода, не квота провайдера).', {}, async () => {
  const rows = [];
  for (const j of list()) {
    try {
      const c = await normalized(j.id);
      if (['queued', 'running', 'cancelling', 'stop_unconfirmed', 'lost', 'needs_decision'].includes(c.status))
        rows.push(format('Claude', c, c.error || '', 'Запросите результат.'));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const count = ms => list().filter(j => Date.parse(j.startedAt) > Date.now() - ms).length;
  return reply({ status: 'done' },
    'Версия процесса: ' + VERSION + '\nClaude-исполнитель: ' + (currentBinary() || 'не найден') +
    '\nПоручений за 5 ч: ' + count(5 * 3600000) + ', за сутки: ' + count(24 * 3600000) + ' (счётчик расхода, не квота провайдера).\n' +
    (rows.join('\n') || 'Идущих и ожидающих поручений нет.'), 'Выберите поручение или начните новое.');
});
async function shutdown() {
  if (closing) return;
  closing = true;
  if (restartServer) restartServer.closed = true;
  await Promise.all([...active.keys()].map((id) => stop(id, 'shutdown').catch(logFailure)));
  const end = Date.now() + 5000;
  while (active.size && Date.now() < end) await sleep(100);
  process.exit(0);
}
(async () => {
  await require('../../common/state-migration').start(require('../../common/paths'));
  restartServer = access.guest() ? null : restartHold.serverAsync(stateDir, 'claude');
  process.stdin.on('close', guarded(shutdown));
  const owner = await locks.startOwner({ version: VERSION, file: __filename });
  if (!owner.ok) throw Error('Не удалось открыть канал владельца.');
  process.stdin.on('end', guarded(shutdown));
  process.on('SIGINT', guarded(shutdown));
  process.on('SIGTERM', guarded(shutdown));
  server.server.onclose = guarded(shutdown);
  await server.connect(require('../../common/public-transport').publicTransport(new StdioServerTransport()));
  access.ready('claude');
  if (!access.guest() && process.env.MOST_PROBE_ONLY !== '1') {
    await queue().catch(logFailure);
    setInterval(guarded(queue), Math.min(30000, Number(process.env.MOST_QUEUE_TICK_MS || 1000))).unref();
  }
})().catch((e) => { logFailure(e); process.exit(1); });
