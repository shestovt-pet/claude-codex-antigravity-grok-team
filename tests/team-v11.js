'use strict';
// team-v11: установщик на чужом компьютере (Р1), пути без личного (Р2), публичная копия (Р3), тесты без истории (Р6).
// Все частные значения здесь вымышленные: «Иннокентий Пупкин», папка Innokenty (случай 55).
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..'), RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v11-'));
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const json = (f, s) => write(f, JSON.stringify(s, null, 2));
const read = (f) => fs.readFileSync(f, 'utf8');
Object.assign(process.env, { MOST_REPO_ROOT: RUN, MOST_STATE_DIR: path.join(RUN, 'state'), MOST_TEST_KEEP: '1', MOST_CLIENT: 'claude',
  MOST_NOTIFY: 'off', MOST_CLAUDE_CONFIGS: '[]', MOST_CODEX_CONFIG: path.join(RUN, 'absent.toml'),
  MOST_AGY_MCP_CONFIG: path.join(RUN, 'absent.json'), MOST_AGY_CONFIG: path.join(RUN, 'absent-permissions.json'),
  MOST_CODEX_RULES: path.join(RUN, 'codex-home/AGENTS.md'), MOST_AGY_RULES: path.join(RUN, 'agy-home/AGENTS.md'), MOST_AFTER_DEPLOY: 'off' });
delete process.env.MOST_CODEX_ARCHIVE_DIR;
const { git } = require('../common/team-git');
const paths = require('../common/paths'), own = require('../common/ownership'), d = require('../common/deploy');
const cc = require('../common/client-configs'), rules = require('../common/client-rules');
const setupMod = require('../tools/setup'), ex = require('../tools/export-public');
const tests = [], test = (label, fn) => tests.push({ label, fn });
const H = (c) => c.repeat(40);
function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.name', 'Тест'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(dir, ['config', k, v]);
  return dir;
}
const commit = (dir, msg = 'x') => { git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', msg]); return git(dir, ['rev-parse', 'HEAD']).trim(); };

// ---- Р1/Р2: правила с фактическим корнем (случай 31)
test('Р1 случай 31: правила доставляются с корнем установки, посторонние C:\\most… не трогаются', () => {
  const t = 'Файлы: C:\\most\\state\\grok и C:/most/works; не трогать C:\\mostly и C:\\most-x.';
  assert.equal(paths.withRoot(t, 'C:\\most'), t);
  assert.equal(paths.withRoot(t, 'c:\\MOST\\'), t);
  const moved = paths.withRoot(t, 'D:\\Команда\\');
  assert.equal(moved, 'Файлы: D:\\Команда\\state\\grok и D:/Команда/works; не трогать C:\\mostly и C:\\most-x.');
  const saved = process.env.MOST_REPO_ROOT;
  try {
    process.env.MOST_REPO_ROOT = 'D:\\Команда';
    for (const kind of ['codex', 'antigravity']) {
      const b = rules.body(kind);
      assert(!/C:\\most(?![\w-])/i.test(b), kind + ': остался C:\\most');
    }
  } finally { process.env.MOST_REPO_ROOT = saved; }
  assert.match(read(path.join(ROOT, 'common/team.js')), /withRoot\(git\(this\.root, \['show'/);
});

// ---- Р1: своя и чужая запись (случаи 25–27, Codex d2bebbcb Б1)
test('Р1 случаи 25–27: своя запись — только этого корня; другая установка и посторонний сервер — отказ без записи', () => {
  const root = 'C:\\A';
  assert(own.own({ args: ['c:/a/live/' + H('a') + '/servers/team/index.js'] }, 'team', root), 'слэши и регистр');
  assert(own.own({ args: ['x'], env: { MOST_REPO_ROOT: 'c:/a/' } }, 'team', root), 'MOST_REPO_ROOT этого корня');
  assert(!own.own({ args: ['C:\\B\\live\\' + H('a') + '\\servers\\team\\index.js'] }, 'team', root), 'другая установка');
  assert(!own.own({ args: ['C:\\A\\live\\' + H('a') + '\\servers\\grok\\index.js'] }, 'team', root), 'чужое имя сервера');
  assert(!own.own({ args: ['x'], env: { MOST_REPO_ROOT: 'C:\\B' } }, 'team', root), 'MOST_REPO_ROOT другой установки');
  assert(!own.own({ command: 'npx', args: ['-y', '@openai/codex', 'mcp'] }, 'codex', root));
  // Codex 88f34c43: «..» раскрывается до сравнения — C:\A\..\B не внутри C:\A.
  assert(!own.pointsInto({ args: ['C:\\A\\..\\B\\servers\\most.js'] }, root));
  assert(own.pointsInto({ args: ['C:/A/x/../servers/most.js'] }, root));
  assert(!own.own({ args: ['C:\\A\\live\\..\\..\\B\\live\\' + H('a') + '\\servers\\team\\index.js'] }, 'team', root));
  const escape = d.configFor({ mcpServers: { most: { command: 'node', args: ['C:\\A\\..\\B\\servers\\most.js'] },
    agy: { command: 'node', args: ['C:\\A\\..\\B\\node_modules\\mcp-server-google-antigravity\\index.js'] } } }, root + '\\live\\' + H('b'), root);
  assert(escape.mcpServers.most && escape.mcpServers.agy, 'обе старые чистки не трогают путь с выходом из корня');
  const foreign = { mcpServers: { codex: { command: 'npx', args: ['-y', '@openai/codex', 'mcp'] }, other: { command: 'keep' } } };
  const before = JSON.stringify(foreign);
  assert.throws(() => d.configFor(foreign, root + '\\live\\' + H('b'), root, root + '\\state', 'claude.json'),
    (e) => /Чужие записи подключений в claude\.json: «codex» → npx -y @openai\/codex mcp/.test(e.message) && /файл не изменён/.test(e.message));
  assert.equal(JSON.stringify(foreign), before);
  // Старые записи прежних версий: удаляются только если указывают в этот корень (случай 26).
  const legacy = { mcpServers: {
    most: { command: 'node', args: ['C:\\A\\servers\\most.js'] }, mostElse: { command: 'x' },
    agyOld: { command: 'node', args: ['C:/A/node_modules/mcp-server-google-antigravity/index.js'] },
    agyUser: { command: 'npx', args: ['-y', 'mcp-server-google-antigravity'] },
    team: { command: 'node', args: ['C:\\A\\live\\' + H('a') + '\\servers\\team\\index.js'], env: { KEEP: '1' } } } };
  const n = d.configFor(legacy, 'C:\\A\\live\\' + H('b'), root, root + '\\state', 'c.json');
  assert(!n.mcpServers.most && !n.mcpServers.agyOld, 'свои старые записи убраны');
  assert.deepEqual(n.mcpServers.agyUser, legacy.mcpServers.agyUser, 'чужой сервер с той же подстрокой сохранён');
  assert.equal(n.mcpServers.team.env.KEEP, '1'); assert(n.mcpServers.team.args[0].includes(H('b')));
  const other = { mcpServers: { most: { command: 'node', args: ['C:\\B\\servers\\most.js'] } } };
  assert(d.configFor(other, 'C:\\A\\live\\' + H('b'), root).mcpServers.most, 'чужой «most» не удаляется');
});
test('Р1 случай 25: Codex и Antigravity — блок или записи другой установки не перезаписываются', () => {
  const first = cc.toml('# мой текст\n', 'C:\\A\\live\\' + H('a'), 'C:\\A', 'C:\\A\\state', 'node');
  assert.equal(cc.toml(first, 'C:\\A\\live\\' + H('a'), 'C:\\A', 'C:\\A\\state', 'node'), first, 'повтор своей установки');
  assert(cc.toml(first, 'C:\\A\\live\\' + H('b'), 'c:/a', 'C:\\A\\state', 'node').includes(H('b')), 'обновление своей установки');
  assert.throws(() => cc.toml(first, 'C:\\B\\live\\' + H('a'), 'C:\\B', 'C:\\B\\state', 'node', 'config.toml'), /Чужие записи подключений в config\.toml: «team»/);
  const agy = { mcpServers: { grok: { command: 'python', args: ['grok_server.py'] }, mine: { command: 'keep' } } };
  assert.throws(() => cc.jsonConfig(agy, 'agy', 'C:\\A\\live\\' + H('a'), 'C:\\A', 's', 'node', 'mcp_config.json'), /«grok» → python grok_server\.py/);
  const ok = cc.jsonConfig({ mcpServers: { mine: { command: 'keep' } } }, 'agy', 'C:\\A\\live\\' + H('a'), 'C:\\A', 's', 'node');
  assert.deepEqual(ok.mcpServers.mine, { command: 'keep' }); assert(ok.mcpServers.team && ok.mcpServers.codex && ok.mcpServers.grok);
});

// ---- Р1: первая доставка правил (случай 30)
test('Р1 случай 30, Codex 88f34c43: правила помощникам — создать, дописать, обновить устаревший раздел с .prev, dry-run без записи', async () => {
  const codex = process.env.MOST_CODEX_RULES, agy = process.env.MOST_AGY_RULES;
  assert.match(await rules.ensure(codex), /пропущено — папки помощника нет/); assert(!fs.existsSync(codex));
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  assert.match(await rules.ensure(codex, { dryRun: true }), /будет создан/); assert(!fs.existsSync(codex));
  assert.match(await rules.ensure(codex), /создан с разделом/);
  assert(read(codex).startsWith('<!-- most:begin -->\n') && read(codex).trimEnd().endsWith('<!-- most:end -->'));
  const userText = '\uFEFF# Мои правила\r\nНе трогать.';
  write(agy, userText);
  assert.match(await rules.ensure(agy, { dryRun: true }), /будет дописан/); assert.equal(read(agy), userText);
  assert.match(await rules.ensure(agy), /дописан в конец \(копия — \.prev\)/);
  assert.equal(read(agy + '.prev'), userText, 'копия до правки');
  const after = read(agy);
  assert(after.startsWith(userText + '\r\n\r\n<!-- most:begin -->\r\n'), 'чужой текст сохранён побайтно, перевод строк файла');
  assert.match(await rules.ensure(agy), /актуален/); assert.equal(read(agy), after);
  // Повторная установка после git pull или переноса папки: устаревший раздел заменяется, чужой текст вокруг — нет.
  const stale = after.replace(/<!-- most:begin -->[\s\S]*<!-- most:end -->/, '<!-- most:begin -->\r\nстарые правила C:/old-root\r\n<!-- most:end -->');
  write(agy, stale + '\r\nХвост пользователя.\r\n');
  assert.match(await rules.ensure(agy, { dryRun: true }), /будет обновлён/);
  assert.match(await rules.ensure(agy), /обновлён \(копия — \.prev\)/);
  assert(!read(agy).includes('C:/old-root') && read(agy).endsWith('\r\nХвост пользователя.\r\n') && read(agy).startsWith(userText));
  assert.equal(read(agy + '.prev'), stale + '\r\nХвост пользователя.\r\n');
  // После первой доставки обычная замена работает (deploy из Claude), отсутствующий файл помощника пропускается.
  assert.equal(rules.plans([codex, agy]).length, 2);
  fs.renameSync(codex, codex + '.moved');
  assert.equal(rules.plans([codex, agy]).length, 1);
  fs.renameSync(codex + '.moved', codex);
  write(agy, 'x <!-- most:end --> y'); await assert.rejects(() => rules.ensure(agy), /меток|раздел/);
});
test('Codex 88f34c43: повреждённые правила помощника останавливают установку до сборки и записи', async () => {
  const root = repo(path.join(RUN, 'bad-rules')); write(path.join(root, 'a'), 'a'); commit(root);
  const cfg = path.join(RUN, 'bad-rules-claude.json'); json(cfg, { mcpServers: {} });
  const codexCfg = path.join(RUN, 'bad-rules-codex.toml'); write(codexCfg, '');
  write(process.env.MOST_CODEX_RULES, 'x <!-- most:begin --> без конца');
  const lines = [], saved = { c: process.env.MOST_CLAUDE_CONFIGS, x: process.env.MOST_CODEX_CONFIG };
  process.env.MOST_CLAUDE_CONFIGS = JSON.stringify([cfg]); process.env.MOST_CODEX_CONFIG = codexCfg;
  try {
    const r = await setupMod.setup([], okDeps({ root, print: (s) => lines.push(s), exists: (p) => p === cfg || p === codexCfg,
      deploy: async () => { throw Error('не должен вызываться'); } }));
    assert(!r.ok, lines.join('\n'));
  } finally { process.env.MOST_CLAUDE_CONFIGS = saved.c; process.env.MOST_CODEX_CONFIG = saved.x; }
  assert(lines.some((l) => /✗ .*(меток|раздел)/.test(l)), lines.join('\n'));
  assert(!fs.existsSync(path.join(root, 'state')));
  write(process.env.MOST_CODEX_RULES, '');
});

// ---- Р1: проверки установщика (случаи 1–3, 8, 9, 11, 14, 19)
const okDeps = (extra = {}) => ({ platform: 'win32', nodeVersion: '20.0.0', has: () => true, exists: fs.existsSync, print: () => {}, ...extra });
test('Р1 случаи 1–3, 8–9: проверки окружения называют недостающее, ZIP без .git распознан', () => {
  const dir = path.join(RUN, 'checks'); fs.mkdirSync(dir, { recursive: true });
  const text = (deps) => setupMod.checks(dir, deps).filter((x) => !x.ok).map((x) => x.text).join(' | ');
  assert.match(text(okDeps({ platform: 'linux' })), /нужен Windows/);
  assert.match(text(okDeps({ nodeVersion: '16.20.0' })), /18 или новее/);
  assert.match(text(okDeps({ has: (c) => c !== 'npm' })), /npm не найден/);
  assert.match(text(okDeps({ has: (c) => c !== 'git' })), /git не найден.*git-scm/);
  const zip = setupMod.checks(dir, okDeps());
  assert(zip.every((x) => x.ok) && zip.some((x) => x.zip), 'папка без .git — установка из ZIP');
  const noMain = repo(path.join(RUN, 'nomain')); write(path.join(noMain, 'a'), 'a');
  assert.match(text.call(null, okDeps()) + setupMod.checks(noMain, okDeps()).map((x) => x.text).join(), /нет ветки main/);
  assert.match(read(path.join(ROOT, 'setup.cmd')), /where node[\s\S]*nodejs\.org[\s\S]*node tools\\setup\.js %\*/);
  assert.match(read(path.join(ROOT, 'setup.cmd')), /set CODE=%ERRORLEVEL%[\s\S]*if not defined MOST_SETUP_NOPAUSE pause[\s\S]*exit \/b %CODE%/, 'окно ждёт и при успехе');
});
test('Р1 случаи 5, 11, 14, 19: корень от установщика, один полный хеш, dry-run ничего не пишет, пропуски приложений', async () => {
  const lines = [], calls = [];
  const cwd = process.cwd();
  process.chdir(RUN);
  try {
    // Приложения «не найдены»; .git этого клона — настоящий (иначе установщик принял бы клон за ZIP).
    const r = await setupMod.setup(['--dry-run'], okDeps({ exists: (p) => p === path.join(ROOT, '.git') && fs.existsSync(p), deploy: async (o) => { calls.push(o); return 'план'; }, print: (s) => lines.push(s) }));
    assert(r.ok, lines.join('\n'));
  } finally { process.chdir(cwd); }
  assert(lines.includes('Папка: ' + ROOT), 'корень — папка установщика, не текущая');
  assert(lines.some((l) => /Claude Desktop не найден/.test(l)) && lines.some((l) => /Codex не найден/.test(l)) && lines.some((l) => /Antigravity не найден/.test(l)));
  // Этот клон — git: хеш main полный и передан deploy, dry-run без конфигов.
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    assert.equal(calls.length, 1); assert.match(calls[0].commit, /^[0-9a-f]{40}$/); assert.equal(calls[0].dryRun, true); assert.equal(calls[0].releaseOnly, true);
  }
  // Фиктивный корень: dry-run не создаёт state, не создаёт .git.
  const zipRoot = path.join(RUN, 'zip-dry'); write(path.join(zipRoot, 'README.md'), 'x');
  const r2 = await setupMod.setup(['--dry-run'], okDeps({ root: zipRoot, exists: (p) => fs.existsSync(p) && !/claude_desktop|\.codex|\.gemini/.test(p), deploy: async () => { throw Error('не должен вызываться'); } }));
  assert(r2.ok); assert(!fs.existsSync(path.join(zipRoot, 'state')) && !fs.existsSync(path.join(zipRoot, '.git')));
});
test('Р1 случаи 8, 10: установка из ZIP — один коммит автора setup, обновление ZIP фиксируется, глобальный git config не участвует', async () => {
  const root = path.join(RUN, 'zip'); write(path.join(root, 'a.txt'), '1');
  const calls = [];
  const deps = okDeps({ root, exists: (p) => p.startsWith(root) && fs.existsSync(p), deploy: async (o) => { calls.push(o); return 'релиз'; } });
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.GIT_CONFIG_GLOBAL = path.join(RUN, 'no-global-gitconfig');
  try {
    assert((await setupMod.setup([], deps)).ok);
    assert.equal(git(root, ['log', '--format=%an <%ae>|%cn <%ce>']).trim(), 'setup <setup@localhost>|setup <setup@localhost>');
    const first = git(root, ['rev-parse', 'main']).trim();
    assert.equal(calls[0].commit, first); assert(fs.existsSync(path.join(root, 'state')));
    assert((await setupMod.setup([], deps)).ok); assert.equal(git(root, ['rev-list', '--count', 'main']).trim(), '1', 'без изменений — без нового коммита');
    write(path.join(root, 'a.txt'), '2');
    assert((await setupMod.setup(['--dry-run'], deps)).ok); assert.equal(git(root, ['rev-list', '--count', 'main']).trim(), '1', 'dry-run не фиксирует');
    assert((await setupMod.setup([], deps)).ok);
    assert.equal(git(root, ['rev-list', '--count', 'main']).trim(), '2');
    assert.equal(calls.at(-1).commit, git(root, ['rev-parse', 'main']).trim());
  } finally { if (saved.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL; }
});
test('Р1 случай 25: чужая запись останавливает установку до сборки и записи', async () => {
  const root = repo(path.join(RUN, 'conflict')); write(path.join(root, 'a'), 'a'); commit(root);
  const cfg = path.join(RUN, 'conflict-claude.json');
  json(cfg, { mcpServers: { team: { command: 'node', args: ['E:\\другая\\live\\' + H('c') + '\\servers\\team\\index.js'] } } });
  const before = read(cfg), lines = [];
  const saved = process.env.MOST_CLAUDE_CONFIGS; process.env.MOST_CLAUDE_CONFIGS = JSON.stringify([cfg]);
  try {
    const r = await setupMod.setup([], okDeps({ root, print: (s) => lines.push(s), exists: (p) => p === cfg, deploy: async () => { throw Error('не должен вызываться'); } }));
    assert(!r.ok);
  } finally { process.env.MOST_CLAUDE_CONFIGS = saved; }
  assert(lines.some((l) => /«team» → node E:\\другая/.test(l)), lines.join('\n'));
  assert(lines.includes('Установка остановлена: ничего не изменено.'));
  assert.equal(read(cfg), before); assert(!fs.existsSync(path.join(root, 'state')));
});

// ---- Р2 (случаи 21, 39)
test('Р2 случаи 21, 39: пакеты Claude_* из Store находятся по шаблону; личный архив Codex без переменной не читается', () => {
  const saved = { l: process.env.LOCALAPPDATA, c: process.env.MOST_CLAUDE_CONFIGS };
  try {
    delete process.env.MOST_CLAUDE_CONFIGS; process.env.LOCALAPPDATA = path.join(RUN, 'local');
    for (const n of ['Claude_abc123', 'Claude_pzs8sxrjxfjjc', 'ClaudeX_1', 'Other']) fs.mkdirSync(path.join(RUN, 'local/Packages', n), { recursive: true });
    const found = d.configPaths().map((p) => p.split(path.sep).join('/'));
    assert(found.some((p) => p.includes('Packages/Claude_abc123/')) && found.some((p) => p.includes('Packages/Claude_pzs8sxrjxfjjc/')));
    assert(!found.some((p) => /ClaudeX_1|Other/.test(p)));
    assert.equal(new Set(found).size, found.length, 'без дублей');
  } finally { process.env.LOCALAPPDATA = saved.l; process.env.MOST_CLAUDE_CONFIGS = saved.c; }
  const store = require('../common/team-store');
  assert.equal(store.roots().archive, null);
  assert(!/Documents[\\/]+Codex/.test(read(path.join(ROOT, 'common/team-store.js'))));
});

// ---- Р3: публичная копия на вымышленных данных (случаи 41–72)
function fixture(name) {
  const root = repo(path.join(RUN, name));
  write(path.join(root, 'docs/a.md'), 'Сказал Иннокентий; спросили Иннокентия. Путь C:\\Users\\Innokenty\\AppData и C:/Users/Innokenty/x.\n');
  write(path.join(root, 'common/b.json'), JSON.stringify({ p: 'C:\\Users\\Innokenty\\Temp', mail: 'pupkin@firma.example' }) + '\n');
  write(path.join(root, 'common/c.js'), "const winner = 'Innokentyville'; // посторонний корень слова\n");
  write(path.join(root, 'tests/windows-test-output-x.txt'), 'Innokenty\n');
  write(path.join(root, 'tests/any.log'), 'Innokenty\n');
  write(path.join(root, 'skill/vtm-hronika/SKILL.md'), 'Иннокентий\n');
  write(path.join(root, 'skill/helpers/SKILL.md'), 'общий\n');
  commit(root);
  const terms = path.join(RUN, name + '-terms.json');
  json(terms, { userFolder: 'Innokenty', replace: [['Иннокентия', 'пользователя'], ['Иннокентий', 'пользователь'], ['pupkin@firma.example', 'user@example.invalid']], forbidden: ['Innokenty', 'Иннокент', 'pupkin', 'firma.example'], allow: ['Innokentyville'] });
  return { root, terms };
}
test('Р3 случаи 41–42, 50–52, 56–57, 66: один хеш, формы имени и пути, почта, исключения, LICENSE', () => {
  const f = fixture('exp1');
  write(path.join(f.root, 'uncommitted.md'), 'Иннокентий');
  const hash = git(f.root, ['rev-parse', 'main']).trim();
  const r = ex.exportPublic({ root: f.root, target: path.join(RUN, 'out1'), holder: 'some-login', termsFile: f.terms });
  assert.equal(r.commit, hash);
  const out = (p) => read(path.join(RUN, 'out1', p));
  assert.equal(out('docs/a.md'), 'Сказал пользователь; спросили пользователя. Путь C:\\Users\\user\\AppData и C:/Users/user/x.\n');
  assert.deepEqual(JSON.parse(out('common/b.json')), { p: 'C:\\Users\\user\\Temp', mail: 'user@example.invalid' });
  assert.equal(out('common/c.js'), "const winner = 'Innokentyville'; // посторонний корень слова\n", 'разрешённая строка не тронута');
  for (const p of ['uncommitted.md', 'tests/windows-test-output-x.txt', 'tests/any.log', 'skill/vtm-hronika']) assert(!fs.existsSync(path.join(RUN, 'out1', p)), p);
  assert(fs.existsSync(path.join(RUN, 'out1/skill/helpers/SKILL.md')));
  assert.match(out('LICENSE'), /^MIT License\n\nCopyright \(c\) \d{4} some-login\n/);
  assert.throws(() => ex.exportPublic({ root: f.root, target: path.join(RUN, 'out1b'), holder: 'Innokenty', termsFile: f.terms }), /Правообладатель/);
  assert.throws(() => ex.exportPublic({ root: f.root, target: path.join(RUN, 'out1c'), holder: 'имя с пробелом', termsFile: f.terms }), /Правообладатель/);
});
test('Р3 случаи 53, 67: остаток в имени файла или тексте — отказ с местом, без самой строки', () => {
  const f = fixture('exp2');
  write(path.join(f.root, 'docs/Innokenty-notes.md'), 'ok\n');
  write(path.join(f.root, 'docs/d.md'), 'строка 1\nИННОКЕНТИЙ Пупкин\n');
  commit(f.root);
  let msg = '';
  try { ex.exportPublic({ root: f.root, target: path.join(RUN, 'out2'), holder: 'h', termsFile: f.terms }); } catch (e) { msg = e.message; }
  assert.match(msg, /docs\/Innokenty-notes\.md:имя файла \(запрещённая строка №1\)/);
  assert.match(msg, /docs\/d\.md:2 \(запрещённая строка №2\)/);
  const lines = msg.split('\n').slice(1).join('\n');
  assert(!/ИННОКЕНТИЙ|Пупкин/i.test(lines.replace(/docs\/Innokenty-notes\.md/g, '')), 'сама строка не выводится');
});
test('Р3 случаи 43–46, 54: назначение внутри связки, непустое, ссылка; ссылка в дереве и не-UTF-8 — отказ', () => {
  const f = fixture('exp3');
  const run = (target, root = f.root) => ex.exportPublic({ root, target, holder: 'h', termsFile: f.terms });
  assert.throws(() => run(path.join(f.root, 'sub')), /внутри связки/);
  assert.throws(() => run(f.root), /не пуста|внутри связки/);
  write(path.join(RUN, 'busy/x'), 'x'); assert.throws(() => run(path.join(RUN, 'busy')), /не пуста/);
  try {
    fs.symlinkSync(path.join(RUN, 'busy'), path.join(RUN, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => run(path.join(RUN, 'link')), /ссылкой/);
  } catch (e) { if (!/EPERM/.test(e.code || '')) throw e; }
  // Ссылка в дереве без ссылки на диске: индекс git с режимом 120000.
  const blob = git(f.root, ['hash-object', '-w', '--stdin'], { input: 'docs/a.md' }).trim();
  git(f.root, ['update-index', '--add', '--cacheinfo', '120000,' + blob + ',docs/link']);
  git(f.root, ['commit', '-q', '-m', 'link']);
  assert.throws(() => run(path.join(RUN, 'out3a')), /ссылки или подмодули.*docs\/link/);
  git(f.root, ['rm', '-q', '--cached', 'docs/link']); git(f.root, ['commit', '-q', '-m', 'unlink']);
  write(path.join(f.root, 'docs/cp1251.txt'), Buffer.from([0xcf, 0xf3, 0xef, 0xea, 0xe8, 0xed])); commit(f.root);
  assert.throws(() => run(path.join(RUN, 'out3b')), /Не UTF-8.*docs\/cp1251\.txt/);
});
test('Р3 случаи 55, 60–63: частные значения не в репозитории; тесты без истории и без личного скилла; run.js запускает team-v11', () => {
  assert.match(read(path.join(ROOT, 'tools/export-public.js')), /state\\public-export\.json/);
  assert(!fs.existsSync(path.join(ROOT, 'public-export.json')));
  assert.match(read(path.join(ROOT, '.gitignore')), /^state\/$/m);
  assert.match(read(path.join(__dirname, 'trio-v5.js')), /4b825dc642cb6eb9a060e54bf8d69288fbee4904/);
  assert.match(read(path.join(__dirname, 'trio-v5.js')), /docs\/architecture\.md/);
  for (const f of ['team-v7.js', 'team-v8.js']) assert.match(read(path.join(__dirname, f)), /vtm-hronika[\s\S]{0,200}existsSync|existsSync[\s\S]{0,200}vtm-hronika/, f);
  assert.match(read(path.join(__dirname, 'run.js')), /'team-v11\.js'/);
});
test('Р5: README для новичка — установка git и ZIP, Grok по шагам, чужие записи, безопасность', () => {
  const t = read(path.join(ROOT, 'README.md'));
  for (const re of [/Download ZIP/, /setup\.cmd --dry-run/, /brief_path/, /reply_path/, /secret_hex/, /КОНЕЦ ОТВЕТА/, /state\\grok-webhook\.json/, /api2\.cursor\.sh\/automations\/webhook/, /из панели этой рутины/,
    /state\\grok`, `works` и `.work`/, /Grok: мост настроен/, /Смена ключа/, /считается чужой/, /телеметрии нет/, /English summary/,
    /github\.com\/shestovt-pet\/claude-codex-antigravity-grok-team/]) assert.match(t, re);
  assert.match(read(path.join(ROOT, 'docs/architecture.md')), /## Что изменилось в версии 0\.5\.0/);
  assert.match(read(path.join(ROOT, 'package.json')), /"version": "0\.5\.6"/);
});

(async () => {
  console.log('team-v11: ' + process.platform + ' ' + process.version + '; ' + RUN);
  let passed = 0, failed = 0;
  for (const t of tests) { try { await t.fn(); passed++; console.log('OK ' + t.label); } catch (e) { failed++; console.log('ПРОВАЛ ' + t.label + '\n' + e.stack); } }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0'); process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(), 200).unref();
})();
