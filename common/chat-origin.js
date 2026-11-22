'use strict';
// team-v58-any-chat, часть Г (замысел §1): права чата выдаются ТОЛЬКО по доказанному происхождению сервера моста от
// приложения-клиента зарегистрированного участника. MOST_JOB_ID и имя клиента задаются окружением процесса и
// доказательством не служат — сервер (его запускает клиент как дочерний процесс) один раз при запуске строит цепочку
// своих предков (PID и точное время создания каждого) и выдаёт права чата, только если выполнено всё сразу (четыре
// условия раздела 1). При каждом действии, доступном только чату, запомненные предки дёшево перепроверяются «живы с теми
// же временами» и заново сверяются с записями серверов моста и исполнителей. Невыполнение любого условия (в том числе
// нечитаемая, пустая, оборванная или неоднозначная таблица процессов) — прав чата нет, причина понятным русским текстом.
//
// Подстановка в тестах — только через внутренние зависимости (setTest/withOrigin), недоступные боевому процессу из
// окружения. Для дочерних тестовых серверов, которые тестовый прогон запускает из клона (а не из приложения-клиента),
// действует переменная MOST_TEST_CHAT_ORIGIN, но ТОЛЬКО когда выпуск запущен не из установленного E:\most\live
// (см. honoursEnv): боевой сервер из live её игнорирует всегда.
const fallback = () => require('./fallback');
const paths = () => require('./paths');

// Пять зарегистрированных клиентов связки и как их приложение опознаётся среди предков. Сервер моста — это node,
// запускающий servers\<n>\index.js; его родитель — приложение-клиента (Codex/Antigravity/DeepSeek пишут command=node в
// настройках, Claude Desktop и Kimi — тоже запускают node напрямую), поэтому опознаём именно процесс-предок. Где клиент
// работает через общий интерпретатор (node.exe/python.exe), имя процесса ненадёжно — проверяем и командную строку.
// Путь сверяется по каталогу установки без привязки к номеру версии: regex не содержит версии, поэтому автообновление
// клиента ложного отказа не даёт.
const RECOGNIZERS = [
  { id: 'claude', name: /^claude/i, cmd: /[\\/]claude[\\/]|anthropicclaude|claude_desktop/i },
  { id: 'codex', name: /^(codex|chatgpt)/i, cmd: /[\\/](codex|chatgpt)[\\/]|codex-cli/i },
  { id: 'antigravity', name: /^(antigravity|language_server)/i, cmd: /[\\/](antigravity)[\\/]|language_server/i },
  { id: 'deepseek', name: /^(deepseek|dsh)/i, cmd: /deepseek[._-]?harness|[\\/]dsh[\\/]/i },
  { id: 'kimi', name: /^kimi/i, cmd: /[\\/]kimi[\\/]|kimi\.exe/i },
];
function recognisedClient(p) {
  const name = String(p.name || ''), cmd = String(p.commandLine || '');
  for (const r of RECOGNIZERS) if (r.name.test(name) || (cmd && r.cmd.test(cmd))) return r.id;
  return null;
}

// team-v58 (дирижёр п.5): предок считается сервером моста и по командной строке — node …\servers\<имя>\index.js, — даже если
// записи готовности о нём ещё/уже нет (гонка на старте, затёртая запись). Серверы моста — team и серверы участников связки.
const BRIDGE_SERVER_CMD = /[\\/]servers[\\/](team|claude|codex|antigravity|deepseek|kimi|grok)[\\/]index\.js/i;
function looksLikeBridgeServer(p) { return BRIDGE_SERVER_CMD.test(String(p.commandLine || '')); }

// Запуск сервера из установленного выпуска E:\most\live\<коммит>: переменная-подмена происхождения не действует.
function fromInstalledLive(release = require('path').resolve(__dirname, '..')) {
  return /[\\/]live[\\/][a-f0-9]{40}([\\/]|$)/i.test(release);
}
// Каталог выпуска и каталог состояния — как их видит процесс (та же логика, что в common/paths.js, но читаем окружение здесь,
// чтобы honoursEnv проверялся на текущем значении переменных).
function repoRootDir() { const p = require('path'); return p.resolve(process.env.MOST_REPO_ROOT || p.join(__dirname, '..')); }
function stateDirPath() { const p = require('path'); return p.resolve(process.env.MOST_STATE_DIR || p.join(repoRootDir(), 'state')); }
// Путь — внутри временной папки прогона. Наборы изолируют состояние в нескольких местах: под …\tests\.tmp-…, под системным
// TEMP (os.tmpdir, в прогоне он подменён на tests\.tmp-windows-…) и под MOST_TEST_OUTSIDE (пишущие наборы кладут его в
// системный TEMP\most-tests-outside; antigravity — состояние туда же). MOST_TEST_OUTSIDE ставит только тестовый раннер; в бою
// его нет, поэтому проверка безопасна.
function underTestTmp(p) {
  const pathmod = require('path'), r = pathmod.resolve(String(p || ''));
  if (/[\\/]tests[\\/]\.tmp-/i.test(r)) return true;
  const under = base => { try { const rel = pathmod.relative(pathmod.resolve(base), r); return !!rel && !rel.startsWith('..') && !pathmod.isAbsolute(rel); } catch { return false; } };
  if (under(require('os').tmpdir())) return true;
  if (process.env.MOST_TEST_OUTSIDE && under(process.env.MOST_TEST_OUTSIDE)) return true;
  return false;
}
// team-v58 (дирижёр п.6): тестовая подмена происхождения (MOST_TEST_CHAT_ORIGIN) действует, ТОЛЬКО если И каталог выпуска —
// временная копия тестового прогона, И каталог СОСТОЯНИЯ — временная папка прогона, а не настоящее состояние моста
// (E:\most\state). Именно про состояние и говорит замысел: уязвимость была в том, что прежнее условие «не из E:\most\live»
// пропускало любой рабочий клон E:\most\.work\… «с настоящим состоянием моста». Решающий признак — каталог состояния: у
// настоящего моста это E:\most\state (под клоном или явный), не временная папка. Выпуск: не установленный live (выше) и его
// каталог — временная копия прогона ЛИБО тот самый работающий клон (in-process наборы запускают серверы из клона с временным
// состоянием — это тест, а не боевой мост: у него временное состояние). Поэтому гейтим по каталогу состояния.
function honoursEnv() {
  if (!process.env.MOST_TEST_CHAT_ORIGIN || fromInstalledLive()) return false;
  const repo = repoRootDir();
  // Каталог выпуска — временная копия прогона либо тот самый работающий клон (его физический каталог кода).
  const releaseOk = underTestTmp(repo) || require('path').resolve(__dirname, '..').toLowerCase() === repo.toLowerCase();
  return releaseOk && underTestTmp(stateDirPath());
}

const parse = t => { const n = Date.parse(t); return Number.isFinite(n) ? n : null; };
// Предок не позже потомка (равенство допустимо; это исключает переиспользованный PID — у него время создания позже).
// Нечитаемое время ни у одного из двух — не доказывает переиспользование, ложного отказа не делаем.
function notLater(parentStart, childStart) {
  const a = parse(parentStart), b = parse(childStart);
  if (a === null || b === null) return true;
  return a <= b;
}
// Тот же процесс в записи готовности/исполнителя: PID совпал, время создания близко (Windows отдаёт PID заново).
// team-v58 (дирижёр п.7): допуск сужен с 10 минут до нескольких секунд. Время в ЗАПИСИ готовности (state\ready\…) — это
// момент её записи (access.ready: new Date().toISOString()), он наступает сразу ПОСЛЕ создания процесса сервера, задержка —
// только старт Node и первые require (обычно доли секунды, на холодном Windows с антивирусом — до секунды-двух). Время в
// ТАБЛИЦЕ процессов — настоящее CreationDate (Win32_Process, UTC). Разница между ними односторонняя и мала: запись не может
// быть РАНЬШЕ создания. Переиспользованный Windows PID получает новое CreationDate, отстоящее от прежней записи куда больше
// нескольких секунд, поэтому 5 с надёжно отличают «тот же процесс» от «PID переиспользован». Защиту это не ослабляет:
// предка-исполнителя (сверка по времени карточки, которое может отличаться сильнее) дублирует предок-СЕРВЕР моста, который
// есть у любого поручения и ловится и по записи готовности, и по командной строке.
const SAME_PROC_MS = 5000;
function sameProc(procStart, recStart) {
  const a = parse(procStart), b = parse(recStart);
  if (a === null || b === null) return true;
  return Math.abs(a - b) < SAME_PROC_MS;
}

// Записи готовности серверов моста (state\ready\…: PID + время запуска). Запись создаётся синхронно при запуске сервера,
// до начала обработки инструментов, удаляется при собственном выходе (access.ready).
// team-v58 (дирижёр п.5): запись на ЭКЗЕМПЛЯР (<server>.<pid>.json), а не одна на имя сервера: каждый клиент (Claude, Codex,
// Antigravity, DeepSeek, Kimi) запускает свои экземпляры серверов моста, и прежний общий <server>.json затирался последним
// запустившимся — тогда исполнитель, запущенный сервером ДРУГОГО клиента, не нашёл бы своего предка-сервера в записях
// готовности. Читаем ВСЕ экземпляры (и общий <server>.json — для совместимости). Устаревшие записи на экземпляр (процесса с
// таким PID нет) чистятся при чтении; общий <server>.json не удаляем (его читают другие).
function serverRecords() {
  const out = [];
  try {
    const fs = require('fs'), path = require('path');
    const dir = path.join(paths().stateDir, 'ready');
    const alive = require('./deploy-ops').alive;
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.json')) continue;
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8').replace(/^﻿/, '')); } catch { continue; }
      if (!r || !Number.isInteger(r.pid)) continue;
      const inst = n.match(/^(.+)\.(\d+)\.json$/); // запись на экземпляр: <server>.<pid>.json
      if (inst && Number(inst[2]) === r.pid && alive(r.pid) === false) { try { fs.unlinkSync(path.join(dir, n)); } catch {} continue; }
      out.push({ name: inst ? inst[1] : n.slice(0, -5), pid: r.pid, startedAt: r.startedAt || null });
    }
  } catch {}
  return out;
}
// Записи запуска исполнителей (PID + время): карточки поручений любого статуса — хранятся до подтверждённой остановки
// всего дерева процессов, а не до смены статуса карточки, поэтому берём все карточки, а не только незавершённые.
let cardsCache = null;
function executorRecords(now = Date.now) {
  if (cardsCache && now() - cardsCache.at < 3000) return cardsCache.rows;
  const rows = [];
  try {
    for (const { j } of require('./live-jobs').cards({ stateDir: paths().stateDir })) {
      const start = j.startedAt || j.createdAt || null;
      for (const pid of require('./live-jobs').cardPids(j)) rows.push({ pid, startedAt: start });
    }
  } catch {}
  cardsCache = { at: now(), rows };
  return rows;
}

// Чистая функция решения по четырём условиям (вход — таблица процессов и записи; удобна для тестов с подстановкой).
// table: [{pid, ppid, name, startedAt, commandLine?}]; selfPid — процесс сервера; servers/executors — записи.
function decide({ table, selfPid, servers = [], executors = [] }) {
  if (!Array.isArray(table) || !table.length) return { chat: false, reason: 'таблица процессов не прочитана' };
  const byPid = new Map(table.map(r => [r.pid, r]));
  const self = byPid.get(selfPid);
  if (!self) return { chat: false, reason: 'свой процесс не найден в таблице процессов' };
  const isServer = p => servers.some(r => r.pid === p.pid && sameProc(p.startedAt, r.startedAt));
  const isExecutor = p => executors.some(r => r.pid === p.pid && sameProc(p.startedAt, r.startedAt));
  const chain = [];
  const seen = new Set([selfPid]);
  let client = null, reachedClient = false, cur = self;
  for (let n = 0; n < 128; n++) {
    const parent = byPid.get(cur.ppid);
    if (!parent) {
      // Цепочка оборвана. До клиента не дошли — отказ (завершившийся промежуточный процесс или неполная таблица);
      // выше клиента обрыв допустим — условия 1–3 для человека проверены на отрезке до приложения-клиента.
      if (client) break;
      return { chat: false, reason: 'цепочка предков оборвана до приложения-клиента (предок PID ' + cur.ppid + ' не найден: завершился или таблица неполна)' };
    }
    if (seen.has(parent.pid)) break; // защита от цикла в подменённой таблице
    // Условие 1 (только до приложения-клиента): время создания предка не позже потомка.
    if (!client && !notLater(parent.startedAt, cur.startedAt))
      return { chat: false, reason: 'время создания предка PID ' + parent.pid + ' позже потомка — переиспользованный PID, цепочка неоднозначна' };
    // Условие 3: среди предков (строго от родителя и выше — собственная запись сервера не считается) нет сервера моста и
    // нет исполнителя поручения. Поиск сервера-предка не прекращаем на первом распознанном клиенте: вложенный запуск
    // настоящего клиента из поручения — тоже поручение (поэтому сканируем всю цепочку, в т.ч. ВЫШЕ клиента).
    if (isServer(parent) || looksLikeBridgeServer(parent)) return { chat: false, reason: 'среди предков — сервер моста (PID ' + parent.pid + '): это поручение, а не чат' };
    if (isExecutor(parent)) return { chat: false, reason: 'среди предков — исполнитель поручения (PID ' + parent.pid + '): это поручение, а не чат' };
    // Условие 2: цепочка доходит до процесса приложения-клиента зарегистрированного участника.
    if (!client) { const id = recognisedClient(parent); if (id) client = { id, pid: parent.pid, startedAt: parent.startedAt || null }; }
    // team-v58 (task10 в): в запомненную цепочку (ancestors) для перепроверки живости/состава берём предков ТОЛЬКО до
    // приложения-клиента включительно. Процессы ВЫШЕ клиента (терминал, explorer.exe, сценарий запуска) в перепроверку не
    // входят: их завершение не должно лишать настоящий чат прав (замысел §1, условие 1 — живость только до клиента).
    if (!reachedClient) chain.push({ pid: parent.pid, startedAt: parent.startedAt || null, name: parent.name || null });
    if (client && parent.pid === client.pid) reachedClient = true;
    seen.add(parent.pid);
    cur = parent;
  }
  if (!client) return { chat: false, reason: 'цепочка предков не доходит до приложения-клиента зарегистрированного участника связки' };
  return { chat: true, reason: '', client, ancestors: chain };
}

// --- Боевой/тестовый ввод и кэш решения ---
let override = null; // { chat, reason } или null — внутренняя тестовая подстановка готового решения
let testSources = null; // { table, selfPid, servers, executors } — подстановка входа (таблицы и записей)
let built = null; // закэшированное построенное решение
// Внутренняя тестовая подстановка (недоступна боевому процессу из окружения): либо готовое решение {decision:{chat,reason}},
// либо вход {table, selfPid, servers, executors} для проверки четырёх условий на подставленной таблице процессов и записях.
function setTest(o) {
  override = o && o.decision ? o.decision : null;
  testSources = o && o.table ? o : (o && o.sources ? o.sources : null);
  built = null; cardsCache = null;
}
function clearTest() { override = null; testSources = null; built = null; cardsCache = null; }
function withOrigin(o, fn) { const sv = { override, testSources, built }; try { setTest(o); return fn(); } finally { override = sv.override; testSources = sv.testSources; built = sv.built; } }

function liveTable() {
  // team-v58 (task10 б): боевая проверка происхождения берёт ТОЛЬКО настоящую таблицу процессов. native:true запрещает
  // подмену окружением (NODE_ENV=test + MOST_TEST_PROCESS_TREE в fallback.processTable): в установленном выпуске/при настоящем
  // состоянии моста подставить таблицу предков и так получить права чата из поручения нельзя. Тестовый вход для decide ставят
  // внутренние зависимости (setTest/withOrigin), которые боевому процессу из окружения недоступны.
  try { return fallback().processTable(true, { commandLine: true, native: true }); } catch { return null; }
}

// team-v59 (task2 п.2–3): АСИНХРОННЫЙ снимок таблицы процессов С командными строками — не блокирует событийный цикл
// (execFile, а не execFileSync). Нужен для фонового вычисления происхождения после server.connect(), чтобы ответ на
// initialize/tools/list не ждал PowerShell. На не-Windows возвращает null (там processTable синхронна и дёшева — хватает
// ленивого синхронного пути при первом guard). Ошибка/нечитаемая таблица — null (как у liveTable).
function liveTableAsync() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Start';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}} | ConvertTo-Json -Compress"],
      { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64e6 }, (e, out) => {
        if (e) return resolve(null);
        try { resolve([].concat(JSON.parse(out || '[]')).map(r => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, startedAt: r.Start || null, commandLine: r.CommandLine || '' }))); }
        catch { resolve(null); }
      });
    } catch { resolve(null); }
  });
}

// team-v59 (task2): фоновое вычисление происхождения после server.connect(). Не блокирует событийный цикл; результат
// кэшируется в built, как у синхронного build(). Если инструмент вызовут раньше готовности — result() посчитает синхронно
// (один раз, ~1 c на самом вызове, а НЕ на handshake). Идемпотентно; под пробой/тестовой подменой/окружением — не нужно.
let priming = null;
let asyncTableFn = liveTableAsync; // подменяется только в тестах (setAsyncTableForTest); боевой процесс берёт настоящий снимок
function setAsyncTableForTest(fn) { asyncTableFn = fn || liveTableAsync; }
function primeAsync() {
  if (priming) return priming;
  if (process.env.MOST_PROBE_ONLY === '1' || override || testSources || honoursEnv() || built) return Promise.resolve();
  priming = asyncTableFn().then(table => {
    if (built || !table) return; // синхронный build успел раньше, либо таблицу не прочли — оставим ленивый путь на первый guard
    built = decide({ table, selfPid: process.pid, servers: serverRecords(), executors: executorRecords() });
  }).catch(() => {}).finally(() => { priming = null; });
  return priming;
}

// Полное построение решения (один раз при старте / при первом обращении), с реальными или подставленными источниками.
function build() {
  if (testSources) {
    const selfPid = testSources.selfPid === undefined ? process.pid : (testSources.selfPid === 'self' ? process.pid : testSources.selfPid);
    const table = (testSources.table || []).map(r => ({ ...r, pid: r.pid === 'self' ? process.pid : r.pid, ppid: r.ppid === 'self' ? process.pid : r.ppid }));
    return decide({ table, selfPid, servers: testSources.servers || [], executors: testSources.executors || [] });
  }
  const table = liveTable();
  if (!table) return { chat: false, reason: 'таблица процессов не прочитана' };
  return decide({ table, selfPid: process.pid, servers: serverRecords(), executors: executorRecords() });
}

// Дешёвая перепроверка: запомненные предки живы (process.kill(pid,0)) и среди них не появилось сервера моста/исполнителя.
// Время создания запомнено при построении; переиспользование PID уже исключено на построении, а живость — прямой проверкой.
// team-v58 (task10 в): d.ancestors содержит предков только ДО приложения-клиента включительно, поэтому и живость, и состав
// перепроверяются лишь на этом отрезке; завершение процессов ВЫШЕ клиента (explorer.exe, терминал) прав чата не снимает.
function revalidate(d) {
  if (!d.chat) return d;
  const alive = require('./deploy-ops').alive;
  for (const a of d.ancestors || []) { if (alive(a.pid) === false) return { chat: false, reason: 'предок PID ' + a.pid + ' завершился — цепочка до приложения-клиента оборвалась' }; }
  const servers = serverRecords(), executors = executorRecords();
  for (const a of d.ancestors || []) {
    if (servers.some(r => r.pid === a.pid && sameProc(a.startedAt, r.startedAt))) return { chat: false, reason: 'среди предков появился сервер моста (PID ' + a.pid + '): это поручение, а не чат' };
    if (executors.some(r => r.pid === a.pid && sameProc(a.startedAt, r.startedAt))) return { chat: false, reason: 'среди предков появился исполнитель поручения (PID ' + a.pid + '): это поручение, а не чат' };
  }
  return d;
}

// Итог «чат / не чат» для access. Боевой процесс: построить при первом обращении, дальше — дешёвая перепроверка.
function result() {
  if (override) return override;
  if (testSources) return build(); // в тестах подстановка входа решается заново (детерминированно, без перепроверки живости)
  if (honoursEnv()) {
    const v = String(process.env.MOST_TEST_CHAT_ORIGIN);
    if (v === 'proven' || v === 'chat' || v === '1') return { chat: true, reason: '' };
    if (v === 'job' || v === 'none' || v === '0') return { chat: false, reason: 'подстановка происхождения (тест): не чат' };
  }
  if (!built) built = build();
  if (built.chat) return revalidate(built);
  return built;
}
function reset() { built = null; cardsCache = null; priming = null; }
function ok(opts) { return result(opts).chat; }
function reason(opts) { return result(opts).reason || ''; }

module.exports = {
  decide, recognisedClient, looksLikeBridgeServer, fromInstalledLive, honoursEnv,
  result, ok, reason, reset, build, primeAsync, liveTableAsync, setAsyncTableForTest,
  setTest, clearTest, withOrigin, serverRecords, executorRecords,
};
