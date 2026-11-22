'use strict';
// team-v56 А1: исполнение Kimi с реальными разрешениями CLI — писатель, полный доступ, профили, очищенная среда,
// разделение допуска исполнения и голоса, таблица переходов Б0 для писателя (needs_decision при ошибке/квоте запущенного).
// Реестр возможностей (writer/sends) включается только в тестовом реестре через f.roles — боевой реестр не меняется.
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const h = require('./fake-kimi'), f = h.setup(); f.active(); f.probe();
const launch = require('../common/kimi-launch'); let c;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freshFolder(name) { const dir = path.join(f.root, name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'data.txt'), 'исходный материал'); return dir; }
async function run(task, extra = {}) {
  const before = new Set(h.cards(f).map(j => j.id));
  const r = await c.callTool({ name: 'kimi_send', arguments: { folder: extra.folder || f.folder, task, ...extra } });
  const created = h.cards(f).find(j => !before.has(j.id));
  return { r, j: created ? await h.wait(f, created.id) : null };
}
const tests = [
  ['писатель: профиль Read/Write/Edit без Bash; правка оригинала; writeCheck; не голос; замок отпущен', async () => {
    c = await h.client(f); f.roles({ writer: true });
    const folder = freshFolder('writer-ok');
    const { r, j } = await run('FAKE:write', { role: 'текст', write: true, folder });
    assert(!r.isError, h.text(r)); assert.equal(j.status, 'done', j.error);
    assert.equal(j.write, true); assert.equal(j.fullAccess, false); assert.equal(j.profileKind, 'writer');
    assert.deepEqual([...j.profileTools].sort(), ['Edit', 'Glob', 'Grep', 'Read', 'Write']);
    assert(fs.existsSync(path.join(folder, 'kimi-wrote.txt')), 'писатель изменил оригинал абсолютным путём');
    assert.equal(j.writeCheck.status, 'passed'); assert(j.writeCheck.changed.some(p => p.endsWith('kimi-wrote.txt')));
    assert.equal(j.voteEligible, false); assert(j.voteIneligibleReason, 'писатель не голосует — причина сохранена');
    assert.throws(() => require('../common/kimi-review').evidence(j));
    const obs = JSON.parse(fs.readFileSync(path.join(j.tempFolder, 'observed.json')));
    assert.equal(obs.agentFile, j.profileFile); assert.equal(obs.agentSha256, j.profileSha256); assert(!obs.tools.includes('Bash'));
    assert.equal(obs.argv[obs.argv.indexOf('--agent-file') + 1], j.profileFile);
    const lock = require('../common/write-lock').acquire(folder); assert(lock.ok); lock.release();
    const res = await c.callTool({ name: 'kimi_result', arguments: { id: j.id } });
    assert.match(h.text(res), /ИЗМЕНЕНИЯ УЖЕ ВНЕСЕНЫ/); assert.match(h.text(res), /Запись \(профиль writer\)/);
  }],
  ['полный доступ: профиль писателя + Bash, запуск программы; full_access без write отвергается до карточки', async () => {
    f.roles({ writer: true });
    const folder = freshFolder('writer-full');
    const { r, j } = await run('FAKE:program', { role: 'текст', write: true, full_access: true, folder });
    assert(!r.isError, h.text(r)); assert.equal(j.status, 'done', j.error);
    assert.equal(j.fullAccess, true); assert.equal(j.profileKind, 'writer-full'); assert(j.profileTools.includes('Bash'));
    assert(fs.existsSync(path.join(folder, 'kimi-wrote.txt'))); assert(fs.existsSync(path.join(folder, 'kimi-program.txt')), 'программа выполнена под Bash');
    const lock = require('../common/write-lock').acquire(folder); assert(lock.ok); lock.release();
    const before = h.cards(f).length; const bad = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', full_access: true } });
    assert(bad.isError); assert.match(h.text(bad), /требует write/); assert.equal(h.cards(f).length, before);
  }],
  ['запись без включённой роли писателя: шлюз приёма отвергает до карточки', async () => {
    f.roles({ writer: false });
    const folder = freshFolder('writer-off');
    const before = h.cards(f).length;
    const r = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true } });
    assert(r.isError); assert.match(h.text(r), /роль писателя не включена/); assert.equal(h.cards(f).length, before, 'карточка не создана');
    assert(!fs.existsSync(path.join(folder, 'kimi-wrote.txt')));
    f.roles({ writer: true });
  }],
  ['писатель: отказ до spawn (вход изменился) остаётся failed, не needs_decision; без записи; замок свободен', async () => {
    f.roles({ writer: true });
    const folder = freshFolder('writer-prespawn'), barrier = path.join(f.root, 'wbar.json');
    await c.close(); c = await h.client(f, 'claude', { MOST_FAKE_PREPARE_BARRIER: barrier });
    const pending = c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true } }).then(v => ({ value: v }), e => ({ error: e }));
    let prep;
    try {
      for (let i = 0; i < 300 && !fs.existsSync(barrier); i++) await sleep(50);
      assert(fs.existsSync(barrier), 'сервер не дошёл до подготовки писателя'); prep = JSON.parse(fs.readFileSync(barrier));
      assert.equal(prep.write, true, 'это путь писателя (prepareWrite)');
      fs.writeFileSync(prep.inputFile, 'подмена входа перед запуском'); // sha разойдётся → отказ до spawn
    } finally { fs.writeFileSync(barrier + '.release', 'release'); }
    const reply = await pending; if (reply.error) throw reply.error;
    const ended = await h.wait(f, prep.id);
    assert.equal(ended.status, 'failed', JSON.stringify(ended)); assert(!ended.childPid, 'spawn не произошёл'); assert(!ended.voteEligible);
    assert.match(ended.error, /изменил|Сверка/); assert(!fs.existsSync(path.join(folder, 'kimi-wrote.txt')), 'писатель не стартовал');
    const lock = require('../common/write-lock').acquire(folder); assert(lock.ok, 'замок отпущен'); lock.release();
    await c.close(); c = await h.client(f);
  }],
  ['ошибка/квота УЖЕ ЗАПУЩЕННОГО писателя → needs_decision; частичная запись видна; замок отпущен', async () => {
    f.roles({ writer: true });
    const folder = freshFolder('writer-quota');
    const { j } = await run('FAKE:write-quota', { role: 'текст', write: true, folder });
    assert.equal(j.status, 'needs_decision', JSON.stringify(j)); assert(j.childPid, 'писатель уже запускался');
    assert(j.stopConfirmed); assert(!j.launch, 'needs_decision не запрещает продолжение');
    assert(fs.existsSync(path.join(folder, 'kimi-wrote.txt')), 'частичная запись сохранена');
    assert.equal(j.writeCheck.status, 'passed'); assert(j.writeCheck.changed.some(p => p.endsWith('kimi-wrote.txt')));
    assert(!j.voteEligible);
    const lock = require('../common/write-lock').acquire(folder); assert(lock.ok, 'при stopConfirmed write-lock снят'); lock.release();
  }],
  ['очищенная среда CLI: системные есть; MOST_*/секрет/доверие/NODE_OPTIONS/PYTHONPATH сняты', async () => {
    // Прямая проверка builder: подаём искусственную среду, включая MOST_AUTHORITY/чужой MOST_JOB_ID/доверие — её builder не пропускает.
    const planted = { FAKE_SECRET_V56: 'тайна', MOST_AUTHORITY: 'user', MOST_JOB_ID: 'чужой', KIMI_CODE_TRUST_WORKSPACE: '1', NODE_OPTIONS: '--trace-warnings', PYTHONPATH: 'C:/x' };
    const saved = {}; for (const [k, v] of Object.entries(planted)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      const env = launch.cliEnv({ tempFolder: path.join(f.root, 'temp', 'x') });
      assert(env.PATH, 'системный PATH сохранён'); assert(env.TEMP && env.TEMP === env.TMPDIR, 'TEMP/TMPDIR заданы папкой поручения');
      for (const k of Object.keys(planted)) assert.equal(env[k], undefined, k + ' не передаётся CLI');
      assert(!Object.keys(env).some(k => /^MOST_/i.test(k)), 'MOST_* не наследуются: ' + Object.keys(env).filter(k => /^MOST_/i.test(k)).join(','));
    } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // Сквозная проверка: фиктивный секрет/доверие/NODE_OPTIONS и инертный MOST_ не доходят до подставного CLI.
    await c.close();
    c = await h.client(f, 'claude', { FAKE_SECRET_V56: 'тайна', KIMI_CODE_TRUST_WORKSPACE: '1', NODE_OPTIONS: '--trace-warnings', MOST_ALIEN_SECRET: 'чужой' });
    const { j } = await run('FAKE:success', { role: 'проверка' });
    assert.equal(j.status, 'done', j.error);
    const obs = JSON.parse(fs.readFileSync(path.join(j.tempFolder, 'observed.json')));
    assert(obs.hasPath, 'системный PATH сохранён у CLI');
    assert.equal(obs.secret, null); assert.equal(obs.trust, null); assert.equal(obs.nodeOptions, null);
    assert.deepEqual(obs.mostKeys, [], 'MOST_* в среду CLI не попали: ' + obs.mostKeys.join(','));
    await c.close(); c = await h.client(f);
  }],
  ['продолжение сеанса (А2): --session без --agent-file, права не повышены, вершина цепочки передана', async () => {
    f.roles({ writer: true });
    const folder = freshFolder('writer-continue');
    // Исходный писатель → needs_decision + сохранённый session.resume_hint (sessionId).
    const { j: prior } = await run('FAKE:write-quota', { role: 'текст', write: true, folder });
    assert.equal(prior.status, 'needs_decision', JSON.stringify(prior)); assert.equal(prior.sessionId, 'session_fixture');
    // Явное продолжение того же сеанса.
    const { r, j: cont } = await run('FAKE:write', { role: 'текст', write: true, folder, continue_id: prior.id });
    assert(!r.isError, h.text(r)); assert.equal(cont.status, 'done', cont.error);
    assert.equal(cont.previous, prior.id); assert.equal(cont.sessionId, 'session_fixture');
    assert.equal(cont.write, true); assert.equal(cont.fullAccess, false); assert.equal(cont.role, 'текст');
    assert(!cont.profileFile, 'продолжение не генерирует профиль'); assert(cont.cliIdentity && cont.cliIdentity.sha256);
    assert.equal(cont.sessionCwd, prior.executionFolder, 'переиспользована служебная папка сеанса');
    assert(fs.existsSync(path.join(folder, 'kimi-continued.txt')), 'именно продолженный сеанс исполнился');
    const obs = JSON.parse(fs.readFileSync(path.join(cont.tempFolder, 'observed.json')));
    assert(obs.argv.includes('--session')); assert.equal(obs.argv[obs.argv.indexOf('--session') + 1], 'session_fixture');
    assert(!obs.argv.includes('--agent-file'), 'продолжение не передаёт --agent-file'); assert.equal(obs.agentFile, null);
    // Передача вершины цепочки: исходная карточка → failed, decision=continued, ссылка; частичный результат сохранён.
    const priorAfter = h.cards(f).find(x => x.id === prior.id);
    assert.equal(priorAfter.status, 'failed'); assert.equal(priorAfter.decision, 'continued'); assert.equal(priorAfter.continuedBy, cont.id);
    assert(priorAfter.writeCheck, 'частичный writeCheck исходной карточки сохранён');
    assert(!cont.voteEligible); assert.throws(() => require('../common/kimi-review').evidence(cont));
    // Повторно продолжить исходную уже нельзя (вершина передана).
    const again = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true, continue_id: prior.id } });
    assert(again.isError); assert.match(h.text(again), /завершённая карточка|уже продолжено|подтверждённой/);
  }],
  ['продолжение (А2): пустой/битый continue_id и попытка повышения прав отвергаются до карточки', async () => {
    f.roles({ writer: true });
    const folder = freshFolder('writer-continue2');
    const { j: prior } = await run('FAKE:write-quota', { role: 'текст', write: true, folder });
    assert.equal(prior.status, 'needs_decision');
    const n0 = h.cards(f).length;
    let bad = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true, continue_id: '' } });
    assert(bad.isError); assert.match(h.text(bad), /Пустой continue_id/);
    bad = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true, continue_id: 'old' } });
    assert(bad.isError); assert.match(h.text(bad), /Некорректный номер|нет собственной карточки/);
    // Повышение прав: продолжение writer-сессии без write отвергается.
    bad = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:success', role: 'текст', continue_id: prior.id } });
    assert(bad.isError); assert.match(h.text(bad), /не повышает права|write/);
    assert.equal(h.cards(f).length, n0, 'ни одна отвергнутая попытка не создала карточку');
  }],
  ['А3: совет с sends создаёт проектный MCP в служебной папке и доверие; делегирует дочерней карточкой с parentJob', async () => {
    f.roles({ writer: true, sends: true });
    const folder = freshFolder('a3-advice');
    const { r, j } = await run('FAKE:delegate', { role: 'совет', folder });
    assert(!r.isError, h.text(r)); assert.equal(j.status, 'done', j.error);
    assert.equal(j.mcpPolicy, 'project');
    // Конфиг — в служебной executionFolder, не в целевом проекте; целевой .kimi-code не создавался.
    const mcpFile = path.join(j.executionFolder, '.kimi-code', 'mcp.json'); assert(fs.existsSync(mcpFile), 'проектный MCP в служебной папке');
    assert(!fs.existsSync(path.join(folder, '.kimi-code', 'mcp.json')), 'целевой проект не трогаем');
    const cfg = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
    for (const n of ['codex', 'deepseek', 'team']) assert(cfg.mcpServers[n], n);
    // Среда MCP — ровно семь служебных полей; чужой MOST_JOB_ID/MOST_AUTHORITY/секрет не наследуются.
    assert.deepEqual(Object.keys(cfg.mcpServers.codex.env).sort(), ['MOST_CLIENT', 'MOST_JOB_ID', 'MOST_REPO_ROOT', 'MOST_STATE_DIR', 'TEMP', 'TMP', 'TMPDIR']);
    assert.equal(cfg.mcpServers.codex.env.MOST_JOB_ID, j.id); assert.equal(cfg.mcpServers.codex.env.MOST_CLIENT, 'job');
    assert(!('MOST_AUTHORITY' in cfg.mcpServers.codex.env) && !('FAKE_SECRET_V56' in cfg.mcpServers.codex.env));
    assert(path.isAbsolute(cfg.mcpServers.codex.command) && path.isAbsolute(cfg.mcpServers.codex.args[0]));
    // Доверие выставлено самому CLI (project); профиль совета содержит ТОЧНЫЕ mcp-инструменты, без '*'/'mcp__*'.
    const obs = JSON.parse(fs.readFileSync(path.join(j.tempFolder, 'observed.json'))); assert.equal(obs.trust, '1');
    assert(j.profileTools.includes('mcp__codex__codex_send')); assert(!j.profileTools.some(t => t === '*' || t === 'mcp__*'));
    // Делегация идёт дочерней карточкой codex с parentJob; учтена в outgoingCount; подпоручение голосом не является.
    const child = JSON.parse(fs.readFileSync(path.join(f.state, 'codex-jobs', 'kimi-child-' + j.id.slice(0, 8) + '.json')));
    assert.equal(child.parentJob, j.id); assert.equal(j.outgoingCount, 1); assert(j.delegations.includes(child.id));
    assert.equal(j.voteEligible, false);
    // team-v56 Л2 (круг 5, М1): след получения результата теперь пишет сервер-ПОЛУЧАТЕЛЬ в карточку ПОТОМКА (resultDeliveries),
    // а не мост-родитель из stream.ndjson. Здесь потомок — подставная карточка codex (настоящий сервер codex не запускается),
    // поэтому отметки выдачи у неё нет, и у родителя поля resultsReceived больше нет. Фактическая запись отметки проверяется в
    // kimi-server (kimi_result выдаёт результат потомка его родителю), а приёмка по отметке — в kimi-deploy.
    assert.equal(j.resultsReceived, undefined, 'ненадёжный resultsReceived родителя убран');
    assert.equal(child.resultDeliveries, undefined, 'без настоящего сервера-получателя отметки выдачи нет');
    f.roles({ sends: false });
  }],
  ['А3: роль «проверка» — MCP не создаётся вовсе (mcpPolicy none), доверия нет, делегирование недоступно', async () => {
    f.roles({ sends: true });
    const folder = freshFolder('a3-review');
    const { r, j } = await run('FAKE:delegate', { role: 'проверка', folder });
    assert(!r.isError, h.text(r)); assert.equal(j.status, 'done', j.error);
    assert.equal(j.mcpPolicy, 'none'); assert.equal(j.outgoingCount, 0);
    assert(!fs.existsSync(path.join(j.executionFolder, '.kimi-code', 'mcp.json')), 'у проверки конфига нет');
    const obs = JSON.parse(fs.readFileSync(path.join(j.tempFolder, 'observed.json'))); assert.equal(obs.trust, null, 'доверия у проверки нет');
    assert(!(j.profileTools || []).some(t => /^mcp__/.test(t)), 'профиль проверки без MCP/Agent');
    assert.match(fs.readFileSync(j.resultFile, 'utf8'), /CODEX_SEND_UNAVAILABLE/);
    // team-v56 Л2 (круг 5, М1): без делегирования потомков нет — и ненадёжного поля resultsReceived у родителя больше нет.
    assert.equal(j.resultsReceived, undefined, 'resultsReceived родителя убран');
    f.roles({ sends: false });
  }],
  ['продолжение читателя (А2): новый jobId, --session без --agent-file, без записи, материал в run-<jobId>', async () => {
    f.roles({ writer: true });
    const folder = freshFolder('reader-continue');
    const { j: prior } = await run('FAKE:read-session', { role: 'совет', folder });
    assert.equal(prior.status, 'done', prior.error); assert.equal(prior.write, false); assert.equal(prior.sessionId, 'read_fixture'); assert(prior.stopConfirmed);
    const { r, j: cont } = await run('FAKE:read-session', { role: 'совет', folder, continue_id: prior.id });
    assert(!r.isError, h.text(r)); assert.equal(cont.status, 'done', cont.error);
    assert.notEqual(cont.id, prior.id); assert.equal(cont.previous, prior.id); assert.equal(cont.write, false);
    assert.equal(cont.sessionCwd, prior.executionFolder, 'переиспользована служебная папка сеанса');
    const obs = JSON.parse(fs.readFileSync(path.join(cont.tempFolder, 'observed.json')));
    assert(obs.argv.includes('--session')); assert.equal(obs.argv[obs.argv.indexOf('--session') + 1], 'read_fixture');
    assert(!obs.argv.includes('--agent-file'), 'продолжение не передаёт профиль');
    assert(fs.existsSync(path.join(cont.executionFolder, 'run-' + cont.id)), 'материал продолжения в отдельной поддиректории');
  }],
  ['recovery_required (А2/Б0): оборванный commit перехода вершины блокирует продолжение до восстановления', async () => {
    await c.close(); c = await h.client(f, 'claude', { MOST_FAKE_STOP_FAULT: 'continue-commit' });
    f.roles({ writer: true });
    const folder = freshFolder('recover');
    const { j: prior } = await run('FAKE:write-quota', { role: 'текст', write: true, folder });
    assert.equal(prior.status, 'needs_decision', JSON.stringify(prior));
    // Продолжение: commit перехода вершины прервётся → reservation recovery_required.
    const bad = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true, continue_id: prior.id } });
    assert(bad.isError, h.text(bad));
    const key = require('../common/job-admission').sessionKey(prior.cli.sha256, prior.sessionId, prior.executionFolder);
    const res = require('../common/job-admission').readSession(f.state, key);
    assert(res && res.status === 'recovery_required', 'reservation в recovery_required: ' + JSON.stringify(res));
    // team-v56 И9 (ревью Codex 2): проход очереди над застрявшей карточкой-продолжением переводит её в failed, но
    // reservation recovery_required НЕ отпускается (finalizeCard её бережёт) — запрет повтора держится.
    const stuck = h.cards(f).find(x => x.previous === prior.id && x.status === 'queued');
    assert(stuck, 'карточка-продолжение осталась queued');
    await run('FAKE:success', { role: 'проверка' }); // benign send триггерит queue() сервера
    const afterStuck = await h.wait(f, stuck.id);
    assert(['failed', 'cancelled'].includes(afterStuck.status), 'застрявшая карточка завершена: ' + JSON.stringify(afterStuck));
    const res2 = require('../common/job-admission').readSession(f.state, key);
    assert(res2 && res2.status === 'recovery_required', 'reservation recovery_required пережила проход очереди: ' + JSON.stringify(res2));
    // Повторное продолжение той же тройки блокируется (reservation recovery_required).
    const again = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true, continue_id: prior.id } });
    assert(again.isError); assert.match(h.text(again), /SESSION_BUSY|восстановлен|recovery|уже продолжено/i);
    await c.close(); c = await h.client(f);
  }],
  ['продолжение (А2/И10): другой владелец (owner) того же отправителя продолжить не может; тот же owner — проходит', async () => {
    f.roles({ writer: true });
    const folder = freshFolder('owner-cont');
    const { j: prior } = await run('FAKE:write-quota', { role: 'текст', write: true, folder, owner: 'влад-A' });
    assert.equal(prior.status, 'needs_decision'); assert.equal(prior.ownerLabel, 'влад-A');
    const n0 = h.cards(f).length;
    // Другой владелец (owner=влад-B) того же отправителя (claude) — отказ до карточки.
    const bad = await c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true, continue_id: prior.id, owner: 'влад-B' } });
    assert(bad.isError); assert.match(h.text(bad), /тому же владельцу|родительскому|parentJob/);
    assert.equal(h.cards(f).length, n0, 'чужой владелец не создал карточку');
    // Тот же владелец — продолжение проходит.
    const { r, j: cont } = await run('FAKE:write', { role: 'текст', write: true, folder, continue_id: prior.id, owner: 'влад-A' });
    assert(!r.isError, h.text(r)); assert.equal(cont.previous, prior.id); assert.equal(cont.ownerLabel, 'влад-A');
  }],
  ['продолжение (А2/И11): отказ до spawn финализирует карточку через finalizeCard (launch=forbidden, finalizedAt, reservation снята)', async () => {
    f.roles({ writer: true });
    const folder = freshFolder('cont-prespawn'), barrier = path.join(f.root, 'cbar.json');
    const { j: prior } = await run('FAKE:write-quota', { role: 'текст', write: true, folder });
    assert.equal(prior.status, 'needs_decision'); assert(prior.sessionId);
    await c.close(); c = await h.client(f, 'claude', { MOST_FAKE_PREPARE_BARRIER: barrier });
    const pending = c.callTool({ name: 'kimi_send', arguments: { folder, task: 'FAKE:write', role: 'текст', write: true, continue_id: prior.id } }).then(v => ({ value: v }), e => ({ error: e }));
    let prep;
    try {
      for (let i = 0; i < 300 && !fs.existsSync(barrier); i++) await sleep(50);
      assert(fs.existsSync(barrier), 'сервер не дошёл до подготовки продолжения'); prep = JSON.parse(fs.readFileSync(barrier));
      fs.writeFileSync(prep.inputFile, 'подмена входа продолжения перед запуском'); // sha разойдётся → отказ до spawn
    } finally { fs.writeFileSync(barrier + '.release', 'release'); }
    const reply = await pending; if (reply.error) throw reply.error;
    const ended = await h.wait(f, prep.id);
    assert(['failed', 'cancelled'].includes(ended.status), JSON.stringify(ended));
    assert.equal(ended.launch, 'forbidden', 'launch=forbidden на терминале до spawn'); assert(ended.finalizedAt, 'finalizedAt проставлен');
    assert(!ended.childPid, 'spawn не произошёл'); assert(!fs.existsSync(path.join(folder, 'kimi-continued.txt')), 'CLI не запущен');
    const key = require('../common/job-admission').sessionKey(prior.cli.sha256, prior.sessionId, prior.executionFolder);
    assert.equal(require('../common/job-admission').readSession(f.state, key), null, 'session-reservation снята финализацией');
    await c.close(); c = await h.client(f);
  }],
  ['исполнение отдельно от голоса: voter=false — проверка исполняется, но голос не выдаётся', async () => {
    f.roles({ voter: false });
    const { r, j } = await run('FAKE:success', { role: 'проверка' });
    assert(j, 'карточка должна создаться даже при voter=false: ' + h.text(r));
    assert.equal(j.status, 'done', j.error); assert.equal(j.voteEligible, false); assert(j.voteIneligibleReason);
    assert.throws(() => require('../common/kimi-review').evidence(j));
    f.roles({ voter: true });
  }],
];
h.run(tests).finally(async () => { if (c) await c.close(); });
