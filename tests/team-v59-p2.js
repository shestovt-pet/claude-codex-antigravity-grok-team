'use strict';
// team-v59 часть 2 (task2): серверы моста отвечают на запуск мгновенно — регистрация инструментов (initialize/tools/list)
// НЕ снимает таблицу процессов (chat-origin), иначе handshake упирается в startup_timeout клиента (Codex терял все инструменты,
// codex-diagnosis.md). Граница не ослаблена: список виден всем, но вызвать инструмент чата можно лишь по доказанному
// происхождению (guard). Плюс: startup_timeout_sec Codex поднят с 30 до 120; происхождение считается лениво/в фоне.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const REPO = path.resolve(__dirname, '..');
const tests = [];
const T = (n, f) => tests.push([n, f]);
function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), 'v59p2-' + p + '-')); }
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

// (1) Регистрация объявляет полный набор дирижёра зарегистрированному участнику-чату БЕЗ доказательства происхождения;
//     поручение/недоказанный сеанс видят тот же список. Право ВЫЗВАТЬ — только по доказанному происхождению (guard).
T('offered показывает набор чата без снимка происхождения; guard гейтит по происхождению', () => {
  const access = require('../common/access');
  const origin = require('../common/chat-origin');
  const saved = { job: process.env.MOST_JOB_ID, client: process.env.MOST_CLIENT };
  delete process.env.MOST_JOB_ID; process.env.MOST_CLIENT = 'codex'; // зарегистрированный участник-чат, не поручение
  try {
    // Доказанный чат: список полный, вызов проходит.
    origin.setTest({ decision: { chat: true, reason: '' } });
    assert.equal(access.offered('team', 'team_members'), true, 'доказанный чат видит team_members');
    assert.equal(access.offered('team', 'team_status'), true, 'team_status виден всегда');
    assert.doesNotThrow(() => access.guard('team', 'team_members', { action: 'list' }), 'доказанный чат вызывает team_members');
    // Недоказанное происхождение: СПИСОК тот же (offered), но ВЫЗОВ инструмента чата — отказ guard.
    origin.setTest({ decision: { chat: false, reason: 'цепочка оборвана' } });
    assert.equal(access.offered('team', 'team_members'), true, 'недоказанный сеанс всё равно видит список (handshake не ждёт происхождения)');
    assert.equal(access.offered('team', 'team_status'), true, 'team_status виден и недоказанному');
    assert.throws(() => access.guard('team', 'team_members', { action: 'list' }), /Гостю это действие запрещено/, 'недоказанный сеанс не может вызвать team_members');
    assert.doesNotThrow(() => access.guard('team', 'team_status', {}), 'team_status зовётся и недоказанным');
  } finally {
    origin.clearTest();
    if (saved.job !== undefined) process.env.MOST_JOB_ID = saved.job; else delete process.env.MOST_JOB_ID;
    if (saved.client !== undefined) process.env.MOST_CLIENT = saved.client; else delete process.env.MOST_CLIENT;
  }
});

// (2) Ключевое: загрузка серверного модуля и регистрация инструментов НЕ снимают таблицу процессов (PowerShell/CIM).
//     Проверяем в дочернем процессе с ВЫКЛЮЧЕННОЙ тестовой подменой происхождения (MOST_TEST_CHAT_ORIGIN снят): тогда, если бы
//     offered/register трогали chat-origin, пошёл бы реальный снимок — его перехватываем счётчиком. Ожидаем 0 вызовов.
T('регистрация инструментов не снимает таблицу процессов (handshake мгновенный)', () => {
  const state = tmp('noproc');
  try {
    const code = `
      const fallback = require(${JSON.stringify(path.join(REPO, 'common', 'fallback.js'))});
      let calls = 0; const real = fallback.processTable; fallback.processTable = function(){ calls++; return []; };
      require(${JSON.stringify(path.join(REPO, 'servers', 'team', 'index.js'))});
      process.stdout.write(JSON.stringify({ calls }));
    `;
    const env = { ...process.env, MOST_STATE_DIR: state, MOST_REPO_ROOT: REPO, MOST_CLIENT: 'codex', MOST_JOB_ID: '', NODE_OPTIONS: '' };
    delete env.MOST_TEST_CHAT_ORIGIN; // без подмены — боевой путь chat-origin пошёл бы к processTable, если бы его позвали
    const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', windowsHide: true, env });
    const r = JSON.parse(out.trim());
    assert.equal(r.calls, 0, 'при регистрации таблица процессов не снимается ни разу (факт ' + r.calls + ')');
  } finally { rmrf(state); }
});

// (3) Фоновое вычисление происхождения (primeAsync) заполняет кэш без блокировки событийного цикла; под тестовой подменой —
//     не нужно (noop). Проверяем, что primeAsync при подставленном входе-таблице строит решение в built и дальнейший ok() его берёт.
T('chat-origin.primeAsync заполняет кэш из асинхронной таблицы, ok() берёт его', async () => {
  const origin = require('../common/chat-origin');
  origin.clearTest();
  const savedEnv = process.env.MOST_TEST_CHAT_ORIGIN; delete process.env.MOST_TEST_CHAT_ORIGIN;
  try {
    // Подставная асинхронная таблица: сервер (self, живой) → приложение-клиента codex (его РОДИТЕЛЬ, тоже живой — иначе
    // revalidate снял бы право по мёртвому предку). Доказанная цепочка.
    const now = new Date().toISOString(), earlier = new Date(Date.now() - 10000).toISOString();
    origin.setAsyncTableForTest(async () => [
      { pid: process.pid, ppid: process.ppid, name: 'node.exe', startedAt: now, commandLine: 'node servers/team/index.js' },
      { pid: process.ppid, ppid: 1, name: 'codex.exe', startedAt: earlier, commandLine: 'C:/codex/codex.exe' },
    ]);
    origin.reset();
    await origin.primeAsync();
    assert.equal(origin.ok(), true, 'после фонового снимка происхождение доказано без синхронного блокирующего снимка');
  } finally {
    origin.setAsyncTableForTest(null); origin.reset();
    if (savedEnv !== undefined) process.env.MOST_TEST_CHAT_ORIGIN = savedEnv;
  }
});

// (4) Настройки Codex: startup_timeout_sec серверов моста поднят с 30 до 120 (чтобы одновременный старт укладывался в дедлайн).
T('config Codex: startup_timeout_sec = 120 у серверов моста', () => {
  const cc = require('../common/client-configs');
  const state = tmp('cfg');
  try {
    const toml = cc.toml('# пусто\n', REPO, state, state, process.execPath);
    assert(/startup_timeout_sec = 120/.test(toml), 'в блоке Codex startup_timeout_sec = 120');
    assert(!/startup_timeout_sec = 30\b/.test(toml), 'старого значения 30 в блоке нет');
  } finally { rmrf(state); }
});

run();
async function run() {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('OK ' + n); }
    catch (e) { failed++; console.error('FAIL ' + n + '\n' + (e.stack || e.message)); }
  }
  console.log('Итого: пройдено ' + (tests.length - failed) + ', провалено ' + failed);
  process.exitCode = failed ? 1 : 0;
}
