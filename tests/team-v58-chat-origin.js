'use strict';
// team-v58-any-chat, часть Г: права чата — ТОЛЬКО по доказанному происхождению (common/chat-origin.js, замысел §1).
// Подстановка таблицы процессов и записей — через внутренние зависимости (chat-origin.setTest/withOrigin, decide), НЕ через
// переменные окружения, которые мог бы задать сам процесс. Проверяются все четыре условия раздела 1 и «Опасные случаи» п.1.
const assert = require('assert');
const { run, RUN } = require('./team-v16-fixture');
const fs = require('fs'), path = require('path');
const co = require('../common/chat-origin');
const access = require('../common/access');
const members = require('../common/members');
const paths = require('../common/paths');

function withEnv(env, fn) {
  const save = {};
  for (const k of Object.keys(env)) { save[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(save)) { if (save[k] === undefined) delete process.env[k]; else process.env[k] = save[k]; } }
}
// Удобные строители цепочек предков (таблица процессов): self → parents… до корня.
const T = rows => rows;
const node = (pid, ppid, startedAt) => ({ pid, ppid, name: 'node.exe', startedAt });
const app = (pid, ppid, name, startedAt) => ({ pid, ppid, name, startedAt });
const t0 = '2026-11-18T10:00:00.000Z';
const at = s => '2026-11-18T10:00:' + String(s).padStart(2, '0') + '.000Z';

// Настоящий чат каждого из пяти клиентов: сервер(1) ← приложение-клиента(2) ← explorer(3).
const CLIENT_NAMES = { claude: 'Claude.exe', codex: 'codex.exe', antigravity: 'Antigravity.exe', deepseek: 'deepseek-harness.exe', kimi: 'kimi.exe' };
function chatChain(clientName, serverStart = at(3), clientStart = at(1)) {
  return T([node(1, 2, serverStart), app(2, 3, clientName, clientStart), app(3, 0, 'explorer.exe', '2026-11-18T09:00:00.000Z')]);
}

run([
  ['Условие 2: настоящий чат каждого из пяти клиентов — права чата есть', () => {
    for (const id of ['claude', 'codex', 'antigravity', 'deepseek', 'kimi']) {
      const d = co.decide({ table: chatChain(CLIENT_NAMES[id]), selfPid: 1 });
      assert.equal(d.chat, true, id + ': ' + d.reason);
      assert.equal(d.client.id, id, 'опознан клиент ' + id);
    }
  }],
  ['Условие 2: клиент опознаётся и по командной строке (общий интерпретатор node/python)', () => {
    const d = co.decide({ table: T([node(1, 2, at(3)),
      { pid: 2, ppid: 3, name: 'python.exe', startedAt: at(1), commandLine: 'python C:\\\\Users\\\\x\\\\deepseek-harness\\\\run.py' },
      app(3, 0, 'explorer.exe', t0)]), selfPid: 1 });
    assert.equal(d.chat, true, d.reason);
    assert.equal(d.client.id, 'deepseek');
  }],
  ['Условие 3: имя участника от потомка исполнителя (среди предков сервер моста) — отказ', () => {
    // сервер(1) ← исполнитель codex(2) ← сервер team(3) ← клиент(4)
    const d = co.decide({ table: T([node(1, 2, at(6)), app(2, 3, 'codex.exe', at(5)), node(3, 4, at(2)), app(4, 0, 'Claude.exe', at(1))]),
      selfPid: 1, servers: [{ name: 'team', pid: 3, startedAt: at(2) }] });
    assert.equal(d.chat, false);
    assert.match(d.reason, /сервер моста/);
  }],
  ['Условие 3: предок — исполнитель поручения (по записи запуска) — отказ', () => {
    const d = co.decide({ table: T([node(1, 2, at(6)), app(2, 3, 'codex.exe', at(5)), app(3, 0, 'Claude.exe', at(1))]),
      selfPid: 1, executors: [{ pid: 2, startedAt: at(5) }] });
    assert.equal(d.chat, false);
    assert.match(d.reason, /исполнитель/);
  }],
  ['Условие 3: гонка на старте — среди предков сервер моста, записи об исполнителе ещё нет — отказ', () => {
    // executors пуст (карточка исполнителя ещё не записана), но предок-сервер team ловит поручение.
    const d = co.decide({ table: T([node(1, 2, at(6)), app(2, 3, 'codex.exe', at(5)), node(3, 4, at(2)), app(4, 0, 'Claude.exe', at(1))]),
      selfPid: 1, servers: [{ name: 'team', pid: 3, startedAt: at(2) }], executors: [] });
    assert.equal(d.chat, false);
    assert.match(d.reason, /сервер моста/);
  }],
  ['Условие 3: вложенный запуск настоящего клиента из поручения — поиск сервера-предка не стоп на первом клиенте — отказ', () => {
    // сервер(1) ← настоящий claude(2) ← исполнитель codex(3) ← сервер team(4) ← внешний клиент(5)
    const d = co.decide({ table: T([node(1, 2, at(6)), app(2, 3, 'Claude.exe', at(5)), app(3, 4, 'codex.exe', at(4)), node(4, 5, at(2)), app(5, 0, 'codex.exe', at(1))]),
      selfPid: 1, servers: [{ name: 'team', pid: 4, startedAt: at(2) }] });
    assert.equal(d.chat, false, 'вложенный клиент из поручения — не чат');
    assert.match(d.reason, /сервер моста/);
  }],
  ['Условие 1: промежуточный родитель завершился (оборванная цепочка) — отказ', () => {
    const d = co.decide({ table: T([node(1, 777, at(5))]), selfPid: 1 }); // родитель 777 отсутствует в таблице
    assert.equal(d.chat, false);
    assert.match(d.reason, /оборван/);
  }],
  ['Условие 1: PID предка использован повторно (время позже потомка) — отказ', () => {
    const d = co.decide({ table: T([node(1, 2, at(1)), app(2, 3, 'Claude.exe', at(9)), app(3, 0, 'explorer.exe', t0)]), selfPid: 1 });
    assert.equal(d.chat, false);
    assert.match(d.reason, /переиспользованн/);
  }],
  ['Условие 1: родитель и потомок созданы в один момент — ложного отказа нет', () => {
    const d = co.decide({ table: T([node(1, 2, at(1)), app(2, 3, 'Claude.exe', at(1)), app(3, 0, 'explorer.exe', at(1))]), selfPid: 1 });
    assert.equal(d.chat, true, d.reason);
  }],
  ['Условие 2: цепочка не доходит до приложения-клиента — отказ', () => {
    const d = co.decide({ table: T([node(1, 2, at(3)), app(2, 3, 'bash.exe', at(2)), app(3, 3, 'services.exe', t0)]), selfPid: 1 });
    assert.equal(d.chat, false);
    assert.match(d.reason, /не доходит до приложения-клиента/);
  }],
  ['Таблица процессов не читается (пустая) — отказ', () => {
    assert.equal(co.decide({ table: [], selfPid: 1 }).chat, false);
    assert.match(co.decide({ table: [], selfPid: 1 }).reason, /таблица процессов не прочитана/);
    assert.equal(co.decide({ table: [node(1, 2, at(3))], selfPid: 5 }).chat, false); // своего процесса нет в таблице
  }],
  ['После установки/перезапуска серверов — записи готовности чужих серверов НЕ среди предков — права есть', () => {
    // Чат claude: его предки — клиент и explorer; записи готовности team/codex указывают на другие PID (не предки) — чат.
    const d = co.decide({ table: chatChain('Claude.exe'), selfPid: 1,
      servers: [{ name: 'team', pid: 900, startedAt: at(1) }, { name: 'codex', pid: 901, startedAt: at(1) }] });
    assert.equal(d.chat, true, d.reason);
  }],
  ['Сервер не принимает собственную запись готовности за предка (self исключён)', () => {
    // Запись готовности с PID самого сервера (1) не должна делать его «предком-сервером»: проверяются строго родитель и выше.
    const d = co.decide({ table: chatChain('Claude.exe'), selfPid: 1, servers: [{ name: 'team', pid: 1, startedAt: at(3) }] });
    assert.equal(d.chat, true, d.reason);
  }],

  ['serverRecords: читает state\\ready\\<server>.json (PID + время запуска)', () => {
    const dir = path.join(paths.stateDir, 'ready');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({ release: 'r', pid: 4321, startedAt: at(2) }));
    const recs = co.serverRecords();
    assert(recs.some(r => r.name === 'team' && r.pid === 4321), 'запись team прочитана');
    fs.rmSync(path.join(dir, 'team.json'));
  }],
  ['executorRecords: карточки ЛЮБОГО статуса (завершённая карточка, процесс жив) — PID исполнителя в записях', () => {
    const dir = path.join(paths.stateDir, 'codex-jobs');
    fs.mkdirSync(dir, { recursive: true });
    const id = 'job-origin-' + Date.now();
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, status: 'done', pid: 55501, startedAt: at(2) }));
    co.reset();
    const recs = co.executorRecords();
    assert(recs.some(r => r.pid === 55501), 'PID завершённой карточки присутствует (хранится до остановки дерева, не до статуса)');
    fs.rmSync(path.join(dir, id + '.json'));
    co.reset();
  }],

  ['access.chatSession опирается на chat-origin: доказано — чат; не доказано — права поручения', () => {
    for (const client of ['codex', 'antigravity', 'deepseek', 'claude', 'kimi']) {
      withEnv({ MOST_CLIENT: client, MOST_JOB_ID: undefined, MOST_AUTHORITY: undefined, MOST_PROBE_ONLY: undefined }, () => {
        co.withOrigin({ decision: { chat: true, reason: '' } }, () => {
          assert.equal(access.chatSession(), true, client + ': доказанный чат');
          assert.equal(access.allowed('team', 'team_change'), true, client + ': team_change открыт');
          assert.equal(access.allowed('team', 'team_members'), true, client + ': team_members открыт');
        });
        co.withOrigin({ decision: { chat: false, reason: 'цепочка предков оборвана' } }, () => {
          assert.equal(access.chatSession(), false, client + ': недоказанный — не чат');
          assert.equal(access.allowed('team', 'team_change'), false, client + ': team_change закрыт');
          assert.equal(access.allowed('team', 'team_members'), false, client + ': team_members закрыт');
          assert.throws(() => access.guard('team', 'team_change', { action: 'merge' }), /запрещено/, client + ': guard team_change отказ');
          assert.throws(() => access.guard('team', 'team_status', { claude_quota: true }), /запрещено/, client + ': диагностика закрыта');
        });
      });
    }
  }],
  ['Признак поручения (MOST_JOB_ID) главнее доказанного происхождения — не чат', () => {
    withEnv({ MOST_CLIENT: 'codex', MOST_JOB_ID: 'job-xyz', MOST_AUTHORITY: undefined }, () => {
      co.withOrigin({ decision: { chat: true, reason: '' } }, () => {
        assert.equal(access.jobSession(), true);
        assert.equal(access.chatSession(), false, 'из поручения прав чата нет даже при доказанной цепочке');
        assert.equal(access.allowed('team', 'team_change'), false);
      });
    });
  }],
  ['Причина невыдачи прав чата доступна строкой (team_status показывает её)', () => {
    withEnv({ MOST_CLIENT: 'codex', MOST_JOB_ID: undefined, MOST_AUTHORITY: undefined }, () => {
      co.withOrigin({ decision: { chat: false, reason: 'цепочка предков оборвана до приложения-клиента' } }, () => {
        assert.equal(access.chatOriginOk(), false);
        assert.match(access.chatOriginReason(), /оборвана/);
        // Условие строки team_status (та же проверка, что в common/team.js status()).
        const show = !access.jobSession() && access.registeredMember(access.client()) && !access.chatOriginOk();
        assert.equal(show, true, 'строка причины показывается');
      });
    });
  }],
  ['guestTools остаётся полным (offered-набор для грантов в настройках), origin гейтит только allowed/guard', () => {
    withEnv({ MOST_CLIENT: 'codex', MOST_JOB_ID: undefined, MOST_AUTHORITY: undefined }, () => {
      co.withOrigin({ decision: { chat: false, reason: 'нет цепочки' } }, () => {
        // Объявленный набор (для client-configs.grantsFor) — полный, даже без доказанного происхождения боевого процесса.
        assert(access.guestTools('team', 'codex').includes('team_change'), 'offered-набор полон');
        // Но боевое право закрыто.
        assert.equal(access.allowed('team', 'team_change'), false);
      });
    });
  }],

  // --- Дополнение дирижёра (task5, пп. 5–7) ---
  ['п.5: предок — сервер моста по командной строке (node …\\servers\\<имя>\\index.js) без записи готовности — отказ', () => {
    const d = co.decide({ table: T([node(1, 2, at(6)),
      { pid: 2, ppid: 3, name: 'node.exe', startedAt: at(5), commandLine: 'node E:/most/.work/clone/servers/team/index.js' },
      app(3, 0, 'Claude.exe', at(1))]), selfPid: 1, servers: [], executors: [] });
    assert.equal(d.chat, false, 'сервер-предок по командной строке без записи готовности — не чат');
    assert.match(d.reason, /сервер моста/);
  }],
  ['п.5: записи готовности на экземпляр (<server>.<pid>.json) и общий файл читаются; устаревшие на экземпляр чистятся при чтении', () => {
    const dir = path.join(paths.stateDir, 'ready');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({ pid: 555, startedAt: at(1) }));                            // общий — совместимость
    fs.writeFileSync(path.join(dir, 'team.' + process.pid + '.json'), JSON.stringify({ pid: process.pid, startedAt: at(1) })); // экземпляр, процесс жив
    const dead = path.join(dir, 'team.2147483000.json');
    fs.writeFileSync(dead, JSON.stringify({ pid: 2147483000, startedAt: at(1) }));                                           // экземпляр, процесс мёртв
    const recs = co.serverRecords();
    assert(recs.some(r => r.pid === 555), 'общий <server>.json читается');
    assert(recs.some(r => r.pid === process.pid), 'запись на экземпляр читается (два экземпляра — оба в записях)');
    assert(!recs.some(r => r.pid === 2147483000), 'устаревшая запись на экземпляр в выдачу не попадает');
    assert(!fs.existsSync(dead), 'устаревшая запись на экземпляр удалена при чтении');
    fs.rmSync(path.join(dir, 'team.json')); fs.rmSync(path.join(dir, 'team.' + process.pid + '.json'));
  }],
  ['п.5: исполнитель от «второго» экземпляра сервера (его запись среди предков) — отказ в правах чата', () => {
    // Исполнитель(1) ← сервер-team экземпляра клиента B(2, PID 2) ← клиент B(3). Запись готовности second-экземпляра — pid 2.
    const d = co.decide({ table: T([node(1, 2, at(6)), node(2, 3, at(2)), app(3, 0, 'codex.exe', at(1))]),
      selfPid: 1, servers: [{ name: 'team', pid: 900, startedAt: at(2) }, { name: 'team', pid: 2, startedAt: at(2) }] });
    assert.equal(d.chat, false, 'предок — второй экземпляр сервера team');
    assert.match(d.reason, /сервер моста/);
  }],
  ['п.6: MOST_TEST_CHAT_ORIGIN действует только с временным состоянием прогона (настоящее состояние моста/клон — нет)', () => {
    const tmpRepo = RUN, tmpState = path.join(RUN, 'state');
    const realClone = path.resolve(__dirname, '..');            // клон вне tests\.tmp-*
    const cloneState = path.join(realClone, 'state');            // НЕвременное состояние клона
    const realState = path.join('E:', 'most', 'state');          // настоящее состояние моста
    withEnv({ MOST_TEST_CHAT_ORIGIN: 'proven', MOST_REPO_ROOT: tmpRepo, MOST_STATE_DIR: tmpState }, () =>
      assert.equal(co.honoursEnv(), true, 'временный выпуск + временное состояние — действует'));
    withEnv({ MOST_TEST_CHAT_ORIGIN: 'proven', MOST_REPO_ROOT: realClone, MOST_STATE_DIR: cloneState }, () =>
      assert.equal(co.honoursEnv(), false, 'клон вне tests\\.tmp-* с его НЕвременным состоянием — не действует'));
    withEnv({ MOST_TEST_CHAT_ORIGIN: 'proven', MOST_REPO_ROOT: tmpRepo, MOST_STATE_DIR: realState }, () =>
      assert.equal(co.honoursEnv(), false, 'настоящее состояние моста — не действует'));
    withEnv({ MOST_TEST_CHAT_ORIGIN: 'proven', MOST_REPO_ROOT: realClone, MOST_STATE_DIR: tmpState }, () =>
      assert.equal(co.honoursEnv(), true, 'in-process набор (клон-код + временное состояние) — действует'));
    withEnv({ MOST_TEST_CHAT_ORIGIN: undefined, MOST_REPO_ROOT: tmpRepo, MOST_STATE_DIR: tmpState }, () =>
      assert.equal(co.honoursEnv(), false, 'без переменной — не действует'));
  }],
  ['п.7: допуск sameProc сужен до нескольких секунд (запись исполнителя: в пределах 5 с — тот же процесс, дальше — нет)', () => {
    const chain = T([node(1, 2, at(1)), app(2, 3, 'Claude.exe', at(1)), app(3, 0, 'explorer.exe', t0)]);
    assert.equal(co.decide({ table: chain, selfPid: 1, executors: [{ pid: 2, startedAt: at(4) }] }).chat, false, '3 с — тот же процесс (исполнитель) → отказ');
    assert.equal(co.decide({ table: chain, selfPid: 1, executors: [{ pid: 2, startedAt: at(15) }] }).chat, true, '14 с — переиспользованный PID, не тот же процесс → предок-клиент, чат есть');
  }],

  // --- Часть Д (task6 п.4): настоящий чат настольного Kimi и сервер под консольным kimi.exe поручения ---
  // Имена и командные строки — из E:\Codex\work\v58-origin-probe\report2.md (раздел Kimi) и research v58-kimi-chat:
  // цепочка чата — node …\servers\<имя>\index.js → Kimi.exe (gate: -e … runner\cli.js start --control) → Kimi.exe (главный);
  // исполнитель поручений Kimi моста — ОТДЕЛЬНЫЙ консольный kimi.exe (common\kimi-launch.js: …\.kimi-code\bin\kimi.exe).
  ['п.4 (Д): чат настольного Kimi (node сервер ← Kimi.exe gate ← Kimi.exe главный) — опознан клиент kimi, права чата есть', () => {
    const gateCmd = 'E:\\Kimi\\Kimi.exe -e "<DaimonStartGate>" E:\\KimiData\\daimon-bundle\\app\\daimon\\dist\\src\\runner\\cli.js start --config E:\\KimiData\\daimon-share\\daimon\\config.json --control';
    const d = co.decide({ table: T([
      { pid: 1, ppid: 2, name: 'node.exe', startedAt: at(37), commandLine: 'node E:\\most\\live\\' + 'a'.repeat(40) + '\\servers\\kimi\\index.js' },
      { pid: 2, ppid: 3, name: 'Kimi.exe', startedAt: at(37), commandLine: gateCmd },
      { pid: 3, ppid: 4, name: 'Kimi.exe', startedAt: at(30), commandLine: '"E:\\Kimi\\Kimi.exe" ' },
      app(4, 0, 'explorer.exe', t0)]), selfPid: 1 });
    assert.equal(d.chat, true, d.reason);
    assert.equal(d.client.id, 'kimi', 'предок Kimi.exe (gate настольного приложения) опознан как клиент kimi');
  }],
  ['п.4 (Д): сервер под консольным kimi.exe поручения (исполнитель, не настольный Kimi) — запись исполнителя, не чат', () => {
    // Исполнитель моста — консольный …\.kimi-code\bin\kimi.exe (его PID в карточке kimi-jobs → executorRecords). Он совпадает с
    // распознавателем клиента по имени, но запись исполнителя проверяется РАНЬШЕ распознавания клиента: сервер под ним — не чат.
    const execCmd = 'C:\\Users\\user\\.kimi-code\\bin\\kimi.exe -m kimi-code/k3.1-pro-highspeed --output-format stream-json --agent-file E:\\most\\state\\kimi-jobs\\job-k\\most-reader.md -p "Прочитай файл most-kimi-task-job-k.md в текущей папке и выполни поручение. Ответ дай по-русски"';
    const d = co.decide({ table: T([
      { pid: 1, ppid: 2, name: 'node.exe', startedAt: at(6), commandLine: 'node E:\\most\\live\\' + 'a'.repeat(40) + '\\servers\\codex\\index.js' },
      { pid: 2, ppid: 3, name: 'kimi.exe', startedAt: at(5), commandLine: execCmd },
      app(3, 0, 'Claude.exe', at(1))]),
      selfPid: 1, executors: [{ pid: 2, startedAt: at(5) }] });
    assert.equal(d.chat, false, 'сервер под консольным kimi.exe поручения — не чат');
    assert.match(d.reason, /исполнитель/);
  }],
  // --- task10 в: перепроверка живости/состава — только ДО приложения-клиента включительно ---
  ['task10 в: ancestors — только до приложения-клиента; процессы ВЫШЕ клиента (explorer) в перепроверку не входят', () => {
    const d = co.decide({ table: chatChain('Claude.exe'), selfPid: 1 });
    assert.equal(d.chat, true, d.reason);
    assert.deepEqual(d.ancestors.map(a => a.pid), [2], 'запомнен только клиент(2); explorer(3) не запоминается');
    // revalidate: explorer(3) не среди ancestors, значит его «смерть» не проверяется и прав не снимает; клиент(2) жив (self-процесс
    // теста как PID не совпадает, поэтому подставим живого предка через setTest-ввод невозможно — проверяем состав ancestors).
    assert(!d.ancestors.some(a => a.pid === 3), 'explorer(3) исключён из перепроверки живости');
  }],
  ['task10 в: сервер-предок ВЫШЕ клиента по-прежнему ловится (условие 3 сканирует всю цепочку), но в ancestors его нет', () => {
    // сервер(1) ← клиент codex(2) ← сервер team(3) ← внешний клиент(4): это поручение (сервер выше клиента) — отказ.
    const d = co.decide({ table: T([node(1, 2, at(6)), app(2, 3, 'codex.exe', at(5)), node(3, 4, at(2)), app(4, 0, 'Claude.exe', at(1))]),
      selfPid: 1, servers: [{ name: 'team', pid: 3, startedAt: at(2) }] });
    assert.equal(d.chat, false, 'сервер моста выше клиента — не чат');
    assert.match(d.reason, /сервер моста/);
  }],
  // --- task10 б: боевая проверка происхождения берёт только настоящую таблицу (подмену окружением не учитывает) ---
  ['task10 б: liveTable игнорирует MOST_TEST_PROCESS_TREE (боевая таблица — native), подстановка через окружение не даёт чат', () => {
    // Собираем «вражескую» таблицу-подмену: сервер(self) ← Claude.exe(2) ← explorer — как будто настоящий чат.
    const spoof = JSON.stringify([{ pid: 'self', ppid: 2, name: 'node.exe', startedAt: at(3) },
      { pid: 2, ppid: 3, name: 'Claude.exe', startedAt: at(1) }, { pid: 3, ppid: 0, name: 'explorer.exe', startedAt: t0 }]);
    const fallback = require('../common/fallback');
    withEnv({ NODE_ENV: 'test', MOST_TEST_PROCESS_TREE: spoof }, () => {
      // fallback.processTable без native отдаёт подмену…
      assert(fallback.processTable(true, { commandLine: true }).some(r => r.name === 'Claude.exe'), 'подмена действует без native');
      // …а с native:true (как в chat-origin.liveTable) — НЕ отдаёт подмену: реальная таблица процессов без Claude.exe-предка.
      const native = fallback.processTable(true, { commandLine: true, native: true });
      assert(!native.some(r => r.name === 'Claude.exe' && r.pid === 2 && r.ppid === 3), 'native-таблица подмену не содержит');
    });
  }],
  // --- task10 а: слово владельца — только из доказанного чата; недоказанный сеанс (не поручение) — отказ ---
  ['task10 а: недоказанный сеанс (не поручение, нет происхождения) слово владельца не пишет — stop_confirm/close/release_orphan', async () => {
    const words = require('../common/user-word');
    const savedClient = process.env.MOST_CLIENT, savedJob = process.env.MOST_JOB_ID, savedAuth = process.env.MOST_AUTHORITY, savedProbe = process.env.MOST_PROBE_ONLY;
    process.env.MOST_CLIENT = 'codex'; delete process.env.MOST_JOB_ID; delete process.env.MOST_AUTHORITY; delete process.env.MOST_PROBE_ONLY;
    // setTest держит подстановку происхождения через все await (в отличие от withOrigin, который снимает её синхронно).
    co.setTest({ decision: { chat: false, reason: 'цепочка предков оборвана' } });
    try {
      assert.equal(access.jobSession(), false, 'не поручение');
      assert.equal(access.chatSession(), false, 'происхождение не доказано');
      // Промисы создаются синхронно, пока подстановка «не чат» активна: синхронный пролог каждой функции записи бросает отказ.
      const calls = [words.recordStopConfirmation(['job-nd-0001'], 'нет'), words.recordJobClose(['job-nd-0001'], 'нет'),
        words.recordOrphanRelease('i'.repeat(12), 'job-nd-0001', 'E:\\x', 'нет')];
      for (const p of calls) await assert.rejects(p, /происхождение чата не доказано/);
    } finally { co.clearTest(); }
    // Доказанный чат тех же данных — пишет (source chat-codex).
    co.setTest({ decision: { chat: true, reason: '' } });
    try {
      const rec = await words.recordStopConfirmation(['job-nd-0002'], 'снять', async r => r);
      assert.equal(rec.source, 'chat-codex', 'доказанный чат пишет слово');
    } finally {
      co.clearTest();
      for (const [k, v] of [['MOST_CLIENT', savedClient], ['MOST_JOB_ID', savedJob], ['MOST_AUTHORITY', savedAuth], ['MOST_PROBE_ONLY', savedProbe]])
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }],
  // --- task10 г: запись готовности на экземпляр пишется и для сервера, запущенного чатом не-Claude (guest) ---
  ['task10 г: ready() пишет <server>.<pid>.json для чата не-Claude (kimi/codex-гость), прежний гейт guest() снят', () => {
    const dir = path.join(paths.stateDir, 'ready');
    fs.mkdirSync(dir, { recursive: true });
    withEnv({ MOST_CLIENT: 'kimi', MOST_JOB_ID: undefined, MOST_AUTHORITY: undefined, MOST_PROBE_ONLY: undefined }, () => {
      assert.equal(access.guest(), true, 'kimi — гость (не дирижёр Claude)');
      access.ready('codex'); // не team, чтобы не трогать фоновый kimi-client.capture
      const inst = path.join(dir, 'codex.' + process.pid + '.json');
      assert(fs.existsSync(inst), 'запись на экземпляр записана и для чата kimi');
      assert.equal(JSON.parse(fs.readFileSync(inst, 'utf8')).pid, process.pid);
      fs.rmSync(inst, { force: true }); fs.rmSync(path.join(dir, 'codex.json'), { force: true });
    });
  }],
  // Регресс сборки v58 (report9): пробный запуск выпуска идёт из процесса node УСТАНОВЩИКА, а не из приложения-клиента, поэтому
  // доказанного происхождения чата у серверов пробы НЕТ — и не должно быть (проба прав чата не получает). До исправления
  // common/access.offered серверы регистрировали инструменты по боевому allowed(): без прав чата у собственного сервера участника
  // (codex для claude) набор пуст → сервер не объявлял инструментов → listTools отвечал MethodNotFound (-32601) → сборка падала.
  // Существующие deploy-тесты это не ловили: тестовый раннер ставит MOST_TEST_CHAT_ORIGIN=proven, и серверы пробы получали права
  // чата (полный набор). Здесь ставим НЕ-чат (MOST_TEST_CHAT_ORIGIN='job'; состояние пробы под tests\.tmp- → honoursEnv истинно,
  // поэтому подстановка детерминирована независимо от того, из какого приложения запущены тесты) и проверяем, что проба проходит.
  ['Регресс: пробный запуск выпуска из НЕ-чата проходит (нет -32601; гостевые наборы совпадают)', async () => {
    const deploy = require('../common/deploy');
    const CODE = path.resolve(__dirname, '..'); // рабочее дерево клона = выпуск (настоящие серверы и common)
    const base = fs.mkdtempSync(path.join(RUN, 'probe-nonchat-'));
    const root = path.join(base, 'root'), state = path.join(root, 'state');
    fs.mkdirSync(state, { recursive: true });
    // Ростер по умолчанию (включает codex — именно его сервер без прав чата прежде отдавал пустой набор и ронял пробу в -32601).
    require('../common/members-store').create(state).read({ initialRoster: require('../common/members-default')() });
    const deployState = path.join(base, 'deploy-state'); fs.mkdirSync(deployState, { recursive: true });
    const save = process.env.MOST_TEST_CHAT_ORIGIN;
    process.env.MOST_TEST_CHAT_ORIGIN = 'job'; // серверы пробы — НЕ чат (как в боевой сборке из процесса установщика)
    try {
      // preserveMarker: не писать probe-ok.json в дерево клона; настоящая проба (common/probe) используется.
      await deploy.probeRelease(CODE, root, 'f'.repeat(40), deployState, { preserveMarker: true }, async () => {});
      // Дошли сюда без исключения — обе фазы пробы (объявление инструментов и сверка гостевых наборов) прошли без прав чата.
    } finally {
      if (save === undefined) delete process.env.MOST_TEST_CHAT_ORIGIN; else process.env.MOST_TEST_CHAT_ORIGIN = save;
      try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    }
  }],
]);
