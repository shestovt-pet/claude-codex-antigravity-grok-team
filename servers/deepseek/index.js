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
const writeLock = require('../../common/write-lock'),
  writeFolder = require('../../common/write-folder');
const profiles = require('../../common/dsh-profiles');
let restartServer;
// Вызывается только под job_start: обработчики могут загрузиться до стартового цикла.
function admitExecution() {
  restartServer ||= restartHold.server(stateDir, 'deepseek');
  restartHold.assertAdmitted(stateDir, restartServer);
}
const VERSION = '0.5.9',
  dir = path.resolve(process.env.MOST_DEEPSEEK_JOBS_DIR || path.join(stateDir, 'deepseek-jobs'));
fs.mkdirSync(dir, { recursive: true });
const active = new Map(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let closing = false,
  scanning = false;

function adapterParams() {
  return require('../../common/members').all().find(m => m.id === 'deepseek')?.adapter_params || {};
}
function findDsh() {
  return require('../../common/dsh-probe').binary();
}
function findDshLegacy() {
  const p = adapterParams().path;
  if (p) return fs.existsSync(p) ? p : null;
  if (process.env.DSH_PATH) return fs.existsSync(process.env.DSH_PATH) ? process.env.DSH_PATH : null;
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'dsh.cmd' : 'dsh'], { encoding: 'utf8', windowsHide: true });
    const first = out.trim().split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
  } catch {}
  if (!process.env.LOCALAPPDATA) return null;
  const root = path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness');
  const candidate = path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  return fs.existsSync(candidate) ? candidate : null;
}
let cachedBinary = findDsh(), searchedAt = Date.now();
function currentBinary() {
  if (cachedBinary && fs.existsSync(cachedBinary)) return cachedBinary;
  if (cachedBinary || Date.now() - searchedAt >= 60000) { searchedAt = Date.now(); cachedBinary = findDsh(); }
  return cachedBinary;
}
// Фактическая версия dsh: повторная проба по обращению спустя более 60 с.
const dshVersion = require('../../common/version-cache')(() => {
  const bin = currentBinary();
  if (!bin) return null;
    const out = execFileSync(require('../../common/dsh-probe').command(bin), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000, shell: require('../../common/dsh-probe').viaShell(bin) });
  return /(\d+\.\d+\.\d+[^\s]*)/.exec(out || '')?.[1] || null;
});
function file(id) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw Error('Некорректный номер поручения.');
  const bundle = path.join(dir, id, 'card.json');
  return fs.existsSync(bundle) ? bundle : path.join(dir, id + '.json');
}
function save(j) {
  const p = file(j.id),
    tmp = p + '.' + randomUUID() + '.tmp';
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
function list() { return require('../../common/team-store').list('deepseek', false).jobs; }
async function mutate(id, fn) {
  const l = await locks.waitLock('deepseek_job', id, { jobId: id }, 8000);
  if (!l.ok) throw Error('Карточка занята.');
  try {
    const j = load(id);
    const before = { ...j };
    if ((await fn(j)) !== false) { save(j); require('../../common/notify').transition('DeepSeek', before, j); }
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
// Полный номер по полному номеру или однозначному префиксу: тот же источник, что у закрытия словом.
async function resolveId(id) {
  let j;
  try { j = load(id); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (j && j.id === id) return j.id;
  const found = list().filter(x => typeof x.id === 'string' && x.id.startsWith(id));
  if (found.length !== 1) throw Error(found.length ? 'Предыдущее поручение неоднозначно: ' + id : 'Предыдущее поручение не найдено: ' + id);
  return found[0].id;
}
function reply(j, body, next = 'Проверьте результат.', error = false) {
  return { content: [{ type: 'text', text: format('DeepSeek', j, body, next) }], ...(error ? { isError: true } : {}) };
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
      return reply(j, body, 'Вызовите deepseek_result: id ' + j.id + ', from_char ' + (offset + 24000) + '.');
  }
  return reply(j, body,
    j.status === 'needs_decision' ? 'Проверьте изменения и решите, продолжать ли.'
      : j.status === 'running' ? 'Запросите deepseek_result с id ' + j.id + '.' : 'Проверьте результат.');
}
function fullAccessAllowed(card) {
  return card.fullAccess === true && card.write === true && ['текст', 'совет'].includes(card.role) &&
    card.from === 'claude' && !card.parentJob && !card.fallbackWord && !Object.hasOwn(card, 'fromChat');
}
function fullAccessFolderRefusal(folder) {
  const paths = require('../../common/paths');
  if (!path.isAbsolute(folder) || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return 'Нужна абсолютная существующая папка.';
  if ([paths.repoRoot, path.resolve(__dirname, '../..')].some(root => paths.isSameOrInsideReal(folder, root) || paths.isSameOrInsideReal(root, folder)))
    return 'Полный доступ запрещён в папке связки, её рабочей копии или релиза, а также в содержащей их папке.';
  return null;
}
function chatFolderRefusal(folder) {
  const refusal = fullAccessFolderRefusal(folder);
  return refusal && refusal.replace('Полный доступ запрещён', 'Запись из чата DeepSeek запрещена');
}
function chatCardRefusal(card) {
  const chain = require('../../common/job-chain').queuedRefusal(card, undefined, 'deepseek');
  if (chain) return chain;
  if (!Object.hasOwn(card, 'fromChat')) return null;
  if (card.fromChat !== 'deepseek' || card.from !== 'deepseek' || card.fullAccess === true)
    return 'Карточка чата DeepSeek отклонена: противоречивые поля fromChat, from или fullAccess.';
  return card.write ? chatFolderRefusal(card.folder) : null;
}
function fullAccessRefusal(a) {
  if (!a.full_access) return null;
  if (access.guest()) return 'Гостю полный доступ DeepSeek запрещён; изменения не выполнены.';
  if (a.write !== true) return 'Полный доступ требует write=true.';
  if (!['текст', 'совет'].includes(a.role)) return 'Для полного доступа явно укажите роль «текст» или «совет»; проверка остаётся в песочнице.';
  return fullAccessFolderRefusal(a.folder);
}
async function execute(job, folderLock) {
  const execution = await locks.tryLock('deepseek_execution', job.id, { jobId: job.id });
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
      if (e.type === 'session' && e.sessionId) { job.sessionId = e.sessionId; mutate(job.id, c => { c.sessionId = e.sessionId; }).catch(logFailure); }
      if (e.type === 'final') { finalText = String(e.text ?? ''); completed = true; }
      if (e.type === 'tool_call') provenance.observe(job, 'deepseek', { toolNames: [e.tool] });
    } catch {}
  }
  async function finish(code, error) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(poll);
    if (buffer.trim()) line(buffer);
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
        c.sessionId = job.sessionId;
        // team-v35: модель и доказательство — маршрут поставщика DeepSeek (запрошенная модель), с честной пометкой.
        const ev = profiles.sessionEvidence(job.sessionId);
        c.reportedModel = ev?.model || null;
        c.modelEvidence = ev?.evidence || null;
        c.modelConfirmed = !!c.reportedModel && c.reportedModel === profiles.profileModel(job.profile || profiles.profileName(job), params);
        c.provenance = provenance.forJob(job, 'deepseek');
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
            : c.stopReason === 'shutdown' ? 'Сервер остановлен. Проверьте частичный результат.'
            : c.stopReason === 'parent' ? 'Родитель завершился; поручение остановлено.'
            : 'Выполнение остановлено. Уже внесённые изменения сохраняются.';
        } else if (!error && code === 0 && completed && finalText !== null) {
          const out = path.join(path.dirname(file(job.id)), job.id + '.attempt-' + (job.quotaAttempts || 0) + '.result.txt');
          fs.writeFileSync(out, finalText);
          c.resultFile = out;
          c.status = 'done';
          delete c.error;
        } else {
          c.status = c.write ? 'needs_decision' : 'failed';
          c.error = 'DeepSeek не завершил поручение: ' + (error || errors || 'нет подтверждённого результата');
        }
        if (!c.treeWarning) delete c.stopUnconfirmed;
      });
    } finally {
      active.delete(job.id);
      await execution.release();
      if (folderLock) await folderLock.release();
    }
  }
  const params = adapterParams();
  job.resultFile = path.join(path.dirname(file(job.id)), job.id + '.attempt-' + (job.quotaAttempts || 0) + '.result.txt');

  try {
    if (job.write) {
      try {
        const before = require('../../common/fallback').folderStateDetailed(job.folder);
        writesBefore = before.state;
        formatBefore = textFormat.snapshot(job.folder, writesBefore, { dir: formatDir, errors: before.errors });
      } catch (e) { formatResult = { formatCheck: 'ошибка снимка: ' + e.message, formatSuspicions: [] }; }
    }
    job.fullAccessApplied = false;
    const chatRefusal = chatCardRefusal(job);
    if (chatRefusal) throw Error(chatRefusal);
    // team-v46 п.5а: повторная проверка папки записи перед запуском.
    if (job.write) {
      const fref = writeFolder.refusal(job.folder, { client: job.from, guest: !!job.parentJob || job.from !== 'claude', fullAccess: fullAccessAllowed(job), owner: job.ownerLabel });
      if (fref) throw Error(fref);
    }
    if (fullAccessAllowed(job)) {
      const refusal = fullAccessFolderRefusal(job.folder);
      if (refusal) throw Error(refusal);
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
  job.profile = profiles.profileName(job);
  try {
    await mutate(job.id, (c) => { c.fullAccessApplied = job.fullAccessApplied; c.profile = job.profile; c.dshVersion = dshVersion(); c.resultFile = job.resultFile; });
    if (!process.env.MOST_DSH_NO_PROFILES) profiles.generate(params, undefined, bridgeParams());
    if (require('../../common/chain-deadline').deadlinePassed(job)) throw Error('Срок поручения истёк до запуска.');
    const args = ['--profile', job.profile, '--json', '-']; // слово headless dsh считал задачей; «-» — задача из stdin (живые пробы 95ce3e03, 48edb61f, 406eb880)
    child = spawn(require('../../common/dsh-probe').command(currentBinary()), args, {
      cwd: job.folder,
      env: { ...require('../../common/fallback').jobEnv(job.id), DSH_HOME: profiles.profilesDir() },
      windowsHide: true,
      detached: process.platform !== 'win32',
      // dsh — это .cmd на Windows; оболочка запускает его и передаёт stdin.
      shell: /\.(cmd|bat)$/i.test(currentBinary()),
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
    timer = setTimeout(guarded(() => stop(job.id, 'timeout')), require('../../common/chain-deadline').runtimeBudget(job, 'deepseek'));
    poll = setInterval(guarded(function pollJob() {
      const j = load(job.id);
      if (require('../../common/chain-deadline').parentTerminal(j)) stop(job.id, 'parent').catch(logFailure);
      else if (j.status === 'cancelling') stop(job.id, j.stopReason).catch(logFailure);
    }), 200);
    child.stdin.end(['Это отдельное поручение пользователя через Claude. Не считай, что знаешь другие чаты.',
      job.fullAccessApplied ? 'Полный доступ: команды выполняются от имени пользователя без песочницы. Запускай только то, что названо в поручении; не изменяй файлы связки; удаления запрещены; каждое действие вне папки поручения перечисли в отчёте.'
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
// team-v36: пути гостевых серверов моста для профилей поручений DeepSeek.
function bridgeParams() {
  return { release: path.resolve(__dirname, '..', '..'), root: require('../../common/paths').repoRoot, node: process.execPath };
}
function parentJob() { return require('../../common/job-identity').currentJob(); }
async function send(a) {
  access.guard('deepseek', 'deepseek_send', a);
  const refusal = fullAccessRefusal(a);
  if (refusal) throw Error(refusal);
  // К2: запись просит только дирижёр Claude, чат пользователя (запасной дирижёр) или пишущее поручение участника с writer=true.
  if (a.write && access.guest() && !(require('../../common/fallback').caller() || (process.env.MOST_JOB_ID && require('../../common/members').canWrite(access.client()) && parentJob()?.write === true)))
    throw Error('Запись DeepSeek может просить только дирижёр Claude, запасной дирижёр или пишущее поручение участника с writer=true.');
  const support = require('../../common/brief-support');
  const extra = support.text(support.support(a.folder, a.opora));
  if (extra) a.text = (a.text || '') + extra;
  if (!currentBinary() && !access.guest()) throw Error('Исполнитель DeepSeek не найден. Укажите DSH_PATH.');
  if (closing) throw Error('Сервер останавливается.');
  if (!path.isAbsolute(a.folder) || !fs.existsSync(a.folder) || !fs.statSync(a.folder).isDirectory())
    throw Error('Нужна абсолютная существующая папка.');
  if (a.work && !a.stage) throw Error('Для работы укажите этап.');
  // team-v46 п.5а: общее правило папок для любой записи.
  if (a.write) {
    const fref = writeFolder.refusal(a.folder, { client: access.client(), guest: access.guest(), fullAccess: a.full_access === true, owner: a.owner });
    if (fref) throw Error(fref);
  }
  const folder = fs.realpathSync(a.folder),
    id = randomUUID();
  let prior = null, priorLock = null, folderLock = null;
  try {
    if (a.continue_id) {
      const full = await resolveId(a.continue_id);
      priorLock = await locks.tryLock('deepseek_queue', full, { jobId: id });
      if (!priorLock.ok) throw Error('Предыдущее поручение возобновляется.');
      prior = await normalized(full);
      if (prior.closedByWord) throw Error('Поручение закрыто словом пользователя; продолжение недоступно.');
      if (prior.archived || !['done', 'failed', 'needs_decision'].includes(prior.status) || prior.stopUnconfirmed)
        throw Error('Продолжение недоступно: нужно завершённое поручение с подтверждённой остановкой.');
      if (canon(prior.folder) !== canon(folder) || prior.write !== a.write) throw Error('Сохраните папку и режим записи предыдущего поручения.');
    }
    if (a.write) {
      folderLock = await writeLock.acquire(folder, { jobId: id });
      if (!folderLock.ok) throw Error(folderLock.needsDecision ? 'Нужно решение: остановка прежнего исполнителя не подтверждена; замок записи сохранён.' : 'В этой папке (или вложенной) уже идёт поручение с записью.');
    }
    const params = adapterParams();
    a.model ??= prior?.model ?? profiles.modelFor({ role: a.role, write: a.write, fullAccessApplied: fullAccessAllowed({ fullAccess: a.full_access === true, write: a.write, role: a.role, from: access.client() }) }, params);
    if (!access.guest() && restartServer) restartHold.assertAdmitted(stateDir, restartServer, { early: true });
    // Профиль назначается сервером до ворот этапа: проверка этапа требует most-review (ревью Codex f977c3d4, п.1).
    a.profile = profiles.profileName({ role: a.role, write: a.write, fullAccessApplied: fullAccessAllowed({ fullAccess: a.full_access === true, write: a.write, role: a.role, from: access.client() }) });
    if (a.role === 'проверка' && !access.guest() && !process.env.MOST_DSH_NO_PROFILES) await require('../../common/dsh-probe').ensure().catch(logFailure);
    await require('../../common/stage-gate').prepareJob(a, 'deepseek');
    const chainFields = require('../../common/job-chain').fields(a);
    const dl = require('../../common/chain-deadline').applyDeadline(chainFields, access.client(), 'deepseek');
    if (dl.error) throw Error(dl.error);
    const job = {
      id, folder, write: a.write, fullAccess: a.full_access === true, model: a.model,
      profile: profiles.profileName({ role: a.role, write: a.write, fullAccessApplied: fullAccessAllowed({ fullAccess: a.full_access === true, write: a.write, role: a.role, from: access.client() }) }),
      task: a.task,
      stage: a.stage, stageTitle: a.stageTitle, stageId: a.stageId, gateOrder: a.gateOrder, scopeTask: a.scopeTask, role: a.role, replaces: a.replaces, replacementEvidence: a.replacementEvidence,
      work: a.work,
      from: require('../../common/job-identity').memberId(access.client()) || access.client(),
      ...chainFields,
      ...(access.guest() && access.client() === 'deepseek' && !process.env.MOST_JOB_ID ? { fromChat: 'deepseek' } : {}),
      status: access.guest() ? 'queued' : 'running',
      startedAt: new Date().toISOString(),
      owner: access.guest() ? null : locks.owner(),
      ownerLabel: a.owner,
      previous: prior?.id || null,
      rev: require('../../common/members').rev(),
      dshVersion: dshVersion(),
      quotaAttempts: 0,
      ...(dl.deadline ? { deadline: dl.deadline } : {}),
    };
    if (a.text !== undefined) { job.textFile = path.join(dir, id + '.input.txt'); fs.writeFileSync(job.textFile, a.text); }
    job.provenance = provenance.forJob(job, 'deepseek');
    if (access.guest()) save(job);
    else await restartHold.locked(stateDir, () => { admitExecution(); save(job); });
    if (access.guest()) return reply(job, access.queued);
    const lock = folderLock;
    folderLock = null;
    await execute(job, lock);
    return view(load(job.id));
  } finally {
    if (priorLock?.ok) await priorLock.release();
    if (folderLock?.ok) await folderLock.release();
  }
}
async function queue() {
  if (access.guest() || !currentBinary() || scanning || closing) return;
  scanning = true;
  try {
    await require('../../common/progress').longRunning('DeepSeek', list(), mutate);
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
      try { refusal = chatCardRefusal(j); } catch (e) { refusal = e.message; }
      if (refusal) {
        await mutate(j.id, c => { if (c.status !== 'queued') return false; c.status = 'failed'; c.error = refusal; c.fullAccessApplied = false; c.finishedAt = new Date().toISOString(); });
        continue;
      }
      // team-v46 п.5а: срок родителя истёк в очереди — отмена без запуска.
      if (require('../../common/chain-deadline').deadlinePassed(j)) {
        await mutate(j.id, c => { if (c.status !== 'queued') return false; c.status = 'cancelled'; c.error = 'Срок родителя истёк, пока поручение ждало очереди; запуск отменён.'; c.finishedAt = new Date().toISOString(); });
        continue;
      }
      const l = await locks.tryLock('deepseek_queue', j.id, { jobId: j.id });
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
          // team-v36 Р2: перепроверка карточки под замком перед первым запуском (родитель мог завершиться за время ожидания).
          let reason;
          try { reason = chatCardRefusal(c); } catch (e) { reason = e.message; }
          if (reason) { c.status = 'failed'; c.error = reason; c.fullAccessApplied = false; c.finishedAt = new Date().toISOString(); return; }
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
const server = new McpServer({ name: 'deepseek', version: VERSION }, require('../../common/server-instructions').options('deepseek'));
function register(name, title, description, inputSchema, fn) {
  if (!access.allowed('deepseek', name)) return;
  server.registerTool(name, { title, description, inputSchema: require('../../common/schema').compatible(inputSchema) }, async (a) => {
    try {
      access.guard('deepseek', name, a);
      if (name === 'deepseek_send') {
        const refusal = fullAccessRefusal(a);
        if (refusal) throw Error(refusal);
      }
      return name === 'deepseek_send' ? await require('../../common/work-owner').withWork(a, () => fn(a)) : await fn(a);
    } catch (e) {
      let j = { id: a.id, status: 'failed' };
      try { if (a.id) j = { ...load(a.id), status: 'failed' }; } catch {}
      return reply(j, 'Ошибка: ' + require('../../common/errors').errorText(e), 'Исправьте причину и повторите запрос.', true);
    }
  });
}
register('deepseek_send', 'Поручить DeepSeek', 'Начать отдельное поручение DeepSeek (headless dsh).', {
  folder: z.string().describe('Абсолютная папка проекта.'),
  ...require('../../common/stage-schema').send,
  task: z.string().min(1).describe('Поручение.'),
  text: z.string().optional().describe('Материал для работы.'),
  write: z.boolean().default(false).describe('Разрешить изменения по поручению.'),
  full_access: z.boolean().default(false).describe('Полный доступ для запуска программ пользователя; только Claude, с записью и ролью текст или совет.'),
  model: z.string().regex(/^[A-Za-z0-9._:-]+$/).optional().describe('Запрошенная модель; по умолчанию из реестра по роли.'),
  continue_id: z.string().optional().describe('Номер предыдущего поручения.'),
  stage: z.string().optional().describe('Этап.'),
  owner: z.string().optional().describe('Метка сеанса владельца работы.'),
  work: z.string().optional().describe('Работа.'),
}, send);
register('deepseek_result', 'Результат DeepSeek', 'Получить состояние и ответ, при необходимости частями.', {
  id: z.string().describe('Номер поручения.'),
  wait_sec: z.number().int().min(0).max(40).default(0).describe('Ожидание в секундах.'),
  from_char: z.number().int().min(0).default(0).describe('Начальный символ.'),
}, async ({ id, wait_sec, from_char }) => {
  const end = Date.now() + wait_sec * 1000;
  let j = await normalized(id);
  while (j.status === 'running' && Date.now() < end) { await sleep(100); j = await normalized(id); }
  return view(j, from_char);
});
register('deepseek_cancel', 'Отменить DeepSeek', 'Остановить поручение.', { id: z.string().describe('Номер поручения.') }, async (a) => {
  const { id } = a;
  const j = await mutate(id, (c) => {
    if (require('../../common/job-cancel').cancelWaiting(c)) return;
    if (c.status === 'running') { c.status = 'cancelling'; c.cancellingAt ||= new Date().toISOString(); }
  });
  if (active.has(id)) await stop(id);
  return view(j);
});
register('deepseek_status', 'Состояние DeepSeek', 'Проверить версии и поручения.', {}, async () => {
  const rows = [];
  for (const j of list()) {
    try {
      const c = await normalized(j.id);
      if (['queued', 'running', 'needs_decision', 'cancelling', 'stop_unconfirmed', 'lost'].includes(c.status))
        rows.push(format('DeepSeek', c, c.error || '', 'Запросите результат.'));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return reply({ status: 'done' },
    'Версия процесса: ' + VERSION + '; на диске: ' + JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version +
    '\nDeepSeek: ' + (currentBinary() || 'не найден') + '\n' +
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
  restartServer = access.guest() ? null : restartHold.serverAsync(stateDir, 'deepseek');
  process.stdin.on('close', guarded(shutdown));
  const owner = await locks.startOwner({ version: VERSION, file: __filename });
  if (!owner.ok) throw Error('Не удалось открыть канал владельца.');
  process.stdin.on('end', guarded(shutdown));
  process.on('SIGINT', guarded(shutdown));
  process.on('SIGTERM', guarded(shutdown));
  server.server.onclose = guarded(shutdown);
  await server.connect(require('../../common/public-transport').publicTransport(new StdioServerTransport()));
  access.ready('deepseek');
  if (!access.guest() && process.env.MOST_PROBE_ONLY !== '1') {
    // Профили поручений создаются из реестра (временный DSH_HOME в тестах).
    if (!process.env.MOST_DSH_NO_PROFILES) profiles.generate(adapterParams(), undefined, bridgeParams());
    dshVersion();
    // Проба отказа записи после установки (ревью Codex f977c3d4, п.4): без неё голос DeepSeek не засчитывается.
    if (!process.env.MOST_DSH_NO_PROFILES) require('../../common/dsh-probe').ensure().catch(logFailure);
    await queue().catch(logFailure);
    setInterval(guarded(queue), Math.min(30000, Number(process.env.MOST_QUEUE_TICK_MS || 1000))).unref();
  }
})().catch((e) => { logFailure(e); process.exit(1); });
