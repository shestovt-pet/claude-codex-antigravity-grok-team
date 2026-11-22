'use strict';
// team-v62 (репетиция на копии живого состояния): два исправления, обнаруженные сквозным прогоном через MCP.
//  1) common/work-owner.withWork — внешняя обёртка *_send падала на name() для РУССКОЙ/незарегистрированной работы РАНЬШЕ,
//     чем stage-gate.prepareJob успевал заменить её ярлыком (workLabel). Теперь некириллическая/незарегистрированная работа
//     у роли «совет» проходит без замка (ярлык), а зарегистрированная латинская — как прежде (замок + проверка владения).
//     Требование владельца: «поручение идёт без работы; имя работы любое (кириллица), незарегистрированная принимается».
//  2) servers/claude/index.js — claude_send требовал folder (и в схеме, и в теле), в отличие от codex/deepseek/kimi/antigravity.
//     Теперь роль «совет»/«текст» без записи берёт служебную папку (scratch-folder.ensure), схема делает folder необязательным.
//     Требование владельца: «поручение идёт без папки; никаких искусственных ограничений».
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const REPO = path.resolve(__dirname, '..');

// --- режим дочернего сервера claude: подмена исполнителя на node fake-claude.js (как tests/fake-claude.js), проба --help ---
if (process.argv.includes('--claude-server')) {
  const cp = require('child_process'), realSpawn = cp.spawn, realExec = cp.execFileSync;
  const FAKE = path.join(__dirname, 'fake-claude.js');
  const isBin = f => typeof f === 'string' && /claude/i.test(f) && !/servers[\\/]claude[\\/]index\.js/i.test(f);
  cp.spawn = (file, args, options) => isBin(file) ? realSpawn(process.execPath, [FAKE], options) : realSpawn(file, args, options);
  cp.execFileSync = (file, args, options) => (isBin(file) && Array.isArray(args) && args.includes('--help'))
    ? '-p --tools --strict-mcp-config --mcp-config --permission-mode --output-format --allowedTools --no-session-persistence --setting-sources --settings\n'
    : realExec(file, args, options);
  require('../servers/claude/index'); // сервер стартует сам при загрузке модуля (верхнеуровневый IIFE)
  return;
}

// Для случая «слово владельца снимает границу малой правки»: состояние моста — во временной папке под TEMP прогона,
// чтобы chat-origin.honoursEnv признал проверочное происхождение (MOST_TEST_CHAT_ORIGIN) и слово владельца прошло.
// Ставится ТОЛЬКО в основном процессе набора (ветка --claude-server выше уже вышла через return и этого кода не видит).
const OWNER_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'v62-ownerstate-'));
process.env.MOST_STATE_DIR = OWNER_STATE;
process.on('exit', () => { try { fs.rmSync(OWNER_STATE, { recursive: true, force: true }); } catch {} });

const tests = [];
const T = (n, f) => tests.push([n, f]);
const rmrf = d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), 'v62-' + p + '-'));
const SERVERS = { claude: 'servers/claude/index.js', codex: 'servers/codex/index.js', deepseek: 'servers/deepseek/index.js', kimi: 'servers/kimi/index.js', antigravity: 'servers/antigravity/index.js' };
const srcOf = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ===== 1) work-owner.withWork: ярлык для кириллицы/незарегистрированной; замок и владение для зарегистрированной =====
T('withWork: русская работа — ярлык без замка (прежде падало на name())', async () => {
  const wo = require('../common/work-owner');
  const root = tmp('wo1');
  try {
    let ran = 0;
    await wo.withWork({ work: 'проверка-связи' }, async () => { ran++; }, root);         // кириллица
    await wo.withWork({ work: 'nonexistent-xyz' }, async () => { ran++; }, root);         // латиница, но нет файла работы
    assert.equal(ran, 2, 'оба поручения с незарегистрированной работой выполнились без отказа name()');
  } finally { rmrf(root); }
});
T('withWork: зарегистрированная латинская работа — замок и проверка владения (как прежде)', async () => {
  const wo = require('../common/work-owner');
  const root = tmp('wo2');
  try {
    fs.mkdirSync(path.join(root, 'works'), { recursive: true });
    fs.writeFileSync(path.join(root, 'works', 'reg.json'), JSON.stringify({ name: 'reg', owner: null, stages: [] }));
    let ran = 0;
    await wo.withWork({ work: 'reg', owner: 'sess-a' }, async () => { ran++; }, root);      // первый владелец — ок, owner закрепится
    assert.equal(ran, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'works', 'reg.json'), 'utf8')).owner, 'sess-a', 'владелец закреплён');
    await assert.rejects(wo.withWork({ work: 'reg', owner: 'sess-b' }, async () => {}, root), /владение передано/, 'чужой сеанс — отказ по владению');
  } finally { rmrf(root); }
});
T('stage-gate.prepareJob: совет + русская/незарегистрированная работа → workLabel (без привязки)', async () => {
  const sg = require('../common/stage-gate');
  const root = tmp('sg'); fs.mkdirSync(path.join(root, 'works'), { recursive: true });
  try {
    const a = { role: 'совет', task: '2+2?', work: 'Вопрос про 2+2' };
    await sg.prepareJob(a, 'codex', root);
    assert.equal(a.work, undefined, 'work снята');
    assert.equal(a.workUnbound, true, 'помечена как ярлык');
    assert.equal(a.workLabel, 'Вопрос про 2+2', 'исходное имя сохранено ярлыком');
  } finally { rmrf(root); }
});

// ===== 2) claude_send: папка необязательна (служебная) для роли «совет» =====
T('claude_send: поручение ТОЛЬКО с task (без folder) принимается — служебная папка', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const run = tmp('cl'), state = path.join(run, 'state');
  fs.mkdirSync(state, { recursive: true });
  const env = { ...process.env, MOST_REPO_ROOT: REPO, MOST_STATE_DIR: state, MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off',
    MOST_TEST_CHAT_ORIGIN: 'proven', MOST_TEST_OUTSIDE: os.tmpdir(), CLAUDE_PATH: path.join(__dirname, 'fake-claude.js'), NODE_ENV: 'test' };
  delete env.MOST_JOB_ID; delete env.MOST_AUTHORITY;
  const transport = new StdioClientTransport({ command: process.execPath, args: [__filename, '--claude-server'], stderr: 'pipe', env });
  const c = new Client({ name: 'v62', version: '1' });
  try {
    await c.connect(transport);
    await new Promise(r => setTimeout(r, 2500)); // дать серверу снять снимок процессов (admission)
    const r = await c.callTool({ name: 'claude_send', arguments: { task: 'Сколько будет 2+2?' } }, undefined, { timeout: 60000 });
    const text = (r.content || []).map(x => x.text).join('\n');
    assert(!r.isError, 'claude_send без folder не должен падать: ' + text);
    assert(/поручение|ИДЁТ|ПРИНЯ|НЕ УДАЛОСЬ|claude_result/i.test(text), 'карточка поручения создана: ' + text.slice(0, 120));
    assert(!/Нужна абсолютная существующая папка|Required.*folder/i.test(text), 'отказа по папке нет');
    // Сквозь MCP: поручение с РУССКОЙ работой без stage/role/folder принимается, карточка хранит ярлык, *_result его показывает.
    const r2 = await c.callTool({ name: 'claude_send', arguments: { task: 'Сколько будет 2+2?', work: 'Русская работа' } }, undefined, { timeout: 60000 });
    const text2 = (r2.content || []).map(x => x.text).join('\n');
    assert(!r2.isError, 'claude_send с русской работой без этапа не должен падать: ' + text2);
    assert(!/укажите этап/i.test(text2), 'отказа «укажите этап» нет: ' + text2);
    // *_result показывает ярлык работы (format читает поля workLabel/workUnbound карточки поручения); сохранение полей в
    // карточке каждого адаптера проверяет источниковый инвариант ниже, а relabel — случай «п.2 prepareJob → ярлык».
    assert(/работа: Русская работа \(без привязки\)/.test(text2), '*_result показывает ярлык работы: ' + text2.slice(0, 200));
  } finally { try { await c.close(); } catch {} rmrf(run); }
});

// ===== ПУНКТ 1: ранняя проверка этапа исключает роль «совет» у всех пяти адаптеров =====
T('п.1 все пять send принимают {task, work:"Русская работа"} без stage/role/folder (ранняя проверка этапа)', async () => {
  // claude/codex/deepseek/kimi: одинаковая ранняя проверка ВЫПОЛНЯЕТСЯ ПОСЛЕ scratch-folder.ensure, который по умолчанию
  // (без write и без role) ставит роль «совет». Проверяем ту же композицию, что в теле send, и эталон в исходнике.
  const sf = require('../common/scratch-folder');
  for (const who of ['claude', 'codex', 'deepseek', 'kimi']) {
    const a = { task: 'Сколько будет 2+2?', work: 'Русская работа' };
    sf.ensure(a);
    assert.equal(a.role, 'совет', who + ': роль по умолчанию «совет»');
    assert(!(a.work && !a.stage && a.role !== 'совет'), who + ': ранняя проверка этапа не отвергает совет с русской работой');
    assert(/a\.work && !a\.stage && a\.role !== 'совет'/.test(srcOf(SERVERS[who])), who + ': исходник приведён к эталону (роль «совет» исключена)');
  }
  // antigravity: ранняя проверка в compat-обёртке; роль по умолчанию «совет» → (role||'совет')!=='совет' == false.
  assert(/args\.work && !args\.stage && \(args\.role \|\| 'совет'\) !== 'совет'/.test(srcOf(SERVERS.antigravity)), 'antigravity: исключение роли «совет» в ранней проверке');
  const role = undefined, stage = undefined, work = 'Русская работа';
  assert(!(work && !stage && ((role || 'совет') !== 'совет')), 'antigravity: {work, без stage/role} проходит раннюю проверку');
});

// ===== ПУНКТ 2: имя работы-ярлыка не теряется — карточка, сводка и *_result его сохраняют =====
T('п.2 prepareJob → ярлык; все пять карточек сохраняют workLabel/workUnbound', async () => {
  const sg = require('../common/stage-gate');
  const root = tmp('relabel'); fs.mkdirSync(path.join(root, 'works'), { recursive: true });
  try {
    const a = { role: 'совет', task: 'q', work: 'Русская работа' };
    await sg.prepareJob(a, 'codex', root);
    assert.equal(a.work, undefined, 'привязка снята');
    assert.equal(a.workLabel, 'Русская работа', 'имя сохранено ярлыком');
    assert.equal(a.workUnbound, true, 'помечено без привязки');
  } finally { rmrf(root); }
  // карточки claude/codex/deepseek/kimi переносят ярлык из a; antigravity — из context.getStore().args.
  for (const who of ['claude', 'codex', 'deepseek', 'kimi'])
    assert(/workLabel: a\.workLabel, workUnbound: a\.workUnbound/.test(srcOf(SERVERS[who])), who + ': карточка сохраняет workLabel/workUnbound');
  assert(/workLabel: context\.getStore\(\)\?\.args\.workLabel, workUnbound: context\.getStore\(\)\?\.args\.workUnbound/.test(srcOf(SERVERS.antigravity)), 'antigravity: карточка сохраняет workLabel/workUnbound');
});

T('п.2 показ ярлыка: workLabelLine, *_result (format) и полная сводка (live-jobs) — «работа: … (без привязки)»', async () => {
  const summary = require('../common/summary');
  const job = { id: 'abcd1234ef', status: 'done', workUnbound: true, workLabel: 'Русская работа', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
  assert.equal(summary.workLabelLine(job), 'работа: Русская работа (без привязки)', 'ярлык собран');
  assert.equal(summary.workLabelLine({ work: 'reg', stage: 's1' }), null, 'привязанная работа ярлыка не даёт');
  assert(/работа: Русская работа \(без привязки\)/.test(require('../common/format').format('Codex', job, 'тело')), '*_result показывает ярлык');
  // краткая сводка (compact) строит строку активного поручения через тот же workLabelLine.
  assert(/workLabelLine\(j\)/.test(srcOf('common/summary.js')), 'краткая сводка использует workLabelLine');
  // полная сводка: live-jobs по реальной карточке на диске.
  const state = tmp('lj'), dir = path.join(state, 'codex-jobs'); fs.mkdirSync(dir, { recursive: true });
  const INSTANCE = require('../common/locks').INSTANCE;
  fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify({ id: 'r1234567', status: 'running', startedAt: new Date().toISOString(),
    workUnbound: true, workLabel: 'Русская работа', owner: { instance: INSTANCE, pid: process.pid, startedAt: new Date().toISOString() } }));
  try {
    const lj = require('../common/live-jobs');
    const rows = await lj.running({ stateDir: state });
    assert(/работа Русская работа \(без привязки\)/.test(lj.describe(rows)), 'полная сводка (describe) показывает ярлык: ' + lj.describe(rows));
  } finally { rmrf(state); }
});

// ===== task4: быстрый ответ на initialize/tools/list — миграция НЕ держит server.connect =====
// Причина задержки инструментов четырёх серверов после установки v61: каждый сервер моста делал
// `await state-migration.start()` ДО server.connect, а миграция держит ОДИН общий замок на все серверы, —
// поэтому серверы подключались по очереди (стагер в секунды), поздние не попадали в первый проход привязки
// приложения и их инструменты появлялись минутами позже. Исправление: миграция и первая сверка очереди — в
// ФОНЕ после connect (барьер «очередь после миграции» сохранён).
const ALL_SERVERS = { ...SERVERS, team: 'servers/team/index.js' };

T('task4: во всех шести серверах server.connect идёт ДО state-migration.start (исходники)', () => {
  for (const who of Object.keys(ALL_SERVERS)) {
    const s = srcOf(ALL_SERVERS[who]);
    const iConnect = s.indexOf('.connect(');
    const iMigrate = s.indexOf("state-migration').start(");
    assert(iConnect >= 0, who + ': есть server.connect');
    assert(iMigrate >= 0, who + ': есть state-migration.start');
    assert(iConnect < iMigrate, who + ': connect должен идти ДО миграции (миграция — в фоне после ответа на initialize/tools/list)');
  }
});

// Поднять сервер моста дочерним процессом, замерить мс от запуска до ответа на initialize и tools/list.
function handshakeMs(who, code, env) {
  return new Promise((resolve) => {
    const cp = require('child_process');
    const entry = path.join(code, ALL_SERVERS[who]);
    const t0 = Date.now();
    const proc = cp.spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', tInit = null, done = false;
    const finish = r => { if (done) return; done = true; try { proc.kill(); } catch {} resolve(r); };
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't4', version: '1' } } }) + '\n');
    proc.stdout.on('data', d => {
      buf += d.toString(); let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1 && m.result && tInit === null) {
          tInit = Date.now() - t0;
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (m.id === 2 && m.result) {
          finish({ who, tInit, tTools: Date.now() - t0, nTools: (m.result.tools || []).length });
        }
      }
    });
    setTimeout(() => finish({ who, tInit, tTools: null, nTools: 0, timeout: true }), 20000);
  });
}

T('task4: шесть серверов параллельно — initialize+tools/list ≤3с, полный набор инструментов сразу (активная миграция)', async () => {
  const run = tmp('t4'), state = path.join(run, 'state'), local = path.join(run, 'fakelocal');
  // Источник миграции: ~60 комплектов (cancelled) — первый старт реально копирует их, занимая общий замок.
  const jobsSrc = path.join(local, 'most', 'jobs');
  fs.mkdirSync(jobsSrc, { recursive: true });
  for (let i = 0; i < 60; i++) {
    const id = 'mig' + String(i).padStart(4, '0'), dir = path.join(jobsSrc, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'card.json'), JSON.stringify({ id, status: 'cancelled', finishedAt: new Date().toISOString() }));
  }
  fs.mkdirSync(state, { recursive: true });
  const env = { ...process.env, MOST_REPO_ROOT: run, MOST_STATE_DIR: state, LOCALAPPDATA: local,
    MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off', MOST_TEST_KEEP: '1', MOST_DSH_NO_PROFILES: '1',
    MOST_TEST_CHAT_ORIGIN: 'proven', MOST_TEST_OUTSIDE: run, NODE_ENV: 'test',
    CODEX_PATH: '', AGY_PATH: '', DSH_PATH: '', KIMI_PATH: '', CLAUDE_PATH: '' };
  delete env.MOST_JOB_ID; delete env.MOST_AUTHORITY; delete env.MOST_PROBE_ONLY;
  try {
    // Все шесть стартуют ОДНОВРЕМЕННО и делят один замок миграции (как при установке поверх состояния).
    const rows = await Promise.all(Object.keys(ALL_SERVERS).map(who => handshakeMs(who, REPO, env)));
    for (const r of rows) {
      assert(!r.timeout, r.who + ': ответил на initialize+tools/list (не таймаут)');
      assert(r.nTools > 0, r.who + ': полный набор инструментов сразу (не пустой список), получено ' + r.nTools);
      assert(r.tInit <= 3000, r.who + ': initialize ≤3с, факт ' + r.tInit + 'мс');
      assert(r.tTools <= 3000, r.who + ': tools/list ≤3с, факт ' + r.tTools + 'мс');
    }
    // Миграция всё же выполняется (в фоне): дождёмся отметки .migration-done, чтобы подтвердить барьер очереди.
    const marker = path.join(state, '.migration-done-' + require('../common/state-migration').VERSION);
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise(r => setTimeout(r, 100));
    assert(fs.existsSync(marker), 'миграция выполнилась в фоне (появилась отметка .migration-done)');
  } finally { rmrf(run); }
});

// ===== взгляд участников (пункт 2): сбой первичной (теперь фоновой) миграции НЕ теряется =====
// Прежде start() вызывал migrate() вне try/catch и до установки таймера: при выбросе на первичном проходе
// migration-error.json не писался, таймер повтора не ставился, а фоновая цепочка сервера печатала лишь
// «сбой операции» без текста. Теперь ошибка пишется в файл, таймер повтора ставится всегда, текст — в журнал.
T('п.2: сбой первичной миграции виден — migration-error.json, таймер повтора всегда, ТЕКСТ ошибки в журнал, строка в краткой team_status', async () => {
  const mig = require('../common/state-migration');
  const root = tmp('migfail'), state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  const src = path.join(root, 'src'), b = path.join(src, 'jobs', 'j1');
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, 'card.json'), JSON.stringify({ id: 'j1', status: 'cancelled' }));
  let scheduled = 0;
  const scheduler = { setInterval: () => { scheduled++; return { unref() {} }; }, clearInterval() {} };
  const logs = [], realErr = console.error; console.error = (...a) => logs.push(a.join(' '));
  try {
    // hook бросает на этапе before_publish первого комплекта → migrate() отклоняется на ПЕРВИЧНОМ проходе.
    await mig.start({ root, state, sources: [src], env: { ...process.env, MOST_CLIENT: 'claude' },
      hook: () => { throw Object.assign(Error('сбой копирования переноса'), { migrationInterrupted: true }); } }, scheduler);
  } finally { console.error = realErr; }
  const errFile = path.join(state, 'migration-error.json');
  assert(fs.existsSync(errFile), 'migration-error.json создан при сбое первичной миграции');
  assert(/сбой копирования переноса/.test(JSON.parse(fs.readFileSync(errFile, 'utf8')).error), 'в файле — текст ошибки');
  assert.equal(scheduled, 1, 'таймер повторной сверки ставится ВСЕГДА (в т.ч. при первичном сбое)');
  assert(logs.some(l => /первичная сверка не завершена/.test(l) && /сбой копирования переноса/.test(l)),
    'в журнал ушёл ТЕКСТ ошибки, а не только «сбой операции»: ' + logs.join(' | '));
  // Краткая team_status (summary.compact) читает migration-error.json и выводит строку об ошибке сверки.
  assert(/migration-error\.json[\s\S]{0,200}Ошибка сверки хранилища/.test(srcOf('common/summary.js')),
    'краткая сводка читает migration-error.json и выводит «Ошибка сверки хранилища»');
  rmrf(root);
});

// ===== взгляд участников (пункт 1): барьер первичной миграции для обработчиков и периодических триггеров =====
T('п.1: обёртки обработчиков всех шести серверов ждут первичную миграцию (awaitPrimary); интервал очереди антигравити — после миграции', () => {
  for (const who of Object.keys(ALL_SERVERS))
    assert(/state-migration'\)\.awaitPrimary\(\)/.test(srcOf(ALL_SERVERS[who])), who + ': обёртка обработчика ждёт первичную миграцию (awaitPrimary)');
  const agy = srcOf(SERVERS.antigravity);
  const iMigrate = agy.indexOf("state-migration').start(");
  const iInterval = agy.lastIndexOf('setInterval(');
  assert(iMigrate >= 0 && iInterval > iMigrate, 'antigravity: setInterval(resumeQueue) идёт ПОСЛЕ state-migration.start (в фоне после миграции)');
  // initialize/tools/list барьер не ждут: awaitPrimary только в обёртке registerTool, не в connect-цепочке.
});

T('п.1: вызов инструмента во время идущей миграции ждёт барьер и даёт понятный текст; после миграции — проходит', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const locks = require('../common/locks');
  const run = tmp('gate'), state = path.join(run, 'state'), local = path.join(run, 'fakelocal');
  fs.mkdirSync(state, { recursive: true });
  const jobsSrc = path.join(local, 'most', 'jobs', 'g1'); fs.mkdirSync(jobsSrc, { recursive: true });
  fs.writeFileSync(path.join(jobsSrc, 'card.json'), JSON.stringify({ id: 'g1', status: 'cancelled', finishedAt: new Date().toISOString() }));
  // Держим общий замок миграции из теста: первичная миграция сервера не завершится, пока его не отпустим.
  const held = await locks.tryLock('migration', path.resolve(state), {}, state);
  assert(held.ok, 'тест захватил замок миграции');
  const env = { ...process.env, MOST_REPO_ROOT: run, MOST_STATE_DIR: state, LOCALAPPDATA: local,
    MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off', MOST_TEST_KEEP: '1',
    MOST_TEST_CHAT_ORIGIN: 'proven', MOST_TEST_OUTSIDE: run, NODE_ENV: 'test', MOST_MIGRATION_WAIT_MS: '800', CODEX_PATH: '' };
  delete env.MOST_JOB_ID; delete env.MOST_AUTHORITY; delete env.MOST_PROBE_ONLY;
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, 'servers/codex/index.js')], stderr: 'pipe', env });
  const c = new Client({ name: 'v62gate', version: '1' });
  try {
    await c.connect(transport); // initialize/tools/list НЕ ждут миграцию
    const tools = await c.listTools();
    assert(tools.tools.length > 0, 'tools/list отдаёт полный набор сразу (не ждёт миграцию)');
    // Миграция «идёт» (замок у теста): вызов инструмента ждёт барьер MOST_MIGRATION_WAIT_MS, затем — понятный текст.
    const r1 = await c.callTool({ name: 'codex_status', arguments: {} }, undefined, { timeout: 20000 });
    const t1 = (r1.content || []).map(x => x.text).join('\n');
    assert(/переносится/i.test(t1) && /повторите через \d+ с/i.test(t1), 'во время миграции — понятный текст: ' + t1.slice(0, 200));
    await held.release(); // отпускаем замок — сервер домигрирует
    const marker = path.join(state, '.migration-done-' + require('../common/state-migration').VERSION);
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise(r => setTimeout(r, 100));
    assert(fs.existsSync(marker), 'первичная миграция завершилась после снятия замка (появилась отметка)');
    const r2 = await c.callTool({ name: 'codex_status', arguments: {} }, undefined, { timeout: 20000 });
    const t2 = (r2.content || []).map(x => x.text).join('\n');
    assert(!/переносится/i.test(t2), 'после миграции инструмент проходит без барьера: ' + t2.slice(0, 200));
    assert(/Версия процесса/.test(t2), 'codex_status отдал нормальный ответ после миграции: ' + t2.slice(0, 120));
  } finally { try { await held.release(); } catch {} try { await c.close(); } catch {} rmrf(run); }
});

// ===== слово владельца снимает границу малой правки (commit/merge fast по защищённому пути) =====
// Поломка v62: слово владельца (quote) в commit/merge снимало ворота замысла и голосов, но НЕ границу малой правки —
// commit fast-изменения, правящего защищённый путь, отказывал «не малая правка». Требование владельца: его слово
// главнее любых правил моста, включая эту границу. Теперь ворота малой правки снимаются словом, риск называется в ответе,
// слово дословно пишется в карточку; без слова поведение прежнее, но в тексте отказа появилась подсказка про quote.
T('слово владельца: fast + защищённый путь — commit без quote отказ с подсказкой; с quote проходит; merge с quote проходит', async () => {
  const g = require('../common/team-git'), { Team } = require('../common/team');
  require('../common/members-store').create(OWNER_STATE).read(); // реестр участников в проверочном состоянии
  const run = tmp('ownfast'), root = path.join(run, 'repo');
  fs.mkdirSync(root, { recursive: true });
  try {
    g.git(root, ['init', '-b', 'main']); g.git(root, ['config', 'user.email', 't@e.invalid']); g.git(root, ['config', 'user.name', 'Т']);
    fs.writeFileSync(path.join(root, '.gitignore'), '.work/\nstate/\nworks/\ntests/.tmp-*\n');
    fs.writeFileSync(path.join(root, 'src.js'), '// baseline\n');
    fs.writeFileSync(path.join(root, 'lessons.md'), '# Уроки\n');
    fs.mkdirSync(path.join(root, 'common'), { recursive: true });
    fs.writeFileSync(path.join(root, 'common', 'state-migration.js'), '// protected baseline\n'); // защищённый путь (precheck.fastProtected)
    g.git(root, ['add', '-A']); g.git(root, ['commit', '-m', 'база']);
    const team = new Team(root), name = 'ownfast';
    const NOTE = 'симптом: мелочь; что меняется: защищённый файл; затронутые места: common/state-migration.js; тест: до/после; откат: прежний релиз';
    await team.change({ action: 'start', name, request: 'Правка защищённого файла малым изменением по слову владельца.', fast: true, note: NOTE });
    const folder = team.clone(name);
    g.git(folder, ['config', 'user.email', 't@e.invalid']); g.git(folder, ['config', 'user.name', 'Т']);
    const card = () => JSON.parse(fs.readFileSync(team.changeFile(name), 'utf8'));
    fs.appendFileSync(path.join(folder, 'common', 'state-migration.js'), '// изменение\n'); // правим защищённый путь

    // commit БЕЗ слова — прежний отказ ворот малой правки, с новой подсказкой про quote.
    await assert.rejects(team.change({ name, action: 'commit', message: 'правка' }),
      e => /защищённый путь common\/state-migration\.js/.test(e.message) && /передайте слово владельца параметром quote/.test(e.message),
      'без слова: отказ «защищённый путь …» с подсказкой про quote');
    assert.equal(card().candidate, card().base, 'без слова кандидат не зафиксирован');

    // commit СО словом — проходит, риск назван одной строкой, слово дословно в карточке.
    const QUOTE = 'правь защищённый файл моим словом, замысел не нужен';
    const out = await team.change({ name, action: 'commit', message: 'правка защищённого словом', quote: QUOTE });
    assert(/Кандидат:/.test(out), 'commit прошёл словом: ' + out.slice(0, 300));
    assert(/Принято словом владельца[^\n]*защищённ/i.test(out), 'в ответе одной строкой назван риск (защищённые пути): ' + out.slice(0, 300));
    const c = card();
    assert(c.candidate !== c.base, 'кандидат зафиксирован');
    assert((c.decisions || []).some(d => d.kind === 'owner_word' && d.phase === 'verdict' && d.replaces === 'all'), 'owner_word записан по изменению');
    assert((c.verdicts || []).some(v => v.who === 'user' && v.quote === QUOTE), 'слово дословно в карточке изменения');

    // merge СО словом — проходит, несмотря на защищённый путь.
    const m = await team.change({ name, action: 'merge', message: 'слияние защищённого словом', quote: QUOTE });
    assert(/Слито в main/.test(m), 'merge прошёл словом: ' + m.slice(0, 400));
    assert(/граница малой правки снята словом владельца/.test(m), 'merge назвал снятие границы малой правки: ' + m.slice(0, 400));
    assert.equal(card().status, 'слито', 'карточка помечена слито');
  } finally { rmrf(run); }
});

(async () => {
  let passed = 0, failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log('OK ' + n); passed++; } catch (e) { console.log('FAIL ' + n + '\n' + (e.stack || e.message)); failed++; } }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0');
  if (failed) process.exitCode = 1;
})();
