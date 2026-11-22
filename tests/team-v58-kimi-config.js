'use strict';
// team-v58-any-chat (часть Д, task6 п.6): client-configs для вида клиента 'kimi' (user-mcp.json ядра kimi-code).
// Только на ВРЕМЕННЫХ копиях (MOST_KIMI_MCP_CONFIG во временную папку); живые настройки Kimi не трогаются.
// Проверяется: создание с нуля; сохранение посторонних записей и ключей; одноимённый чужой сервер → отказ; откат к
// «файла не было» (сбой установки удаляет созданный файл); повторная установка идемпотентна; смена выпуска обновляет пути.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { run, RUN } = require('./team-v16-fixture');
const cc = require('../common/client-configs');
const d = require('../common/deploy');
const members = require('../common/members');

const SERVERS = [...members.installedServers];           // серверы связки (team + получатели)
const node = process.execPath;
const dir = path.join(RUN, 'kimi-home'); fs.mkdirSync(dir, { recursive: true });  // «домашняя папка kimi-code»
const file = path.join(dir, 'mcp.json');
const root = require('../common/paths').repoRoot;        // корень установки фикстуры
const state = path.join(root, 'state');
const rel = id => path.join(root, 'live', id);
const A = rel('a'.repeat(40)), B = rel('b'.repeat(40));
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const snap = () => ({ ...d.snapshot(file, true), kind: 'kimi', client: 'kimi' });
const reset = () => { try { fs.unlinkSync(file); } catch {} try { fs.unlinkSync(file + '.prev'); } catch {} };

// --- task7: путь настроек чата Kimi находится сам (kimi-client) ---
const kc = require('../common/kimi-client');
const savedFile = path.join(state, 'kimi-client.json');
const readSaved = () => { try { return JSON.parse(fs.readFileSync(savedFile, 'utf8')).path; } catch { return null; } };
const clearKimi = () => { delete process.env.MOST_KIMI_MCP_CONFIG; try { fs.unlinkSync(savedFile); } catch {} };
const home = () => { const h = fs.mkdtempSync(path.join(RUN, 'kh-')); return { dir: h, file: path.join(h, 'mcp.json') }; };
// База настольного Kimi для источника (г): «… runner\cli.js start --config <X>\config.json …» → <X>\runtime\kimi-code\home\mcp.json.
const procHome = () => {
  const X = fs.mkdtempSync(path.join(RUN, 'kx-'));
  fs.mkdirSync(path.join(X, 'runtime', 'kimi-code', 'home'), { recursive: true });
  const cfg = path.join(X, 'config.json');
  const cmd = 'E:\\Kimi\\Kimi.exe -e "<gate>" E:\\d\\dist\\src\\runner\\cli.js start --config ' + cfg + ' --control';
  return { cmd, mcp: path.join(X, 'runtime', 'kimi-code', 'home', 'mcp.json') };
};
const procTable = cmd => () => [{ pid: 3, name: 'Kimi.exe', commandLine: cmd }];

run([
  ['present(): kimi подключается только при существующей домашней папке; путь не задан — не подключается', () => {
    assert.equal(cc.present({ kind: 'kimi', file }), true, 'есть home → подключается');
    assert.equal(cc.present({ kind: 'kimi', file: path.join(RUN, 'no-such-home', 'mcp.json') }), false, 'нет home → нет');
    assert.equal(cc.present({ kind: 'kimi', file: null }), false, 'путь не задан → нет');
    assert.equal(cc.present({ kind: 'agy', file: __filename }), true, 'прочие — по существованию самого файла');
    assert.equal(cc.present({ kind: 'agy', file }), false, 'прочие — несуществующий файл не подключается');
  }],

  ['task10 Codex7: чат Kimi present, но mcp.json ещё нет — установка берёт снимок как необязательный (создаёт файл), не падает ENOENT', () => {
    reset();
    // present=true (домашняя папка есть), а самого mcp.json ещё нет — как при первом подключении Kimi.
    assert.equal(fs.existsSync(file), false, 'mcp.json ещё нет');
    assert.equal(cc.present({ kind: 'kimi', file }), true, 'home есть → present');
    // Прежний баг (Codex 7): deploy.configureContinuation брал snapshot(p.file) БЕЗ признака необязательного файла — ENOENT.
    assert.throws(() => d.snapshot(file), /ENOENT/, 'снимок без optional падает на отсутствующем mcp.json (прежний баг)');
    // Исправлено: установка клиентов берёт snapshot(p.file, p.kind==='kimi') — план на создание нового файла, без падения.
    const plans = cc.plans([{ ...d.snapshot(file, true), kind: 'kimi', client: 'kimi' }], A, root, state, node);
    assert.equal(plans.length, 1); assert.equal(plans[0].exists, false, 'план на создание нового mcp.json');
    reset();
  }],

  ['Создание с нуля: файла нет — пишутся все серверы связки с нужными полями', async () => {
    reset();
    const plans = cc.plans([snap()], A, root, state, node);
    assert.equal(plans.length, 1); assert.equal(plans[0].exists, false, 'файла не было');
    assert.equal(plans[0].backup, false, 'для нового файла резерв не нужен');
    await d.switchConfigs(plans);
    const cfg = read(file);
    for (const n of SERVERS) {
      const e = cfg.mcpServers[n];
      assert(e, 'сервер ' + n + ' записан');
      assert.equal(e.command, node, n + ': command=node');
      assert.deepEqual(e.args, [path.join(A, 'servers', n, 'index.js')], n + ': args');
      assert.deepEqual(e.env, { MOST_REPO_ROOT: root, MOST_STATE_DIR: state, MOST_CLIENT: 'kimi' }, n + ': env');
      assert.equal(e.enabled, true); assert.equal(e.deferred, false); assert.equal(e.startupTimeoutMs, 30000);
    }
    reset();
  }],

  ['Сохранение посторонних записей и ключей пользователя', async () => {
    reset();
    fs.writeFileSync(file, JSON.stringify({ someKey: { keep: 1 }, mcpServers: { foreignUser: { command: 'x', args: ['y'] } } }));
    await d.switchConfigs(cc.plans([snap()], A, root, state, node));
    const cfg = read(file);
    assert.deepEqual(cfg.someKey, { keep: 1 }, 'посторонний ключ сохранён');
    assert.deepEqual(cfg.mcpServers.foreignUser, { command: 'x', args: ['y'] }, 'посторонний сервер сохранён');
    for (const n of SERVERS) assert(cfg.mcpServers[n], 'сервер связки ' + n + ' добавлен');
    reset();
  }],

  ['Одноимённый чужой сервер (не наш) → отказ, файл не изменён', () => {
    reset();
    const other = SERVERS[0];
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { [other]: { command: 'alien.exe', args: ['--run'] } } }));
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => cc.plans([snap()], A, root, state, node), /Чужие записи подключений/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'файл не тронут при отказе');
    reset();
  }],

  ['Откат к «файла не было»: сбой установки удаляет созданный файл', async () => {
    reset();
    const other = path.join(RUN, 'kimi-other.json'); fs.writeFileSync(other, JSON.stringify({ x: 0 }));
    const kimiPlan = cc.plans([snap()], A, root, state, node)[0];
    const dummy = { ...d.snapshot(other), next: JSON.stringify({ x: 1 }) + '\n', backup: false };
    await assert.rejects(d.switchConfigs([kimiPlan, dummy], async label => { if (label === 'config2') throw Error('сбой'); }));
    assert.equal(fs.existsSync(file), false, 'созданный файл удалён (вернулось «файла не было»)');
    assert.equal(fs.existsSync(file + '.prev'), false, 'и резерва не осталось');
    reset();
  }],

  ['Повторная установка идемпотентна (того же выпуска): плана нет', async () => {
    reset();
    await d.switchConfigs(cc.plans([snap()], A, root, state, node));
    assert.deepEqual(cc.plans([snap()], A, root, state, node), [], 'повтор того же выпуска — изменений нет');
    reset();
  }],

  ['Смена выпуска обновляет пути args; резерв .prev создаётся', async () => {
    reset();
    await d.switchConfigs(cc.plans([snap()], A, root, state, node));
    const plansB = cc.plans([snap()], B, root, state, node);
    assert.equal(plansB.length, 1); assert.equal(plansB[0].backup, true, 'смена выпуска → резерв');
    await d.switchConfigs(plansB);
    const cfg = read(file);
    for (const n of SERVERS) assert.deepEqual(cfg.mcpServers[n].args, [path.join(B, 'servers', n, 'index.js')], n + ': путь выпуска B');
    assert(fs.existsSync(file + '.prev'), 'резерв .prev есть');
    assert.deepEqual(read(file + '.prev').mcpServers[SERVERS[0]].args, [path.join(A, 'servers', SERVERS[0], 'index.js')], 'в резерве — выпуск A');
    reset();
  }],

  ['resolve: приоритет (а)client_config > (б)env > (в)сохранённое > (г)процесс', () => {
    clearKimi();
    const a = home(), b = home(), c = home(), dproc = procHome();
    kc.save(state, c.file, 'test');                            // (в)
    process.env.MOST_KIMI_MCP_CONFIG = b.file;                 // (б)
    const deps = { includeLive: true, processes: procTable(dproc.cmd) };  // (г)
    assert.equal(kc.resolve({ adapter_params: { client_config: a.file } }, state, deps).source, 'client_config');
    assert.equal(kc.resolve({ adapter_params: {} }, state, deps).source, 'env');
    delete process.env.MOST_KIMI_MCP_CONFIG;
    assert.equal(kc.resolve({ adapter_params: {} }, state, deps).source, 'saved');
    try { fs.unlinkSync(savedFile); } catch {}
    const r = kc.resolve({ adapter_params: {} }, state, deps);
    assert.equal(r.source, 'process'); assert.equal(r.file, dproc.mcp, 'путь выведен из командной строки');
    clearKimi();
  }],

  ['resolve: кандидат без существующей домашней папки отвергается — берётся следующий', () => {
    clearKimi();
    const good = home();
    kc.save(state, good.file, 'test');                                       // (в) home существует
    process.env.MOST_KIMI_MCP_CONFIG = path.join(RUN, 'no-home-' + Date.now(), 'mcp.json'); // (б) home нет
    assert.equal(kc.resolve({ adapter_params: {} }, state, {}).source, 'saved', 'env без home пропущен → сохранённое');
    try { fs.unlinkSync(savedFile); } catch {}
    const r = kc.resolve({ adapter_params: {} }, state, {});
    assert.equal(r.found, false, 'ни одного кандидата с home');
    assert.equal(r.file, process.env.MOST_KIMI_MCP_CONFIG, 'путь высшего приоритета — для предупреждения');
    clearKimi();
  }],

  ['Источник (г): настольный Kimi по таблице процессов; консольный kimi.exe поручения игнорируется', () => {
    clearKimi();
    const X = fs.mkdtempSync(path.join(RUN, 'kx-'));
    fs.mkdirSync(path.join(X, 'runtime', 'kimi-code', 'home'), { recursive: true });
    const cfg = path.join(X, 'config.json');
    // Формы командных строк — из E:\Codex\work\v58-origin-probe\report2.md (раздел Kimi) и research v58-kimi-chat.
    const gate = 'E:\\Kimi\\Kimi.exe -e "<DaimonStartGate>" E:\\KimiData\\daimon-bundle\\app\\daimon\\dist\\src\\runner\\cli.js start --config ' + cfg + ' --control';
    const exec = 'C:\\Users\\user\\.kimi-code\\bin\\kimi.exe -m kimi-code/k3.1-pro -p "задача"';
    assert.equal(kc.fromProcesses({ processes: () => [{ pid: 2, name: 'kimi.exe', commandLine: exec }, { pid: 3, name: 'Kimi.exe', commandLine: gate }] }),
      path.join(X, 'runtime', 'kimi-code', 'home', 'mcp.json'));
    assert.equal(kc.fromProcesses({ processes: () => [{ pid: 2, name: 'kimi.exe', commandLine: exec }] }), null, 'консольный исполнитель — не источник пути');
    clearKimi();
  }],

  ['Сохранение и повторное использование без процесса Kimi и без переменной', () => {
    clearKimi();
    const p = procHome();                                                    // «нашли по живому процессу»
    let r = kc.capture(state, { adapter_params: {} }, { processes: procTable(p.cmd) });
    assert.equal(r.source, 'process'); assert.equal(readSaved(), p.mcp, 'путь запомнен');
    r = kc.resolve({ adapter_params: {} }, state, { includeLive: true, processes: () => [] });  // ни процесса, ни env
    assert.equal(r.source, 'saved'); assert.equal(r.file, p.mcp, 'переживает отсутствие Kimi и переменной');
    clearKimi();
  }],

  ['Установка с MOST_KIMI_MCP_CONFIG: создаёт mcp.json и запоминает путь', async () => {
    clearKimi();
    const h = home();
    process.env.MOST_KIMI_MCP_CONFIG = h.file;
    kc.capture(state);                                                       // начало установки: путь находится сам и запоминается
    assert.equal(readSaved(), h.file, 'путь запомнен в state\\kimi-client.json');
    const kimiPaths = cc.paths().filter(p => p.kind === 'kimi');             // код, пишущий настройки клиентов
    assert.equal(kimiPaths.length, 1); assert.equal(kimiPaths[0].file, h.file);
    assert.equal(cc.present(kimiPaths[0]), true, 'подключается (home существует)');
    assert.deepEqual(cc.connected(), ['чат Kimi подключён: ' + h.file]);
    await d.switchConfigs(cc.plans(kimiPaths.map(p => ({ ...d.snapshot(p.file, true), kind: p.kind, client: p.client })), A, root, state, node));
    const cfg = read(h.file);
    for (const n of SERVERS) assert(cfg.mcpServers[n], 'сервер ' + n + ' записан в mcp.json');
    try { fs.unlinkSync(h.file); } catch {}
    clearKimi();
  }],
]);
