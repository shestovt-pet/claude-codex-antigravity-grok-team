'use strict';
// team-v63 (п.4): исполнитель сценариев — мост САМ ведёт многоходовый цикл. Чат (любой доказанный) один раз запускает
// сценарий (team_scenario action=start), дальше мост сам шлёт поручения, ждёт ответы и по ответу «крючка» (hook) решает,
// что слать дальше — без участия чата. Мост НЕ знает правил игры: их знает крючок (внешняя команда владельца). Здесь —
// движок (машина состояний, сеансы, обход участника по лимиту, параллельность, журнал шагов) и управление сценариями.
//
// Протокол крючка (stdin JSON → stdout JSON, одна команда на шаг):
//   мост → крючку: { event: 'start'|'results', scenario: {...}, state: <прошлое>, results: [ {key, member, status, text|resultFile, error, seconds, chars_in, chars_out} ] }
//   крючок → мосту: { state, send: [ {key, member|members, level, role, task, files, session, fresh, memory_file, timeout_sec} ], done: true|false, note }
// Все поручения из send уходят ПАРАЛЛЕЛЬНО (с учётом parallel); когда все завершились — следующий вызов крючка.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID, createHash } = require('crypto');
// cache-622 (М2): участники, у которых *_send принимает continue_id и продолжает сеанс (Claude-исполнитель — нет).
const CAN_CONTINUE = new Set(['codex', 'deepseek', 'kimi', 'antigravity']);

function nowIso() { return new Date().toISOString(); }
// team-v63 (п.13): id сценария — та же проверка, что в create (без разделителей пути и обхода `..\..`).
function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(id); }
function assertId(id) { if (!validId(id)) throw Error('Недопустимый id сценария: ' + id); return id; }

// ───────────────────────── Хранилище состояния ─────────────────────────
function scenariosDir(stateDir) { return path.join(stateDir, 'scenarios'); }
function dirOf(stateDir, id) { return path.join(scenariosDir(stateDir), id); }
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(obj, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // team-v63: на Windows rename над открытым файлом (другой процесс/чат читает state.json через status, антивирус сканирует)
  // даёт транзиентный EPERM/EACCES/EBUSY — короткий повтор с отступом; иначе ведущий цикл падал бы на безобидной гонке чтения.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, p); return; }
    catch (e) {
      if (i >= 12 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      const until = Date.now() + 8; while (Date.now() < until) { /* короткая пауза без await (writeJson синхронна) */ }
    }
  }
}
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function saveState(stateDir, S) { writeJson(path.join(dirOf(stateDir, S.id), 'state.json'), S); }
// team-v63 (п.6/Б1): запись состояния идущего сценария НЕ затирает внешнюю остановку. Перед каждой записью сверяемся с
// диском. Внешняя остановка (disk=`stopped`) ОКОНЧАТЕЛЬНА: её не перекрывает даже терминальный переход тика (done/failed) —
// иначе убитый по stop крючок писал бы `failed` поверх `stopped`. Прочая внешняя смена статуса блокирует лишь запись идущего
// снимка. Так `stop`, записавший `stopped`, остаётся stopped, что бы ни досчитал ведущий цикл.
function commit(stateDir, S) {
  let disk; try { disk = loadState(stateDir, S.id); } catch { disk = null; }
  if (disk && disk.status === 'stopped' && S.status !== 'stopped') return disk;
  if (S.status === 'running' && disk && disk.status !== 'running') return disk;
  saveState(stateDir, S);
  return S;
}
function loadState(stateDir, id) { return readJson(path.join(dirOf(stateDir, id), 'state.json')); }
function appendStep(stateDir, id, entry) {
  fs.appendFileSync(path.join(dirOf(stateDir, id), 'steps.jsonl'), JSON.stringify(entry) + '\n');
}
function listIds(stateDir) {
  try { return fs.readdirSync(scenariosDir(stateDir)).filter(n => fs.existsSync(path.join(scenariosDir(stateDir), n, 'state.json'))); }
  catch { return []; }
}

// ───────────────────────── Движок (машина состояний) ─────────────────────────
// Выбор участника: первый из списка без действующей отметки «лимит исчерпан» и не на паузе; если все заняты — первый из списка.
function pickMember(membersLeft, deps) {
  for (const m of membersLeft) if (!deps.runner.quotaBlocked(m) && !deps.runner.paused(m)) return m;
  return membersLeft[0];
}

// team-v63 (п.11): ключ для request_id должен быть ОДНОЗНАЧНЫМ. Простая очистка (нелатиница→`_`, обрезка до 40) давала
// одинаковый request_id разным ключам (кириллица → `____`) — и два поручения получали бы одну admission-карточку и чужой
// результат. Поэтому, когда очистка теряет информацию (изменила строку или строка длиннее 40), добавляем хвост-хеш исходного
// ключа. Для чистых коротких ASCII-ключей строка остаётся прежней (читаемый request_id в обычном случае).
function safeKey(s) {
  const raw = String(s);
  const san = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (san === raw && raw.length <= 40) return raw;
  return san.slice(0, 30) + '-' + createHash('sha256').update(raw).digest('hex').slice(0, 10);
}

async function dispatch(stateDir, S, key, deps) {
  const j = S.jobs[key], cmd = j.cmd;
  // team-v63 (п.9/Б6): подъём после перезапуска посреди шага. Если участник и request_id у поручения уже выбраны (оборвано
  // «на лету» в фазе `sending`/`running`), переотправляем ТОМУ ЖЕ участнику тем же request_id — повтор admission вернёт
  // прежнюю карточку: готово — возьмём результат; идёт и живо — дождёмся; осиротело (владелец мёртв) — poll вернёт провал и
  // шаг повторит ТОМУ ЖЕ участнику новой попыткой (pollRound). Нового request_id на подъёме НЕ выбираем, иначе возникло бы
  // второе поручение.
  const resuming = j.resume && j.member && j.requestId;
  const member = resuming ? j.member : pickMember(j.membersLeft, deps);
  j.member = member; j.resume = false;
  const sess = cmd.session ? S.sessions[cmd.session] : null;
  // Продолжение сеанса — только тем же участником, без fresh и без вынужденного рестарта (обход участника).
  // cache-622 (М2): продолжение умеют codex, deepseek, kimi и (с cache-622) antigravity — agy --conversation. У Claude-
  // исполнителя продолжения нет: ему сеанс начинается заново с memory_file, а не отказ «не поддерживает continue_id».
  const continueId = sess && sess.member === member && CAN_CONTINUE.has(member) && !cmd.fresh && !j.forcedFresh ? sess.jobId : null;
  const files = Array.isArray(cmd.files) ? [...cmd.files] : [];
  // Память сценария: когда сеанс начинается заново (нет continue_id), крючок может указать memory_file — вкладываем целиком.
  // Нет такого файла — пропускаем (эмулировать нечем): отсутствующая память не должна ронять всё поручение.
  if (!continueId && cmd.memory_file && fs.existsSync(cmd.memory_file)) files.push(cmd.memory_file);
  // team-v63 (А): request_id стабилен по (шаг, ключ, участник, попытка) — при подъёме после перезапуска переотправка тем же
  // ключом возвращает уже существующую карточку (повтор admission), а не выполняет поручение заново.
  const requestId = resuming ? j.requestId
    : 'sc-' + safeKey(S.id) + '-s' + S.step + '-' + safeKey(key) + '-' + member + '-a' + (j.attempts || 0);
  j.requestId = requestId;
  // team-v63 (Б6): НАМЕРЕНИЕ на диск ДО отправки. Участник, request_id и попытка зафиксированы; статус «отправляется».
  // Падение между этой записью и ответом *_send не теряет выбор: подъём увидит `sending` и переотправит тем же request_id
  // тому же участнику (repend обрабатывает `sending` как `running`), а не выберет другого участника с другим id.
  j.status = 'sending'; j.jobId = null; j.startedAt = deps.now();
  { const after = commit(stateDir, S); if (after.status !== 'running') return; } // уже остановлено на диске — не шлём
  // team-v63 (Б1): раннер проверяет остановку ПОСЛЕ всех await (включая clientFor), непосредственно перед client.callTool,
  // и при остановке вызов НЕ делается (отправка после stop не происходит). Проверка — token.stop (этот процесс) или диск.
  const notStopped = () => {
    if (deps.stopped && deps.stopped()) return false;
    try { const d = loadState(stateDir, S.id); if (d && d.status !== 'running') return false; } catch {}
    return true;
  };
  const r = await deps.runner.start({ scenarioId: S.id, key, member, role: cmd.role, level: cmd.level, task: cmd.task,
    files: files.length ? files : undefined, continueId, timeout_sec: cmd.timeout_sec, requestId, resuming, notStopped,
    // quota-622: после resume сценария, вставшего «нет денег», — одна попытка в обход отметки (слово пользователя).
    ...(j.forceOnce ? { force: true } : {}) });
  j.forceOnce = false;
  // Остановка перехватила отправку до вызова — поручение осталось `sending`, подъём переотправит его тем же request_id.
  if (r && r.stopped) return;
  j.jobId = r.jobId; j.status = 'running';
}

async function pollRound(S, deps) {
  for (const key of Object.keys(S.jobs)) {
    const j = S.jobs[key];
    if (j.status !== 'running') continue;
    let p; try { p = await deps.runner.poll(j.jobId, j.member); } catch (e) { p = { terminal: true, status: 'failed', error: e.message }; }
    if (!p || !p.terminal) continue;
    const usage = { seconds: p.seconds, chars_in: p.chars_in, chars_out: p.chars_out, tokens: p.tokens };
    if (p.status === 'done') {
      j.status = 'collected'; j.resuming = false;
      j.memberJobId = p.memberJobId || j.jobId;
      j.result = { key, member: j.member, status: 'done', text: p.text, resultFile: p.resultFile, memberJobId: j.memberJobId, ...clean(usage) };
      // Сеанс хранит НАСТОЯЩИЙ номер поручения участника (continue_id следующего хода), а не внутренний handle.
      if (j.cmd.session) S.sessions[j.cmd.session] = { jobId: j.memberJobId, member: j.member };
    } else {
      // team-v63 (п.24): неудачная попытка (квота/отказ/сбой) потратила секунды/знаки/токены — учитываем их в итоге отдельно
      // от принятого ответа, чтобы объём сценария был честным.
      addFailedUsage(S, j.member, p);
      // team-v63 (п.10/п.5): карточка упавшей попытки (особенно waiting_quota) может позже исполниться сама — отменяем её при
      // передаче другому участнику. Отмена ПОДТВЕРЖДАЕТСЯ (раннер опрашивает карточку); не подтверждена за срок — продолжаем,
      // но пишем предупреждение о возможном двойном расходе (п.5).
      if (j.jobId) { let c; try { c = await deps.runner.cancel(j.jobId, j.member); } catch {} if (c && c.confirmed === false) addStopWarning(S, c.id || j.jobId, j.member); }
      // team-v63 (п.4/п.7): если это был подъём прерванного хода и прежняя карточка вернулась КОНЕЧНОЙ (отменена при stop или
      // осиротела — lost/needs_decision), повторяем ТОМУ ЖЕ участнику НОВОЙ попыткой (новый request_id), не обходя его —
      // пока он доступен. Недоступен (лимит/пауза) — обход по правилам ниже.
      if (j.resuming) {
        j.resuming = false;
        if (!deps.runner.quotaBlocked(j.member) && !deps.runner.paused(j.member)) {
          j.membersLeft = [j.member, ...j.membersLeft.filter(m => m !== j.member)];
          j.status = 'pending'; j.forcedFresh = true; j.jobId = null; j.attempts = (j.attempts || 0) + 1; continue;
        }
      }
      // Отказ/квота/сбой: пробуем следующего участника тем же ключом (сеанс заново с memory_file, если задан).
      j.membersLeft = j.membersLeft.filter(m => m !== j.member);
      // quota-622 (слово пользователя 23.11.2026): «на счёте нет денег» — недоступность участника, а не провал игрока. Есть
      // запасной участник — переходим к нему (ниже). Нет — сценарий встаёт на паузу с причиной; шаг остаётся ждущим тому же
      // участнику (тот же сеанс, новая попытка) и продолжается через resume, крючок «провала» не получает.
      if (p.status === 'balance' && !j.membersLeft.length) {
        j.membersLeft = [j.member]; j.status = 'pending'; j.jobId = null; j.attempts = (j.attempts || 0) + 1; j.balancePaused = true;
        S.status = 'paused'; S.pauseReason = 'нет денег на счёте ' + memberTitle(j.member) + ' (шаг ' + S.step + ', ключ ' + key + '); пополните счёт и продолжите resume';
        continue;
      }
      if (j.membersLeft.length) { j.status = 'pending'; j.forcedFresh = true; j.jobId = null; j.attempts = (j.attempts || 0) + 1; }
      else { j.status = 'collected'; j.result = { key, member: j.member, status: p.status, error: p.error, ...clean(usage) }; }
    }
  }
}
function memberTitle(m) { return { deepseek: 'DeepSeek', codex: 'Codex', kimi: 'Kimi', antigravity: 'Antigravity', claude: 'Claude' }[m] || m; }
function clean(o) { const r = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) r[k] = v; return r; }
// team-v63 (п.24): копим объём неудачных попыток отдельной строкой итога (secondsFailed/charsInFailed/charsOutFailed/attempts).
function addFailedUsage(S, member, p) {
  const f = S.totals.failed || (S.totals.failed = { seconds: 0, chars_in: 0, chars_out: 0, attempts: 0 });
  f.seconds += p.seconds || 0; f.chars_in += p.chars_in || 0; f.chars_out += p.chars_out || 0; f.attempts += 1;
}
// team-v63 (п.5): отмена поручения не подтвердилась за срок — продолжаем, но предупреждаем о возможном двойном расходе.
// Предупреждение видно в statusLine (а значит в team_scenario status/list) и держится до конца сценария.
function addStopWarning(S, id, member) {
  const msg = 'поручение ' + id + ' участника ' + member + ' не подтвердило остановку — возможен двойной расход';
  S.warnings = S.warnings || [];
  if (!S.warnings.includes(msg)) S.warnings.push(msg);
}

// Один шаг работы движка: вызов крючка (если ждём) ИЛИ разводка/опрос поручений. Возвращает состояние.
async function tick(stateDir, id, deps) {
  let S = loadState(stateDir, id);
  if (S.status !== 'running') return S;
  if (S.phase === 'await_hook') {
    const event = S.step === 0 ? 'start' : 'results';
    let resp;
    // team-v63 (Б1): убитый по stop крючок (killTree) выбрасывает — пишем результат через commit, а не прямым saveState,
    // чтобы `stopped` на диске НЕ превратился в `failed`. То же для прочих ранних выходов фазы крючка.
    try { resp = await deps.invokeHook(S, { event, scenario: S.scenario, state: S.hookState ?? null, results: S.lastResults || [] }); }
    catch (e) { S.status = 'failed'; S.error = 'крючок: ' + e.message; return commit(stateDir, S); }
    if (!resp || typeof resp !== 'object') { S.status = 'failed'; S.error = 'крючок вернул не объект'; return commit(stateDir, S); }
    if (resp.state !== undefined) S.hookState = resp.state;
    if (resp.note !== undefined) S.note = String(resp.note);
    S.step += 1;
    if (resp.done) { S.status = 'done'; S.finishedAt = deps.nowIso(); return commit(stateDir, S); }
    S.jobs = {};
    for (const cmd of Array.isArray(resp.send) ? resp.send : []) {
      if (!cmd || !cmd.key || !cmd.task) { S.status = 'failed'; S.error = 'крючок: у send нужен key и task'; return commit(stateDir, S); }
      // team-v63 (п.11): ключи send в одном шаге должны быть уникальны — иначе одно поручение затёрло бы другое в S.jobs.
      if (Object.prototype.hasOwnProperty.call(S.jobs, cmd.key)) { S.status = 'failed'; S.error = 'крючок: повторный ключ send «' + cmd.key + '» в одном шаге'; return commit(stateDir, S); }
      const members = Array.isArray(cmd.members) && cmd.members.length ? cmd.members : [cmd.member].filter(Boolean);
      if (!members.length) { S.status = 'failed'; S.error = 'крючок: у send нужен member или members'; return commit(stateDir, S); }
      S.jobs[cmd.key] = { cmd, membersLeft: [...members], member: null, jobId: null, status: 'pending' };
    }
    S.lastResults = [];
    S.phase = Object.keys(S.jobs).length ? 'running_jobs' : 'await_hook';
    { const after = commit(stateDir, S); if (after.status !== 'running') return after; }
    if (S.phase === 'await_hook') return S; // пустой шаг — следующий тик снова спросит крючок
  }
  if (S.phase === 'running_jobs') {
    let running = Object.values(S.jobs).filter(j => j.status === 'running').length;
    for (const key of Object.keys(S.jobs)) {
      const j = S.jobs[key];
      if (j.status !== 'pending') continue;
      if (S.parallel && running >= S.parallel) break;
      // team-v63 (п.6): перед КАЖДОЙ отправкой перечитываем остановку — после stop новых поручений не шлём.
      { let disk; try { disk = loadState(stateDir, id); } catch { disk = null; } if (disk && disk.status !== 'running') return disk; }
      await dispatch(stateDir, S, key, deps); running++;
      { const after = commit(stateDir, S); if (after.status !== 'running') return after; }
    }
    await pollRound(S, deps);
    { const after = commit(stateDir, S); if (after.status !== 'running') return after; }
    const vals = Object.values(S.jobs);
    if (vals.length && vals.every(j => j.status === 'collected')) {
      S.lastResults = vals.map(j => j.result);
      for (const r of S.lastResults) { S.totals.seconds += r.seconds || 0; S.totals.chars_in += r.chars_in || 0; S.totals.chars_out += r.chars_out || 0; }
      S.totals.steps += 1;
      appendStep(stateDir, id, { at: deps.nowIso(), step: S.step, note: S.note || null,
        results: S.lastResults.map(r => ({ key: r.key, member: r.member, status: r.status, seconds: r.seconds, chars_in: r.chars_in, chars_out: r.chars_out, tokens: r.tokens, memberJobId: r.memberJobId, error: r.error })) });
      S.jobs = {};
      S.phase = 'await_hook';
      { const after = commit(stateDir, S); if (after.status !== 'running') return after; }
    }
  }
  return S;
}

// Прогон до покоя: тикаем, пока есть что делать (или до остановки). tickMs — пауза между опросами идущих поручений.
async function drive(stateDir, id, deps) {
  const tickMs = deps.tickMs ?? 200, maxIdle = deps.maxTicks ?? Infinity;
  for (let n = 0; n < maxIdle; n++) {
    const S = await tick(stateDir, id, deps);
    if (S.status !== 'running') return S;
    // Если есть идущие поручения — короткая пауза перед следующим опросом.
    const hasRunning = Object.values(S.jobs || {}).some(j => j.status === 'running');
    if (hasRunning) await deps.sleep(tickMs);
  }
  return loadState(stateDir, id);
}

// ───────────────────────── Производственный крючок (spawn) ─────────────────────────
// team-v63 (п.6): снятие ДЕРЕВА процессов крючка (на Windows child.kill() не убивает потомков — крючок мог запустить свои).
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) { try { child && child.kill(); } catch {} return; }
  if (process.platform === 'win32') {
    try { require('child_process').execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); return; } catch {}
  }
  try { child.kill(); } catch {}
}
function spawnHook(S, payload, { timeoutMs = 300000, onChild } = {}) {
  return new Promise((resolve, reject) => {
    const h = S.hook; // { interp, script }
    const child = spawn(h.interp, [h.script], { cwd: S.folder, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (onChild) try { onChild(child); } catch {}
    let out = '', err = '', done = false;
    // Завершение — снимаем ДЕРЕВО процессов крючка (и по таймауту, и при stop через onChild-abort, и штатно).
    const finish = (e, r) => { if (done) return; done = true; clearTimeout(t); killTree(child); e ? reject(e) : resolve(r); };
    const t = setTimeout(() => finish(Error('крючок не ответил за ' + Math.round(timeoutMs / 1000) + ' с')), timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => (out += d)); child.stderr.on('data', d => (err = (err + d).slice(-4000)));
    child.stdin.on('error', () => {});
    child.on('error', e => finish(e));
    child.on('close', () => { try { finish(null, JSON.parse(out.trim())); } catch (e) { finish(Error('крючок вернул не-JSON: ' + (err || e.message))); } });
    child.stdin.end(JSON.stringify(payload));
  });
}

// ───────────────────────── Управление сценариями ─────────────────────────
// Создать сценарий: читает JSON-файл, определяет крючок (из JSON или аргументов), заводит состояние на диске.
function create(stateDir, { scenarioFile, hook, parallel, by }) {
  if (!scenarioFile || !path.isAbsolute(scenarioFile) || !fs.existsSync(scenarioFile)) throw Error('Нужен абсолютный путь существующего файла сценария.');
  const scenario = readJson(scenarioFile);
  const folder = path.dirname(scenarioFile);
  const h = hook || scenario.hook; // { interp, script } — полные пути интерпретатора и скрипта
  if (!h || !h.interp || !h.script) throw Error('Сценарий без крючка: нужен hook { interp, script } (в файле сценария или в start).');
  if (!path.isAbsolute(h.interp) || !path.isAbsolute(h.script)) throw Error('Крючок: interp и script — абсолютные пути.');
  if (!fs.existsSync(h.script)) throw Error('Крючок: скрипт не найден: ' + h.script);
  // team-v63 (п.14): parallel из файла сценария проходит мимо схемы инструмента — проверяем сами: целое ≥ 1 или не задано.
  const par = parallel ?? scenario.parallel;
  if (par !== undefined && par !== null && (!Number.isInteger(par) || par < 1)) throw Error('parallel должно быть целым ≥ 1 (дано: ' + par + ').');
  const id = (scenario.id && /^[A-Za-z0-9_-]{1,60}$/.test(scenario.id) ? scenario.id : 'sc-' + randomUUID().slice(0, 8));
  // team-v63 (п.12): повторный start с существующим id не затирает идущий сценарий — отказ с понятным текстом (нужен новый id
  // или сначала остановить/дождаться прежнего). Завершённый/остановленный с тем же id можно перезапустить (resume), но не start.
  try {
    const prev = loadState(stateDir, id);
    if (prev && prev.status !== 'done') throw Error('Сценарий ' + id + ' уже существует (статус ' + prev.status + '); задайте другой id или остановите/дождитесь прежнего (resume для продолжения).');
  } catch (e) { if (/уже существует/.test(e.message)) throw e; }
  const S = {
    id, status: 'running', phase: 'await_hook', step: 0, by: by || null,
    scenarioFile, folder, scenario, hook: { interp: h.interp, script: h.script },
    parallel: Number.isFinite(par) ? par : null,
    hookState: scenario.state ?? null, note: null,
    jobs: {}, sessions: {}, lastResults: [],
    totals: { seconds: 0, chars_in: 0, chars_out: 0, steps: 0, failed: { seconds: 0, chars_in: 0, chars_out: 0, attempts: 0 } },
    createdAt: nowIso(),
  };
  writeJson(path.join(dirOf(stateDir, id), 'scenario.json'), { id, scenarioFile, hook: S.hook, parallel: S.parallel, scenario });
  saveState(stateDir, S);
  return S;
}

function riskLine(S) { return 'мост будет запускать команду «' + S.hook.interp + ' ' + S.hook.script + '» (cwd ' + S.folder + ') на каждом шаге сценария.'; }

function statusLine(S) {
  const t = S.totals || {};
  const jobLine = Object.entries(S.jobs || {}).filter(([, j]) => j.status === 'running').map(([k, j]) => k + '→' + j.member).join(', ');
  const f = t.failed || {};
  const failedLine = f.attempts ? ' · неудачных попыток ' + f.attempts + ' (вход ' + (f.chars_in || 0) + ' / выход ' + (f.chars_out || 0) + ' знаков, время ' + Math.round(f.seconds || 0) + ' с)' : '';
  return 'Сценарий ' + S.id + ': ' + S.status + '; шаг ' + S.step + (S.phase === 'await_hook' ? ' (ждёт крючок)' : jobLine ? ' (идут: ' + jobLine + ')' : '') +
    '; поручений ' + t.steps + ', объём вход ' + (t.chars_in || 0) + ' / выход ' + (t.chars_out || 0) + ' знаков, время ' + Math.round(t.seconds || 0) + ' с' +
    failedLine + (S.status === 'paused' && S.pauseReason ? ' · ПАУЗА: ' + S.pauseReason : '') + (S.note ? ' · ' + S.note : '') + ((S.warnings && S.warnings.length) ? ' · ⚠ ' + S.warnings.join('; ') : '') + (S.error ? ' · ОШИБКА: ' + S.error : '');
}

// Число идущих сценариев — для краткой team_status (без тяжёлых чтений: только status.json каждого).
function runningCount(stateDir) {
  let n = 0;
  for (const id of listIds(stateDir)) { try { if (loadState(stateDir, id).status === 'running') n++; } catch {} }
  return n;
}
// quota-622: сценарии на паузе (например, «нет денег на счёте DeepSeek») — для краткой сводки.
function pausedList(stateDir) {
  const out = [];
  for (const id of listIds(stateDir)) { try { const S = loadState(stateDir, id); if (S.status === 'paused') out.push(id + (S.pauseReason ? ' (' + S.pauseReason + ')' : '')); } catch {} }
  return out;
}

module.exports = {
  scenariosDir, dirOf, saveState, commit, loadState, appendStep, listIds,
  tick, drive, dispatch, pollRound, pickMember, safeKey, validId, assertId,
  spawnHook, killTree, create, riskLine, statusLine, runningCount, pausedList, nowIso, CAN_CONTINUE,
};
