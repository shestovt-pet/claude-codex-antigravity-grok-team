'use strict';
// team-v59, одно исправление по взгляду участников:
//  (1) Codex №1 — поручение, снятое словом владельца НА ХОДУ (close/stop_confirm форсом), поздним результатом исполнителя
//      НЕ воскрешается: статус остаётся снятым, done не выставляется, голосом результат не считается; процесс останавливается.
//  (2) Codex №4 — повтор без folder с тем же request_id не ломается на служебной папке (REQUEST_ID_CONFLICT): служебная
//      папка в отпечаток запроса не входит, повтор возвращает прежнее поручение.
// Настоящий сервер codex (MCP, stdio) с фейковым исполнителем; состояние изолировано фикстурой team-v16.
const assert = require('assert'), fs = require('fs'), path = require('path');
const fx = require('./team-v16-fixture');
const { project, root, RUN } = fx;
const state = path.join(root, 'state');
const { serverReady } = require('./runner-support');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const jobs = path.join(RUN, 'late-jobs'); fs.mkdirSync(jobs, { recursive: true });
const tests = [], test = (n, f) => tests.push([n, f]);
const readJob = id => JSON.parse(fs.readFileSync(path.join(jobs, id + '.json')));
const writeJob = (id, j) => fs.writeFileSync(path.join(jobs, id + '.json'), JSON.stringify(j, null, 2));

let client, transport;
async function setup() {
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../servers/codex/index.js')], stderr: 'pipe',
    env: { ...process.env, NODE_ENV: 'test', MOST_CLIENT: 'claude', MOST_JOB_ID: '', MOST_CODEX_JOBS_DIR: jobs, MOST_QUEUE_TICK_MS: '50',
      CODEX_PATH: path.join(__dirname, 'fake-codex.js') } });
  client = new Client({ name: 'v59-late', version: '1' }); await client.connect(transport);
  await serverReady(state, transport.pid);
}
const call = a => client.callTool({ name: 'codex_send', arguments: a });
const send = async a => { const r = await call(a); assert(!r.isError, JSON.stringify(r)); const text = r.content.map(c => c.text).join('\n'); return { id: text.match(/Номер поручения: (\S+)/)[1], text }; };
const waitFor = async (id, pred) => { for (let i = 0; i < 300; i++) { try { if (pred(readJob(id))) return readJob(id); } catch {} await new Promise(r => setTimeout(r, 50)); } throw Error('не дождались условия для ' + id); };

test('снятое словом поручение поздним результатом не воскрешается (нет done; статус снят; голосом не считается)', async () => {
  const { id } = await send({ folder: project, task: 'SLOW проверка кода', role: 'проверка' });
  // Исполнитель запущен (childPid) — снимаем карточку словом владельца, как close форсом (status cancelled + closedByWord).
  await waitFor(id, j => j.status === 'running' && j.childPid);
  const j = readJob(id);
  j.status = 'cancelled';
  j.closedByWord = { basis: 'слово пользователя', quote: 'закрой это поручение', word_id: 'w-late-1', at: new Date().toISOString() };
  writeJob(id, j);
  // Опрос убивает процесс (killByWord); фейковый Codex завершается и зовёт finish. Ждём отметку завершения.
  const done = await waitFor(id, c => c.finishedAt);
  assert.equal(done.status, 'cancelled', 'статус остаётся снятым словом (не done/failed): ' + done.status);
  assert(done.closedByWord && done.closedByWord.basis === 'слово пользователя', 'closedByWord сохранён');
  assert.equal(done.voteEligible, false, 'поздний результат голосом не считается');
  assert(done.lateResult, 'поздний результат помечен отдельно (lateResult)');
  // Даже спустя время статус не перескочил в done.
  await new Promise(r => setTimeout(r, 300));
  assert.equal(readJob(id).status, 'cancelled', 'статус не воскрес после завершения процесса');
});

test('повтор без folder с тем же request_id возвращает прежнее поручение (служебная папка не ломает идемпотентность)', async () => {
  const rid = 'rid-scratch-1';
  const a = await send({ task: 'сколько будет 2+2', role: 'совет', request_id: rid });
  const r2 = await call({ task: 'сколько будет 2+2', role: 'совет', request_id: rid });
  assert(!r2.isError, 'повтор не должен давать REQUEST_ID_CONFLICT: ' + JSON.stringify(r2));
  const text2 = r2.content.map(c => c.text).join('\n');
  assert(text2.includes(a.id), 'повтор вернул тот же номер ' + a.id + '; получено: ' + text2);
});

run();
async function run() {
  await setup();
  let failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log('OK ' + n); } catch (e) { failed++; console.error('FAIL ' + n + '\n' + (e.stack || e.message)); } }
  try { await client.close(); } catch {}
  try { await transport.close(); } catch {}
  console.log('Итого: пройдено ' + (tests.length - failed) + ', провалено ' + failed);
  process.exitCode = failed ? 1 : 0;
}
