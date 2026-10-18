'use strict';
// team-v22, замысел ред. 4, #7b387133. Только изолированные данные внутри клона.
// О9 и О16 — границы области кода; О19 требует живой проверки после установки.
const fs = require('fs'), path = require('path'), cp = require('child_process'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..'), CASE = process.env.MOST_V22_CASE;
const tests = [], test = (name, fn) => tests.push([name, fn]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = r => r.content.map(c => c.text || '').join('\n');
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const json = (f, v) => write(f, JSON.stringify(v, null, 2));
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const LINE = 'Доступ: полный (от имени пользователя, без песочницы); изменения вне папки поручения в список изменённых файлов не попадают';
const BRIEF = 'Полный доступ: команды выполняются от имени пользователя без песочницы. Запускай только то, что названо в поручении; не изменяй файлы связки (E:\\most, C:\\most, E:\\test-most); удаления запрещены; каждое действие вне папки поручения перечисли в отчёте.';
let RUN, REPO, STATE, PROJECT, JOBS, LOG, RELEASE;
if (CASE !== undefined) {
  RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v22-'));
  REPO = path.join(RUN, 'repo'); STATE = path.join(RUN, 'state'); PROJECT = path.join(RUN, 'program');
  RELEASE = path.join(RUN, 'release');
  for (const name of ['common', 'rules']) fs.cpSync(path.join(ROOT, name), path.join(RELEASE, name), { recursive: true });
  for (const name of ['package.json', 'servers/codex/index.js']) write(path.join(RELEASE, name), fs.readFileSync(path.join(ROOT, name)));
  JOBS = path.join(STATE, 'codex-jobs'); LOG = path.join(RUN, 'fake.jsonl');
  for (const p of [REPO, STATE, PROJECT, JOBS]) fs.mkdirSync(p, { recursive: true });
  for (const k of ['MOST_AUTHORITY', 'MOST_JOB_ID', 'MOST_FALLBACK_DIR', 'MOST_PROBE_ONLY', 'MOST_PROBE_GUEST', 'MOST_TEST_PROCESS_TREE']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', NODE_PATH: [process.env.NODE_PATH, path.join(ROOT, 'node_modules')].filter(Boolean).join(path.delimiter), MOST_REPO_ROOT: REPO, MOST_STATE_DIR: STATE,
    MOST_CLIENT: 'claude', MOST_CODEX_JOBS_DIR: JOBS, MOST_CODEX_ARCHIVE_DIR: path.join(RUN, 'archive'),
    MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off', MOST_TEST_KEEP: '1', MOST_QUEUE_TICK_MS: '100',
    MOST_CLAUDE_CONFIGS: '[]', MOST_CODEX_CONFIG: path.join(RUN, 'absent.toml'),
    MOST_AGY_MCP_CONFIG: path.join(RUN, 'absent.json'), MOST_AGY_QUOTA_FILE: path.join(RUN, 'quota.json'),
    MOST_CODEX_SESSIONS: path.join(RUN, 'sessions'), LOCALAPPDATA: path.join(RUN, 'local'),
    MOST_CODEX_RULES: path.join(RUN, 'AGENTS.md'), MOST_AGY_RULES: path.join(RUN, 'agy.md'),
    CODEX_PATH: path.join(__dirname, 'fake-codex.js'), FAKE_CODEX_LOG: LOG, TEMP: RUN, TMP: RUN, TMPDIR: RUN });
}
const cardFile = id => path.join(JOBS, id + '.json');
const card = id => read(cardFile(id));
const logs = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const idOf = r => text(r).match(/Номер поручения: (\S+)/)?.[1];
const defaults = () => ({ folder: PROJECT, task: 'Проба', write: true, full_access: true, role: 'совет' });
async function until(fn, name, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw Error('Не дождались: ' + name);
}
async function mcp(extra = {}) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(RELEASE, 'servers/codex/index.js')],
    env: { ...process.env, ...extra }, stderr: 'pipe' });
  let errors = ''; transport.stderr?.on('data', d => { errors += d; });
  const client = new Client({ name: 'team-v22', version: '1' });
  try { await client.connect(transport); }
  catch (e) { await client.close().catch(() => {}); throw Error(e.message + '\n' + errors); }
  return { call: (name, a = {}) => client.callTool({ name, arguments: a }), close: () => client.close(), errors: () => errors };
}
async function withMcp(fn, env) { const c = await mcp(env); try { await fn(c); } finally { await c.close(); } }
async function send(c, patch = {}) {
  const r = await c.call('codex_send', { ...defaults(), ...patch });
  assert(!r.isError, text(r)); assert(idOf(r), text(r)); return { id: idOf(r), response: r };
}
async function settled(c, id) {
  let result;
  await until(async () => { result = await c.call('codex_result', { id }); return !['running', 'cancelling'].includes(card(id).status); }, 'окончание ' + id);
  return result;
}
async function refuse(c, patch, pattern) {
  const before = fs.readdirSync(JOBS), n = logs().length;
  const r = await c.call('codex_send', { ...defaults(), ...patch });
  assert(r.isError, text(r)); assert.match(text(r), pattern);
  assert.deepEqual(fs.readdirSync(JOBS), before); assert.equal(logs().length, n);
}
function mode(row) { return row.args[row.args.indexOf('-s') + 1]; }
function junction(link, target) {
  if (process.platform !== 'win32') throw Object.assign(Error('junction требует Windows'), { skip: true });
  cp.execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { windowsHide: true, stdio: 'pipe' });
  assert(fs.lstatSync(link).isSymbolicLink()); assert.equal(fs.realpathSync(link), fs.realpathSync(target));
}
// Как oldModule в team-v21: доступ к внутренним функциям для детерминированной гонки
// и карточек, которые штатная очередь принципиально не запускает. Замки и fake-codex настоящие.
// Запуск MCP ниже отдельно проверяет обычный старт без подмены отпечатка процесса.
function internals() {
  const Module = require('module'), file = path.join(RELEASE, 'servers/codex/index.js');
  const m = new Module(file, module); m.filename = file; m.paths = [...Module._nodeModulePaths(path.dirname(file)), path.join(ROOT, 'node_modules')];
  const source = fs.readFileSync(file, 'utf8'), end = source.lastIndexOf('\n(async () => {');
  assert(end > 0);
  m._compile(source.slice(0, end) + '\nmodule.exports = { fullAccessAllowed, fullAccessRefusal, sandboxMode, execute, send, queue, save, load, view, active };', file);
  return m.exports;
}
function seeded(id, patch = {}) {
  const j = { id, folder: PROJECT, write: false, role: 'совет', from: 'claude', status: 'queued', task: 'SLOW',
    startedAt: new Date().toISOString(), quotaAttempts: 0, ...patch };
  json(cardFile(id), j); return j;
}

test('О1, О4: запись и явная роль обязательны; текст и совет разрешены', async () => withMcp(async c => {
  await refuse(c, { write: false }, /требует write=true/);
  await refuse(c, { role: undefined }, /явно укажите роль/);
  await refuse(c, { role: 'проверка' }, /проверка остаётся в песочнице/);
  for (const role of ['текст', 'совет']) { const j = await send(c, { role }); await settled(c, j.id); assert.equal(card(j.id).fullAccessApplied, true); }
}));

test('О2: равенство, вложенность, регистр, .., другой диск и ..cache', async () => {
  const paths = require('../common/paths'), cache = path.join(PROJECT, '..cache'); fs.mkdirSync(cache);
  assert(paths.isSameOrInsideReal(REPO, REPO)); assert(paths.isSameOrInsideReal(path.join(REPO, '..cache'), REPO));
  assert(!paths.isSameOrInsideReal(cache, REPO)); assert(!paths.isInsideReal(REPO, REPO));
  if (process.platform === 'win32') {
    const other = path.parse(REPO).root.toLowerCase() === 'c:\\' ? 'E:\\' : 'C:\\';
    assert(fs.existsSync(other), 'Для проверки другого диска нужен существующий корень ' + other);
    assert(!paths.isSameOrInsideReal(other, REPO));
  }
  await withMcp(async c => {
    for (const folder of [REPO, path.join(REPO, '.work/x'), path.join(REPO, 'live/hash'), RELEASE, path.join(RELEASE, 'common')]) {
      fs.mkdirSync(folder, { recursive: true }); await refuse(c, { folder }, /Полный доступ запрещён/);
    }
    await refuse(c, { folder: path.join(REPO, '..', 'repo') }, /Полный доступ запрещён/);
    if (process.platform === 'win32') await refuse(c, { folder: REPO.toUpperCase() }, /Полный доступ запрещён/);
    await refuse(c, { folder: '.' }, /Нужна абсолютная существующая папка/);
    // RELEASE — отдельная копия релиза тестируемого сервера. Внешний к нему путь моделируется
    // новым repoRoot; разрешение другого диска проверяется функцией пути без запуска в корне диска.
    const j = await send(c, { folder: cache }); await settled(c, j.id);
  });
});

test('О2: настоящая junction в корень и вложенную папку (Windows без пропуска)', async () => {
  const link = path.join(RUN, 'alias'); junction(link, REPO);
  fs.mkdirSync(path.join(REPO, 'child'));
  const paths = require('../common/paths'); assert(paths.isSameOrInsideReal(link, REPO));
  await withMcp(async c => { for (const folder of [link, path.join(link, 'child')]) await refuse(c, { folder }, /Полный доступ запрещён/); });
});

test('О3, О9: гости, включая запасного дирижёра, не получают флаг', async () => {
  const access = require('../common/access'), fallback = require('../common/fallback');
  const original = fallback.conductorAllows;
  fallback.conductorAllows = () => { throw Error('До разрешения дирижёра доходить нельзя'); };
  try {
    for (const client of ['codex', 'antigravity']) {
      process.env.MOST_CLIENT = client;
      assert.throws(() => access.guard('codex', 'codex_send', defaults()), /Гостю полный доступ Codex запрещён/);
      await withMcp(async c => { await refuse(c, {}, /Гостю полный доступ Codex запрещён/); await refuse(c, { full_access: 'true' }, /Гостю полный доступ Codex запрещён/); });
    }
  } finally { fallback.conductorAllows = original; process.env.MOST_CLIENT = 'claude'; }
});

test('О5: продолжение в обе стороны, старые карточки и resume', async () => withMcp(async c => {
  const full = await send(c); await settled(c, full.id);
  await refuse(c, { continue_id: full.id, full_access: false }, /Сохраните папку, режим записи и доступ/);
  const resume = await send(c, { continue_id: full.id }); await settled(c, resume.id);
  assert(logs().at(-1).args.includes('resume')); assert.equal(mode(logs().at(-1)), 'danger-full-access');
  const plain = await send(c, { full_access: false }); await settled(c, plain.id);
  await refuse(c, { continue_id: plain.id }, /Сохраните папку, режим записи и доступ/);
  const old = card(plain.id); delete old.fullAccess; delete old.fullAccessApplied; json(cardFile(old.id), old);
  await refuse(c, { continue_id: old.id }, /Сохраните папку, режим записи и доступ/);
  const next = await send(c, { continue_id: old.id, full_access: false }); await settled(c, next.id);
  assert.equal(mode(logs().at(-1)), 'workspace-write'); assert(logs().at(-1).args.includes('resume'));
}));

test('О6, О17: аргументы и точный бриф трёх режимов', async () => withMcp(async c => {
  for (const [patch, sandbox, brief] of [[{}, 'danger-full-access', BRIEF],
    [{ full_access: false }, 'workspace-write', 'Изменения разрешены только в рамках поручения. Перечисли файлы и проверки.'],
    [{ full_access: false, write: false }, 'read-only', 'Только чтение. Не изменяй файлы.']]) {
    const j = await send(c, patch); await settled(c, j.id); const row = logs().at(-1);
    assert.deepEqual(row.args.slice(0, 4), ['-a', 'never', '-s', sandbox]); assert(row.prompt.includes(brief), row.prompt);
    assert.equal(row.prompt.includes(BRIEF), sandbox === 'danger-full-access');
    assert.equal(text(j.response).includes(LINE), sandbox === 'danger-full-access');
  }
}));

test('О7: сохранённый режим виден во всех состояниях и длинном ответе', async () => {
  const { format } = require('../common/format');
  for (const status of ['queued', 'running', 'done', 'failed', 'needs_decision', 'waiting_quota', 'cancelled', 'cancelling', 'lost', 'stop_unconfirmed']) {
    assert(format('Codex', { id: 'x', status, fullAccessApplied: true }).includes(LINE));
    assert(!format('Codex', { id: 'x', status, fullAccess: true }).includes(LINE));
  }
  await withMcp(async c => {
    const j = await send(c, { task: 'SLOW LARGE' });
    assert(text(j.response).includes(LINE)); assert(text(await c.call('codex_status')).includes(LINE));
    await settled(c, j.id);
    const r = await c.call('codex_result', { id: j.id, from_char: 24000 }); assert(text(r).includes(LINE)); assert(text(r).includes('КОНЕЦ'));
    for (const status of ['failed', 'needs_decision', 'waiting_quota', 'cancelled']) {
      json(cardFile(j.id), { ...card(j.id), status, nextAttemptAt: '2999-01-01T00:00:00Z' });
      assert(text(await c.call('codex_result', { id: j.id })).includes(LINE));
    }
  });
});

test('О8: старая карточка в очереди запускается без полного доступа', async () => {
  seeded('old');
  await withMcp(async c => { await settled(c, 'old'); assert.equal(card('old').fullAccessApplied, false); assert.equal(mode(logs()[0]), 'read-only'); });
});

test('О10: отказ раньше work, heartbeat, владельца и замков', async () => {
  const file = path.join(REPO, 'works', 'w.json'); json(file, { name: 'w', owner: null, heartbeat_at: 'old', stages: [] });
  const before = fs.readFileSync(file);
  await withMcp(async c => {
    const lockDir = path.join(STATE, 'locks');
    const snapshot = () => fs.existsSync(lockDir) ? fs.readdirSync(lockDir).sort().map(n => [n, fs.readFileSync(path.join(lockDir, n), 'utf8')]) : [];
    const locks = snapshot();
    for (const patch of [{ write: false }, { role: 'проверка' }, { folder: REPO }]) {
      await refuse(c, { work: 'w', owner: 'new-owner', stage: 'stage', ...patch }, /Полный доступ|полного доступа/);
      assert(fs.readFileSync(file).equals(before)); assert.deepEqual(snapshot(), locks);
    }
  });
});

test('О11: квота без автоповтора, явное продолжение сохраняет режим', async () => withMcp(async c => {
  const j = await send(c, { task: 'QUOTA' }); await settled(c, j.id);
  assert.equal(card(j.id).status, 'needs_decision'); await sleep(500); assert.equal(logs().length, 1);
  const next = await send(c, { continue_id: j.id }); await settled(c, next.id);
  assert.equal(mode(logs().at(-1)), 'danger-full-access'); assert.equal(card(next.id).status, 'done');
}));

test('О12: подложенные карточки — единый отказ для аргументов, брифа, отчёта и продолжения', async () => {
  const api = internals();
  const patches = [{ from: 'codex' }, { from: 'antigravity' }, { fallbackWord: 'word' },
    { write: false }, { role: undefined }, { role: 'проверка' }];
  for (const [i, patch] of patches.entries()) for (const status of ['queued', 'waiting_quota']) {
    const j = seeded('bad-' + i + '-' + status, { fullAccess: true, write: true, ...patch, status,
      nextAttemptAt: '2000-01-01T00:00:00Z', threadId: 'test-thread' });
    assert(!api.fullAccessAllowed(j)); assert.notEqual(api.sandboxMode(j), 'danger-full-access');
    // Прямой запуск покрывает также карточки с записью, которые очередь базы не берёт.
    j.status = 'running'; api.save(j); await api.execute(j);
    await until(() => card(j.id).status === 'done', j.id);
    await until(() => !api.active.has(j.id), 'освобождение замков');
    assert.equal(card(j.id).fullAccessApplied, false); assert(!text(api.view(card(j.id))).includes(LINE));
    const row = logs().at(-1); assert.notEqual(mode(row), 'danger-full-access'); assert(!row.prompt.includes(BRIEF));
    await assert.rejects(api.send({ ...defaults(), continue_id: j.id }), /Сохраните папку, режим записи и доступ/);
  }
  // Реальный путь повторного запуска после квоты (запись у такой карточки выключена).
  seeded('retry', { fullAccess: true, write: false, status: 'waiting_quota', nextAttemptAt: '2000-01-01T00:00:00Z',
    threadId: 'retry-thread', owner: require('../common/locks').owner() });
  await api.queue(); await until(() => card('retry').status === 'done', 'повтор очереди');
  assert.equal(card('retry').fullAccessApplied, false); assert.equal(mode(logs().at(-1)), 'read-only');
  await withMcp(async c => {
    json(cardFile('retry'), { ...card('retry'), status: 'waiting_quota', nextAttemptAt: '2999-01-01T00:00:00Z' });
    assert(!text(await c.call('codex_status')).includes(LINE)); assert(!text(await c.call('codex_result', { id: 'retry' })).includes(LINE));
  });
});

test('О13а: строка true через зарегистрированный инструмент нормализуется', async () => withMcp(async c => {
  const j = await send(c, { full_access: 'true' }); await settled(c, j.id);
  assert.equal(card(j.id).fullAccess, true); assert.equal(card(j.id).fullAccessApplied, true);
}));

test('О13б: строка, число и null в карточке полного доступа не дают', async () => {
  const api = internals();
  for (const [i, value] of ['true', 1, null].entries()) {
    const j = seeded('value-' + i, { fullAccess: value, write: true, status: 'running' });
    await api.execute(j); await until(() => card(j.id).status === 'done', j.id);
    await until(() => !api.active.has(j.id), 'освобождение замков');
    assert.equal(card(j.id).fullAccessApplied, false); assert.equal(mode(logs().at(-1)), 'workspace-write'); assert(!logs().at(-1).prompt.includes(BRIEF));
  }
});

test('О14: повторный realpath после замка — failed, без исполнителя, все замки свободны', async () => {
  const api = internals(), locks = require('../common/locks'), paths = require('../common/paths');
  const link = path.join(RUN, 'changed-folder'); junction(link, REPO);
  assert.equal(api.fullAccessRefusal(defaults()), null);
  const j = seeded('swapped', { fullAccess: true, write: true, status: 'running' });
  const folderKey = paths.canon(PROJECT), folderLock = await locks.tryLock('codex_folder', folderKey, { jobId: j.id }); assert(folderLock.ok);
  // Детерминированная подмена сохранённого пути между проверкой send и execute;
  // сама junction настоящая. Каталоги пользователя не удаляются и не переименовываются.
  j.folder = link; api.save(j); await api.execute(j, folderLock);
  assert.equal(card(j.id).status, 'failed'); assert.match(card(j.id).error, /Полный доступ запрещён/);
  assert.equal(card(j.id).fullAccessApplied, false); assert.equal(logs().length, 0);
  for (const [kind, key] of [['codex_folder', folderKey], ['codex_execution', j.id], ['codex_job', j.id]]) {
    const l = await locks.tryLock(kind, key, {}); assert(l.ok, kind); await l.release();
  }
});

test('О15а: явная отмена, нет автоповтора', async () => withMcp(async c => {
  const j = await send(c, { task: 'HANG' }); await until(() => logs().length === 1, 'старт');
  await c.call('codex_cancel', { id: j.id }); await settled(c, j.id);
  assert.equal(card(j.id).status, 'cancelled'); assert(text(await c.call('codex_result', { id: j.id })).includes(LINE));
  await sleep(500); assert.equal(logs().length, 1);
}));

test('О15б: таймаут — состояние базы, нет автоповтора', async () => withMcp(async c => {
  const j = await send(c, { task: 'HANG' }); await settled(c, j.id);
  assert.equal(card(j.id).status, 'needs_decision'); assert.match(card(j.id).error, /Истёк предел времени/);
  await sleep(500); assert.equal(logs().length, 1);
}, { MOST_CODEX_TIMEOUT_MS: '800' }));

test('О15в: остановка и перезапуск — только явное продолжение; неподтверждённая остановка блокирует', async () => {
  let c = await mcp(), j;
  try { j = await send(c, { task: 'HANG' }); await until(() => card(j.id).threadId, 'threadId'); }
  finally { await c.close(); }
  await until(() => card(j.id).status === 'needs_decision', 'остановка сервера');
  c = await mcp();
  try {
    await sleep(500); assert.equal(logs().length, 1);
    if (card(j.id).stopUnconfirmed) {
      await refuse(c, { continue_id: j.id }, /подтверждённой остановкой/);
      if (process.platform === 'win32') {
        // Независимая проба на собственном процессе: сбой сервера сам по себе не повод пропускать тест.
        const probe = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
        try {
          await new Promise((resolve, reject) => { probe.once('spawn', resolve); probe.once('error', reject); });
          const killed = cp.spawnSync('taskkill.exe', ['/PID', String(probe.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
          const bytes = killed.stderr || Buffer.alloc(0);
          const denied = /access is denied|отказано в доступе/i;
          const reason = [bytes.toString('utf8'), new TextDecoder('ibm866').decode(bytes)].find(s => denied.test(s));
          if (killed.status !== 0 && (reason || ['EACCES', 'EPERM'].includes(killed.error?.code)))
            throw Object.assign(Error('Среда запрещает taskkill /T: независимая проба, код ' + killed.status + '; ' + (reason?.trim() || killed.error.message) + '; продолжение при неподтверждённой остановке заблокировано.'), { skip: true });
        } finally { probe.kill(); }
      }
      throw Error('Остановка дерева не подтверждена; продолжение правильно заблокировано. Проверка подтверждённой остановки не пройдена: ' + card(j.id).treeWarning);
    }
    const next = await send(c, { continue_id: j.id }); await settled(c, next.id);
    assert(logs().at(-1).args.includes('resume')); assert.equal(mode(logs().at(-1)), 'danger-full-access');
    json(cardFile(next.id), { ...card(next.id), stopUnconfirmed: { pid: 123 } });
    await refuse(c, { continue_id: next.id }, /подтверждённой остановкой/);
  } finally { await c.close(); }
});

test('О15г: завершённое поручение после перезапуска продолжается только явно', async () => {
  let first;
  await withMcp(async c => { first = await send(c); await settled(c, first.id); });
  await withMcp(async c => {
    await sleep(500); assert.equal(logs().length, 1);
    const next = await send(c, { continue_id: first.id }); await settled(c, next.id);
    assert.equal(logs().length, 2); assert(logs().at(-1).args.includes('resume'));
    assert.equal(mode(logs().at(-1)), 'danger-full-access');
  });
});

test('О16: правило одного поручения на программу; дословное решение и диагностика', () => {
  const quote = 'У поручения появляется переключатель „полный доступ“. Я сам включаю его, когда Codex должен запускать ваши программы (дубляж, GPU, сборки). Тогда Codex работает от вашего имени, как в своём чате. Правка кода связки и проверки остаются в песочнице.';
  for (const f of ['rules/claude.md']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8'); assert(s.includes(quote));
    for (const line of ['не больше одного', 'что можно менять вне папки', '`whoami`', '«проверка»', 'только Claude']) assert(s.includes(line), f + ': ' + line);
  }
});

test('О16а: краткая памятка отсылает к полному правилу Claude', () => {
  const s = fs.readFileSync(path.join(ROOT, 'rules/brief.md'), 'utf8');
  assert(s.includes('полный доступ — только Claude, rules/claude.md'));
  assert(s.length <= 7587); assert(s.split('\n').length <= 64);
});

test('О18: доставка двух режимов в временный AGENTS.md с проверкой содержимого', async () => {
  const rules = require('../common/client-rules'), file = path.join(RUN, 'AGENTS.md');
  const before = 'Личные правила\r\n\r\n<!-- most:begin -->\r\nСтарый раздел\r\n<!-- most:end -->\r\nХвост\r\n'; write(file, before);
  const plans = rules.plans([{ file, role: 'codex' }]);
  // Содержание доставки проверяется тем же evidence, что deployed.json rulesDelivery.
  const result = await rules.configure({ files: [{ file, role: 'codex' }] }); assert(!result.join().includes('отказ'), result.join());
  const evidence = rules.evidence(plans, 'team-v22-test'); assert(evidence[0].contentVerified && evidence[0].deliveryPerformed);
  const s = fs.readFileSync(file, 'utf8'); assert(s.startsWith('Личные правила\r\n')); assert(s.endsWith('Хвост\r\n'));
  for (const line of ['в двух режимах', 'Обычный', 'Полный доступ', 'от имени пользователя', 'Удаления запрещены в обоих режимах', 'каждое действие вне папки поручения']) assert(s.includes(line), line);
  assert(!s.includes('Через сервер Codex работает в песочнице отдельного пользователя Windows без сети;'));
});

async function main() {
  if (CASE !== undefined) {
    try { await tests[Number(CASE)][1](); process.exit(0); }
    catch (e) { console.error(e.stack || e); process.exit(e.skip ? 77 : 1); }
  }
  let failed = 0, skipped = 0;
  for (let i = 0; i < tests.length; i++) {
    const r = cp.spawnSync(process.execPath, [__filename], { env: { ...process.env, MOST_V22_CASE: String(i) }, encoding: 'utf8', timeout: 75000 });
    if (r.status === 0) console.log('ПРОЙДЕНО: ' + tests[i][0]);
    else if (r.status === 77) { skipped++; console.log('ПРОПУЩЕНО: ' + tests[i][0] + '\n' + r.stderr); }
    else { failed++; console.error('ПРОВАЛ: ' + tests[i][0] + '\n' + (r.stdout || '') + (r.stderr || '') + (r.error?.message || '')); }
  }
  console.log('Итого: пройдено ' + (tests.length - failed - skipped) + ', провалено ' + failed + ', пропущено ' + skipped);
  process.exitCode = failed ? 1 : 0;
}
main();
