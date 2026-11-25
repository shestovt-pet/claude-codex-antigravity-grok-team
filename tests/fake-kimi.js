'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-')), state = path.join(root, 'state');
  Object.assign(process.env, { MOST_REPO_ROOT: root, MOST_STATE_DIR: state, MOST_CLIENT: 'claude', MOST_NOTIFY: 'off',
    MOST_KIMI_WORK_ROOT: path.join(root, 'copies'), MOST_KIMI_TEMP_ROOT: path.join(root, 'temp'), MOST_CODEX_JOBS_DIR: '', MOST_CODEX_ARCHIVE_DIR: '', MOST_PROBE_ONLY: '1' });
  fs.mkdirSync(state, { recursive: true }); const folder = path.join(root, 'material'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'data.txt'), 'исходный материал');
  const store = require('../common/members-store').create(state); store.read();
  function active(on = true) { store.update(store.read().rev, n => { const m = n.members.find(m => m.id === 'kimi'); m.adapter_params.path = process.execPath; m.state = on ? 'active' : 'paused'; m.pause = on ? null : require('../common/members-kimi').member().pause; }, { action: 'test', who: 'claude', reason: 'проверка' }); }
  // team-v56 А1: включение возможностей Kimi (writer/sends) в тестовом реестре — боевой реестр остаётся без них до этапа включения ролей.
  function roles(patch) { store.update(store.read().rev, n => { Object.assign(n.members.find(m => m.id === 'kimi').roles, patch); }, { action: 'test', who: 'claude', reason: 'роли для теста' }); }
  function probe() { const cli = require('../common/kimi-launch').identity(process.execPath); const p = { ...cli, version: '2.5.3', policy: require('../common/kimi-launch').POLICY, status: 'passed', delivery: true, parsing: true, detection: true }; fs.writeFileSync(path.join(state, 'kimi-compatibility.json'), JSON.stringify(p)); return p; }
  return { root, state, folder, store, active, roles, probe };
}
async function run(tests) {
  let passed = 0, failed = 0;
  for (const [name, fn] of tests) try { await fn(); passed++; console.log('OK ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.stack); }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0'); process.exitCode = failed ? 1 : 0;
}
// Готовность сервера ждём по СВЕЖЕМУ маркеру restart-servers/<pid>.json (mtime не раньше момента перед connect).
// В одном наборе kimi-server десятки серверов запускаются и закрываются в общей state-папке, оставляя старые маркеры;
// под нагрузкой полного прогона Windows переиспользует только что освободившийся pid, и прежний serverReady по одному лишь
// существованию файла возвращался на чужом (устаревшем) маркере, пока свежий сервер ещё снимал дерево процессов (pending)
// — тогда kimi_send падал с «сервер ещё готовится». Свежий серверAsync всегда перезаписывает маркер уже после снятия
// pending, поэтому ожидание mtime свежего файла принимает только готовый сервер и не ослабляет ни одной проверки.
async function serverReadyFresh(stateDir, pid, since, ms = 120000) {
  if (!pid) throw Error('serverReady: не передан pid транспорта сервера.');
  const file = path.join(stateDir, 'restart-servers', pid + '.json'), end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (fs.statSync(file).mtimeMs >= since) return true; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error('Сервер моста не подготовился за ' + ms + ' мс: нет свежего маркера ' + file + ' (mtime ≥ ' + since + ').');
}
async function client(f, client = 'claude', extra = {}) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [__filename, '--server'], stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test', MOST_CLIENT: client, MOST_PROBE_ONLY: '1', MOST_PROBE_GUEST: 'full', ...extra } });
  const c = new Client({ name: 'kimi-test', version: '1' }); const since = Date.now(); await c.connect(transport); if (client === 'claude') await serverReadyFresh(f.state, transport.pid, since);
  return c;
}
function cards(f) { const dir = path.join(f.state, 'kimi-jobs'); return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => fs.existsSync(path.join(dir, n, 'card.json'))).map(n => JSON.parse(fs.readFileSync(path.join(dir, n, 'card.json'), 'utf8'))) : []; }
async function wait(f, id) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { const j = cards(f).find(j => j.id === id); if (j && !['queued', 'running', 'cancelling'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 50)); }
  throw Error('Нет конечного состояния ' + id);
}
const text = r => (r.content || []).map(c => c.text || '').join('\n');
async function fake() {
  if (process.argv.includes('--version')) { process.stdout.write('kimi 2.5.3\n'); return; }
  if (process.argv.includes('--help')) { process.stdout.write('fake kimi: -m --output-format stream-json -p\n'); return; }
  const argv = process.argv.slice(2), prompt = argv[argv.indexOf('-p') + 1];
  const name = /most-kimi-task-[a-zA-Z0-9_-]+\.md/.exec(prompt)?.[0]; assert(name);
  const input = fs.readFileSync(path.join(process.cwd(), name), 'utf8');
  const sha = require('../common/kimi-launch').sha;
  // team-v56 А1: профиль передаётся через --agent-file; инструменты берём из него. Фиксируем профиль и очищенную среду CLI.
  const agentFile = argv.includes('--agent-file') ? argv[argv.indexOf('--agent-file') + 1] : null;
  const tools = []; if (agentFile && fs.existsSync(agentFile)) for (const line of fs.readFileSync(agentFile, 'utf8').split('\n')) { const m = /^\s*-\s*([A-Za-z]+)\s*$/.exec(line); if (m) tools.push(m[1]); }
  fs.writeFileSync(path.join(process.env.TEMP, 'observed.json'), JSON.stringify({ argv, effort: process.env.KIMI_MODEL_THINKING_EFFORT, cwd: process.cwd(), env: { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR },
    agentFile, agentSha256: agentFile && fs.existsSync(agentFile) ? sha(fs.readFileSync(agentFile)) : null, tools, inputSha256: sha(input), tail: input.includes('КОНТРОЛЬНЫЙ ХВОСТ'), bytes: Buffer.byteLength(input),
    hasPath: !!process.env.PATH, secret: process.env.FAKE_SECRET_V56 || null, authority: process.env.MOST_AUTHORITY || null, nodeOptions: process.env.NODE_OPTIONS || null, trust: process.env.KIMI_CODE_TRUST_WORKSPACE || null, mostKeys: Object.keys(process.env).filter(k => /^MOST_/i.test(k)).sort() }));
  // team-v58 §9: штатная проверка совместимости (tools/kimi-probe.js) шлёт длинный файл-поручение с уникальной меткой
  // «МЕТКА-ДОСТАВКИ: <нонс>» в самой последней строке и просит вернуть её. Подставной CLI находит метку и возвращает её
  // дословно финальным текстом — так проверка delivery подтверждается без живого kimi.exe. MOST_FAKE_PROBE_FAIL=delivery
  // заставляет вернуть не тот текст (проверка не подтверждается — запись не создаётся).
  // Метка — в САМОЙ ПОСЛЕДНЕЙ строке файла; в head есть пример «МЕТКА-ДОСТАВКИ: <код>», поэтому берём ПОСЛЕДНЕЕ совпадение.
  const deliveryMatches = [...input.matchAll(/МЕТКА-ДОСТАВКИ:\s*([0-9a-fA-F-]{8,})/g)];
  const deliveryMark = deliveryMatches.length ? deliveryMatches[deliveryMatches.length - 1] : null;
  if (deliveryMark) {
    const out = e => process.stdout.write(JSON.stringify(e) + '\n');
    out({ role: 'meta', type: 'system.version', version: '2.5.3' });
    out({ role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'Read' } }] });
    out({ role: 'assistant', content: process.env.MOST_FAKE_PROBE_FAIL === 'delivery' ? 'метку не нашёл' : deliveryMark[1] });
    return;
  }
  const scenario = /FAKE:([a-z-]+)/.exec(input)?.[1] || 'success';
  if (scenario === 'orphan') {
    // Подставной снимок: живой процесс набора представляет пережившего родителя потомка.
    fs.writeFileSync(path.join(process.env.TEMP, 'child.json'), JSON.stringify({ pid: Number(process.env.MOST_FAKE_ORPHAN_PID), ppid: process.pid }));
  }
  const emit = e => process.stdout.write(JSON.stringify(e) + '\n');
  if (scenario === 'empty') return;
  if (scenario === 'broken') { process.stdout.write('{bad\n'); return; }
  if (scenario === 'model-error') { process.stdout.write(fs.readFileSync(path.join(__dirname, 'fixtures/kimi/model-error.ndjson'))); process.stderr.write(fs.readFileSync(path.join(__dirname, 'fixtures/kimi/model-error.stderr.txt'))); process.exitCode = 7; return; }
  // team-v60: исчерпан 5-часовой лимит подписки Kimi — провайдерская строка в stderr и код 1 (как у живого kimi.exe).
  if (scenario === 'quota') { emit({ role: 'meta', type: 'system.version', version: '2.5.3' }); process.stderr.write("error: failed to run prompt: provider.api_error: You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.\n"); process.exitCode = 1; return; }
  // Обычный сбой без признаков квоты и код 1 — должен остаться failed с «код 1».
  if (scenario === 'fail-code') { process.stderr.write('error: failed to run prompt: internal error\n'); process.exitCode = 1; return; }
  // team-v61 (п.1): слово «quota» в ТЕКСТЕ ОТВЕТА (parsed.text) при обычном сбое не делает квоту — должно остаться failed.
  if (scenario === 'text-quota') { emit({ role: 'meta', type: 'system.version', version: '2.5.3' }); emit({ role: 'assistant', content: 'The quota column stores a number; rate limit of the table is irrelevant.' }); process.stderr.write('error: failed to run prompt: internal error\n'); process.exitCode = 1; return; }
  if (scenario === 'wait' || scenario === 'child' || scenario === 'late') {
    if (scenario === 'child') {
      const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
      fs.writeFileSync(path.join(process.env.TEMP, 'child.json'), JSON.stringify({ pid: child.pid, ppid: process.pid }));
    }
    emit({ role: 'meta', type: 'system.version', version: '2.5.3' });
    if (scenario === 'late') emit({ role: 'assistant', content: 'НЕ ПРИНЯТО: 1 блокирующих' });
    setInterval(() => {}, 1000); return;
  }
  if (scenario === 'change') {
    const m = JSON.parse(/Карта оригинал → копия:\n(\[[\s\S]*\])\s*$/.exec(input)[1]); fs.writeFileSync(path.join(m[0].copy, 'data.txt'), 'подмена');
  }
  if (scenario === 'refuse' || scenario === 'exit') {
    emit({ role: 'meta', type: 'system.version', version: '2.5.3' }); emit({ role: 'assistant', content: 'ПРИНЯТО' });
    emit({ role: 'assistant', content: 'НЕ ПРИНЯТО: 1 блокирующих' }); if (scenario === 'exit') process.exitCode = 9; return;
  }
  // team-v56 А1: писатель правит оригиналы по карте абсолютных путей. Запись/запуск программы — только если профиль их
  // разрешил (tool_calls сохраняются как доказательство). write-quota: частичная запись и ошибка/квота уже запущенного писателя.
  if (scenario === 'write' || scenario === 'program' || scenario === 'write-quota') {
    const targets = JSON.parse(/Целевые пути \(абсолютные\):\n(\[[\s\S]*\])\s*$/.exec(input)[1]);
    emit({ role: 'meta', type: 'system.version', version: '2.5.3' });
    // team-v56 А2: подсказка продолжения — структурированный session_id (+ неисполняемая строка command/content).
    emit({ role: 'meta', type: 'session.resume_hint', session_id: 'session_fixture', command: 'kimi -r session_fixture', content: 'To resume: kimi -r session_fixture' });
    // Продолжение (--session) не получает профиль/agent-file: право записи помнит сам сеанс, поэтому пишем и без tools,
    // но в отдельный файл — так тест видит, что исполнился именно продолженный сеанс.
    const isCont = argv.includes('--session');
    if (tools.includes('Write') || isCont) { emit({ role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'Write' } }] }); fs.writeFileSync(path.join(targets[0], isCont ? 'kimi-continued.txt' : 'kimi-wrote.txt'), isCont ? 'KIMI_CONTINUED_V56' : 'KIMI_WROTE_V56'); }
    if (scenario === 'program' && tools.includes('Bash')) { emit({ role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'Bash' } }] }); fs.writeFileSync(path.join(targets[0], 'kimi-program.txt'), 'KIMI_PROGRAM_V56'); }
    if (scenario === 'write-quota') { emit({ role: 'assistant', content: 'Частично выполнено' }); process.stderr.write('error: quota exceeded\n'); process.exitCode = 1; return; }
    emit({ role: 'assistant', content: 'ПРИНЯТО: запись выполнена' }); return;
  }
  // team-v56 А3: исходящее поручение через проектный MCP. Если конфиг и доверие есть (совет/текст), имитируем вызов
  // codex_send: создаём дочернюю карточку codex с parentJob из служебной среды MCP (ровно семь полей jobEnv). Для роли
  // «проверка» конфига и доверия нет — делегирование недоступно (CODEX_SEND_UNAVAILABLE).
  if (scenario === 'delegate') {
    emit({ role: 'meta', type: 'system.version', version: '2.5.3' });
    const mcpFile = path.join(process.cwd(), '.kimi-code', 'mcp.json'), trust = process.env.KIMI_CODE_TRUST_WORKSPACE;
    if (fs.existsSync(mcpFile) && trust === '1') {
      const cfg = JSON.parse(fs.readFileSync(mcpFile, 'utf8')), codex = cfg.mcpServers.codex, parent = codex.env.MOST_JOB_ID;
      const childDir = path.join(codex.env.MOST_STATE_DIR, 'codex-jobs'); fs.mkdirSync(childDir, { recursive: true });
      const childId = 'kimi-child-' + parent.slice(0, 8);
      fs.writeFileSync(path.join(childDir, childId + '.json'), JSON.stringify({ id: childId, status: 'done', parentJob: parent, from: 'kimi', mcpEnv: codex.env, finishedAt: new Date().toISOString(), exitCode: 0, resultFile: 'r' }));
      emit({ role: 'assistant', tool_calls: [{ type: 'function', id: 'tc_send', function: { name: 'mcp__codex__codex_send' } }] });
      emit({ role: 'tool', tool_call_id: 'tc_send', content: 'codex: поручение ' + childId + ' принято' });
      // team-v56 Л2 (круг 5, М1): модель-родитель запрашивает результат потомка (*_result). Сам по себе этот ответ в потоке
      // БОЛЬШЕ не является следом получения — доказуемую отметку выдачи пишет сервер-получатель в карточку потомка
      // (здесь подставной codex-сервер не запускается, поэтому отметки нет; её запись проверяется в kimi-server).
      emit({ role: 'assistant', tool_calls: [{ type: 'function', id: 'tc_res', function: { name: 'mcp__codex__codex_result', arguments: JSON.stringify({ id: childId }) } }] });
      emit({ role: 'tool', tool_call_id: 'tc_res', content: 'codex ' + childId + ': done\nрезультат потомка получен' });
      emit({ role: 'assistant', content: 'ПРИНЯТО: поручение Codex отправлено и результат получен через MCP' });
    } else emit({ role: 'assistant', content: 'CODEX_SEND_UNAVAILABLE: нет проектного MCP/доверия для делегирования' });
    return;
  }
  // team-v56 А2: чтение с сохранением session.resume_hint для продолжения читателя (--session), без записи.
  if (scenario === 'read-session') {
    emit({ role: 'meta', type: 'system.version', version: '2.5.3' });
    emit({ role: 'meta', type: 'session.resume_hint', session_id: 'read_fixture', command: 'kimi -r read_fixture' });
    emit({ role: 'assistant', content: argv.includes('--session') ? 'ПРОДОЛЖЕНО: чтение продолжено' : 'ПРИНЯТО: материал прочитан' });
    return;
  }
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/kimi/success.ndjson'));
  for (let i = 0; i < bytes.length; i += 7) process.stdout.write(bytes.subarray(i, i + 7));
}
// Подмены только тестового сервера: реальные MCP, замки и дочерние процессы остаются.
if (require.main === module && process.argv[2] === '--server') {
  const cp = require('child_process'), spawn = cp.spawn, execFile = cp.execFile;
  const fault = process.env.MOST_FAKE_STOP_FAULT, trace = process.env.MOST_FAKE_STOP_TRACE;
  const event = (name, fields = {}) => { if (trace) fs.appendFileSync(trace, JSON.stringify({ name, ...fields }) + '\n'); };
  let writes = 0, injected = false, kills = 0, fallbackKills = 0;
  if (fault) {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (typeof to === 'string' && path.basename(to) === 'card.json') {
        const card = JSON.parse(fs.readFileSync(from, 'utf8'));
        // team-v56 А2/Б0: оборванный commit перехода вершины — бросаем на записи карточки-источника decision=continued.
        if (fault === 'continue-commit' && card.decision === 'continued' && !injected) { injected = true; event('continue-commit', { id: card.id }); throw Object.assign(Error('test continue commit fault'), { code: 'EIO' }); }
        if (card.cancellingAt) {
          writes++;
          if (!injected && (fault === 'card-1' && writes === 1 || fault === 'card-2' && writes === 2 || fault === 'retry' && card.status === 'stop_unconfirmed')) {
            injected = true; event('write-failed', { id: card.id, status: card.status, writes });
            throw Object.assign(Error('test stop card write'), { code: 'EIO' });
          }
        }
      }
      return rename(from, to);
    };
    cp.execFile = (file, args, options, callback) => {
      if (file === 'taskkill.exe') {
        event('taskkill', { attempt: ++kills, pid: Number(args[1]) });
        if (fault === 'retry' && kills === 1) { process.nextTick(() => callback(Error('test first taskkill failure'))); return {}; }
      }
      return execFile(file, args, options, callback);
    };
  }
  cp.spawn = (file, args, options) => {
    if (args?.[0] !== __filename) return spawn(file, args, options);
    // team-v56 А1: сервер очищает среду CLI (cliEnv). Возвращаем в подставной CLI только тестовые переключатели MOST_FAKE_*
    // (управление сценарием), не настоящие MOST_*/секреты — их отсутствие проверяет тест очищенной среды.
    options = { ...options, env: { ...options.env, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^MOST_FAKE_/i.test(k))) } };
    const barrier = process.env.MOST_FAKE_SPAWN_BARRIER;
    if (barrier) {
      fs.writeFileSync(barrier, JSON.stringify({ id: path.basename(options.env.TEMP) }));
      const end = Date.now() + 30000;
      while (!fs.existsSync(barrier + '.release') && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    const child = spawn(file, args, options), kill = child.kill.bind(child);
    if (fault === 'retry') child.kill = (...args) => {
      event('fallback-kill', { attempt: ++fallbackKills });
      return fallbackKills === 1 ? false : kill(...args);
    };
    return child;
  };
  const cancelTrace = process.env.MOST_FAKE_CANCEL_LOCK_TRACE;
  if (cancelTrace) {
    const locks = require('../common/locks'), waitLock = locks.waitLock;
    locks.waitLock = async (kind, key, info, ms, state) => {
      if (kind !== 'kimi_job') return waitLock(kind, key, info, ms, state);
      const attempt = await locks.tryLock(kind, key, info, state);
      fs.writeFileSync(cancelTrace + '.attempt', JSON.stringify({ ok: attempt.ok, busy: attempt.busy }));
      const lock = attempt.ok ? attempt : await waitLock(kind, key, info, ms, state);
      if (lock.ok) fs.writeFileSync(cancelTrace + '.acquired', fs.readFileSync(path.join(process.env.MOST_STATE_DIR, 'kimi-jobs', key, 'card.json')));
      return lock;
    };
  }
}
if (require.main === module && process.argv[2] === '--server' && process.env.MOST_FAKE_PREPARE_BARRIER) {
  // Синхронная подготовка блокирует один сервер; отмена/подмена приходит через другой MCP-процесс. Барьер — и для чтения
  // (prepare), и для писателя (prepareWrite): так проверяется «отказ до spawn остаётся failed».
  const material = require('../common/kimi-material');
  for (const fn of ['prepare', 'prepareWrite']) {
    const orig = material[fn];
    material[fn] = (job, bundle, profile) => {
      const result = orig(job, bundle, profile), barrier = process.env.MOST_FAKE_PREPARE_BARRIER;
      fs.writeFileSync(barrier, JSON.stringify({ id: job.id, write: !!job.write, ...result.fields }));
      const end = Date.now() + 30000;
      while (!fs.existsSync(barrier + '.release') && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      return result;
    };
  }
}
if (require.main === module) {
  if (process.argv[2] === '--server') require('../servers/kimi/index').start({ command: process.execPath, prefixArgs: [__filename], processTable: async () => {
    if (process.env.MOST_FAKE_INCOMPLETE_TREE === '1') return [];
    const root = process.env.MOST_KIMI_TEMP_ROOT, rows = [{ pid: process.pid, ppid: process.ppid }];
    if (fs.existsSync(root)) for (const id of fs.readdirSync(root)) { const file = path.join(root, id, 'child.json'); if (fs.existsSync(file)) { const p = JSON.parse(fs.readFileSync(file)); try { process.kill(p.pid, 0); rows.push(p); } catch {} } }
    return rows;
  } }).catch(e => { console.error(e); process.exit(1); });
  else fake().catch(e => { console.error(e); process.exit(1); });
}
module.exports = { setup, run, client, cards, wait, text };
