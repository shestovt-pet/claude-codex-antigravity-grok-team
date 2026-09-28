'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v5-'));
process.env.MOST_REPO_ROOT = RUN; process.env.MOST_STATE_DIR = path.join(RUN, 'state');
process.env.MOST_CODEX_JOBS_DIR = path.join(RUN, 'state/codex-jobs');
process.env.MOST_CODEX_ARCHIVE_DIR = path.join(RUN, 'archive');
process.env.MOST_CLIENT = 'claude'; process.env.MOST_NOTIFY = 'off'; process.env.MOST_TEST_KEEP = '1';
process.env.MOST_CLAUDE_CONFIGS = '[]';
process.env.MOST_CODEX_CONFIG = path.join(RUN, 'codex.toml');
process.env.MOST_AGY_MCP_CONFIG = path.join(RUN, 'agy.json');
process.env.MOST_AGY_CONFIG = path.join(RUN, 'permissions.json');
process.env.MOST_CODEX_RULES = path.join(RUN, 'missing-codex.md'); process.env.MOST_AGY_RULES = path.join(RUN, 'missing-agy.md');
const d = require('../common/deploy'), ops = require('../common/deploy-ops'), gate = require('../common/grok-gate');
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const json = (f, v) => write(f, JSON.stringify(v)), read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const tests = [], test = (label, fn) => tests.push({ label, fn });
function plan(name) { const file = path.join(RUN, name + '.json'); json(file, { old: true }); return { ...d.snapshot(file), next: '{"new":true}', backup: true }; }
test('Р1: равный текст двух разных файлов записывается дважды', async () => {
  const a = plan('equal-a'), b = plan('equal-b'); let writes = 0;
  await d.switchConfigs([a, b], () => { writes++; });
  assert.equal(writes, 2); assert.equal(fs.readFileSync(b.file, 'utf8'), b.next);
});
test('Р1: псевдонимы dev+ino+nlink=1 — одна запись и чтение обоих путей', async () => {
  const a = plan('alias-a'), b = { ...a, file: path.join(RUN, 'alias-b.json') };
  const stat = fs.statSync, readFile = fs.readFileSync, lstat = fs.lstatSync;
  let seen = 0, writes = 0;
  fs.statSync = (f, ...args) => stat(f === b.file ? a.file : f, ...args);
  fs.lstatSync = (f, ...args) => lstat(f === b.file ? a.file : f, ...args);
  fs.readFileSync = (f, ...args) => { if (f === b.file) seen++; return readFile(f === b.file ? a.file : f, ...args); };
  try { await d.switchConfigs([a, b], () => { writes++; }); assert.equal(writes, 1); assert(seen >= 2); }
  finally { fs.statSync = stat; fs.readFileSync = readFile; fs.lstatSync = lstat; }
});
test('Р1: изменение идентичности до записи запрещено', async () => {
  const a = plan('identity'), original = fs.statSync; let changed = false;
  fs.statSync = (f, opts) => { const s = original(f, opts); if (changed && f === a.file && opts?.bigint) return { ...s, ino: s.ino + 1n }; return s; };
  try { await assert.rejects(d.switchConfigs([a], () => { changed = true; }), /Состав группы/); assert.equal(fs.readFileSync(a.file, 'utf8'), a.text); }
  finally { fs.statSync = original; }
});
test('Р1: жёсткая ссылка отвергается до записи', async () => {
  const a = plan('hardlink'), original = fs.statSync;
  fs.statSync = (f, opts) => { const s = original(f, opts); return f === a.file && opts?.bigint ? { ...s, nlink: 2n } : s; };
  try { await assert.rejects(d.switchConfigs([a]), /Жёсткие ссылки/); assert.equal(fs.readFileSync(a.file, 'utf8'), a.text); }
  finally { fs.statSync = original; }
});
test('Р1: настоящая жёсткая ссылка Windows не разрывается установкой', async () => {
  const a = plan('real-hardlink'); fs.linkSync(a.file, path.join(RUN, 'real-hardlink-copy.json'));
  await assert.rejects(d.switchConfigs([a]), /Жёсткие ссылки/);
  assert.equal(fs.readFileSync(a.file, 'utf8'), a.text); assert.equal(fs.statSync(a.file).nlink, 2);
});
test('Р1: расхождение псевдонима после записи вызывает откат', async () => {
  const a = plan('divergence-a'), b = { ...a, file: path.join(RUN, 'divergence-b.json') };
  const stat = fs.statSync, readFile = fs.readFileSync, lstat = fs.lstatSync;
  fs.statSync = (f, ...args) => stat(f === b.file ? a.file : f, ...args);
  fs.lstatSync = (f, ...args) => lstat(f === b.file ? a.file : f, ...args);
  fs.readFileSync = (f, ...args) => f === b.file ? a.text : readFile(f, ...args);
  try { await assert.rejects(d.switchConfigs([a, b]), /Проверка пути.*\nКонфиги восстановлены/); assert.equal(readFile(a.file, 'utf8'), a.text); }
  finally { fs.statSync = stat; fs.readFileSync = readFile; fs.lstatSync = lstat; }
});
test('Р1: нулевой ino не объединяет файлы', async () => {
  const a = plan('zero-a'), b = plan('zero-b'), original = fs.statSync; let writes = 0;
  fs.statSync = (f, opts) => { const s = original(f, opts); return opts?.bigint ? { ...s, ino: 0n } : s; };
  try { await d.switchConfigs([a, b], () => { writes++; }); assert.equal(writes, 2); }
  finally { fs.statSync = original; }
});
test('Р1: после отката перечитываются все псевдонимы', async () => {
  const a = plan('rollback-a'), b = { ...a, file: path.join(RUN, 'rollback-b.json') }, c = plan('rollback-c');
  const stat = fs.statSync, readFile = fs.readFileSync, lstat = fs.lstatSync; let oldReads = 0;
  fs.statSync = (f, ...args) => stat(f === b.file ? a.file : f, ...args);
  fs.lstatSync = (f, ...args) => lstat(f === b.file ? a.file : f, ...args);
  fs.readFileSync = (f, ...args) => { const text = readFile(f === b.file ? a.file : f, ...args); if (f === b.file && text === a.text) oldReads++; return text; };
  try { await assert.rejects(d.switchConfigs([a, b, c], phase => { if (phase === 'config2') throw Error('сбой'); }), /Конфиги восстановлены/); assert(oldReads >= 2); }
  finally { fs.statSync = stat; fs.readFileSync = readFile; fs.lstatSync = lstat; }
});
test('Р1 Д1: 300 с, поздний итог, запрет параллельной установки и потеря ожидающего вызова', async () => {
  const root = path.join(RUN, 'operation'); let now = Date.now(), file;
  const deps = { now: () => now, sleep: async ms => { now += ms; }, alive: () => true, launch: async (_, args) => { file = args[args.indexOf('--result') + 1]; return process.pid; } };
  assert.equal(ops.WAIT_MS, 300000);
  const start = now, text = await ops.start({ root, release: RUN, configs: ['one'], restartClaude: true }, deps);
  assert.equal(now - start, 300000); assert.match(text, /не подтверждён/); assert(!text.includes('не тронуты'));
  await assert.rejects(ops.start({ root, release: RUN, configs: ['one'] }, deps), /Идёт установка/);
  ops.update(file, { status: 'завершено' });
  assert.equal(ops.list(root).at(-1).status, 'завершено');
  // Новый экземпляр читателя не зависит от прежнего ожидающего вызова.
  assert.equal(require('../common/deploy-ops').list(root).at(-1).id, read(file).id);
});
test('Р1: отказ CIM сохраняется до записи настроек', async () => {
  const root = path.join(RUN, 'cim-failure');
  await assert.rejects(ops.start({ root, release: RUN, configs: ['untouched'] }, { launch: async () => { throw Error('CIM отказ'); } }), /CIM отказ/);
  assert.equal(ops.list(root).at(-1).status, 'отказ');
});
test('Р1: запуск действительно строит Win32_Process Create и разбирает PID', async () => {
  const cp = require('child_process'), original = cp.execFile; let command;
  cp.execFile = (exe, args, opts, callback) => { assert.equal(exe, 'powershell.exe'); assert(opts.windowsHide); command = args.at(-1); callback(null, '1234\r\n'); };
  try { assert.equal(await ops.launch(RUN, ['--config-only', '--config', 'C:\\путь с пробелом\\a.json']), 1234); assert.match(command, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/); assert(command.includes('--config-only')); }
  finally { cp.execFile = original; }
});
test('Р1 Д2: мёртвый PID немедленно, неизвестный только через 30 минут; живой не прерывается', () => {
  const root = path.join(RUN, 'dead'), file = path.join(root, 'state/deploy-ops/a.json');
  const card = { id: 'a', pid: 100, status: 'проба', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  json(file, card); assert.equal(ops.list(root, { alive: () => false })[0].status, 'прервана');
  json(file, card); assert.equal(ops.list(root, { alive: () => null })[0].status, 'проба');
  json(file, { ...card, updatedAt: new Date(Date.now() - 1800001).toISOString() });
  assert.equal(ops.list(root, { alive: () => true })[0].status, 'проба');
  assert.equal(ops.list(root, { alive: () => null })[0].status, 'прервана');
});
test('Р1: исполнитель сохраняет переключение раньше перезапуска', async () => {
  const file = path.join(RUN, 'executor.json'); json(file, { root: RUN }); let restart = 0;
  await ops.execute({ result: file, release: RUN, restartClaude: true }, async options => {
    assert.equal(read(file).status, 'проба'); assert.equal(options.restartClaude, false); return 'успех';
  }, { restart: async () => { assert.equal(read(file).status, 'перезапуск идёт'); restart++; return 'перезапуск запланирован'; } });
  assert.equal(restart, 1); assert.equal(read(file).pid, process.pid);
  assert.equal(read(file).status, 'завершено');
  await assert.rejects(ops.execute({ result: file, release: RUN, restartClaude: true }, async () => { throw Error('отказ'); }, { restart: () => { restart++; } }), /отказ/);
  assert.equal(restart, 1); assert.equal(read(file).status, 'отказ');
});
test('Р1: CLI --result ведёт шаги операции и сохраняет успешный итог', async () => {
  const result = path.join(RUN, 'cli-result.json'); json(result, { root: RUN });
  await require('../tools/deploy').main(['--config-only', '--release', RUN, '--config', 'a.json', '--result', result], { configure: async () => 'настроено', print: () => {} });
  assert.equal(read(result).status, 'завершено');
  assert.throws(() => require('../tools/deploy').parseArgs(['--result', result]), /требует --config-only/);
});
test('Codex-1: незавершённый restart блокирует вторую установку до конечного состояния исполнителя', async () => {
  const root = path.join(RUN, 'restart-race'), file = path.join(root, 'state/deploy-ops/first.json');
  json(file, { id: 'first', root, createdAt: new Date().toISOString() });
  let releaseRestart, entered;
  const enteredRestart = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { releaseRestart = resolve; });
  const execution = ops.execute({ result: file, release: RUN, restartClaude: true }, async () => 'Настройки обновлены', {
    restart: async () => { entered(); await blocked; return 'Перезапуск запланирован'; },
  });
  try {
    await enteredRestart;
    assert.equal(read(file).status, 'перезапуск идёт');
    assert.throws(() => ops.assertIdle(root), /Идёт установка first/);
    await assert.rejects(ops.start({ root, release: RUN, configs: ['second'] }, { launch: async () => { throw Error('Запуск второй запрещён'); } }), /Идёт установка first/);
    assert.equal(fs.readdirSync(path.dirname(file)).filter(n => n.endsWith('.json')).length, 1);
  } finally { releaseRestart(); await execution; }
  assert.equal(read(file).status, 'завершено');
  assert.doesNotThrow(() => ops.assertIdle(root));
});
test('Codex-1: отказ запуска перезапуска сохранён отдельно; мёртвый исполнитель освобождает переключённую операцию', async () => {
  const root = path.join(RUN, 'restart-failure'), file = path.join(root, 'state/deploy-ops/first.json');
  json(file, { id: 'first', root, createdAt: new Date().toISOString() });
  await assert.rejects(ops.execute({ result: file, release: RUN, restartClaude: true }, async () => 'обновлено', {
    restart: async () => { throw Error('CIM отказ'); },
  }), /Настройки переключены.*CIM отказ/);
  assert.equal(read(file).status, 'перезапуск не запущен'); assert(read(file).switchedAt);
  assert.doesNotThrow(() => ops.assertIdle(root));
  ops.update(file, { status: 'переключено' });
  assert.equal(ops.list(root, { alive: () => false })[0].status, 'прервана');
  assert.doesNotThrow(() => ops.assertIdle(root));
});
function release(name, complete = true) {
  const root = path.join(RUN, name), id = 'a'.repeat(40), dir = path.join(root, 'live', id);
  for (const n of ['team', 'codex', 'antigravity', ...(complete ? ['grok'] : [])]) write(path.join(dir, 'servers', n, 'index.js'), '');
  json(path.join(dir, 'probe-ok.json'), { root, commit: id, at: new Date().toISOString(), servers: ['antigravity', 'codex', 'team'] });
  return { root, dir };
}
test('Р2 Р3: config-only повторяет десять проб и сохраняет deployed.json', async () => {
  const r = release('legacy'), p = plan('legacy-config'); let probes = 0;
  await d.configure({ release: r.dir, configs: [p.file] }, { probe: async () => { probes++; } });
  assert.equal(probes, 10); assert.equal(read(path.join(r.root, 'live/deployed.json')).method, 'внешним сценарием');
  assert.equal(read(path.join(r.dir, 'probe-ok.json')).servers.length, 4);
});
test('Р2: неполный релиз не меняет конфиги и метку', async () => {
  const r = release('incomplete', false), p = plan('incomplete-config'), marker = fs.readFileSync(path.join(r.dir, 'probe-ok.json'), 'utf8');
  await assert.rejects(d.configure({ release: r.dir, configs: [p.file] }), /Релиз неполон.*team_change deploy/);
  assert.equal(fs.readFileSync(p.file, 'utf8'), p.text); assert.equal(fs.readFileSync(path.join(r.dir, 'probe-ok.json'), 'utf8'), marker);
});
test('Р2 Р3 Д4: clients-only пробует релиз, сохраняет отметку, нераспознанные правила не мешают другим', async () => {
  const r = release('client-release'); write(process.env.MOST_CODEX_CONFIG, ''); json(process.env.MOST_AGY_MCP_CONFIG, {}); json(process.env.MOST_AGY_CONFIG, {});
  const good = path.join(RUN, 'good.md'), bad = path.join(RUN, 'bad.md');
  write(good, '# Личное\nНе менять\n## Связка трёх ИИ\nСтарое\n## Мой раздел\nТочное содержимое\n'); write(bad, '# Личное\n');
  let probes = 0;
  const out = await d.configureClients({ release: r.dir }, { probe: async () => { probes++; }, rules: { files: [{ file: bad, role: 'codex' }, { file: good, role: 'antigravity' }] } });
  assert.equal(probes, 10); assert.match(out, /отказ/); assert.match(fs.readFileSync(good, 'utf8'), /Связка четырёх ИИ/);
  assert.equal(read(path.join(r.root, 'live/deployed.json')).commit, path.basename(r.dir));
  assert(fs.existsSync(good + '.prev')); assert(fs.readFileSync(good, 'utf8').endsWith('## Мой раздел\nТочное содержимое\n'));
  assert.match((await require('../common/client-rules').configure({ files: [good], rollback: true })).join(''), /восстановлен/);
  assert.equal(fs.readFileSync(good, 'utf8'), fs.readFileSync(good + '.prev', 'utf8'));
});
test('Д4: метки, чужие байты, идемпотентность и отказ неоднозначного раздела', () => {
  const rules = require('../common/client-rules'), text = '\uFEFFличное\r\n<!-- most:begin -->\r\nстарое\r\n<!-- most:end -->\r\nхвост';
  const next = rules.replace(text); assert(next.startsWith('\uFEFFличное\r\n')); assert(next.endsWith('\r\nхвост')); assert.equal(rules.replace(next), next);
  for (const bad of ['<!-- most:begin -->', '## Связка трёх ИИ\n## Связка трёх ИИ\n', 'личное']) assert.throws(() => rules.replace(bad));
});
test('63af002a: точные копии глобальных правил — обрамление, внешние байты, повтор и откат', async () => {
  const rules = require('../common/client-rules');
  for (const who of ['antigravity', 'codex']) {
    const original = fs.readFileSync(path.join(__dirname, 'fixtures/trio-v5', who + '-AGENTS.md'));
    const text = original.toString('utf8'), range = rules.section(text), next = rules.replace(text, who);
    const prefix = Buffer.from(text.slice(0, range.from)), suffix = Buffer.from(text.slice(range.to)), bytes = Buffer.from(next);
    assert(bytes.subarray(0, prefix.length).equals(prefix));
    assert(bytes.subarray(bytes.length - suffix.length).equals(suffix));
    assert.equal(rules.replace(next, who), next);
    if (who === 'antigravity') {
      assert.equal((next.match(/<RULE\[/g) || []).length, 3);
      assert.equal((next.match(/<\/RULE\[/g) || []).length, 3);
      assert(text.slice(range.to).startsWith('</RULE[user_global]>'));
    }
    const file = path.join(RUN, who + '-global/AGENTS.md'); write(file, original);
    assert.match((await rules.configure({ files: [{ file, role: who }] })).join(''), /правила обновлены/);
    assert.equal(fs.readFileSync(file, 'utf8'), next);
    assert.match((await rules.configure({ files: [file], rollback: true })).join(''), /восстановлен/);
    assert(fs.readFileSync(file).equals(original));
  }
  for (const tail of ['# Верхний\nЧужое', '## Равный\nЧужое', '</WRAPPER>\nЧужое']) {
    const text = (tail.startsWith('</') ? '<WRAPPER>\n' : '') + '## Связка трёх ИИ\nСтарое\n' + tail;
    assert(rules.replace(text).endsWith(tail));
  }
});
test('63af002a: повреждённое обрамление и кодировка — отказ до записи и резервной копии', async () => {
  const rules = require('../common/client-rules');
  const bad = ['<RULE[user_global]>\n## Связка трёх ИИ\nтекст\n</OTHER>',
    '<RULE[user_global]>\n## Связка трёх ИИ\nтекст',
    '<WRAPPER>\n<!-- most:begin -->\nтекст\n</WRAPPER>\n<!-- most:end -->',
    Buffer.from([0xff, 0xfe, 0x23, 0])];
  for (let i = 0; i < bad.length; i++) {
    const file = path.join(RUN, 'bad-framing-' + i + '/AGENTS.md'); write(file, bad[i]);
    const before = fs.readFileSync(file);
    assert.match((await rules.configure({ files: [{ file, role: 'codex' }] })).join(''), /отказ:/);
    assert(fs.readFileSync(file).equals(before)); assert(!fs.existsSync(file + '.prev'));
  }
});
test('63af002a: последнее слитое определяется временем, старые карточки — коммитом или неизвестностью', () => {
  const { mergedLine, localTime } = require('../common/summary'), g = require('../common/team-git');
  const root = path.resolve(__dirname, '..'), candidate = g.hash(root);
  const recent = { name: 'team-v6', candidate, mergedAt: '2099-02-01T00:00:00Z' };
  const old = { name: 'trio-v5', candidate, mergedAt: '2099-01-01T00:00:00Z' };
  for (const cards of [[recent, old], [old, recent]]) assert.match(mergedLine(root, cards), /последнее team-v6/);
  const legacy = { name: 'legacy', candidate };
  assert.match(mergedLine(root, [legacy]), /последнее legacy.*время коммита/);
  assert(mergedLine(root, [legacy]).includes(localTime(g.git(root, ['show', '-s', '--format=%cI', candidate], { recoverIndex: false }).trim())));
  assert.match(mergedLine(root, [{ name: 'unknown', candidate: '0'.repeat(40) }]), /время неизвестно: 1/);
  assert.match(mergedLine(root, [recent, { name: 'unknown' }]), /последнее с известным временем team-v6.*время неизвестно: 1/);
});
test('63af002a: итоговые уроки проходят действующий блок системных ворот в памяти', () => {
  const root = path.resolve(__dirname, '..'), g = require('../common/team-git');
  const lessons = fs.readFileSync(path.join(root, 'lessons.md'), 'utf8');
  const ids = ['86c40b4d', '2814fa20', 'mujluz79', '8a7270f7', 'mujn954u', 'dd08fe63', '63af002a'];
  for (const id of ids) {
    assert(gate.paragraph(lessons, id, ['closed']), id);
    assert(lessons.split(/\r?\n\s*\r?\n/).some(p => p.includes(id) && /Где закрыто:.*(?:rules|skill|common|servers|tools|tests)\//.test(p)), id);
  }
  // Исполняем сам блок из team.js: git подменён чтением рабочей разницы, никаких merge/записей.
  const source = fs.readFileSync(path.join(root, 'common/team.js'), 'utf8');
  const block = source.slice(source.indexOf('        if (c.systemic?.length) {'), source.indexOf("        if (hash(this.root) !== c.base)"));
  assert(block.includes('Не закрыты системные замечания'));
  const run = new Function('c', 'p', 'folder', 'lessonText', 'git', 'require', block);
  // Публичная копия без истории (team-v11 Р6): старого коммита нет — сверка против пустого дерева.
  let base = '41fd4f7';
  try { g.git(root, ['cat-file', '-e', base + '^{commit}'], { recoverIndex: false }); } catch { base = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; }
  const card = { base, systemic: ids.map(job_id => ({ who: job_id === 'dd08fe63' ? 'grok' : 'codex', job_id })), verdicts: [] };
  const diff = g.git(root, ['diff', '--no-ext-diff', '--no-textconv', base, '--', 'lessons.md'], { recoverIndex: false });
  const files = g.git(root, ['diff', '--name-only', base], { recoverIndex: false });
  const mockGit = (_folder, args) => args.includes('--name-only') ? files : diff;
  const load = name => name === './grok-gate' ? gate : require(name);
  assert.doesNotThrow(() => run(card, { candidate: 'in-memory' }, root, lessons, mockGit, load));
  assert.throws(() => run(card, { candidate: 'in-memory' }, root, lessons,
    (_folder, args) => mockGit(_folder, args).replaceAll('63af002a', 'missing-id'), load), /Не закрыты системные/);
});
const c = { name: 'gate', requestMark: '#12345678', designHash: 'd'.repeat(64), base: 'b'.repeat(40), candidate: 'c'.repeat(40) };
function job(status, phase, decision = 'ПРИНЯТО') {
  const id = crypto.randomUUID(), dir = path.join(RUN, 'state/grok-jobs');
  const card = { id, status, task: c.requestMark + ' ' + (phase === 'design' ? c.designHash : c.base + ' ' + c.candidate), startedAt: new Date().toISOString() };
  if (status === 'done') { const text = decision + '\nКОНТРОЛЬ ' + 'a'.repeat(64) + '\nКОНЕЦ ОТВЕТА'; write(path.join(dir, id + '.result.txt'), text); card.resultHash = crypto.createHash('sha256').update(text).digest('hex'); }
  json(path.join(dir, id + '.json'), card); return id;
}
test('Р5: не запрошен, ожидание, отменённый и неверная привязка', async () => {
  await assert.rejects(gate.check({ ...c }, ''), /Grok не запрошен/);
  const card = { ...c };
  assert.match(await gate.record(card, 'design', { job_id: job('running', 'design') }), /ждём ответ/);
  await assert.rejects(gate.check(card, ''), /Ждём Grok/);
  await assert.rejects(gate.record(card, 'design', { job_id: job('cancelled', 'design') }), /Отменённое/);
  await assert.rejects(gate.record(card, 'design', { job_id: job('running', 'verdict') }), /точного хеша/);
});
test('Р5: проверенные ответы двух фаз и аннулирование пары или замысла', async () => {
  const card = { ...c };
  for (const phase of ['design', 'verdict']) await gate.record(card, phase, { job_id: job('done', phase) });
  await gate.check(card, '');
  await assert.rejects(gate.check({ ...card, candidate: 'e'.repeat(40) }, ''), /Grok не запрошен/);
  await assert.rejects(gate.check({ ...card, designHash: 'f'.repeat(64) }, ''), /Grok не запрошен/);
});
test('Р5: отрицательный ответ требует решения в том же абзаце', async () => {
  const card = { ...c }, id = job('done', 'design', 'НЕ ПРИНЯТО: 1 блокирующих');
  await gate.record(card, 'design', { job_id: id }); await gate.record(card, 'verdict', { job_id: job('done', 'verdict') });
  await assert.rejects(gate.check(card, id.slice(0, 8) + '\n\nОтклонено: причина'), /Нет решения/);
  await gate.check(card, id.slice(0, 8) + ' Отклонено: проверено по фактам');
  await gate.check(card, id.slice(0, 8) + '\nГде закрыто: код\nПроверка: тест');
});
test('Р5: потеря после 60 минут и отказ вебхука требуют отдельных решений', async () => {
  for (const status of ['lost', 'failed']) {
    const card = { ...c }, id = job(status, 'design');
    await gate.record(card, 'design', { job_id: id }); await gate.record(card, 'verdict', { job_id: job('done', 'verdict') });
    await assert.rejects(gate.check(card, ''), /Нет решения/);
    await gate.check(card, id.slice(0, 8) + ' Отклонено: причина отказа');
  }
  const id = job('running', 'design'), f = path.join(RUN, 'state/grok-jobs', id + '.json');
  json(f, { ...read(f), startedAt: new Date(Date.now() - 3600001).toISOString() });
  const card = { ...c }; await gate.record(card, 'design', { job_id: id }); assert.equal(card.grokDesign.status, 'lost');
});
test('Р5: недоступный мост до поручения фиксирует причину и требует абзац с именем', async () => {
  const card = { ...c };
  await gate.record(card, 'design', { unavailable: true }); await gate.record(card, 'verdict', { unavailable: true });
  assert(card.grokDesign.reason); await assert.rejects(gate.check(card, ''), /нужно решение/);
  await gate.check(card, 'Grok недоступен gate: мост не настроен');
});
test('Р5: настроенный мост не позволяет записать недоступность без поручения', async () => {
  const file = path.join(RUN, 'state/grok-webhook.json');
  json(file, { url: 'https://api2.cursor.sh/automations/webhook/test', key: 'test-only-key' });
  await assert.rejects(gate.record({ ...c }, 'design', { unavailable: true }), /Мост настроен/);
  write(file, '{}');
});
test('Р6: нагрузка пятичасового окна, устаревший замер, порог 50 млн', () => {
  const dir = path.join(RUN, 'load');
  json(path.join(dir, 'claude-quota.json'), { calls: 8, reread: 51000000, window_h: 5, taken_at: new Date().toISOString() });
  const text = require('../common/summary').loadLine(dir, { antigravity: [{ startedAt: new Date().toISOString(), usage: { total_tokens: 2000000 } }], grok: [] });
  assert.match(text, /Claude перегружен/); assert.match(text, /2.00 млн токенов/);
  json(path.join(dir, 'claude-quota.json'), { calls: 8, reread: 51000000, window_h: 6, taken_at: new Date().toISOString() });
  assert.match(require('../common/summary').loadLine(dir, {}), /нет замера за 5 ч/);
});
test('Р4 Р8: полный ответ краткой сводки укладывается в 4500, запрос один раз, русские заголовки', async () => {
  const { Team } = require('../common/team'), root = path.join(RUN, 'summary'), state = path.join(root, 'state/team'); fs.mkdirSync(root, { recursive: true });
  const t = new Team(root, state);
  for (let i = 0; i < 10; i++) json(t.changeFile('change-' + i), { ...c, name: 'change-' + i, title: 'Изменение ' + i, request: 'Исходный запрос пользователя '.repeat(40), status: i === 9 ? 'слито' : 'ожидает ревью' });
  for (let i = 0; i < 6; i++) json(t.workFile('work-' + i), { name: 'work-' + i, title: 'Работа ' + i, revision: 1, goal: 'Цель', stages: [{ title: 'Проверка', state: 'идёт', weight: 100 }], next_step: 'Проверить результат', reminders: [] });
  const stores = require('../common/team-store'), old = stores.list, quota = require('../common/quota-line'), oldQuota = quota.quotaLine;
  stores.list = who => ({ jobs: who === 'codex' ? [0, 1, 2].map(i => ({ id: 'job-' + i, status: 'queued', startedAt: new Date().toISOString() })) : [], errors: [] });
  quota.quotaLine = async () => 'Квоты: Claude — процент не виден; Codex — использовано 10 %; Antigravity — осталось 90 %';
  try {
    const result = require('../common/format').format('Команда', { status: 'done' }, await t.status(), 'Проверьте результат и выберите следующий шаг.');
    console.log('Размер синтетической сводки: ' + result.length); assert(result.length <= 4500, result); assert.equal((result.match(/Запрос #12345678/g) || []).length, 1); assert.match(result, /Работа 0/); assert.match(result, /Изменение 0/);
    process.env.MOST_CLIENT = 'codex'; assert.match(await t.status(undefined, undefined, undefined, true), /Хранилище состояния/);
  } finally { stores.list = old; quota.quotaLine = oldQuota; process.env.MOST_CLIENT = 'claude'; }
});
test('Д3 Д5 Д6 Д7 Д8: собственные тексты, версия и уроки', () => {
  const root = path.resolve(__dirname, '..');
  assert.deepEqual(require('./interface-texts').inspect(root), []);
  assert.equal(require('../package.json').version, '0.5.8');
  const lessons = fs.readFileSync(path.join(root, 'lessons.md'), 'utf8');
  for (let n = 28; n <= 32; n++) { const section = lessons.split('## ' + n + '.')[1]?.split('\n## ')[0]; assert(section?.includes('Где закрыто:') && section.includes('Проверка')); }
  assert.match(fs.readFileSync(path.join(root, 'rules/common.md'), 'utf8'), /уже созданных изменений/);
});
test('Д9 Д10: все запрещённые формы обнаруживаются в собственном тексте, common, servers и docs охвачены', () => {
  const scanner = require('./interface-texts'), root = path.resolve(__dirname, '..');
  for (const phrase of ['трёх ИИ', 'Связка трёх', 'Квоты трёх', 'квоты четырёх', 'проверка трёх голосов', 'трое проверяющих', 'трио']) {
    assert.deepEqual(scanner.violations('Заголовок: ' + phrase), [1], phrase);
    assert.deepEqual(scanner.violations('return "' + phrase + '";'), [1], phrase);
    assert.deepEqual(scanner.violations('notify(`' + phrase + '`);'), [1], phrase);
    for (const kind of ['user-request', 'assistant-response'])
      assert.deepEqual(scanner.violations('```' + kind + '\n' + phrase + '\n```'), [], kind);
  }
  assert.deepEqual(scanner.violations('trio-v2, trio-v5; настройки трёх приложений'), []);
  const scope = scanner.inventory(root);
  for (const dir of ['docs/', 'rules/', 'common/', 'servers/']) assert(scope.files.some(f => f.startsWith(dir)), dir);
  for (const f of ['AGENTS.md', 'README.md', 'common/format.js', 'servers/team/index.js', 'docs/trio-v5-deploy.md']) assert(scope.files.includes(f));
  assert.equal(scope.history.length, 4);
  assert.deepEqual(scanner.inspect(root), []);
  assert.match(fs.readFileSync(path.join(root, 'rules/brief.md'), 'utf8'), /Квоты команды/);
});
test('AG-1 AG-3 AG-5: настройка Grok остаётся пользователю, все вердикты названы, правила Claude без дублей', () => {
  const root = path.resolve(__dirname, '..');
  for (const file of ['rules/common.md', 'rules/claude.md', 'rules/grok.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /Пользователь добавляет правило сам; код и Claude настройки Grok Bot не меняют/);
    assert(text.includes('C:\\most\\state\\grok') && text.includes('C:\\most\\works'));
    assert(!text.includes('исправляет дирижёр'));
  }
  const brief = fs.readFileSync(path.join(root, 'rules/brief.md'), 'utf8');
  assert(!brief.includes('verdict ×3')); assert.match(brief, /вердикты Codex и Antigravity \(обязательные\), Claude, плюс Grok по итоговой паре/);
  const claude = fs.readFileSync(path.join(root, 'rules/claude.md'), 'utf8');
  assert.equal((claude.match(/restart_claude=true/g) || []).length, 1);
  assert.equal((claude.match(/claude_usage/g) || []).length, 1);
  assert(!claude.includes('--clients-only'));
  const readme = fs.readFileSync(path.join(root, 'docs/architecture.md'), 'utf8').split('## Что изменилось в версии 0.5.0')[1];
  assert(readme && !/Win32_Process|deploy-ops|most:begin/.test(readme));
});
test('Grok ab708007: решение из lessons.md соответствует воротам того же абзаца', () => {
  const lessons = fs.readFileSync(path.join(__dirname, '../lessons.md'), 'utf8');
  assert(gate.paragraph(lessons, 'ab708007', ['closed']));
  assert.match(lessons, /Где закрыто: tz-v5\.md Д1, common\/deploy-ops\.js \(300 с\)/);
});
test('Р4: полная оболочка ответа на копии текущих карточек — не более 3000 символов', async () => {
  const source = process.env.MOST_TEST_STATUS_SOURCE || 'C:/most', root = path.join(RUN, 'current-copy');
  const { Team } = require('../common/team'), t = new Team(rootForCopy(), path.join(root, 'state/team'));
  function rootForCopy() { fs.mkdirSync(root, { recursive: true }); return root; }
  for (const [from, to] of [['state/team/changes', 'state/team/changes'], ['works', 'works']]) {
    const dir = path.join(source, from);
    assert(fs.existsSync(dir), 'Для проверки нужна копия текущих данных: MOST_TEST_STATUS_SOURCE');
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) write(path.join(root, to, name), fs.readFileSync(path.join(dir, name)));
  }
  const marker = path.join(source, 'live/deployed.json'); if (fs.existsSync(marker)) write(path.join(root, 'live/deployed.json'), fs.readFileSync(marker));
  const usage = path.join(source, 'state/team/claude-quota.json');
  if (fs.existsSync(usage)) write(path.join(t.state, 'claude-quota.json'), fs.readFileSync(usage));
  const stores = require('../common/team-store'), oldList = stores.list, grok = require('../common/grok').Grok.prototype, oldRefresh = grok.refresh;
  const locks = require('../common/locks'), oldOwner = locks.ownerState, snapshots = {};
  for (const [who, folder] of [['codex', 'codex-jobs'], ['antigravity', 'jobs'], ['grok', 'grok-jobs']]) {
    const dir = path.join(source, 'state', folder), jobs = [];
    if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) {
      if (n.startsWith('.') || n.includes('.conflict-')) continue;
      const f = path.join(dir, n), card = fs.statSync(f).isDirectory() ? path.join(f, 'card.json') : n.endsWith('.json') ? f : null;
      if (card && fs.existsSync(card)) jobs.push(read(card));
    }
    snapshots[who] = { jobs, errors: [] };
  }
  // Снимок карточек не должен обращаться к живым владельцам и изменять настоящий Grok.
  stores.list = who => snapshots[who]; grok.refresh = async id => snapshots.grok.jobs.find(j => j.id === id); locks.ownerState = async () => 'unknown';
  const oldBinary = process.env.CODEX_PATH; process.env.CODEX_PATH = path.join(__dirname, 'fake-codex.js');
  const oldQuota = require('../common/quota').codexQuota;
  require('../common/quota').codexQuota = async () => ({ source: 'снимок app-server (подделка источника)', rateLimits: { primary: { usedPercent: 10, windowDurationMins: 10080 } } });
  try {
    const text = require('../common/format').format('Команда', { status: 'done' }, await t.status(), 'Проверьте результат и выберите следующий шаг.');
    console.log('Размер сводки копии текущих карточек: ' + text.length); assert(text.length <= 3000, text);
  } finally { stores.list = oldList; grok.refresh = oldRefresh; locks.ownerState = oldOwner; require('../common/quota').codexQuota = oldQuota; if (oldBinary === undefined) delete process.env.CODEX_PATH; else process.env.CODEX_PATH = oldBinary; }
});
test('Р5: настоящие ворота merge требуют Grok даже при трёх обязательных принятиях', async () => {
  const g = require('../common/team-git'), { Team } = require('../common/team'), root = path.join(RUN, 'merge-gate'); fs.mkdirSync(root);
  g.git(root, ['init', '-b', 'main']); g.git(root, ['config', 'user.name', 'Тест']); g.git(root, ['config', 'user.email', 'test@example.invalid']);
  write(path.join(root, '.gitignore'), '.work/\nstate/\nworks/\n'); write(path.join(root, 'base.txt'), 'база');
  g.git(root, ['add', '-A']); g.git(root, ['commit', '-m', 'Тестовая база']);
  const t = new Team(root, path.join(root, 'state/team'));
  await t.change({ action: 'start', name: 'gate', title: 'Проверка ворот', request: 'Тестовый запрос пользователя для проверки ворот.', design_file: path.join(root, 'base.txt') });
  const folder = t.clone('gate'); g.git(folder, ['config', 'user.name', 'Тест']); g.git(folder, ['config', 'user.email', 'test@example.invalid']);
  let card = read(t.changeFile('gate'));
  card.designVotes = ['codex', 'antigravity'].map(who => ({ who, decision: 'ПРИНЯТО', designHash: card.designHash })); json(t.changeFile('gate'), card);
  write(path.join(folder, 'base.txt'), 'кандидат');
  await t.change({ action: 'commit', name: 'gate', message: 'Тестовый кандидат' }); card = read(t.changeFile('gate'));
  for (const who of ['claude', 'codex', 'antigravity']) await t.change({ action: 'verdict', name: 'gate', base: card.base, candidate: card.candidate, who: 'user', replaces: who, decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ', quote: 'Тестовая цитата принятия вместо ' + who });
  await assert.rejects(t.change({ action: 'merge', name: 'gate' }), /Grok не запрошен/);
  require('./grok-fixture').accepted(t, 'gate');
  assert.match(await t.change({ action: 'merge', name: 'gate' }), /Слито в main/);
  assert.equal(g.hash(root), card.candidate);
  assert(Number.isFinite(Date.parse(read(t.changeFile('gate')).mergedAt)));
});
(async () => {
  let passed = 0, failed = 0;
  for (const { label, fn } of tests) { try { await fn(); passed++; console.log('ПРОЙДЕНО: ' + label); } catch (e) { failed++; console.error('ПРОВАЛЕНО: ' + label + '\n' + e.stack); } }
  console.log(`Итого: пройдено ${passed}, провалено ${failed}, пропущено 0`); process.exitCode = failed ? 1 : 0;
})();
