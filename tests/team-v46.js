'use strict';
// team-v46: полная матрица поручений (каждый → каждому, включая Claude-исполнителя и дирижёра). Без живых исполнителей.
// Раздел «Проверка» замысла ред. 9: 12 направлений, права Claude-исполнителя, пишущие подпоручения, общий замок
// записи, общее правило папок (п.5а), входящие дирижёру, сроки, происхождение, счётчик без лимита.
const assert = require('assert'), fs = require('fs'), path = require('path');
const f = require('./team-v16-fixture');
const chain = require('../common/job-chain'), fallback = require('../common/fallback');
const members = require('../common/members'), access = require('../common/access');
const v46 = require('../common/members-v46');
const deadline = require('../common/chain-deadline');
const claudeArgs = require('../common/claude-args');
const writeLock = require('../common/write-lock');
const writeFolder = require('../common/write-folder');
const inbox = require('../common/inbox');
const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, { NODE_ENV: 'test', MOST_TEST_PROCESS_TREE: JSON.stringify([
  { pid: 'self', ppid: 4100 }, { pid: 4100, ppid: 1 },
]), MOST_TEST_KEEP: '1', MOST_JOB_ID: '', TEMP: f.RUN, TMP: f.RUN, TMPDIR: f.RUN });
fallback.reset();
const registry = require('../common/members-store').create(path.join(f.root, 'state'));
registry.update(members.rev(), n => {
  const d = n.members.find(m => m.id === 'deepseek');
  d.roles = { ...d.roles, receives: true, sends: true, writer: true, voter: true };
  Object.assign(n, v46.forward(n));
}, { action: 'phase', who: 'claude', reason: 'тест матрицы team-v46', quote: 'тест' }, { phase: 'B' });
f.json(path.join(f.root, 'state/ready/team.json'), { pid: 7000, release: ROOT });
let seq = 0;
const tests = [], test = (name, fn) => tests.push([name, fn]);
const SENDERS = ['claude', 'codex', 'antigravity', 'deepseek'];
const RECEIVERS = ['claude', 'codex', 'antigravity', 'deepseek'];

test('Матрица 12 направлений: canSend и регистрация у гостей', () => {
  for (const from of SENDERS) for (const to of RECEIVERS) {
    if (from === to) continue;
    assert.equal(members.canSend(from, to), true, from + ' → ' + to);
  }
  for (const from of ['codex', 'antigravity', 'deepseek']) for (const to of RECEIVERS) {
    if (from === to) continue;
    assert.ok(access.guestTools(to, from).includes(to + '_send'), from + ' → ' + to + ' (гость)');
  }
  for (const to of ['codex', 'antigravity', 'deepseek'])
    assert.ok(access.guestTools(to, 'claude-print').includes(to + '_send'), 'claude-print → ' + to);
  // team-v48e Г4b: claude-print зовёт свой сервер claude безусловно (тумблер MOST_GUEST_STRICT удалён); claude_cancel НЕ выдаётся
  // (своих claude-потомков нет — claude→claude ловит lineageRefusal).
  assert.deepEqual(access.guestTools('claude', 'claude-print'), ['claude_status', 'claude_send', 'claude_result']);
  assert(!access.guestTools('claude', 'claude-print').includes('claude_cancel'), 'claude-print не получает claude_cancel на своём сервере');
  assert.deepEqual(access.guestTools('team', 'claude-print').sort(),
    ['team_status', 'team_rules', 'team_work', 'team_ask', 'team_ask_result'].sort());
});

test('claude-print — всегда гость; роли дирижёра не наследуются, запись — по реестру', () => {
  const parent = { id: 'v46-claude-current', member: 'claude', status: 'running', startedAt: new Date().toISOString() };
  f.json(path.join(f.stores.roots().claude, parent.id + '.json'), parent);
  Object.assign(process.env, fallback.jobEnv(parent.id));
  try {
    assert.equal(access.guest(), true);
    assert.equal(access.client(), 'claude-print');
    const m = members.memberForClient(access.client());
    assert.equal(m.roles.conductor, false);
    assert.equal(m.roles.fallback_conductor, false);
    assert.equal(m.roles.writer, true); // team-v46: writer по реестру (claude)
    assert.equal(members.canWrite('claude-print'), true);
  } finally { process.env.MOST_CLIENT = 'claude'; process.env.MOST_JOB_ID = ''; }
});

test('claude(чат) → T: access.guard разрешает все 4 направления', () => {
  process.env.MOST_CLIENT = 'claude';
  try {
    for (const to of RECEIVERS)
      assert.doesNotThrow(() => access.guard(to, to + '_send', { folder: f.project, task: 'прочитай', role: 'совет' }), 'claude → ' + to);
  } finally { process.env.MOST_CLIENT = 'claude'; }
});

test('claude_send: write допустим по реестру, full_access гостю — отказ', () => {
  process.env.MOST_CLIENT = 'claude';
  try {
    assert.doesNotThrow(() => access.guard('claude', 'claude_send', { folder: f.project, task: 'x', write: true, role: 'текст' }));
    assert.doesNotThrow(() => access.guard('claude', 'claude_send', { folder: f.project, task: 'x', full_access: true, write: true, role: 'совет' }));
  } finally { process.env.MOST_CLIENT = 'claude'; }
  process.env.MOST_CLIENT = 'codex';
  try {
    // team-v48e Г4b: полный доступ гостю открыт безусловно (тумблер MOST_GUEST_STRICT удалён; серверная карточка — Г4c).
    assert.doesNotThrow(() => access.guard('claude', 'claude_send', { folder: f.project, task: 'x', full_access: true, write: true, role: 'совет' }));
  } finally { process.env.MOST_CLIENT = 'claude'; }
});

test('Цепочка: S → claude-исполнитель разрешено; claude-исполнитель → S → claude — отказ', () => {
  const parentS = { id: 'p-codex', status: 'running', member: 'codex' };
  process.env.MOST_JOB_ID = 'p-codex';
  try {
    const r = chain.admit('claude', 'claude_send', {}, { cards: [parentS], ancestors: [{ pid: 999999 }] });
    assert.equal(r.parentJob, 'p-codex');
  } finally { process.env.MOST_JOB_ID = ''; }
  const parentClaude = { id: 'p-claude', status: 'running', member: 'claude' };
  process.env.MOST_JOB_ID = 'p-claude';
  try {
    assert.throws(() => chain.admit('claude', 'claude_send', {}, { cards: [parentClaude], ancestors: [{ pid: 999999 }] }),
      /получатель уже есть в цепочке/);
  } finally { process.env.MOST_JOB_ID = ''; }
});

test('team-v48e Г3: подпоручения — запись шире родителя и полный доступ допускаются безусловно (тумблер MOST_CHAIN_STRICT удалён)', () => {
  const p = { id: 'p-w', status: 'running', member: 'codex' };
  process.env.MOST_JOB_ID = 'p-w';
  try {
    assert.equal(chain.admit('deepseek', 'deepseek_send', { write: true }, { cards: [p], ancestors: [{ pid: 999999 }] }).parentJob, 'p-w', 'запись шире непишущего родителя допускается');
    assert.equal(chain.admit('deepseek', 'deepseek_send', { write: true, role: 'проверка' }, { cards: [{ ...p, write: true }], ancestors: [{ pid: 999999 }] }).parentJob, 'p-w');
    assert.equal(chain.admit('deepseek', 'deepseek_send', { full_access: true }, { cards: [p], ancestors: [{ pid: 999999 }] }).parentJob, 'p-w', 'полный доступ подпоручению допускается');
  } finally { process.env.MOST_JOB_ID = ''; }
});

test('job-chain: team из поручения по-прежнему отказ', () => {
  process.env.MOST_JOB_ID = 'p-codex';
  try {
    assert.throws(() => chain.admit('team', 'team_send', {}, { cards: [], ancestors: [{ pid: 999999 }] }),
      /team поручений не принимает/);
  } finally { process.env.MOST_JOB_ID = ''; }
});

test('claude.exe: buildArgs, editRule и missingFlags', () => {
  const args = claudeArgs.buildArgs({ mcpConfig: 'C:/j/mcp.json', settings: 'C:/j/settings.json' }, {});
  assert.equal(args[0], '-p');
  assert.equal(args.includes('--strict-mcp-config'), true);
  const tools = args[args.indexOf('--tools') + 1];
  for (const forbidden of ['Edit', 'Write', 'Bash', 'NotebookEdit'])
    assert.ok(!tools.split(',').includes(forbidden), 'в --tools не должно быть ' + forbidden);
  // Запись: в --allowedTools появляется Edit с путём диска Windows.
  const w = claudeArgs.buildArgs({ mcpConfig: 'm', settings: 's' }, {}, { write: true, folder: 'E:\\work\\dir' });
  assert.ok(w.some(a => /^Edit\(/.test(a)), 'write добавляет Edit с путём');
  assert.ok(w.includes('--permission-mode'));
  const full = claudeArgs.buildArgs({ mcpConfig: 'm', settings: 's' }, {}, { fullAccessApplied: true, folder: 'E:\\work\\dir' });
  assert.ok(full[full.indexOf('--tools') + 1].split(',').includes('Bash'));
  assert.ok(w[w.indexOf('--tools') + 1].split(',').includes('Edit'));
  assert.ok(!w[w.indexOf('--tools') + 1].split(',').includes('Bash'));
  assert.equal(claudeArgs.editRule('E:\\work\\dir'), 'Edit(//e/work/dir/**)'); // team-v48b: формат, который принимает Claude Code
  assert.ok(!args.some(a => String(a).includes('прочитай файл probe')), 'задание не должно попадать в argv');
  const help = claudeArgs.REQUIRED_FLAGS.join(' ');
  assert.deepEqual(claudeArgs.missingFlags(help), []);
  assert.deepEqual(claudeArgs.REQUIRED_FLAGS, ['-p', '--tools', '--strict-mcp-config', '--mcp-config', '--permission-mode', '--output-format']);
  for (const flag of claudeArgs.REQUIRED_FLAGS)
    assert.deepEqual(claudeArgs.missingFlags(claudeArgs.REQUIRED_FLAGS.filter(f => f !== flag).join(' ')), [flag]);
  assert.ok(claudeArgs.missingFlags('--print --tools-extra --permission-mode').includes('-p'));
  assert.ok(claudeArgs.missingFlags('--print --tools-extra --permission-mode').includes('--tools'));
  const files = { mcpConfig: 'm', settings: 's' };
  for (const optional of claudeArgs.OPTIONAL_FLAGS) {
    assert.ok(!claudeArgs.buildArgs(files, {}, {}, help).includes(optional));
    const supported = claudeArgs.buildArgs(files, { max_turns: 7 }, {}, help + ' ' + optional);
    assert.ok(supported.includes(optional));
    if (optional === '--max-turns') assert.equal(supported[supported.indexOf(optional) + 1], '7');
    if (optional === '--setting-sources') assert.equal(supported[supported.indexOf(optional) + 1], '');
    for (const other of claudeArgs.OPTIONAL_FLAGS.filter(f => f !== optional)) assert.ok(!supported.includes(other));
  }
  // Справка 2.1.198 не перечисляет --max-turns: запуск не блокируется, флаг не добавляется.
  const installedHelp = help + ' --no-session-persistence --setting-sources --settings';
  assert.deepEqual(claudeArgs.missingFlags(installedHelp), []);
  assert.ok(!claudeArgs.buildArgs(files, {}, {}, installedHelp).includes('--max-turns'));
});

test('Миграция team-v46: receives, нет limit_5h, маски claude и team_ask; откат снимает', () => {
  const roster = members.snapshot();
  const fw = v46.forward(roster);
  assert.equal(fw.members.find(m => m.id === 'claude').roles.receives, true);
  assert.equal(fw.members.find(m => m.id === 'claude').adapter_params.limit_5h, undefined);
  const agy = fw.members.find(m => m.id === 'antigravity');
  assert.ok(agy.mcp_allow.includes('claude/claude_send'));
  assert.ok(agy.mcp_allow.includes('team/team_ask'));
  assert.ok(agy.mcp_allow.includes('team/team_ask_result'));
  assert.ok(members.serversForInstall(fw).includes('claude'));
  const back = v46.rollback(fw);
  assert.equal(back.members.find(m => m.id === 'claude').roles.receives, false);
  assert.ok(!back.members.find(m => m.id === 'antigravity').mcp_allow.some(x => /^claude\//.test(x) || ['team/team_ask', 'team/team_ask_result'].includes(x)));
  assert.ok(!members.serversForInstall(back).includes('claude'));
});

test('Сроки: своего срока нет даже при заданных прежних переменных; срок родителя из карточки передаётся ребёнку (− 3 мин) и отказывает при остатке ≤ 3 мин', () => {
  // team-v48e «нет срока» (§2.6/§3): сроковые тумблеры MOST_*_TIMEOUT_MS удалены — обычный срок всегда null, даже если
  // прежние переменные выставлены. Передача срока РОДИТЕЛЯ сохраняется, но берётся из его карточки (deadline), не из тумблера.
  const savedC = process.env.MOST_CODEX_TIMEOUT_MS, savedCl = process.env.MOST_CLAUDE_TIMEOUT_MS;
  process.env.MOST_CODEX_TIMEOUT_MS = '3600000'; process.env.MOST_CLAUDE_TIMEOUT_MS = '3600000';
  try {
    const now = Date.now();
    // (1) Родителя-ребёнка без deadline в карточке (только startedAt) — своего обычного срока нет, тумблеры игнорируются: deadline null, без ошибки.
    const r = deadline.childDeadline({ startedAt: new Date(now - 60000).toISOString() }, 'codex', 'claude', now);
    assert.equal(r.deadline, null); assert.equal(r.error, null);
    // (2) Срок родителя задан в его карточке (данные карточки соблюдаются) — ребёнок не позже срока родителя − 3 мин.
    const r2 = deadline.childDeadline({ deadline: new Date(now + 10 * 60000).toISOString() }, 'codex', 'claude', now);
    assert.ok(r2.deadline); assert.ok(Date.parse(r2.deadline) <= now + 7 * 60000, 'не позже срока родителя − 3 мин');
    // (3) Остаток срока родителя ≤ 3 мин — отказ (ровно 3 мин тоже отказ).
    const r3 = deadline.childDeadline({ deadline: new Date(now + 3 * 60000).toISOString() }, 'codex', 'claude', now);
    assert.equal(r3.deadline, null); assert.match(r3.error, /не хватает времени/);
    assert.equal(deadline.deadlinePassed({ deadline: new Date(Date.now() - 1000).toISOString() }), true);
    assert.equal(deadline.parentTerminal({ parentJob: 'p-done' }, [{ id: 'p-done', status: 'done' }]), true);
    assert.equal(deadline.parentTerminal({ parentJob: 'p-run' }, [{ id: 'p-run', status: 'running' }]), false);
  } finally {
    if (savedC === undefined) delete process.env.MOST_CODEX_TIMEOUT_MS; else process.env.MOST_CODEX_TIMEOUT_MS = savedC;
    if (savedCl === undefined) delete process.env.MOST_CLAUDE_TIMEOUT_MS; else process.env.MOST_CLAUDE_TIMEOUT_MS = savedCl;
  }
});

test('Общий замок записи: граница сегмента, вложенность, junction', async () => {
  const base = fs.mkdtempSync(path.join(f.RUN, 'wl-'));
  const a = path.join(base, 'dir'), b = path.join(base, 'dir2'), c = path.join(base, 'dir', 'sub');
  for (const d of [a, b, c]) fs.mkdirSync(d, { recursive: true });
  assert.equal(writeLock.conflict(a, b), false, 'E:\\work\\dir и E:\\work\\dir2 не конфликтуют');
  const l1 = await writeLock.acquire(a, { jobId: 'j1' });
  assert.ok(l1.ok);
  const l2 = await writeLock.acquire(c, { jobId: 'j2' });
  assert.equal(l2.ok, false, 'вложенная папка конфликтует');
  const l3 = await writeLock.acquire(b, { jobId: 'j3' });
  assert.ok(l3.ok, 'соседняя папка не конфликтует');
  await l1.release(); await l3.release();
  const l4 = await writeLock.acquire(c, { jobId: 'j4' });
  assert.ok(l4.ok, 'после снятия замка вложенная папка свободна');
  await l4.release();
});

test('fix7: устаревший мьютекс восстанавливается; гонка сохраняет нового живого владельца', () => {
  const mutex = path.join(writeLock.dir(), '.mutex'), recovery = mutex + '-recovery';
  const folder = fs.mkdtempSync(path.join(f.RUN, 'fix7-lock-'));
  const read = fs.readFileSync, kill = process.kill, unlink = fs.unlinkSync;
  const dead = 2147483647, live = JSON.stringify({ pid: process.pid, at: 'new-owner' });
  let switched = false, removed = false;
  fs.mkdirSync(writeLock.dir(), { recursive: true });
  fs.writeFileSync(mutex, JSON.stringify({ pid: dead }));
  process.kill = (pid, ...args) => { if (pid === dead) throw Object.assign(Error('dead'), { code: 'ESRCH' }); return kill(pid, ...args); };
  fs.readFileSync = (file, ...args) => {
    const value = read(file, ...args);
    if (file === mutex && !switched) { switched = true; fs.writeFileSync(mutex, live); }
    return value;
  };
  fs.unlinkSync = (file, ...args) => { if (file === mutex) removed = true; return unlink(file, ...args); };
  try {
    assert.throws(() => writeLock.acquire(folder), /Замок записи занят/);
    assert.ok(switched, 'другой процесс успел восстановить мьютекс после первого чтения');
    assert.equal(removed, false, 'живой мьютекс не удалён');
    assert.equal(read(mutex, 'utf8'), live);
    assert.equal(fs.existsSync(writeLock.entryFile(require('../common/paths').canon(folder))), false);
    assert.equal(fs.existsSync(recovery), false, 'замок восстановления освобождён');
  } finally {
    fs.readFileSync = read; fs.unlinkSync = unlink;
    // Тестовый владелец завершился: штатное восстановление, без ручного удаления файлов.
    fs.writeFileSync(mutex, JSON.stringify({ pid: dead }));
    try { const lock = writeLock.acquire(folder); assert.ok(lock.ok); lock.release(); }
    finally { process.kill = kill; }
  }
});

test('Общее правило папок п.5а (MOST_PROTECT_BRIDGE): корень/клон/релиз — отказ; дирижёр + своя .work (три случая)', () => {
  const root = f.root;
  for (const d of [path.join(root, 'common'), path.join(root, 'live', 'hash'), path.join(root, '.work', 'other')])
    fs.mkdirSync(d, { recursive: true });
  // team-v48e Г4a: папочный запрет снят безусловно (refusal→null для существующих абсолютных папок); проверка «абсолютная
  // существующая папка» — всегда. Тумблер MOST_PROTECT_BRIDGE удалён — даже при его выставлении защита не возвращается.
  assert.equal(writeFolder.refusal(path.join(root, 'common'), {}), null);
  assert.match(writeFolder.refusal('относительный-путь', {}), /Нужна абсолютная существующая папка/);
  process.env.MOST_PROTECT_BRIDGE = '1';
  try {
    assert.equal(writeFolder.refusal(path.join(root, 'common'), {}), null, 'MOST_PROTECT_BRIDGE не возвращает папочный запрет (common)');
    assert.equal(writeFolder.refusal(path.join(root, 'live', 'hash'), {}), null, 'MOST_PROTECT_BRIDGE не возвращает папочный запрет (live/hash)');
    assert.equal(writeFolder.refusal(path.join(root, '.work', 'other'), {}), null, 'MOST_PROTECT_BRIDGE не возвращает папочный запрет (.work)');
  } finally { delete process.env.MOST_PROTECT_BRIDGE; }
});

test('Происхождение: parent() с byAncestors=false — процесса среди предков нет', () => {
  const job = { id: 'p-anc', status: 'running', member: 'codex', childPid: 12345, startedAt: new Date().toISOString() };
  process.env.MOST_JOB_ID = 'p-anc';
  try {
    const p = chain.parent([job], [{ pid: 999999, startedAt: new Date().toISOString() }]);
    assert.equal(p.error, undefined);
    assert.equal(p.byAncestors, false, 'процесса среди предков нет — byAncestors=false');
  } finally { process.env.MOST_JOB_ID = ''; }
});

test('Входящие: author по происхождению, сроки, баннер', () => {
  process.env.MOST_JOB_ID = '';
  const a = inbox.author();
  assert.equal(a.kind, 'chat');
  const dl = inbox.askDeadline({}, { kind: 'chat', client: 'codex' }, Date.now());
  assert.ok(Date.parse(dl) - Date.now() <= 24 * 3600000 + 1000);
  const jdl = inbox.askDeadline({ ttl_min: 60 }, { kind: 'job', job: { deadline: new Date(Date.now() + 10 * 60000).toISOString() } }, Date.now());
  assert.ok(Date.parse(jdl) <= Date.now() + 8 * 60000, 'не позже остатка родителя − 2 мин');
  assert.equal(inbox.banner(0), ''); // без входящих — пусто
});

test('Codex findCli: неполная папка bin отвергается; CODEX_PATH принимается как есть', () => {
  const cb = require('../common/codex-binary');
  const tmp = fs.mkdtempSync(path.join(f.RUN, 'bin-'));
  const old = path.join(tmp, 'a'), fresh = path.join(tmp, 'b'), newest = path.join(tmp, 'c');
  for (const d of [old, fresh, newest]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(old, 'codex.exe'), 'x');
  fs.writeFileSync(path.join(fresh, 'codex.exe'), 'x');
  fs.writeFileSync(path.join(fresh, 'codex-code-mode-host.exe'), 'x');
  fs.writeFileSync(path.join(newest, 'codex.exe'), 'x');
  fs.utimesSync(path.join(fresh, 'codex.exe'), new Date(), new Date(Date.now() + 2000));
  fs.utimesSync(path.join(newest, 'codex.exe'), new Date(), new Date(Date.now() + 4000));
  assert.equal(cb.complete(path.join(old, 'codex.exe')), false);
  assert.equal(cb.complete(path.join(newest, 'codex.exe')), false);
  assert.equal(cb.complete(path.join(fresh, 'codex.exe')), true);
  assert.equal(cb.findInBin(tmp), path.join(fresh, 'codex.exe'));
  // Явный CODEX_PATH вне раскладки приложения принимается как есть, без проверки полной папки.
  assert.equal(cb.findCli({ CODEX_PATH: path.join(newest, 'codex.exe') }), path.join(newest, 'codex.exe'));
  assert.equal(cb.findCli({ CODEX_PATH: path.join(fresh, 'codex.exe') }), path.join(fresh, 'codex.exe'));
});

test('models-622 Codex: при обновлённом пакете приложения, не разложенном в bin, берётся свежий CLI из WindowsApps; самый свежий — при раскладке в bin', () => {
  const cb = require('../common/codex-binary');
  const base = fs.mkdtempSync(path.join(f.RUN, 'codex-src-'));
  const local = path.join(base, 'Local'), pf = path.join(base, 'ProgramFiles');
  const bin = path.join(local, 'OpenAI', 'Codex', 'bin');
  const binOld = path.join(bin, 'aaaa000000000000');
  const pkg = path.join(pf, 'WindowsApps', 'OpenAI.Codex_26.1117.4957.0_x64__2p2nqsd0c76g0', 'app', 'resources');
  for (const d of [binOld, pkg]) fs.mkdirSync(d, { recursive: true });
  // Полная папка в bin (старая, выложена приложением) и полный CLI внутри обновлённого пакета приложения.
  for (const d of [binOld, pkg]) { fs.writeFileSync(path.join(d, 'codex.exe'), 'x'); fs.writeFileSync(path.join(d, 'codex-code-mode-host.exe'), 'x'); }
  const env = { LOCALAPPDATA: local, ProgramFiles: pf };
  // Пакет приложения свежее разложенного в bin — выбирается CLI из пакета (путь к версии не захардкожен).
  fs.utimesSync(path.join(binOld, 'codex.exe'), new Date(), new Date(Date.now() - 4000));
  fs.utimesSync(path.join(pkg, 'codex.exe'), new Date(), new Date(Date.now() + 4000));
  assert.equal(cb.findInWindowsApps(env), path.join(pkg, 'codex.exe'));
  assert.equal(cb.findCli(env), path.join(pkg, 'codex.exe'));
  // Приложение разложило свежий CLI в bin\<хеш> — он новее пакета и выбирается он (исполнение остаётся в bin).
  const binNew = path.join(bin, 'bbbb111111111111');
  fs.mkdirSync(binNew);
  fs.writeFileSync(path.join(binNew, 'codex.exe'), 'x'); fs.writeFileSync(path.join(binNew, 'codex-code-mode-host.exe'), 'x');
  fs.utimesSync(path.join(binNew, 'codex.exe'), new Date(), new Date(Date.now() + 8000));
  assert.equal(cb.findCli(env), path.join(binNew, 'codex.exe'));
  // Неполный пакет приложения (без host) игнорируется — свежесть не спасает неполную раскладку.
  const bad = path.join(pf, 'WindowsApps', 'OpenAI.Codex_99.0.0.0_x64__2p2nqsd0c76g0', 'app', 'resources');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'codex.exe'), 'x');
  fs.utimesSync(path.join(bad, 'codex.exe'), new Date(), new Date(Date.now() + 16000));
  assert.equal(cb.findInWindowsApps(env), path.join(pkg, 'codex.exe'));
});

async function client(who, clientName, p, fn) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(ROOT, 'servers', who, 'index.js')], stderr: 'pipe', env: { ...process.env,
      MOST_CLIENT: p ? 'job' : clientName, MOST_JOB_ID: p?.id || '', MOST_PROBE_ONLY: '1', MOST_PROBE_GUEST: 'full', MOST_DSH_NO_PROFILES: '1',
      MOST_AGY_INPUT_FORMAT: 'legacy', AGY_PATH: path.join(__dirname, 'fake-agy.js'),
      MOST_JOURNAL: path.join(f.RUN, 'agy.log'), MOST_INPUT_DIR: path.join(f.RUN, 'input'),
      MOST_AGY_CONFIG: path.join(f.RUN, 'permissions.json'), MOST_AGY_QUOTA_FILE: path.join(f.RUN, 'quota.json'),
      MOST_CODEX_CONFIG: path.join(f.RUN, 'missing.toml'), MOST_AGY_MCP_CONFIG: path.join(f.RUN, 'missing.json'),
      MOST_DSH_CONFIG: path.join(f.RUN, 'missing.yml'), MOST_DSH_RULES: path.join(f.RUN, 'missing-dsh.md'),
      MOST_AGY_RULES: path.join(f.RUN, 'missing-agy.md'), MOST_CODEX_RULES: path.join(f.RUN, 'missing-codex.md'),
    } });
  const c = new Client({ name: 'v46', version: '1' });
  try { await c.connect(transport); await fn(c); } finally { await c.close(); }
}
const text = r => (r.content || []).map(c => c.text || '').join('\n');

test('claude_send: роль «проверка» допускается (без голоса), full_access гостю — отказ', async () => {
  await client('claude', 'codex', null, async c => {
    const r = await c.callTool({ name: 'claude_send', arguments: { folder: f.project, task: 'прочитай файл', role: 'проверка' } });
    assert(!r.isError, text(r));
  });
  // team-v48e Г4c: гость получает полный доступ Claude безусловно (серверная карточка fullAccessAllowed; тумблер MOST_GUEST_STRICT удалён).
  await client('claude', 'codex', null, async c => {
    const r = await c.callTool({ name: 'claude_send', arguments: { folder: f.project, task: 'x', write: true, full_access: true, role: 'совет' } });
    assert(!r.isError, 'полный доступ гостю открыт: ' + text(r));
  });
  // Даже при выставленной прежней переменной полный доступ остаётся открыт — тумблер удалён.
  process.env.MOST_GUEST_STRICT = '1';
  try {
    await client('claude', 'codex', null, async c => {
      const r = await c.callTool({ name: 'claude_send', arguments: { folder: f.project, task: 'x', write: true, full_access: true, role: 'совет' } });
      assert(!r.isError, 'MOST_GUEST_STRICT не ограничивает: ' + text(r));
    });
  } finally { delete process.env.MOST_GUEST_STRICT; }
});

test('team-v48e Г4c: claude fullAccessAllowed и бан записи гостю сняты безусловно (тумблер MOST_GUEST_STRICT удалён)', async () => {
  const Module = require('module'), file = path.join(ROOT, 'servers/claude/index.js');
  const src = fs.readFileSync(file, 'utf8'), end = src.indexOf('\n(async () => {');
  assert(end > 0);
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src.slice(0, end) + '\nmodule.exports = { fullAccessAllowed };', file);
  const api = m.exports;
  // (1) fullAccessAllowed: полный доступ гостю/подпоручению/чату безусловно; даже при выставленной прежней переменной остаётся открыт.
  for (const patch of [{ from: 'antigravity' }, { parentJob: 'p1' }, { fallbackWord: 'w' }, { fromChat: 'claude', from: 'claude' }]) {
    const card = { role: 'совет', write: true, fullAccess: true, from: 'claude', ...patch };
    assert(api.fullAccessAllowed(card), 'полный доступ: ' + JSON.stringify(patch));
    process.env.MOST_GUEST_STRICT = '1';
    try { assert(api.fullAccessAllowed(card), 'MOST_GUEST_STRICT не ограничивает: ' + JSON.stringify(patch)); } finally { delete process.env.MOST_GUEST_STRICT; }
  }
  assert(!api.fullAccessAllowed({ role: 'совет', write: false, fullAccess: true }));
  assert(!api.fullAccessAllowed({ role: 'проверка', write: true, fullAccess: true }));
  // (2) Реальный обработчик: гость claude_send с write (без full_access) к существующей абсолютной папке — принят
  // (серверный бан записи гостю снят безусловно, тумблер MOST_GUEST_STRICT удалён); относительная папка — отказ того же
  // обработчика «Нужна абсолютная существующая папка» (подлинность пути, не бан гостя). Без срезов и подмен (§4).
  await client('claude', 'codex', null, async c => {
    const ok = await c.callTool({ name: 'claude_send', arguments: { folder: f.project, task: 'x', write: true, role: 'совет' } });
    assert(!ok.isError, 'запись гостю открыта: ' + text(ok));
    const bad = await c.callTool({ name: 'claude_send', arguments: { folder: 'относительная', task: 'x', write: true, role: 'совет' } });
    assert(bad.isError); assert.match(text(bad), /Нужна абсолютная существующая папка/);
  });
});

test('claude_status у гостя-отправителя зарегистрирован и отвечает (счётчик без лимита)', async () => {
  await client('claude', 'codex', null, async c => {
    const r = await c.callTool({ name: 'claude_status', arguments: {} });
    assert(!r.isError, text(r));
    assert.match(text(r), /счётчик расхода, не квота провайдера/);
  });
});


test('Antigravity: 2000 done с parentJob — проход очереди < 6 с без job-chain.cards()', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'servers/antigravity/index.js'), 'utf8');
  const jobsDir = fs.mkdtempSync(path.join(f.RUN, 'agy-done-'));
  for (let i = 0; i < 2000; i++) {
    const id = 'done-' + i;
    f.json(path.join(jobsDir, id, 'card.json'), { id, status: 'done', parentJob: 'finished-parent' });
  }
  // Настоящие чтение карточек и цикл очереди, без запуска сервера и таймеров.
  const section = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, 'границы исходного кода: ' + start);
    return source.slice(a, b);
  };
  const sandbox = {
    fs, path, JOBS_DIR: jobsDir, access: { guest: () => false },
    shuttingDown: false, instancePipeOk: true, errText: String,
    updateJob: () => { throw Error('завершённая карточка не должна изменяться'); },
    require: require('module').createRequire(path.join(ROOT, 'servers/antigravity/index.js')),
  };
  require('vm').runInNewContext(
    section('function jobDir(id)', 'function resultPath(id)') +
    section('function loadJob(id)', 'function readResult(job)') +
    section('let scanning = false;', '// ---------- запуск ----------') +
    '\nthis.tick = resumeQueue; this.readJobs = listJobs;', sandbox);
  assert.equal(sandbox.readJobs().length, 2000, 'все карточки прочитаны из хранилища');
  const originalCards = chain.cards;
  let calls = 0, elapsed;
  // Не читаем всё хранилище на каждом ошибочном вызове: база падает быстро.
  chain.cards = () => { calls++; return []; };
  try {
    const start = process.hrtime.bigint();
    await sandbox.tick();
    elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  } finally { chain.cards = originalCards; }
  console.log('Antigravity queue: ' + elapsed.toFixed(1) + ' ms, cards=' + calls);
  assert.equal(calls, 0, 'done не должны вызывать job-chain.cards()');
  assert.ok(elapsed < 6000, 'один проход занял ' + elapsed.toFixed(1) + ' мс');
});

test('Antigravity: первый непосредственный resumeQueue — после server.connect', () => {
  const source = fs.readFileSync(path.join(ROOT, 'servers/antigravity/index.js'), 'utf8');
  const startup = source.slice(source.indexOf('// ---------- запуск ----------'));
  const connect = startup.indexOf('await server.connect(transport);');
  // Отложенный callback setInterval не является непосредственным стартовым вызовом.
  const calls = [...startup.matchAll(/^\s*(?:if\s*\([^\r\n]*\)\s*)?(?:await\s+)?resumeQueue\(\)/gm)];
  assert.ok(connect >= 0 && calls.length > 0, 'подключение и стартовый вызов найдены');
  assert.ok(calls[0].index > connect, 'первый resumeQueue должен идти после await server.connect');
});

test('deploy: проба серверов со сроком 60 с (MOST_DEPLOY_PROBE_MS переопределяет)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'common', 'deploy.js'), 'utf8');
  const calls = src.split('require(\'./probe\').probe)(').length - 1;
  assert.equal(calls, 2, 'два вызова probe в deploy.js');
  assert.equal((src.match(/probeDeployMs\(\)/g) || []).length, 2, 'оба вызова передают probeDeployMs()');
  assert.match(src, /const probeDeployMs = \(\) => Number\(process\.env\.MOST_DEPLOY_PROBE_MS\) \|\| 60000;/);
});
test('PowerShell из node: вход закрыт, срок 120 с (замер 29.10: 58 с со входом, 18 с без)', () => {
  const fs = require('fs'), p = require('path');
  for (const name of ['restart-hold', 'fallback', 'live-jobs', 'cleanup', 'fallback-detect']) {
    const src = fs.readFileSync(p.join(__dirname, '..', 'common', name + '.js'), 'utf8');
    const at = src.indexOf("'powershell.exe'"); assert.ok(at >= 0, name);
    const opts = src.slice(at, src.indexOf('}', src.indexOf('{ encoding', at)) + 1);
    assert.match(opts, /stdio: \['ignore', 'pipe', 'pipe'\]/, name + ': вход PowerShell закрыт');
    assert.match(opts, /timeout: 120000/, name + ': срок 120 с');
  }
});
test('допуск: сторож родителя — alive только по текущему состоянию (сторож жив → родитель жив → сторож жив) и совпавшему времени запуска', () => {
  const rh = require('../common/restart-hold');
  const { EventEmitter } = require('events');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'common', 'restart-hold.js'), 'utf8');
  assert.match(src, /const watched = !deps\.fingerprint && directParentState\(server\.parent\);\n    if \(watched === 'pending'\) return refusal\('starting'\);\n    const parent = watched \|\| processState\(server\.parent, deps\);/);
  assert.match(src, /  if \(!Object\.keys\(deps\)\.length\) watchParent\(\{\}, state\);\n  return s;\n\}/, 'сторож только у вызова без подмен и после снимка');
  assert.match(src, /\$h=\$p\.Handle; \$s=Get-Process -Id " \+ self \+ "; \$sh=\$s\.Handle;/, 'дескрипторы родителя и сервера открыты до чтения времени');
  assert.match(src, /\[IO\.File\]::WriteAllText\(/, 'время запуска сторож пишет и в файл');
  assert.match(src, /\[Console\]::Out\.WriteLine\(\$t\)/, 'и сразу в поток');
  assert.match(src, /while \(-not \$p\.HasExited -and -not \$s\.HasExited\)/, 'сторож выходит и при смерти сервера');
  const started = '2026-10-29T10:00:00.000Z', parent = { pid: process.ppid, startedAt: started };
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {}; child.pid = 777001;
  let spawned;
  const w = rh.watchParent({ spawnWatch: (ppid, self) => { spawned = [ppid, self]; return child; } });
  assert.deepEqual(spawned, [process.ppid, process.pid]);
  const live = new Set([777001, process.ppid]), calls = [];
  const kill = (pid) => { calls.push(pid); if (!live.has(pid)) throw Object.assign(Error('нет'), { code: 'ESRCH' }); return true; };
  assert.equal(rh.directParentState(parent, w, kill), 'pending', 'сторож ещё не ответил — «готовится», без синхронного PowerShell');
  child.stdout.emit('data', '2026-10-29T10:00:00.4000000Z\r\n');
  calls.length = 0;
  assert.equal(rh.directParentState(parent, w, kill), 'alive', 'то же время запуска, сторож и родитель живы');
  assert.deepEqual(calls, [777001, process.ppid, 777001], 'порядок: сторож, родитель, сторож');
  assert.equal(rh.directParentState({ pid: process.ppid, startedAt: '2026-10-29T10:05:00.000Z' }, w, kill), null, 'другое время запуска — прежняя проверка');
  assert.equal(rh.directParentState({ pid: process.ppid + 1, startedAt: started }, w, kill), null, 'не прямой родитель — прежняя проверка');
  assert.equal(rh.directParentState(parent, null, kill), null, 'нет сторожа — прежняя проверка');
  live.delete(777001);
  assert.equal(rh.directParentState(parent, w, kill), null, 'сторож уже умер, а exit ещё не обработан (флаг устарел) — прежняя проверка, не alive');
  live.add(777001); live.delete(process.ppid);
  assert.equal(rh.directParentState(parent, w, kill), null, 'родитель умер, exit сторожа не обработан — прежняя проверка (вернёт old)');
  live.add(process.ppid);
  let n = 0; const flaky = (pid) => { if (pid === 777001 && ++n === 2) throw Object.assign(Error('нет'), { code: 'ESRCH' }); return true; };
  assert.equal(rh.directParentState(parent, w, flaky), null, 'сторож умер между проверками — прежняя проверка');
  // Ответ через файл, если канал молчит.
  const fs2 = require('fs'), os2 = require('os'), p2 = require('path');
  const mark = p2.join(fs2.mkdtempSync(p2.join(os2.tmpdir(), 'v46-mark-')), 'w.watch');
  const wf = { pid: process.ppid, startedAt: null, child: { pid: 777001 }, exitCode: null, spawnedAt: Date.now(), markFile: mark };
  assert.equal(rh.directParentState(parent, wf, kill), 'pending', 'файла ещё нет');
  fs2.writeFileSync(mark, '2026-10-2');
  assert.equal(rh.directParentState(parent, wf, kill), 'pending', 'недописанный файл не принимается');
  fs2.writeFileSync(mark, '2026-10-29T10:00:00.4000000Z');
  assert.equal(rh.directParentState(parent, wf, kill), 'alive', 'время запуска из файла сторожа');
  child.emit('exit', 3);
  assert.equal(rh.directParentState(parent, w, kill), null, 'сторож вышел из-за смерти сервера (3) — прежняя проверка');
  w.exitCode = 0;
  assert.equal(rh.directParentState(parent, w, kill), 'dead', 'родитель завершился (0) — dead');
  rh.resetParentWatch();
  assert.equal(rh.watchParent({}), null, 'в тестах (NODE_ENV=test) настоящий сторож не запускается');
  rh.resetParentWatch();
  assert.match(src, /e\.code === 'EPERM' \|\| e\.code === 'EACCES' \? true/);
});
test('старт сервера: свой отпечаток из снимка процессов, без второго PowerShell', () => {
  const rh = require('../common/restart-hold'), fs = require('fs'), os = require('os'), p = require('path');
  const state = fs.mkdtempSync(p.join(os.tmpdir(), 'v46-self-'));
  const rows = [{ pid: process.pid, ppid: 4242, name: 'node.exe', startedAt: '2026-10-29T10:00:05.000Z' }, { pid: 4242, ppid: 4, name: 'claude.exe', startedAt: '2026-10-29T10:00:00.000Z' }];
  const src = fs.readFileSync(p.join(__dirname, '..', 'common', 'restart-hold.js'), 'utf8');
  assert.match(src, /process: \(!deps\.fingerprint && s\.self\) \|\| \(deps\.fingerprint \|\| fingerprint\)\(process\.pid\)/);
  const s = rh.capture({ processTable: () => rows });
  assert.deepEqual(s.self, { pid: process.pid, startedAt: '2026-10-29T10:00:05.000Z', name: 'node.exe' });
  const saved = rh.server(state, 'self-test', { processTable: () => rows });
  const file = JSON.parse(fs.readFileSync(p.join(state, 'restart-servers', process.pid + '.json'), 'utf8'));
  assert.deepEqual(file.process, saved.self, 'в файл сервера записан отпечаток из снимка');
  fs.rmSync(state, { recursive: true, force: true });
});
test('старт сервера: снимок процессов асинхронно, до ответа admit — starting', async () => {
  const rh = require('../common/restart-hold'), fs = require('fs'), os = require('os'), p = require('path');
  for (const s of ['codex', 'deepseek', 'claude']) assert.match(fs.readFileSync(p.join(__dirname, '..', 'servers', s, 'index.js'), 'utf8'), new RegExp("restartServer = access\\.guest\\(\\) \\? null : restartHold\\.serverAsync\\(stateDir, '" + s + "'\\);"));
  assert.match(fs.readFileSync(p.join(__dirname, '..', 'servers', 'antigravity', 'index.js'), 'utf8'), /restartServer = access\.guest\(\) \? null : restartHold\.serverAsync\(STATE_DIR, 'antigravity'\);/);
  const state = fs.mkdtempSync(p.join(os.tmpdir(), 'v46-async-'));
  const src0 = () => fs.readFileSync(p.join(__dirname, '..', 'common', 'restart-hold.js'), 'utf8');
  let resolve; const s = rh.serverAsync(state, 'async-test', { processTableAsync: () => new Promise(r => { resolve = r; }) });
  assert.equal(s.pending, true);
  assert.equal(rh.admit(state, s, {}).kind === 'members' || rh.admit(state, s, {}).kind === 'starting', true);
  s.closed = true;
  resolve([{ pid: process.pid, ppid: 4242, name: 'node.exe', startedAt: '2026-10-29T10:00:05.000Z' }, { pid: 4242, ppid: 4, name: 'claude.exe', startedAt: '2026-10-29T10:00:00.000Z' }]);
  await s.ready;
  assert.equal(s.pending, undefined);
  assert.equal(s.parent.name, 'claude.exe');
  assert.equal(s.closed, true, 'closed до готовности снимка сохраняется');
  assert.ok(fs.existsSync(p.join(state, 'restart-servers', process.pid + '.json')));
  let calls = 0;
  const e = rh.serverAsync(state, 'async-fail', { captureTries: 3, captureRetryMs: 1, processTableAsync: () => { calls++; return Promise.reject(Error('ETIMEDOUT')); } });
  assert.equal(rh.admit(state, e, {}).kind === 'members' || rh.admit(state, e, {}).kind === 'starting', true, 'пока повторы — «готовится», без синхронного снимка');
  await e.ready;
  assert.equal(calls, 3, 'асинхронные повторы'); assert.equal(e.error, 'ETIMEDOUT'); assert.equal(e.pending, undefined);
  let k = 0;
  const r = rh.serverAsync(state, 'async-retry', { captureRetryMs: 1, processTableAsync: () => ++k < 2 ? Promise.reject(Error('сбой')) : Promise.resolve([{ pid: process.pid, ppid: 4242, name: 'node.exe', startedAt: '2026-10-29T10:00:05.000Z' }, { pid: 4242, ppid: 4, name: 'claude.exe', startedAt: '2026-10-29T10:00:00.000Z' }]) });
  await r.ready;
  assert.equal(r.error, undefined); assert.equal(r.parent.name, 'claude.exe', 'после сбоя второй снимок удался');
  assert.match(src0(), /const retryDue = server\.error && !server\.async &&/);
  const src = fs.readFileSync(p.join(__dirname, '..', 'common', 'restart-hold.js'), 'utf8');
  assert.match(src, /if \(server\.pending\) return refusal\('starting'\);/);
  fs.rmSync(state, { recursive: true, force: true });
});
test('antigravity: очередь не перечитывает завершённые карточки, уборка — после подключения', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'servers', 'antigravity', 'index.js'), 'utf8');
  assert.match(src, /function queueJobs\(\) \{/);
  assert.match(src, /if \(k && k\.mtimeMs === st\.mtimeMs && k\.size === st\.size\) continue;/);
  const rq = src.slice(src.indexOf('async function resumeQueue()'), src.indexOf('// ---------- запуск ----------'));
  assert.equal((rq.match(/listJobs\(\)/g) || []).length, 0, 'resumeQueue не вызывает listJobs()');
  assert.equal((rq.match(/queueJobs\(\)/g) || []).length, 3);
  // team-v62 обернул уборку в waitPrimary().then (уборка — после первичной миграции): обновлённая форма строки.
  assert.match(src, /setTimeout\(\(\) => \{ require\('\.\.\/\.\.\/common\/state-migration'\)\.waitPrimary\(\)\.then\(\(\) => \{ try \{ pruneOld\(\); \} catch \(e\) \{ log\(errText\(e\)\); \} \}\); \}, 120000\)\.unref\(\);/);
});
require('./team-v46-fix5')({ test, f, client, text });
require('./team-v46-fix6')({ test, f, client, text });
require('./team-v48-adapters')({ test, f, client, text });
f.run(process.env.MOST_FIX6_ONLY ? tests.filter(([name]) => name.startsWith('fix6 ')) : tests);
