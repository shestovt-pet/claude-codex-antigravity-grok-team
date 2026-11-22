'use strict';
const fs = require('fs'), path = require('path'), { randomUUID } = require('crypto');
const { spawn, execFile } = require('child_process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { stateDir } = require('../../common/paths'), locks = require('../../common/locks');
const { readCard, logFailure, guarded } = require('../../common/cards');
const { format } = require('../../common/format'), access = require('../../common/access');
const restartHold = require('../../common/restart-hold'), deadlines = require('../../common/chain-deadline');
const launch = require('../../common/kimi-launch'), material = require('../../common/kimi-material');
const VERSION = '0.1.0', dir = path.join(stateDir, 'kimi-jobs');
// team-v60: исчерпание подписочной квоты Kimi (5-часовое окно) — понятное сообщение владельцу вместо невнятного «код 1».
const QUOTA_MESSAGE = 'Лимит Kimi исчерпан (5-часовое окно подписки); сброс — когда окно закончится. Повторите позже или отдайте проверку другой семье.';
const active = new Map(), sleep = ms => new Promise(r => setTimeout(r, ms));
let restartServer, closing = false, scanning = false, options = {};
function admitExecution() { restartHold.assertAdmitted(stateDir, restartServer); }
function file(id) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw Error('Некорректный номер поручения.');
  const bundle = path.join(dir, id, 'card.json');
  return bundle;
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
function list() { return require('../../common/team-store').list('kimi', false).jobs; }
async function mutate(id, fn) {
  const l = await locks.waitLock('kimi_job', id, { jobId: id }, 8000);
  if (!l.ok) throw Error('Карточка занята.');
  try {
    const j = load(id);
    const before = { ...j };
    if ((await fn(j)) !== false) { save(j); require('../../common/notify').transition('Kimi', before, j); }
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
  return { content: [{ type: 'text', text: format('Kimi', j, body, next) }], ...(error ? { isError: true } : {}) };
}
function view(j, offset = 0) {
  let body = j.error || '';
  if (j.status === 'queued') body = access.queued;
  if (j.modelChoiceLine) body += '\n' + j.modelChoiceLine; // team-v59 ч4: строка выбора модели — в карточке и ответе
  // team-v60: исчерпание подписочной квоты видно одной строкой с временем (пока не было успешного поручения Kimi).
  if (j.retryKind === 'quota' && j.lastQuotaAt) body += '\nЛимит Kimi исчерпан с ' + new Date(j.lastQuotaAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + '; сброс — когда 5-часовое окно закончится.';
  body += '\nЗапрошено: ' + (j.requestedModel || j.model || launch.DEFAULT) + '; передано CLI: ' + (j.modelArgumentConfirmed ? j.launchModel : 'не подтверждено') + '; модель провайдером не подтверждена (requested_only).';
  body += '\n' + material.NOTE;
  // team-v56 А3: режим исходящих. none — делегаций нет (проверка/sends выключен); project — конфиг MCP в служебной папке.
  body += '\nИсходящие (MCP): ' + (j.mcpPolicy || 'none') + (j.mcpPolicy === 'project' ? '; получатели: ' + JSON.stringify(j.mcpServers || []) + '; делегаций: ' + (j.outgoingCount ?? 0) : '');
  if (j.write) {
    // team-v56 А1: писатель видит сверку записи — изменения, частичный итог, покрытие, ошибки; утверждения о неизменности копий нет.
    const w = j.writeCheck || {};
    body += '\nЗапись (профиль ' + (j.profileKind || '—') + '): статус ' + (w.status || 'pending') + '; изменено файлов: ' + (w.changed?.length ?? 0) +
      (w.errors?.length ? '; ошибки/неполнота: ' + w.errors.join('; ') : '') + '; покрытие: ' + JSON.stringify(w.coveredRoots || [w.targets].filter(Boolean)) +
      (w.changed?.length ? '\nИзменены: ' + JSON.stringify(w.changed.slice(0, 50)) : '');
  } else body += '\nИсключения: ' + JSON.stringify(j.readOnlyCheck?.excluded || { rules: material.RULES, paths: [] });
  if (j.status === 'done' && (!j.resultFile || !fs.existsSync(j.resultFile)))
    throw Error('Файл подтверждённого результата недоступен.');
  if (j.resultFile && fs.existsSync(j.resultFile)) {
    const s = fs.readFileSync(j.resultFile, 'utf8');
    body += '\n' + s.slice(offset, offset + 24000);
    if (offset + 24000 < s.length)
      return reply(j, body, 'Вызовите kimi_result: id ' + j.id + ', from_char ' + (offset + 24000) + '.');
  }
  return reply(j, body,
    j.status === 'needs_decision' ? 'Проверьте изменения и решите, продолжать ли.'
      : j.status === 'running' ? 'Запросите kimi_result с id ' + j.id + '.' : 'Проверьте результат.');
}
function currentBinary() { return options.command || launch.binary(); }
async function treeRows() {
  const rows = await (options.processTable ? options.processTable() : restartHold.processTableAsync());
  if (!Array.isArray(rows) || !rows.some(p => p.pid === process.pid)) throw Error('Неполный снимок процессов: нет самого сервера.');
  return rows;
}
function descendants(rows, pid, seen = new Set([pid])) {
  let changed; do { changed = false; for (const p of rows) if (seen.has(p.ppid) && !seen.has(p.pid)) { seen.add(p.pid); changed = true; } } while (changed);
  return seen;
}
// team-v56 Б0/А1: единая финализация адаптера Kimi — один путь для finish, отказа очереди (queue) и kimi_cancel.
// Терминальная без права продолжения карточка получает launch='forbidden' (повторный spawn запрещён). Фактический
// release опубликованного folderLock делает finish после подтверждения остановки (для running); у отменённого queued
// замка нет. needs_decision/stop_unconfirmed продолжение не запрещают — launch им не выставляется.
function finalizeCard(c) {
  if (!['done', 'failed', 'cancelled', 'needs_decision', 'stop_unconfirmed', 'lost'].includes(c.status)) return;
  if (!['needs_decision', 'stop_unconfirmed'].includes(c.status)) c.launch = 'forbidden';
  // team-v56 А2 (таблица Б0): session-reservation продолжения освобождается на терминале без удержаний — done/failed/
  // cancelled (в т.ч. отмена/отказ queued до запуска) и needs_decision со stopConfirmed. При неподтверждённом дереве
  // (stop_unconfirmed/treeWarning/stopUnconfirmed) reservation сохраняется: продолжение запрещено до подтверждения остановки.
  const freeSession = !c.stopUnconfirmed && !c.treeWarning && c.status !== 'stop_unconfirmed' &&
    (['done', 'failed', 'cancelled'].includes(c.status) || (c.status === 'needs_decision' && c.stopConfirmed));
  if (c.sessionKey && freeSession)
    try {
      const adm = require('../../common/job-admission'), r = adm.readSession(stateDir, c.sessionKey);
      // team-v56 И9 (ревью Codex 2): reservation в recovery_required (оборванная передача вершины продолжения) НЕ отпускаем
      // при переводе карточки в failed — иначе исчезал бы запрет повторного продолжения до восстановления.
      if (!r || r.jobId !== c.id || r.status !== 'recovery_required') adm.releaseSession(stateDir, c.sessionKey, c.id);
    } catch {}
  c.finalizedAt ||= new Date().toISOString();
}
// team-v56 А2: общий межпроцессный замок постановки Kimi — один 'kimi_queue/all' на state (не замок по j.id), чтобы два
// продолжения одной сессии сериализовались. waitLock для публикации/перед spawn, tryLock для фонового обхода очереди.
function queueLock(wait = true) { return wait ? locks.waitLock('kimi_queue', 'all', {}, 30000, stateDir) : locks.tryLock('kimi_queue', 'all', {}, stateDir); }
const liveCard = jid => { try { return ['queued', 'running', 'cancelling'].includes(load(jid).status); } catch { return false; } };
async function execute(job) {
  const execution = await locks.tryLock('kimi_execution', job.id, { jobId: job.id });
  if (!execution.ok) throw Error('Поручение уже выполняется.');
  const bundle = path.dirname(file(job.id)); let prepared, child, poll, watching, observed = new Set(), done = false, stderr = '';
  const parser = launch.parser();
  async function finish(code, signal, error) {
    if (done) return; done = true; clearInterval(poll);
    const parsed = parser.finish(code, stderr); let stopped = !child?.pid, stopError;
    try {
      if (watching) await watching;
      if (child?.pid) { const rows = await treeRows(); descendants(rows, child.pid, observed); stopped = !rows.some(p => observed.has(p.pid)); }
    } catch (e) { stopped = false; stopError = e.message; }
    let check;
    // team-v56 А1: finish выбирает verify (чтение/проверка) или writeCheck (писатель); разрешённые изменения писателя
    // не считаются провалом сверки копий.
    try { if (prepared && stopped) check = job.write ? material.writeCheck(prepared, bundle) : material.verify(prepared, bundle); }
    catch (e) { check = { status: 'unknown', errors: [e.message] }; }
    const late = c => c.status === 'cancelling' || c.stopReason || deadlines.parentTerminal(c) || deadlines.deadlinePassed(c);
    // Общие поля финала; при подтверждённой остановке здесь же фиксируется stopConfirmed, а статус остаётся НЕтерминальным.
    function common(c) {
      c.stopReason ||= active.get(job.id)?.stopReason;
      c.observedPids = [...observed].filter(Number.isInteger);
      c.exitCode = code; c.exitSignal = signal || null; c.finishedAt = new Date().toISOString(); c.kimiVersion = parsed.version;
      // team-v63 (п.6): объём ответа, секунды, накопленный выход сеанса.
      try { require('../../common/usage').finalize(c, { resultText: parsed.text == null ? undefined : parsed.text }); } catch {}
      if (Number.isFinite(c.chars_out)) c.sessionCharsOut = (c.sessionCharsOut || 0) + c.chars_out;
      c.errorKind = parsed.errorKind || (error ? 'unknown' : null); c.diagnostic = stderr.replace(/[A-Z]:\\[^\r\n]*/gi, '[локальный путь]').slice(-6000);
      if (parsed.session) c.sessionId = parsed.session;
      if (check) { if (c.write) c.writeCheck = { ...c.writeCheck, ...check }; else c.readOnlyCheck = { ...c.readOnlyCheck, ...check }; }
      c.voteEligible = false;
      // team-v56 А3: учёт исходящих. Делегации идут через существующий job-chain дочерними карточками с parentJob=этого
      // поручения (подпоручение голосом не считается). Считаем их здесь; у «проверки» их нет (mcpPolicy none → 0).
      // team-v56 А3 (ревью Kimi №4/Codex №6): ошибка обхода дочерних карточек НЕ равна «ноль исходящих». Успешный обход
      // ставит outgoingVerified=true; сбой — outgoingVerified=false, и тогда evidence() не засчитает голос (а не примет 0).
      try {
        const children = require('../../common/live-jobs').cards({ stateDir }).filter(x => x.j && x.j.parentJob === job.id).map(x => String(x.j.id));
        c.delegations = [...new Set(children)]; c.outgoingCount = c.delegations.length; c.outgoingVerified = true;
      } catch { c.outgoingVerified = false; c.outgoingCount ??= 0; }
      // team-v56 Л2 (ревью круг 5, М1): «получение результата потомка» из stream.ndjson родителя УБРАНО — оно засчитывало
      // любой ответ на *_result (в т.ч. «ещё работает»/ошибку). Теперь факт выдачи готового результата потомку→родителю
      // пишет сервер-получатель в карточку ПОТОМКА (common/result-receipt; см. kimi_result ниже и codex/deepseek_result).
      if (parsed.text !== null) {
        const output = path.join(bundle, job.id + (late(c) ? '.late.result.txt' : '.result.txt')); fs.writeFileSync(output, parsed.text);
        if (late(c)) c.lateResultFile = output;
        c.resultFile = output; c.resultSha256 = launch.sha(parsed.text);
      }
    }
    // team-v56 Б0/этап 2в: терминальный статус по таблице Б0 вычисляется ПОСЛЕ освобождения замка записи (см. ниже), чтобы
    // статус не стал виден терминальным раньше, чем замок снят (иначе гонка «карточка готова, замок ещё держится»).
    function terminal(c) {
      if (late(c)) { c.status = c.stopReason === 'cancel' ? 'cancelled' : 'failed'; c.error = 'Поручение остановлено; поздний ответ не голосует.'; }
      else if (!error && parsed.ok && check?.status === 'passed') {
        c.status = 'done'; delete c.error;
        // team-v56 А1/Б4: voteEligible — ТОЛЬКО успешная полная проверка нового evidence() над окончательной карточкой и
        // уже сохранёнными файлами/событиями; прежний шорткат role/parent/compatibility давал ложный голос. evidence не
        // читает voteEligible (нет рекурсии). Обычный текст/совет остаётся done, но с voteEligible=false и причиной.
        try { require('../../common/kimi-review').evidence({ ...c }); c.voteEligible = true; delete c.voteIneligibleReason; }
        catch (e) { c.voteEligible = false; c.voteIneligibleReason = e.message; }
      }
      // team-v60/61: исчерпание подписочной квоты Kimi (5-часовое окно) — ТОЛЬКО по диагностике провайдера (stderr/ошибка
      // запуска) завершившегося с ошибкой поручения; текст ответа (parsed.text) в распознавание не подставляется (п.1).
      // Статус и поля — через общий quota.retryPlan (как у Codex/Antigravity): чтение/проверка → waiting_quota
      // (доказанная недоступность по квоте для правил замены проверяющего), писатель → needs_decision с частичным итогом.
      // К исходному сообщению моста добавляем строку провайдера без ссылок и путей.
      else if ((error || !parsed.ok) && require('../../common/quota').quotaExhausted([stderr, error].filter(Boolean).join('\n'))) {
        const q = require('../../common/quota'), provider = q.providerLine(stderr || error);
        Object.assign(c, q.retryPlan(c, { kind: 'quota', message: provider, resetsAt: null }));
        c.error = QUOTA_MESSAGE + (provider ? ' (' + provider + ')' : ''); c.errorKind = 'quota';
      }
      // team-v56 А1 (таблица Б0): неуспех при подтверждённой остановке. УЖЕ ЗАПУЩЕННЫЙ писатель (есть childPid) →
      // needs_decision с частичным результатом/writeCheck и правом явного продолжения (А2); отказ ДО spawn (нет childPid)
      // остаётся failed. Чтение/проверка — failed. Квота/ошибка CLI писателя сюда и попадают (parsed.ok=false).
      else if (c.write && c.childPid) { c.status = 'needs_decision'; c.error = error || parsed.diagnostic || 'Писатель не завершил поручение (ошибка/квота); проверьте частичные изменения и решите, продолжать ли.'; c.errorKind ||= 'unknown'; }
      else { c.status = 'failed'; c.error = error || parsed.diagnostic || 'Сверка материала: ' + (check?.status || 'unknown'); c.errorKind ||= 'unknown'; }
      finalizeCard(c);
    }
    let released = false;
    try {
      await mutate(job.id, c => {
        common(c);
        if (!stopped) { c.status = 'stop_unconfirmed'; c.stopUnconfirmed = { pid: child?.pid }; c.error = 'Остановка дерева не подтверждена; замок сохранён. ' + (stopError || ''); finalizeCard(c); }
        else {
          // Подтверждённая остановка: фиксируем stopConfirmed и снимаем флаги неподтверждённого дерева, но статус пока
          // не делаем терминальным — чтобы замок записи успел освободиться до того, как потребитель увидит финал.
          c.stopConfirmed = { basis: 'процесс завершён; наблюдаемое дерево отсутствует', at: c.finishedAt };
          delete c.stopUnconfirmed; delete c.treeWarning;
          if (!['running', 'cancelling'].includes(c.status)) c.status = 'cancelling';
          c.holdsFolder = !!prepared?.held?.length;
        }
      });
      if (stopped) {
        // Освобождаем точные held-замки (карточка уже без stopUnconfirmed/treeWarning — защищённый release пройдёт), и
        // только затем публикуем терминальный статус. Так нет окна «статус терминален, замок ещё держится» (флак kimi-server).
        // До успешного release holdsFolder=true: ошибка release оставляет удержание явным (А5/продолжение блокируются).
        let allReleased = true;
        for (const l of prepared?.held?.slice().reverse() || []) { const r = l.release(); if (r && r.released === false) allReleased = false; }
        released = true;
        await mutate(job.id, c => { c.holdsFolder = !allReleased; terminal(c); });
      }
    } finally { active.delete(job.id); await execution.release(); if (stopped && !released) for (const l of prepared?.held?.slice().reverse() || []) l.release(); }
  }
  try {
    const refusal = launch.refusal(job); if (refusal) throw Error(refusal);
    if (require('../../common/members').recipientPaused('kimi', job.fallbackWord)) throw Error('Kimi на паузе.');
    const chain = require('../../common/job-chain').queuedRefusal(job, undefined, 'kimi'); if (chain) throw Error(chain);
    if (deadlines.parentTerminal(job) || deadlines.deadlinePassed(job)) throw Error('Родитель или срок не допускает запуск.');
    const review = require('../../common/kimi-review');
    // Допуск ИСПОЛНЕНИЯ (voter не требуется) — условие запуска ДО подготовки; отказ (напр. запись без роли писателя) не берёт
    // замок и не создаёт копий. Допуск ГОЛОСА считается отдельно, его отказ лишь снимает голос, но не запрещает исполнение.
    const exec = review.executionEligibility(job, 'kimi', { requireProbe: false });
    let vote = null, voteReason = null;
    try { vote = review.eligibility('kimi', { requireProbe: false }); } catch (e) { voteReason = e.message; }
    // team-v56 А1: писатель правит оригиналы (prepareWrite), проверка/чтение — копии (prepare). Профиль запуска
    // генерируется в служебной папке (до снимка executionBefore), его байты/SHA сохраняются в карточке.
    // team-v56 А2: продолжение (job.sessionId) НЕ генерирует и не передаёт профиль заново — CLI запрещает --agent-file с
    // --session, режим доступа не повышается; профиль/хеш берутся с прежней карточки, запуск идёт по --session.
    // team-v56 А3: проектный MCP создаётся в служебной executionFolder ТОЛЬКО для совет/текст при включённой у места
    // способности sends; для роли «проверка» и выключенного sends — policy none (нет конфига, нет доверия, нет MCP в
    // профиле). KIMI_CODE_TRUST_WORKSPACE добавляется в env CLI только для project (после сборки конфига), не здесь.
    const sendsOn = exec.launchExecutionEligibility?.roles?.sends === true;
    const loc = material.locations(job, material.roots(job));
    const mcp = require('../../common/kimi-mcp').build({ job, sends: sendsOn, newJobId: job.id,
      serversDir: options.serversDir || path.dirname(__dirname), node: process.execPath, servers: options.mcpServers,
      root: require('../../common/paths').repoRoot, state: stateDir, tempFolder: loc.tempFolder });
    const prof = job.sessionId ? null : launch.profile(job, mcp.tools);
    prepared = job.write ? material.prepareWrite(job, bundle, prof, mcp) : material.prepare(job, bundle, prof, mcp);
    const identity = launch.identity(currentBinary());
    const cli = options.command ? identity : exec.cli;
    const compatibility = launch.compatibility(cli.path);
    // Карточка могла получить отмену, пока готовилась копия: пишем только поля подготовки.
    job = await mutate(job.id, c => Object.assign(c, prepared.fields, { launchRegistryRev: exec.launchRegistryRev, launchExecutionEligibility: exec.launchExecutionEligibility,
      ...(vote ? { launchEligibility: vote.launchEligibility } : {}), ...(voteReason ? { voteIneligibleReason: voteReason } : {}),
      ...(prof ? { profileName: prof.name, profileKind: prof.kind, profileTools: prof.tools, profileSha256: prof.sha256 } : {}),
      mcpPolicy: mcp.policy, ...(mcp.policy === 'project' ? { mcpServers: mcp.servers } : {}), outgoingCount: 0,
      // team-v56 Л1 (ревью Kimi круг 4): хеш реализации исходящих Kimi в карточку при запуске — приёмка сверяет, что
      // родительское поручение Kimi выполнено ТЕКУЩЕЙ реализацией (cli.sha256 уже записан рядом). Так ссылки нельзя подставить
      // операциями, выполненными при другой привязке.
      implHash: launch.implementationHash(),
      cli, compatibility, requestedModel: job.model, launchModel: job.model, modelArgumentConfirmed: false, modelConfirmed: false, reportedModel: null, executionIsolation: 'none' }));
    admitExecution();
    if (require('../../common/members').recipientPaused('kimi', job.fallbackWord) || deadlines.parentTerminal(job) || deadlines.deadlinePassed(job)) throw Error('Допуск изменился перед запуском.');
    for (const l of prepared.held) if (require('../../common/paths').canon(l.owner.folder) !== l.owner.folder) throw Error('Материал сместился перед запуском.');
    // team-v56 А1: перед spawn отдельно пересчитать realpath исходного запрошенного пути и сохранённой folder; смещение
    // (подмена symlink/junction) — отказ без запуска, а не незаметный перенос полномочий. reconcile сверяет и instance замка.
    if (job.write) {
      const paths = require('../../common/paths');
      if (paths.canonMaybe(job.requestedFolder) !== paths.canon(job.folder)) throw Error('Целевая папка писателя сместилась между постановкой и запуском.');
      const want = paths.canon(job.folder), lock = prepared.held.find(l => l.owner.folder === want);
      if (!lock) throw Error('Замок целевой папки писателя не найден перед запуском.');
      require('../../common/write-lock').reconcile(lock, job.folder, { jobId: job.id, writer: true });
    }
    if (launch.sha(fs.readFileSync(job.inputFile)) !== job.inputSha256) throw Error('Файл поручения изменился перед запуском.');
    const launchPath = cli.path, current = review.executionEligibility(job, 'kimi', { requireProbe: false });
    if (current.launchRegistryRev !== job.launchRegistryRev || currentBinary() !== launchPath || launch.identity(launchPath).sha256 !== cli.sha256) throw Error('Допуск или бинарник CLI изменился перед запуском.');
    // team-v56 А2/Б0: перед spawn повторно взять job_start → kimi_queue/all → kimi_job, перечитать commit admission,
    // reservation и статус, проверить отмену/срок/папку; только затем spawn и регистрация PID/launch. Подготовка выполнена
    // ВНЕ этих коротких замков (не держим общий mutex на подготовке); CLI/ответов под замками не ждём.
    await restartHold.locked(stateDir, () => (async () => {
      const ql = await queueLock(true); if (!ql.ok) throw Error('Очередь Kimi занята перед запуском.');
      try {
        const adm = require('../../common/job-admission');
        if (job.admissionId) { const a = adm.read(stateDir, job.admissionId); if (!a || !a.committed || a.launch === 'forbidden') throw Error('Постановка не подтверждена admission перед запуском.'); }
        if (job.sessionKey) { const r = adm.readSession(stateDir, job.sessionKey); if (!r || r.jobId !== job.id || r.status === 'recovery_required') throw Error('Reservation сеанса отозвана или в восстановлении перед запуском.'); }
        // Последняя проверка, spawn и регистрация PID — под тем же kimi_job, что и отмена.
        await mutate(job.id, c => {
          if (c.status !== 'running' || c.stopReason || c.launch === 'forbidden') throw Error('Запуск отменён до создания процесса.');
          if (deadlines.parentTerminal(c) || deadlines.deadlinePassed(c)) throw Error('Родитель или срок не допускает запуск.');
          const extra = job.mcpPolicy === 'project' ? { [require('../../common/kimi-mcp').TRUST_VAR]: '1' } : {};
          if (job.effort !== undefined) extra.KIMI_MODEL_THINKING_EFFORT = job.effort;
          child = spawn(launchPath, [...(options.prefixArgs || []), ...launch.args({ model: job.model, jobId: job.id, inputFile: job.inputFile, profileFile: job.profileFile, sessionId: job.sessionId })], { cwd: job.executionFolder,
            env: launch.cliEnv({ tempFolder: job.tempFolder, extra }), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
          observed.add(child.pid); active.set(job.id, { child, job, observed });
          child.stdout.on('data', guarded(d => { fs.appendFileSync(path.join(bundle, 'stream.ndjson'), d); parser.push(d); }));
          child.stderr.on('data', guarded(d => { stderr = (stderr + d.toString('utf8')).slice(-12000); }));
          child.on('error', guarded(e => finish(null, null, e.message)));
          child.on('close', guarded((code, signal) => finish(code, signal)));
          // Опрос уже установлен, даже если последующая запись PID не удастся.
          poll = setInterval(guarded(async () => {
            const pendingStop = active.get(job.id)?.stopReason;
            if (pendingStop) return stop(job.id, pendingStop);
            const c = load(job.id);
            if (!watching) watching = treeRows().then(async rows => { const count = observed.size; descendants(rows, child.pid, observed); if (observed.size !== count) await mutate(job.id, c => { c.observedPids = [...observed].filter(Number.isInteger); }); }).catch(logFailure).finally(() => { watching = null; });
            if (c.status === 'cancelling' || c.stopReason) await stop(c.id, c.stopReason || 'cancel');
            else if (deadlines.parentTerminal(c)) await stop(c.id, 'parent');
            else if (deadlines.deadlinePassed(c)) await stop(c.id, 'timeout');
          }), 250);
          c.childPid = child.pid; c.childStartedAt = new Date().toISOString(); c.modelArgumentConfirmed = !!child.pid; c.observedPids = [...observed].filter(Number.isInteger);
        });
      } finally { await ql.release(); }
    })());
    if (done) return;
    const afterSpawn = load(job.id);
    if (afterSpawn.status === 'cancelling' || afterSpawn.stopReason) await stop(job.id, afterSpawn.stopReason || 'cancel');
  } catch (e) {
    if (child?.pid && !done) { logFailure(e); await stop(job.id, 'launch'); return; }
    await finish(null, null, e.message);
    // team-v56 И11 (ревью Gemini-Б): любой путь завершения ДО spawn проходит через finalizeCard (launch='forbidden',
    // finalizedAt, releaseSession) — даже если finish не довёл карточку до терминала; needs_decision/stop_unconfirmed не трогаем.
    try { await mutate(job.id, c => {
      if (c.finalizedAt || ['needs_decision', 'stop_unconfirmed'].includes(c.status)) return false;
      if (!['done', 'failed', 'cancelled', 'lost'].includes(c.status)) { c.status = 'failed'; c.error = c.error || e.message; }
      finalizeCard(c);
    }); } catch {}
  }
}
async function stop(id, reason = 'cancel') {
  const entry = active.get(id); if (!entry || entry.stopping) return;
  entry.stopping = true; entry.stopReason ||= reason;
  // Ошибка журнала не отменяет запрос остановки и не мешает завершить дерево.
  async function record(fn) {
    try { await mutate(id, c => {
      if (active.get(id) !== entry || !['running', 'cancelling', 'stop_unconfirmed'].includes(c.status)) return false;
      fn(c);
    }); } catch (e) { logFailure(e); }
  }
  try {
    await record(c => { c.status = 'cancelling'; c.stopReason ||= entry.stopReason; c.cancellingAt ||= new Date().toISOString(); });
    try { descendants(await treeRows(), entry.child.pid, entry.observed); } catch (e) { logFailure(e); }
    await record(c => { c.observedPids = [...entry.observed].filter(Number.isInteger); });
    try {
      if (process.platform === 'win32') await new Promise((resolve, reject) => execFile('taskkill.exe', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true, timeout: 30000 }, e => e ? reject(e) : resolve()));
      else process.kill(-entry.child.pid, 'SIGKILL');
    } catch (e) {
      // Даже отказ записи stop_unconfirmed не должен пропустить запасную остановку.
      try { entry.child.kill('SIGKILL'); } catch (killError) { logFailure(killError); }
      await record(c => { c.stopUnconfirmed = { pid: entry.child.pid }; c.treeWarning = e.message; c.status = 'stop_unconfirmed'; });
    }
  } finally { entry.stopping = false; }
}
// team-v56 А2: разрешение явного continue_id. Это номер СОБСТВЕННОЙ предыдущей карточки, не произвольный session_id.
// Все проверки без побочных эффектов: владелец/цепочка, терминальность и подтверждённая остановка, роль, write/full_access,
// realpath целевой папки, sessionCwd и CLI-хеш, сохранность session.resume_hint. Нет hint/истории — честный отказ.
// Продолжение не повышает права: write/full_access/роль обязаны совпасть с исходной карточкой. Возвращает тройку сеанса.
function resolveContinuation(a, { write, fullAccess, from, folder, parentJob, owner }) {
  const cid = a.continue_id;
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(cid || '')) throw Error('Некорректный номер продолжаемого поручения (continue_id).');
  let prior; try { prior = load(cid); } catch { throw Error('Продолжение недоступно: нет собственной карточки Kimi ' + cid + '.'); }
  if (prior.from !== from) throw Error('Продолжение доступно только автору исходного поручения Kimi.');
  // team-v56 И10 (ревью Codex 3): from — только семья (например claude). Тот же отправитель И тот же родитель/владелец:
  // дополнительно сверяем parentJob и метку owner исходной карточки (null===null при их отсутствии). Отказ до публикации.
  if ((prior.parentJob || null) !== (parentJob || null)) throw Error('Продолжение доступно только тому же родительскому поручению (parentJob).');
  if ((prior.ownerLabel || null) !== (owner || null)) throw Error('Продолжение доступно только тому же владельцу (owner).');
  if (!['done', 'needs_decision'].includes(prior.status) || !prior.stopConfirmed) throw Error('Продолжение недоступно: нужна завершённая карточка с подтверждённой остановкой.');
  if (prior.holdsFolder || prior.stopUnconfirmed || prior.treeWarning) throw Error('Продолжение недоступно: по исходному поручению есть удержания или неподтверждённая остановка.');
  if (prior.decision === 'continued' || prior.continuedBy) throw Error('Это поручение уже продолжено' + (prior.continuedBy ? ' (' + prior.continuedBy + ')' : '') + '.');
  if (!prior.sessionId) throw Error('Продолжение недоступно: у исходного поручения нет сохранённого session.resume_hint.');
  const paths = require('../../common/paths');
  if (paths.canon(prior.folder) !== paths.canon(folder)) throw Error('Сохраните исходную папку продолжаемого поручения Kimi.');
  if ((prior.write === true) !== write || (prior.fullAccess === true) !== fullAccess) throw Error('Продолжение не повышает права: сохраните write/full_access исходного поручения.');
  if ((prior.role || null) !== (a.role || null)) throw Error('Сохраните роль исходного продолжаемого поручения.');
  const bin = currentBinary(); if (!bin) throw Error('Исполнитель Kimi не найден для продолжения.');
  const cli = launch.identity(bin);
  if (!prior.cli || prior.cli.sha256 !== cli.sha256) throw Error('Сменился CLI: продолжение прежнего сеанса невозможно, начните новый сеанс.');
  const sessionCwd = prior.sessionCwd || prior.executionFolder;
  if (!sessionCwd || !fs.existsSync(sessionCwd)) throw Error('Служебная папка исходного сеанса утрачена; продолжение невозможно.');
  const sessionKey = require('../../common/job-admission').sessionKey(cli.sha256, prior.sessionId, sessionCwd);
  return { prior, sessionId: prior.sessionId, sessionCwd, continuationRoot: prior.continuationRoot || prior.id, cli, sessionKey,
    fields: { previous: prior.id, continuationRoot: prior.continuationRoot || prior.id, sessionId: prior.sessionId, sessionCwd, sessionKey, cliIdentity: { path: cli.path, sha256: cli.sha256 },
      profileName: prior.profileName, profileKind: prior.profileKind, profileTools: prior.profileTools, profileSha256: prior.profileSha256,
      profileHash: prior.profileSha256, permissionsHash: launch.sha(JSON.stringify([prior.role || null, write, fullAccess])) } };
}
async function send(a) {
  const refusal = launch.refusal(a); if (refusal) throw Error(refusal);
  // team-v63 (п.5): действующая отметка «лимит исчерпан» (меньше 10 минут, без позднего успеха) — не запускаем CLI; force — всегда.
  // team-v63 (п.19): продолжение (continue_id) при свежей отметке — тот же быстрый отказ (кроме force).
  if (a.force !== true && !access.guest()) {
    const qm = require('../../common/quota-mark').blocked(list());
    if (qm.blocked) return reply({ status: 'waiting_quota' }, require('../../common/quota-mark').refusalText('Kimi', qm.at), 'Дождитесь сброса или передайте force: true.');
  }
  // team-v63 (п.1/п.20): вложения мост читает сейчас (отказ на нечитаемом файле — до постановки). Текст вложений НЕ вклеивается
  // в a.task/job.task (как у codex/deepseek): он уходит в отдельный файл (.attach.txt) и подмешивается на этапе сборки input
  // (kimi-material.promptTail) — карточка и admission не раздуваются. Объём в знаках пишется в карточку.
  const _att = require('../../common/attachments');
  const attachData = _att.read(a.files, { authorize: _att.guestAuthorizer({ guest: access.guest() && !access.chatSession(), folder: a.folder, fullAccess: a.full_access === true || a.fullAccess === true }) }); // team-v63 (п.16)
  const mc = require('../../common/model-choice');
  const choice = mc.choose('kimi', { ...a, model: undefined, effort: undefined });
  const modelNamed = a.model !== undefined || a.effort !== undefined;
  const effort = a.effort ?? choice.effort;
  a.model = launch.model(a.model ?? choice.model); access.guard('kimi', 'kimi_send', a);
  const modelChoiceLine = mc.line('kimi', choice, modelNamed, a.model, effort);
  if (closing) throw Error('Сервер останавливается.');
  // team-v59 (часть 3 п.3в): роль «совет»/«текст» без записи и «проверка» text — папка необязательна (служебная пустая).
  require('../../common/scratch-folder').ensure(a);
  if (!path.isAbsolute(a.folder || '') || !fs.statSync(a.folder).isDirectory()) throw Error('Нужна абсолютная существующая папка.');
  material.roots({ folder: a.folder });
  if (!currentBinary() && !access.guest()) throw Error('Исполнитель Kimi не найден.');
  if (a.work && !a.stage && a.role !== 'совет') throw Error('Для работы укажите этап.'); // team-v59 ч3: совет — этап не обязателен (незарегистрированная работа примется ярлыком)
  if (require('../../common/members').recipientPaused('kimi', a.fallbackWord)) throw Error('Kimi на паузе.');
  const extra = require('../../common/brief-support').text(require('../../common/brief-support').support(a.folder, a.opora));
  if (extra) a.text = (a.text || '') + extra;
  await require('../../common/stage-gate').prepareJob(a, 'kimi');
  const chain = require('../../common/job-chain').fields(a), dl = deadlines.applyDeadline(chain, access.client(), 'kimi'); if (dl.error) throw Error(dl.error);
  const id = randomUUID();
  // team-v56 А1: write/full_access берутся из поручения (refusal уже отверг недопустимые сочетания). Сохраняем исходный
  // запрошенный путь (requestedFolder) для повторной сверки realpath перед запуском писателя.
  const write = a.write === true, fullAccess = a.full_access === true || a.fullAccess === true;
  const folder = fs.realpathSync(a.folder);
  const from = require('../../common/job-identity').memberId(access.client()) || access.client();
  // team-v56 А2 (ревью Codex №4): явное продолжение собственного сеанса (continue_id) разрешается ПОСЛЕ проверки request_id
  // (ниже), иначе идемпотентный повтор уже принятого продолжения из needs_decision упирался бы в «уже продолжено» вместо
  // возврата прежнего jobId. Поля продолжения дописываются в job после дедупа; reservation и передача вершины цепочки —
  // под общей короткой секцией. previous=null у нового сеанса.
  const job = { id, folder, requestedFolder: a.folder, task: a.task, model: a.model, effort, requestedModel: a.model, modelChoiceLine, write, fullAccess, previous: null,
    role: a.role, work: a.work, workLabel: a.workLabel, workUnbound: a.workUnbound, stage: a.stage, stageId: a.stageId, stageTitle: a.stageTitle, scopeTask: a.scopeTask, gateOrder: a.gateOrder, replaces: a.replaces, replacementEvidence: a.replacementEvidence,
    from, ...chain, ownerLabel: a.owner, owner: null,
    status: 'queued', startedAt: new Date().toISOString(), rev: require('../../common/members').rev(), ...(dl.deadline ? { deadline: dl.deadline } : {}) };
  if (a.work) {
    const w = JSON.parse(fs.readFileSync(path.join(require('../../common/paths').repoRoot, 'works', a.work + '.json'), 'utf8'));
    const stage = w.stages.find(s => s.id === a.stageId);
    if (stage?.material != null && !Array.isArray(stage.material)) throw Error('material этапа должен быть списком путей.');
    job.material = (stage?.material || []).map((entry, i) => {
      const p = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.path ?? entry.file : null;
      if (typeof p !== 'string' || !p.trim()) throw Error('material[' + i + ']: нужна непустая строка пути или объект с path/file.');
      return path.resolve(w.folder || require('../../common/paths').repoRoot, p);
    });
  }
  // team-v63 (п.1/п.6): объём входа в знаках (исходная задача + материал + вложения) и имена/хеш вложений.
  job.chars_in = require('../../common/usage').charsIn(a, attachData?.chars || 0);
  if (attachData) { job.attachmentsChars = attachData.chars; job.attachmentNames = attachData.names; job.attachmentsHash = attachData.hash; }
  material.locations(job, material.roots(job));
  // team-v56 Б0 (этап 2): устойчивая admission ВСЕГДА до создания каталога/входа/карточки. request_id необязателен — при
  // отсутствии сервер выдаёт новый и показывает его в ответе; повтор того же ID возвращает тот же jobId, иные параметры
  // того же ключа — REQUEST_ID_CONFLICT без каталога, входа и карточки на диске.
  let admId = null;
  {
    const adm = require('../../common/job-admission');
    const values = [['folder', require('../../common/scratch-folder').folderValue(a, job.folder)], ['task', a.task], ['text', a.text === undefined ? undefined : launch.sha(a.text)], ['files', attachData?.hash],
      ['role', a.role], ['write', write], ['full_access', fullAccess], ['model', a.model], ['work', a.work], ['stage', a.stage],
      ['stageId', a.stageId], ['stageTitle', a.stageTitle], ['gateOrder', a.gateOrder], ['scopeTask', a.scopeTask],
      ['replaces', a.replaces], ['replacementEvidence', a.replacementEvidence], ['owner', a.owner], ['level', a.level],
      ['continue_id', a.continue_id], ['parentJob', chain.parentJob], ['deadline', dl.deadline], ['opora', a.opora]];
    if (a.effort !== undefined) values.push(['effort', a.effort]);
    const r = await adm.begin({ adapter: 'kimi-cli', access, requestId: a.request_id, values, newJobId: id });
    job.requestId = r.requestId; job.admissionId = r.admissionId;
    if (r.duplicate) {
      require('../../common/scratch-folder').discard(a);
      try { return view(load(r.jobId)); }
      catch { return reply({ id: r.jobId, status: 'queued', requestId: r.requestId }, 'Повтор request_id ' + r.requestId + ': поручение ' + r.jobId + ' уже принято.'); }
    }
    admId = r.admissionId;
  }
  // team-v56 А2/Б0: публикация карточки, commit admission, session-reservation и передача вершины цепочки — одной короткой
  // транзакцией под job_start → kimi_queue/all (тот же общий порядок, что у claim/cancel/spawn). Так два продолжения одной
  // сессии сериализуются; второй получает SESSION_BUSY до публикации. Подготовка файлов CLI — вне этих замков.
  // Разрешение продолжения (resolveContinuation) — внутри try: его проверки без побочных эффектов, но при ошибке нужен
  // откат уже заведённой незакоммиченной admission. Изменяемые условия перечитываются заново под общим замком.
  let cont = null, reserved = false, published = false;
  try {
    cont = a.continue_id !== undefined && a.continue_id ? resolveContinuation(a, { write, fullAccess, from, folder, parentJob: chain.parentJob, owner: a.owner }) : null;
    if (cont) Object.assign(job, cont.fields);
    // team-v63 (п.2): продолжение — номер хода в сеансе и накопленные знаки входа/выхода.
    if (cont) { job.sessionTurn = (cont.prior.sessionTurn || 1) + 1; job.sessionCharsIn = (cont.prior.sessionCharsIn || cont.prior.chars_in || 0) + job.chars_in; job.sessionCharsOut = cont.prior.sessionCharsOut || cont.prior.chars_out || 0; }
    else { job.sessionTurn = 1; job.sessionCharsIn = job.chars_in; job.sessionCharsOut = 0; }
    await restartHold.locked(stateDir, () => (async () => {
      const ql = await queueLock(true); if (!ql.ok) throw Error('Очередь Kimi занята; повторите.');
      try {
        const adm = require('../../common/job-admission');
        if (cont) {
          // team-v56 А2 (ревью Codex №4): перечитать исходную карточку ПОД общим замком — между resolveContinuation и этой
          // секцией её могли продолжить другим запросом; повторно продолжать нельзя. Условия те же, что в resolveContinuation.
          let fresh; try { fresh = load(cont.prior.id); } catch { throw Error('Исходная карточка продолжения исчезла.'); }
          if (!['done', 'needs_decision'].includes(fresh.status) || !fresh.stopConfirmed || fresh.continuedBy || fresh.decision === 'continued' || fresh.holdsFolder || fresh.stopUnconfirmed || fresh.treeWarning)
            throw Error('Исходное поручение больше не допускает продолжение (перечитано под замком).');
          // team-v56 И9 (ревью Codex 2): жёсткий обрыв между commit и записью continuedBy мог оставить карточку-продолжение
          // без отметки continuedBy на исходной. Наличие любой карточки с previous=исходной — доказательство уже начатого
          // продолжения: повторно продолжить нельзя (защита от двойного продолжения после перезапуска).
          if (list().some(x => x.id !== id && x.previous === cont.prior.id))
            throw Error('Исходное поручение уже продолжено (есть карточка-продолжение); повторно продолжить нельзя.');
          adm.reserveSession(stateDir, cont.sessionKey, { jobId: id, previous: cont.prior.id }, liveCard); reserved = true;
        }
        fs.mkdirSync(path.dirname(file(id)), { recursive: true });
        // team-v63 (п.20): вложения — в отдельный файл рядом с карточкой; job.attachFile подхватит kimi-material на сборке input.
        if (attachData) require('../../common/attachments').attach(job, attachData, path.join(path.dirname(file(id)), id + '.attach.txt'));
        if (a.text !== undefined) { job.textFile = path.join(path.dirname(file(id)), 'input.txt'); fs.writeFileSync(job.textFile, a.text, 'utf8'); }
        job.provenance = require('../../common/provenance').forJob(job, 'kimi'); save(job); published = true;
        // team-v56 И7 (ревью Codex 5): постановка отозвана (release_orphan) под замком постановки → commit вернёт null;
        // карточку не запускаем (переводим в failed, чтобы очередь её не подхватила).
        if (admId && !adm.commit(stateDir, admId)) {
          await mutate(id, c => { c.status = 'failed'; c.error = 'Постановка Kimi отозвана (release_orphan) до запуска.'; finalizeCard(c); });
          throw Error('Постановка Kimi отозвана (release_orphan); запуск отменён.');
        }
        // team-v56 А2 (ревью Codex №4): атомарная передача вершины цепочки для ОБОИХ исходных статусов. done помечается
        // continuedBy (повторно продолжить нельзя); needs_decision дополнительно переходит в failed с decision=continued
        // и ссылкой на новую карточку, без потери частичного результата. Оборванный commit перехода — reservation
        // recovery_required (блокирует spawn до восстановления).
        if (cont) {
          try { await mutate(cont.prior.id, c => {
            if (c.continuedBy) return false;
            c.continuedBy = id;
            if (c.status === 'needs_decision') { c.status = 'failed'; c.decision = 'continued'; c.error = 'Продолжено поручением ' + id + '; частичный результат сохранён.'; finalizeCard(c); }
          }); }
          catch (e) { try { adm.markSessionRecovery(stateDir, cont.sessionKey, id); } catch {} throw e; }
        }
      } finally { await ql.release(); }
    })());
  } catch (e) {
    // До публикации карточки — узкий откат admission и session-reservation; после публикации удержания остаются явными.
    if (admId && !published) try { require('../../common/job-admission').releaseUnpublished(stateDir, admId); } catch {}
    if (reserved && !published) try { require('../../common/job-admission').releaseSession(stateDir, cont.sessionKey, id); } catch {}
    throw e;
  }
  if (!access.guest()) await queue();
  return view(load(id));
}
async function queue() {
  if (access.guest() || scanning || closing || !currentBinary()) return; scanning = true;
  try {
    for (const j of list()) {
      // team-v61 (п.3): Kimi НЕ возобновляет поручение автоматически (в отличие от очередей Codex/Antigravity — её execute
      // не рассчитан на повтор-резюме). Пока окно квоты не истекло (nextAttemptAt в будущем), waiting_quota служит честным
      // доказательством недоступности для замены проверяющего (team-seats.quotaConfirmed). После истечения окна карточка не
      // висит «ждущей автопродолжения» (ложное обещание) — становится failed с ясной просьбой повторить НОВЫМ поручением.
      if (j.status === 'waiting_quota' && Number.isFinite(Date.parse(j.nextAttemptAt)) && Date.parse(j.nextAttemptAt) <= Date.now()) {
        try { await mutate(j.id, c => { if (c.status !== 'waiting_quota' || !(Date.parse(c.nextAttemptAt) <= Date.now())) return false;
          c.status = 'failed'; c.error = QUOTA_MESSAGE + ' Окно закончилось — повторите поручение заново (новое kimi_send).'; finalizeCard(c); }); }
        catch (e) { logFailure(e); }
        continue;
      }
      if (j.status !== 'queued') continue;
      if (require('../../common/members').recipientPaused('kimi', j.fallbackWord)) continue;
      let claimed = false, c = null;
      // team-v56 А2/Б0: короткая критическая секция claim — job_start → kimi_queue/all (общий для state) → kimi_job.
      // execute() вынесен ИЗ неё (и из-под restartHold.locked): иначе подготовка/ожидание CLI держали бы общий mutex,
      // а повторное взятие kimi_queue/all перед spawn дало бы самоблокировку. Очередь занята — следующий тик.
      await restartHold.locked(stateDir, () => (async () => {
        const ql = await queueLock(false); if (!ql.ok) return;
        try {
          c = await mutate(j.id, cc => {
            if (cc.status !== 'queued') return false;
            const refusal = launch.refusal(cc) || require('../../common/job-chain').queuedRefusal(cc, undefined, 'kimi');
            if (refusal || deadlines.parentTerminal(cc) || deadlines.deadlinePassed(cc)) { cc.status = 'failed'; cc.error = refusal || 'Родитель/срок не допускает запуск.'; finalizeCard(cc); return; }
            if (require('../../common/members').recipientPaused('kimi', cc.fallbackWord)) return false;
            admitExecution(); cc.status = 'running'; cc.owner = locks.owner(); claimed = true;
          });
        } finally { await ql.release(); }
      })());
      if (claimed) await execute(c);
    }
  } finally { scanning = false; }
}
async function shutdown() {
  if (closing) return; closing = true; if (restartServer) restartServer.closed = true;
  await Promise.all([...active.keys()].map(id => stop(id, 'shutdown').catch(logFailure)));
  const end = Date.now() + 5000; while (active.size && Date.now() < end) await sleep(100); process.exit(0);
}
async function start(testOptions = {}) {
  options = testOptions; fs.mkdirSync(dir, { recursive: true });
  const server = new McpServer({ name: 'kimi', version: VERSION }, require('../../common/server-instructions').options('kimi'));
  function register(name, title, schema, fn) {
    if (!access.offered('kimi', name)) return;
    server.registerTool(name, { title, description: title, inputSchema: require('../../common/schema').compatible(schema) }, async a => {
      try {
        // team-v62 (взгляд участников): обработчику нужно перенесённое состояние — дождёмся конца первичной миграции (с
        // пределом). initialize/tools/list сюда не попадают. По превышении — понятный текст с предложением повторить.
        const hold = await require('../../common/state-migration').awaitPrimary();
        if (hold) throw Error(hold);
        if (name === 'kimi_send') { const r = launch.refusal(a); if (r) throw Error(r); launch.model(a.model); }
        access.guard('kimi', name, a);
        return name === 'kimi_send' ? await require('../../common/work-owner').withWork(a, () => fn(a)) : await fn(a);
      } catch (e) { return reply({ id: a.id, status: 'failed' }, 'Ошибка: ' + e.message, 'Исправьте причину.', true); }
    });
  }
  register('kimi_send', 'Поручить Kimi: чтение/проверка, запись write=true, программы full_access=true по профилю; продолжение своего сеанса continue_id; совет/текст может сам давать поручения Codex/DeepSeek и спрашивать дирижёра (MCP проекта), «проверка» — только чтение без делегирования', { folder: z.string().optional(), ...require('../../common/stage-schema').send, task: z.string().min(1), text: z.string().optional(),
    files: z.array(z.union([z.string(), z.object({ path: z.string(), lines: z.string().optional() })])).optional(), level: z.enum(['fast', 'normal', 'strong']).optional(), force: z.boolean().optional(),
    model: z.string().optional(), effort: z.enum(['low', 'high', 'max']).optional(), write: z.boolean().default(false), full_access: z.boolean().default(false), continue_id: z.string().optional(), owner: z.string().optional(), work: z.string().optional(), stage: z.string().optional(), request_id: z.string().optional() }, send);
  register('kimi_result', 'Результат Kimi', { id: z.string(), wait_sec: z.number().int().min(0).max(40).default(0), from_char: z.number().int().min(0).default(0) }, async a => {
    const end = Date.now() + a.wait_sec * 1000; let j = await normalized(a.id);
    while (['queued', 'running', 'cancelling'].includes(j.status) && Date.now() < end) { await sleep(100); j = await normalized(a.id); }
    // team-v56 Л2 (ревью круг 5, М1; круг 6): если готовый результат этого поручения-потомка выдаётся его родителю (parentJob ==
    // текущее поручение вызывающего), фиксируем в карточке потомка факт выдачи (кому/когда/sha). Отметку строим по тому же
    // снимку j и from_char, что уходят в view (иначе гонка снимок/карточка засчитала бы невыданный результат). Служебный
    // след; его ошибка не влияет на выдачу результата.
    await require('../../common/result-receipt').record({ mutate, id: a.id, snapshot: j, fromChar: a.from_char });
    return view(j, a.from_char);
  });
  register('kimi_cancel', 'Отменить Kimi', { id: z.string() }, async a => { await mutate(a.id, c => { if (require('../../common/job-cancel').cancelWaiting(c)) { finalizeCard(c); return; } if (c.status === 'running') { c.status = 'cancelling'; c.stopReason = 'cancel'; } }); await stop(a.id); return view(load(a.id)); });
  register('kimi_status', 'Состояние Kimi: CLI/версия/модель и все блокирующие состояния (needs_decision, удержания папки, неподтверждённая остановка, незавершённые admission/reservation, неизвестный статус)', {}, async () => {
    // team-v56 А2: показываем needs_decision и ВСЕ известные блокирующие состояния А5, а также любые карточки с
    // stopUnconfirmed/treeWarning/holdsFolder или незавершённой session-reservation — независимо от status. Неизвестный
    // status — с диагностикой и пометкой блокировки; перечень не ограничен прежними пятью значениями.
    const KNOWN = ['queued', 'running', 'cancelling', 'cancel_requested', 'cancelling', 'waiting_quota', 'applying', 'migration_conflict', 'delivery_unclear',
      'stop_unconfirmed', 'needs_decision', 'lost', 'done', 'failed', 'cancelled', 'applied', 'stop_confirmed'];
    const BLOCKING = ['queued', 'running', 'cancelling', 'cancel_requested', 'waiting_quota', 'applying', 'migration_conflict', 'delivery_unclear', 'stop_unconfirmed', 'needs_decision', 'lost'];
    const all = list(), adm = require('../../common/job-admission');
    const held = j => BLOCKING.includes(j.status) || j.stopUnconfirmed || j.treeWarning || j.holdsFolder ||
      (j.sessionKey && (() => { try { const r = adm.readSession(stateDir, j.sessionKey); return r && r.jobId === j.id && ['active', 'recovery_required'].includes(r.status); } catch { return false; } })());
    const note = j => (j.holdsFolder ? ' [держит папку]' : '') + (j.stopUnconfirmed ? ' [остановка не подтверждена]' : '') + (j.treeWarning ? ' [дерево не подтверждено]' : '') +
      (j.status === 'needs_decision' ? ' [нужно решение; продолжение по continue_id]' : '') + (KNOWN.includes(j.status) ? '' : ' [НЕИЗВЕСТНЫЙ статус — заблокировано]');
    const rows = all.filter(j => held(j) || !KNOWN.includes(j.status)).map(j => j.id + ': ' + j.status + note(j));
    return reply({ status: 'done' }, 'Сервер ' + VERSION + '; CLI: ' + (currentBinary() || 'не найден') + '; версия: ' + (launch.compatibility(currentBinary())?.version || 'не проверена') +
      '; модель по умолчанию: ' + launch.DEFAULT + '; квота неизвестна; совместимость: ' + (launch.compatibility(currentBinary()) ? 'проверена' : 'не проверена') + '\n' + rows.join('\n'));
  });
  restartServer = access.guest() ? null : restartHold.serverAsync(stateDir, 'kimi');
  const owner = await locks.startOwner({ version: VERSION, file: __filename }); if (!owner.ok) throw Error('Не удалось открыть канал владельца.');
  process.stdin.on('close', guarded(shutdown)); process.stdin.on('end', guarded(shutdown)); process.on('SIGINT', guarded(shutdown)); process.on('SIGTERM', guarded(shutdown)); server.server.onclose = guarded(shutdown);
  try { require('../../common/state-migration').arm(); } catch {} // team-v63 (п.18): взвести барьер миграции до connect
  await server.connect(require('../../common/public-transport').publicTransport(new StdioServerTransport())); access.ready('kimi');
  try { require('../../common/chat-origin').primeAsync(); } catch {} // team-v59 (task2): происхождение чата — в фоне после connect
  // team-v62 (task4): миграция и сверка очереди — в ФОНЕ после ответа на initialize/tools/list (общий замок миграции
  // больше не держит server.connect). Очередь стартует после миграции.
  (async () => {
    await require('../../common/state-migration').start(require('../../common/paths'));
    if (!access.guest() && process.env.MOST_PROBE_ONLY !== '1') setInterval(guarded(queue), 1000).unref();
  })().catch(logFailure);
  return server;
}
if (require.main === module) start().catch(e => { logFailure(e); process.exit(1); });
module.exports = { start };
