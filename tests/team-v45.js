'use strict';
// П1–П5. Все данные изолированы; Git для ворот подменён, коммитов/слияний на диске нет.
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process'), Module = require('module');
const BASE = 'a'.repeat(40), CANDIDATE = 'b'.repeat(40);
function teamHarness() {
  const g = require('../common/team-git');
  g.repository = () => {}; g.hash = () => BASE; g.clean = () => true;
  g.git = (_root, args) => args[0] === 'branch' ? 'main' : args[0] === 'rev-parse' ? CANDIDATE : '';
  const { Team } = require('../common/team');
  Team.prototype.pair = function (n) {
    return { c: JSON.parse(fs.readFileSync(this.changeFile(n))), folder: this.root, candidate: CANDIDATE };
  };
  return Team;
}
if (process.argv.includes('--team-server')) {
  teamHarness();
  const { server } = require('../servers/team');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  server.connect(new StdioServerTransport()).catch(e => { console.error(e); process.exitCode = 1; });
} else {
  delete process.env.MOST_JOB_ID;
  const f = require('./team-v16-fixture');
  const { root, project, write, json, sha } = f, state = path.join(root, 'state');
  Object.assign(process.env, { MOST_TEST_KEEP: '1', MOST_DSH_VERSION: '0.2.1-rc.2', MOST_DSH_NO_PROFILES: '1',
    CODEX_PATH: path.join(__dirname, 'fake-codex.js'), MOST_DEEPSEEK_JOBS_DIR: path.join(state, 'deepseek-jobs') });
  const tf = require('../common/text-format'), fb = require('../common/fallback');
  const members = require('../common/members'), registry = require('../common/members-store').create(state);
  const Team = teamHarness(), team = new Team(root);
  const tests = [], test = (n, fn) => tests.push([n, fn]); let seq = 0;
  const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  // team-v46 п.5а: папки записи — вне репозитория (MOST_TEST_OUTSIDE), TEMP раннера лежит внутри клона.
  const outside = path.join(process.env.MOST_TEST_OUTSIDE || require('os').tmpdir(), 'v45-' + process.pid + '-' + Date.now());
  const temp = () => { const p = path.join(outside, 'case-' + ++seq); fs.mkdirSync(p, { recursive: true }); return p; };
  const meta = { action: 'pause', who: 'claude', quote: 'Проверка', reason: 'team-v45' };
  const updateMembers = (fn, phase = 'B') => registry.update(registry.read().rev, fn, meta, { phase });
  const pause = on => updateMembers(n => { const m = n.members.find(m => m.id === 'deepseek'); m.state = on ? 'paused' : 'active'; m.pause = on ? { kind: 'manual', scope: 'participant', since: new Date().toISOString(), until: null, next_probe: null } : null; });
  updateMembers(n => { Object.assign(n.members.find(m => m.id === 'deepseek').roles, { receives: true, sends: true, writer: true, voter: true }); });
  require('../common/dsh-probe').record({ version: '0.2.1-rc.2', writeDenied: true });
  function sample(before, after, name = 'a.js', opts = {}) {
    const dir = temp(), file = path.join(dir, name);
    if (before !== null) write(file, before);
    const state = fb.folderState(dir), snap = tf.snapshot(dir, state, { dir: path.join(temp(), 'format-before') });
    write(file, after);
    return { dir, file, state, snap, writes: [{ path: name, sha256: sha(Buffer.from(after)) }],
      compare: extra => tf.compare(dir, snap, state, [{ path: name, sha256: sha(Buffer.from(after)) }], { ...opts, ...extra }) };
  }
  for (const [title, before, after] of [
    ['одна строка', 'a\r\nb\nc\r\n', 'a\r\nnew\nc\r\n'],
    ['удаление единственной LF', 'a\r\nb\nc\r\n', 'a\r\nc\r\n'],
    ['вставка с окончанием соседей', 'a\r\nb\r\n', 'a\r\nx\r\nb\r\n'],
    ['полная перезапись', 'a\r\nb\n', 'x\ny\n'],
    ['новый CRLF+BOM', null, '\uFEFFa\r\nb\r\n'],
  ]) test('П1 без ложной тревоги: ' + title, () => {
    const result = sample(before, after).compare(); assert.equal(result.formatCheck, 'проверено'); assert.deepEqual(result.formatSuspicions, []);
  });
  for (const [title, before, after, issue] of [
    ['смешанный → CRLF', 'a\r\nb\n', 'a\r\nb\r\n', /1 неизменённых строк/],
    ['LF → CRLF', 'a\nb\n', 'a\r\nb\r\n', /2 неизменённых строк/],
    ['одиночный CR', 'a\rb\r', 'a\nb\n', /CR → LF/],
    ['BOM снят', '\uFEFFa\n', 'a\n', /BOM пропал/],
    ['BOM добавлен', 'a\n', '\uFEFFa\n', /BOM появился/],
    ['U+FFFD', 'a\n', '\uFFFD\n', /U\+FFFD/],
    ['UTF-8', 'a\n', Buffer.from([255, 10]), /невалидный UTF-8/],
    ['новый U+FFFD', null, '\uFFFD\r\n', /U\+FFFD/],
    ['новый невалидный UTF-8', null, Buffer.from([255]), /невалидный UTF-8/],
  ]) test('П1 подозрение: ' + title, () => {
    const result = sample(before, after).compare(); assert.equal(result.formatCheck, 'проверено'); assert.match(JSON.stringify(result.formatSuspicions), issue);
  });
  test('П1 рабочий CRLF при LF в Git и игнорируемый исходник', () => {
    const dir = temp();
    // Копия истории только для чтения HEAD; новых коммитов не создаём.
    const git = args => cp.execFileSync('git', args, { cwd: dir, windowsHide: true });
    const bundle = path.join(temp(), 'source.bundle');
    cp.execFileSync('git', ['bundle', 'create', bundle, 'HEAD'], { cwd: path.resolve(__dirname, '..'), windowsHide: true });
    git(['clone', '--no-checkout', bundle, '.']); git(['config', 'core.autocrlf', 'true']);
    const tracked = 'common/members.js', original = git(['show', 'HEAD:' + tracked]).toString();
    assert(!original.includes('\r')); const disk = original.replace(/\n/g, '\r\n');
    write(path.join(dir, '.gitignore'), 'private.js\n'); write(path.join(dir, tracked), disk);
    write(path.join(dir, 'private.js'), 'x\ny\n');
    const before = fb.folderState(dir), snap = tf.snapshot(dir, before, { dir: path.join(temp(), 'format-before') });
    write(path.join(dir, tracked), disk + '// новая строка\r\n');
    let result = tf.compare(dir, snap, before, [{ path: tracked, sha256: sha(fs.readFileSync(path.join(dir, tracked))) }]);
    assert.deepEqual(result.formatSuspicions, []);
    write(path.join(dir, tracked), original); write(path.join(dir, 'private.js'), 'x\r\ny\r\n');
    result = tf.compare(dir, snap, before, [tracked, 'private.js'].map(p => ({ path: p, sha256: sha(fs.readFileSync(path.join(dir, p))) })));
    assert.equal(result.formatSuspicions.length, 2);
  });
  test('team-v48e Г7: общий размер снимка не ограничен (тумблер MOST_FORMAT_MAX_TOTAL удалён)', () => {
    const old = fs.copyFileSync, oldRead = fs.readFileSync; let calls = 0;
    fs.copyFileSync = fs.readFileSync = () => { calls++; throw Error('чтение запрещено'); };
    try {
      // Общий размер снимка не ограничен — 51 МБ не пропускается по размеру (снимок читает/копирует).
      const def = tf.snapshot(project, new Map([['big.md', (51 * 1024 * 1024) + ':0']]), { dir: path.join(temp(), 'fmt-def') });
      assert(!def.skipped, '51 МБ не пропускается по размеру'); assert(calls > 0, 'копирование предпринято'); calls = 0;
      // Даже при выставленной прежней переменной снимок не пропускается по размеру — тумблер удалён.
      process.env.MOST_FORMAT_MAX_TOTAL = String(50 * 1024 * 1024);
      try { const snap = tf.snapshot(project, new Map([['big.md', (51 * 1024 * 1024) + ':0']]), { dir: path.join(temp(), 'fmt-env') }); assert(!snap.skipped, 'MOST_FORMAT_MAX_TOTAL не ограничивает'); assert(calls > 0); }
      finally { delete process.env.MOST_FORMAT_MAX_TOTAL; }
    } finally { fs.copyFileSync = old; fs.readFileSync = oldRead; }
  });
  test('П1 ошибка копирования не означает новый файл', () => {
    const dir = temp(); write(path.join(dir, 'a.js'), 'x\n'); const before = fb.folderState(dir), copy = fs.copyFileSync;
    let snap; fs.copyFileSync = () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); };
    try { snap = tf.snapshot(dir, before, { dir: path.join(temp(), 'format-before') }); } finally { fs.copyFileSync = copy; }
    const result = tf.compare(dir, snap, before, [{ path: 'a.js', sha256: sha('x\n') }]);
    assert.match(result.formatCheck, /неполная.*EACCES/); assert.deepEqual(result.formatSuspicions, []);
  });
  for (const op of ['readdirSync', 'statSync']) for (const when of ['до', 'после']) test('П1 ошибка ' + op + ' ' + when, () => {
    const dir = temp(), file = path.join(dir, 'a.js'); write(file, 'x\n');
    const scan = () => {
      const old = fs[op]; fs[op] = (...args) => { if (String(args[0]) === (op === 'readdirSync' ? dir : file)) throw Object.assign(Error('denied'), { code: 'EACCES' }); return old(...args); };
      try { return fb.folderStateDetailed(dir); } finally { fs[op] = old; }
    };
    const before = when === 'до' ? scan() : fb.folderStateDetailed(dir);
    const snap = tf.snapshot(dir, before.state, { dir: path.join(temp(), 'format-before'), errors: before.errors });
    write(file, 'x\r\n'); const after = when === 'после' ? scan() : fb.folderStateDetailed(dir);
    const result = tf.compare(dir, snap, before.state, [{ path: 'a.js', sha256: sha('x\r\n') }], { errors: after.errors });
    assert.match(result.formatCheck, new RegExp('неполная.*обход папки ' + when));
    if (when === 'до') assert.deepEqual(result.formatSuspicions, []);
  });
  test('П1 folderChanges сохраняет результат и отдаёт ошибки обхода отдельно', () => {
    const dir = temp(); write(path.join(dir, 'a.js'), 'x'); const before = fb.folderState(dir);
    write(path.join(dir, 'a.js'), 'longer'); const details = {};
    assert.deepEqual(fb.folderChanges(dir, before, details), [{ path: 'a.js', sha256: sha('longer') }]); assert.deepEqual(details.errors, []);
    const old = fs.readdirSync; fs.readdirSync = () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); };
    try { fb.folderChanges(dir, before, details); assert.equal(details.errors[0].code, 'EACCES'); } finally { fs.readdirSync = old; }
  });
  test('П1 ошибка чтения при хеше не считается удалением или полной проверкой', () => {
    const x = sample('a\n', 'longer\n'), details = {}, original = fs.readFileSync; let calls = 0, writes;
    fs.readFileSync = (...args) => {
      if (String(args[0]) === x.file) { calls++; throw Object.assign(Error('denied'), { code: 'EACCES' }); }
      return original(...args);
    };
    try { writes = fb.folderChanges(x.dir, x.state, details); } finally { fs.readFileSync = original; }
    assert.equal(calls, 1);
    assert.deepEqual(writes, [{ path: 'a.js', sha256: null }]);
    const result = tf.compare(x.dir, x.snap, x.state, writes, { errors: details.errors });
    assert.match(result.formatCheck, /^неполная: 1 файлов не проверено;.*a\.js.*EACCES/);
    assert.deepEqual(details.errors, [{ path: 'a.js', op: 'readFileSync', code: 'EACCES' }]);
    assert.deepEqual(result.formatSuspicions, []);
    const deleted = tf.compare(x.dir, x.snap, x.state, writes);
    assert.equal(deleted.formatCheck, 'проверено');
  });
  test('П1 гонка, пропавший файл, размер, предел шагов, нет списков', () => {
    let x = sample('a\n', 'b\n'); write(x.file, 'changed'); assert.match(x.compare().formatCheck, /файл изменился/);
    // team-v48e Г7: кеп размера файла снят — compare больше не делает statSync размера, а читает файл readFileSync; гонка
    // «файл исчез при сравнении» воспроизводится ошибкой чтения (ENOENT), которая так же попадает в formatCheck.
    x = sample('a\n', 'b\n'); const old = fs.readFileSync;
    fs.readFileSync = (...args) => { if (String(args[0]) === x.file) throw Object.assign(Error('gone'), { code: 'ENOENT' }); return old(...args); };
    try { assert.match(x.compare().formatCheck, /ENOENT/); } finally { fs.readFileSync = old; }
    // team-v48e Г7: размер файла не ограничен (тумблер MOST_FORMAT_MAX_FILE удалён) — большой файл проверяется без отказа «2 МБ».
    x = sample('a\n', 'b'.repeat(2 * 1024 * 1024 + 1)); assert(!/2 МБ/.test(x.compare().formatCheck), '>2 МБ без отказа');
    // Даже при выставленной прежней переменной отказа «2 МБ» нет — тумблер удалён.
    process.env.MOST_FORMAT_MAX_FILE = String(2 * 1024 * 1024);
    try {
      x = sample('a\n', 'b'.repeat(2 * 1024 * 1024 + 1)); assert(!/2 МБ/.test(x.compare().formatCheck), 'MOST_FORMAT_MAX_FILE не ограничивает (после)');
      x = sample('a'.repeat(2 * 1024 * 1024 + 1), 'x'); assert(!/2 МБ/.test(x.compare().formatCheck), 'MOST_FORMAT_MAX_FILE не ограничивает (до)');
    } finally { delete process.env.MOST_FORMAT_MAX_FILE; }
    x = sample('a\nb\nc\n', 'x\ny\nz\n'); assert.match(x.compare({ maxSteps: 2 }).formatCheck, /слишком дорогое/);
    assert.match(tf.compare(x.dir, x.snap, x.state, null).formatCheck, /пропущено/);
    assert.match(tf.snapshot(x.dir, null).skipped, /список файлов/);
  });
  test('П1 формат ответа: предупреждение перед телом, 10 файлов, без записи — нет', () => {
    const format = require('../common/format').format, j = { id: 'format-test', status: 'done', write: true, formatCheck: 'неполная: тест',
      formatSuspicions: Array.from({ length: 12 }, (_, i) => ({ path: i + '.js', issues: ['BOM пропал'] })) };
    const out = format('Codex', j, 'ТЕЛО'); assert(out.indexOf('⚠ Подозрение') < out.indexOf('ТЕЛО')); assert.match(out, /и ещё 2/); assert.match(out, /Проверка формата неполная/);
    assert(!format('Codex', { ...j, write: false }, 'ТЕЛО').includes('⚠'));
  });
  function bridgeHarness(who) {
    const file = path.join(__dirname, '../servers', who, 'index.js'), source = fs.readFileSync(file, 'utf8');
    const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    // Якорь по началу строки: бутстрап сервера — `(async () => {` без отступа. Без `\n` lastIndexOf ловил вложенный
    // `  (async () => {` внутри бутстрапа (team-v62) и резал исходник посреди него (Unexpected end of input).
    const end = source.lastIndexOf('\n(async () => {'); assert(end > 0);
    const nativeRequire = m.require.bind(m);
    // DeepSeek запускает тот же fake-codex через обёртку протокола, без настоящего dsh.
    if (who === 'deepseek') m.require = id => id === 'child_process' ? { ...cp, spawn: (_bin, _args, opts) => {
      const script = path.join(project, 'fake-dsh-wrapper.js');
      write(script, `const cp = require('child_process');
const child = cp.spawn(process.execPath, [${JSON.stringify(path.join(__dirname, 'fake-codex.js'))}, '--output-last-message', 'fake-result.txt'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
process.stdin.pipe(child.stdin); let buffer = '';
child.stdout.on('data', d => { buffer += d; let i; while ((i = buffer.indexOf('\\n')) >= 0) { const e = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); if (e.type === 'turn.completed') process.stdout.write(JSON.stringify({ type: 'final', text: 'ПРИНЯТО' }) + '\\n'); } });
child.on('close', code => { process.exitCode = code; });
`);
      return cp.spawn(process.execPath, [script], { ...opts, shell: false });
    } } : nativeRequire(id);
    m._compile(source.slice(0, end) + '\nmodule.exports = { execute, load };', file);
    return m.exports;
  }
  for (const who of ['codex', 'deepseek']) for (const fault of ['нет', 'снимок', 'проверка', 'предел', 'копирование', 'список', 'хеш'])
    test('П1 настоящий execute ' + who + ', сбой: ' + fault, async () => {
      const dir = temp(), id = 'bridge-' + ++seq, jobs = path.join(state, who + '-jobs');
      write(path.join(dir, 'a.js'), '\uFEFFa\r\nb\n');
      const j = { id, status: 'running', folder: dir, write: true, role: 'текст', task: 'ЗАПИШИ ФАЙЛ a.js', startedAt: new Date().toISOString() };
      json(path.join(jobs, id + '.json'), j);
      const bridge = bridgeHarness(who), original = { snapshot: tf.snapshot, compare: tf.compare, copy: fs.copyFileSync, changes: fb.folderChanges };
      if (fault === 'снимок') tf.snapshot = () => { throw Error('test snapshot'); };
      if (fault === 'проверка') tf.compare = () => { throw Error('test compare'); };
      if (fault === 'предел') tf.compare = (dir, snap, before, writes, opts) => original.compare(dir, snap, before, writes, { ...opts, maxSteps: 0 });
      if (fault === 'копирование') fs.copyFileSync = () => { throw Object.assign(Error('test copy'), { code: 'EACCES' }); };
      if (fault === 'список') fb.folderChanges = () => null;
      if (fault === 'хеш') fb.folderChanges = (...args) => {
        const read = fs.readFileSync;
        fs.readFileSync = (...a) => { if (String(a[0]) === path.join(dir, 'a.js')) throw Object.assign(Error('denied'), { code: 'EACCES' }); return read(...a); };
        try { return original.changes(...args); } finally { fs.readFileSync = read; }
      };
      let released = false;
      try {
        // team-v48e (ревью п.1): замок несёт owner.folder фактической папки — reconcile видит совпадение и не переснимает замок.
        await bridge.execute(j, { ok: true, owner: { folder: require('../common/paths').canon(dir) }, release: async () => { released = true; } });
        for (let i = 0; i < 200 && !released; i++) await new Promise(r => setTimeout(r, 50));
        assert(released, 'замок папки освобождён');
        const card = bridge.load(id); assert.equal(card.status, 'done', card.error);
        assert(!fs.existsSync(path.join(jobs, id, 'format-before')));
        const lock = await require('../common/locks').tryLock(who + '_execution', id, { jobId: id });
        assert(lock.ok, 'замок исполнения освобождён'); await lock.release();
        if (fault === 'нет') { assert.equal(card.formatCheck, 'проверено'); assert(card.formatSuspicions.some(s => s.path === 'a.js' && s.issues.includes('BOM пропал'))); }
        else assert.match(card.formatCheck, /ошибка снимка|ошибка проверки|неполная|пропущено/);
        if (fault === 'хеш') { assert.match(card.formatCheck, /^неполная:.*a\.js.*EACCES/); assert.deepEqual(card.writes.find(e => e.path === 'a.js'), { path: 'a.js', sha256: null }); }
      } finally { tf.snapshot = original.snapshot; tf.compare = original.compare; fs.copyFileSync = original.copy; fb.folderChanges = original.changes; }
    });
  function changeCard(name = 'change-' + ++seq) {
    const designFile = path.join(project, name + '.md'); write(designFile, 'замысел');
    const c = { name, base: BASE, candidate: CANDIDATE, status: 'ожидает ревью', request: 'Проверить team-v45 полностью', requestMark: '#12345678',
      designFile, designHash: sha('замысел'), candidateDesignHash: sha('замысел'), designVotes: [], verdicts: [] };
    json(team.changeFile(name), c); return c;
  }
  function review(c, who, decision = 'ПРИНЯТО', phase = 'design') {
    const id = 'review-' + ++seq, dir = f.stores.roots()[who], text = decision === 'ПРИНЯТО' ? 'ПРИНЯТО' : 'НЕ ПРИНЯТО: 1 блокирующих';
    const j = { id, status: 'done', role: 'проверка', mode: 'review', write: false, task: [c.requestMark, c.designHash, BASE, CANDIDATE].join(' '),
      model: who === 'deepseek' ? 'deepseek-v4-pro' : who === 'codex' ? 'gpt-6' : 'gemini-3.8-flash-high',
      profile: 'most-review', modelConfirmed: true, reportedModel: 'deepseek-v4-pro', dshVersion: '0.2.1-rc.2',
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), resultFile: id + '.result.txt' };
    if (who === 'antigravity') { json(path.join(dir, id, 'card.json'), j); write(path.join(dir, id, 'result.txt'), text); json(path.join(dir, id, 'meta.json'), { hash: sha(text) }); }
    else { json(path.join(dir, id + '.json'), j); write(path.join(dir, j.resultFile), text); }
    return { action: phase, name: c.name, who, decision, job_id: id, base: BASE, candidate: CANDIDATE };
  }
  test('П2 MCP: пауза при старте → голос без перезапуска; отказ без записи; удаление', async () => {
    pause(true);
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js'), { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: process.execPath, args: [__filename, '--team-server'], stderr: 'pipe', env: { ...process.env } });
    const client = new Client({ name: 'team-v45', version: '1' });
    await client.connect(transport);
    try {
      const schema = (await client.listTools()).tools;
      assert(schema.find(t => t.name === 'team_change').inputSchema.properties.who.enum.includes('deepseek'));
      assert(schema.find(t => t.name === 'team_word').inputSchema.properties.who_down.enum.includes('deepseek'));
      const c = changeCard(), call = (name, args) => client.callTool({ name, arguments: args }), text = r => r.content.map(x => x.text || '').join('\n');
      pause(false);
      let r = await call('team_change', review(c, 'deepseek')); assert(!r.isError, text(r));
      const operations = () => [
        ['team_change', review(c, 'deepseek')], ['team_change', review(c, 'deepseek', 'ПРИНЯТО', 'verdict')],
        ['team_change', { action: 'design', name: c.name, who: 'claude', replaces: 'deepseek', decision: 'ПРИНЯТО', note: 'Проверено по фактам' }],
        ['team_change', { action: 'verdict', name: c.name, who: 'user', replaces: 'deepseek', decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ', quote: 'Решение', base: BASE, candidate: CANDIDATE }],
        ['team_word', { action: 'record', who_down: 'deepseek', quote: 'DeepSeek отвалился' }],
      ];
      for (const removed of [false, true]) {
        if (removed) updateMembers(n => { n.members.find(m => m.id === 'deepseek').state = 'removed'; }); else pause(true);
        for (const [tool, args] of operations()) {
          const ownerWord = tool === 'team_change' && args.who === 'user';
          const before = fs.readFileSync(team.changeFile(c.name), 'utf8'), words = require('../common/user-word').lines().length;
          r = await call(tool, args);
          // team-v59: слово владельца закрывает место даже для участника на паузе (deepseek ещё в knownSeatIds);
          // удалённого (не место связки) заменить нельзя — отказ по replaces.
          if (ownerWord && !removed) { assert(!r.isError, text(r)); assert.match(text(r), /Закрыто словом владельца/); continue; }
          assert(r.isError, text(r)); assert.match(text(r), removed ? /Неверный участник|replaces/ : /на паузе/);
          assert.equal(fs.readFileSync(team.changeFile(c.name), 'utf8'), before); assert.equal(require('../common/user-word').lines().length, words);
        }
        if (!removed) {
          pause(false);
          for (const phase of ['design', 'verdict']) { r = await call('team_change', review(c, 'deepseek', 'ПРИНЯТО', phase)); assert(!r.isError, text(r)); }
          for (let i = 0; i < 2; i++) { r = await call('team_change', review(c, 'deepseek', 'НЕ ПРИНЯТО')); assert(!r.isError, text(r)); }
          for (const [tool, args] of operations().slice(2)) { r = await call(tool, args); assert(!r.isError, text(r)); }
        }
      }
    } finally { await client.close(); await transport.close(); pause(false); }
  });
  test('П2 фаза A и неголосующая роль не получают новый допуск', async () => {
    const c = changeCard(); updateMembers(() => {}, 'A');
    try { await assert.rejects(team.change(review(c, 'deepseek')), /Неверный участник/); assert(!members.knownSeatIds.includes('deepseek')); }
    finally { updateMembers(() => {}); }
    updateMembers(n => { n.members.find(m => m.id === 'deepseek').roles.voter = false; });
    try { await assert.rejects(team.change(review(c, 'deepseek', 'ПРИНЯТО', 'verdict')), /не голосует/); assert(!members.knownVoterFamilies.includes('deepseek')); }
    finally { updateMembers(n => { n.members.find(m => m.id === 'deepseek').roles.voter = true; }); }
  });
  async function acceptedChange() {
    const c = changeCard();
    for (const who of members.seatIds) for (const phase of ['design', 'verdict']) await team.change(review(c, who, 'ПРИНЯТО', phase));
    return c;
  }
  test('П3 отсутствие Claude допускает слияние, НЕ ПРИНЯТО останавливает, новое ПРИНЯТО снимает', async () => {
    let c = await acceptedChange(); assert.match(await team.change({ action: 'merge', name: c.name }), /Слито/);
    c = await acceptedChange(); const vote = decision => team.change({ action: 'verdict', name: c.name, who: 'claude', decision, base: BASE, candidate: CANDIDATE });
    await vote('НЕ ПРИНЯТО'); await assert.rejects(team.change({ action: 'merge', name: c.name }), /слияние остановлено дирижёром/);
    await vote('ПРИНЯТО'); assert.match(await team.change({ action: 'merge', name: c.name }), /Слито/);
    c = await acceptedChange(); const saved = read(team.changeFile(c.name)); saved.verdicts.push({ who: 'claude', base: 'other', candidate: CANDIDATE, decision: 'НЕ ПРИНЯТО' }); json(team.changeFile(c.name), saved);
    assert.match(await team.change({ action: 'merge', name: c.name }), /Слито/);
    c = await acceptedChange(); await team.change(review(c, 'codex', 'НЕ ПРИНЯТО', 'verdict'));
    await assert.rejects(team.change({ action: 'merge', name: c.name }), /НЕ ПРИНЯТО|отказ|принятия/);
  });
  function work() {
    const name = 'work-' + ++seq, w = { name, title: 'Проверка закрытия', revision: 1, goal: 'Цель', done_criteria: 'Итог', next_step: 'Выдать', reminders: [],
      folder: path.join(project, 'missing'), stages: [
        { id: 'accepted', title: 'Принятый', state: 'принят', weight: 25, version: 'v1', evidence: 'проверено', accept_criteria: 'готово' },
        { id: 'issued', title: 'Выданный', state: 'выдан без принятия', weight: 25, override: { by: 'user', quote: 'раньше' }, accept_criteria: 'готово' },
        { id: 'legacy', title: 'Старый', state: 'идёт', weight: 25, accept_criteria: 'готово' },
        { id: 'missing', title: 'Нет папки', state: 'план', weight: 25, level: 'обычный', author: { family: 'openai', model: 'gpt-6' }, material: ['absent.md'], accept_criteria: 'готово' },
      ] };
    json(team.workFile(name), w); return w;
  }
  test('П5 close → get → list → status: сохранённые этапы, отметка и процент', async () => {
    const w = work(), out = await team.work({ action: 'close', name: w.name, expected_revision: 1, quote: 'Закрыть без принятия' });
    assert.match(out, /Принято 25 %/); assert.match(out, /закрыто словом пользователя/);
    const saved = read(team.workFile(w.name)); assert(saved.closed); assert.deepEqual(saved.closedByWord.stages, ['legacy', 'missing']);
    assert.deepEqual(saved.stages.slice(0, 2), w.stages.slice(0, 2));
    for (const s of saved.stages.slice(2)) { assert.equal(s.state, 'выдан без принятия'); assert(s.override.closed_by_word); }
    for (const action of ['get', 'list']) { const text = await team.work({ action, name: w.name }); assert.match(text, /закрыто словом пользователя/); assert(!text.includes('Нужны level и author')); }
    const status = await team.status(undefined, undefined, false, true); assert(!status.includes('Нужны level и author')); assert.match(status, /закрыто словом пользователя/);
    await require('../common/summary').compact(team, 'Квоты: тест');
    assert.deepEqual(read(team.workFile(w.name)), saved);
    for (const gate of ['stage-gate', 'stage-gate-v15']) for (const s of saved.stages.slice(2)) assert.match(await require('../common/' + gate).evaluate(saved, s, s), /закрыто словом/);
    await assert.rejects(team.work({ action: 'update', name: w.name, expected_revision: 2 }), /Закрытую работу/);
  });
  test('П5 close очищает прежние сообщения gate в ответе и get', async () => {
    const w = work(), stale = { message: 'Нужны level и author', warning: 'Старое предупреждение', version: 'v-old' };
    for (const s of w.stages.slice(0, 2)) s.gate = { version: 'сохранить' };
    for (const s of w.stages.slice(2)) s.gate = { ...stale };
    json(team.workFile(w.name), w);
    const out = await team.work({ action: 'close', name: w.name, expected_revision: 1, quote: 'Закрыть без принятия' });
    const saved = read(team.workFile(w.name));
    assert.deepEqual(saved.stages.slice(0, 2), w.stages.slice(0, 2));
    for (const s of saved.stages.slice(2)) assert.deepEqual(s.gate, { version: 'v-old' });
    for (const text of [out, await team.work({ action: 'get', name: w.name })]) {
      assert(!text.includes(stale.message)); assert(!text.includes(stale.warning)); assert.match(text, /закрыто словом пользователя/);
    }
  });
  test('П5 close сохраняет название старого этапа без id', async () => {
    const w = work(); delete w.stages[2].id; json(team.workFile(w.name), w);
    await team.work({ action: 'close', name: w.name, expected_revision: 1, quote: 'Закрыть без принятия' });
    assert.deepEqual(read(team.workFile(w.name)).closedByWord.stages, ['Старый', 'missing']);
  });
  test('П5 пустое слово, подмена плана, права и прежний close', async () => {
    const w = work(), args = { action: 'close', name: w.name, expected_revision: 1 }, before = fs.readFileSync(team.workFile(w.name), 'utf8');
    for (const quote of ['', '  ']) await assert.rejects(team.work({ ...args, quote }), /нужно слово/);
    for (const extra of [{ stages: [] }, { goal: 'другая' }, { plan_change: 'другая' }, { status_sent: true }]) await assert.rejects(team.work({ ...args, quote: 'Закрыть', ...extra }), /не меняет план/);
    await assert.rejects(team.work(args), /Закрыть можно/);
    // team-v59: закрытие словом — из доказанного чата любого участника и в запасном режиме; только поручение/недоказанный сеанс — отказ.
    const prevJob = process.env.MOST_JOB_ID; process.env.MOST_JOB_ID = 'job-v45';
    try { await assert.rejects(team.work({ ...args, quote: 'Закрыть' }), /из поручения|недоказанного/); }
    finally { if (prevJob === undefined) delete process.env.MOST_JOB_ID; else process.env.MOST_JOB_ID = prevJob; }
    assert.equal(fs.readFileSync(team.workFile(w.name), 'utf8'), before);
  });
  test('П3/П4 тексты и ограничение размера памятки', () => {
    const rules = fs.readFileSync(path.join(__dirname, '../rules/common.md'), 'utf8'), brief = fs.readFileSync(path.join(__dirname, '../rules/brief.md'), 'utf8');
    assert.match(rules, /вердикт Claude необязателен/); assert.match(rules, /если записан — явный/); assert.match(brief, /Claude — необязательно, его НЕ ПРИНЯТО — стоп/); assert(brief.length <= 7587);
    const lesson = fs.readFileSync(path.join(__dirname, '../lessons.md'), 'utf8').split('## 86.')[1]; assert(lesson); assert.match(lesson, /Где закрыто:/); assert.match(lesson, /Проверка фактического поведения:/);
  });
  f.run(tests);
}
