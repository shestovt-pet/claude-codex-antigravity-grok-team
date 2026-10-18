'use strict';
// team-v28 (перенос team-v26 на main 3a81c227), замысел ред. 2. О1–О6, только временные данные вне клона.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'most-v28-'));
Object.assign(process.env, { NODE_ENV: 'test', MOST_NOTIFY: 'off', MOST_REPO_ROOT: path.join(RUN, 'repo'), MOST_STATE_DIR: path.join(RUN, 'state') });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const json = (f, v) => write(f, JSON.stringify(v, null, 2));
const tests = [], test = (name, fn) => tests.push([name, fn]);
const running = require('../common/access').guestTools;
const servers = require('../common/members').servers;
const configs = require('../common/client-configs');

// Как в team-v25 О1: настоящая probeRelease из кода клона, без установки.
function probeRelease() {
  const Module = require('module'), file = path.join(ROOT, 'common/deploy.js');
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.probeRelease = probeRelease;', file);
  return m.exports.probeRelease;
}
let n = 0;
// Поддельный релиз: только common/access.js. extra — инструмент, которого нет в работающем коде.
function release(extra, withAccess = true) {
  const dir = path.join(RUN, 'release-' + (++n));
  for (const s of servers) write(path.join(dir, 'servers', s, 'index.js'), '');
  if (withAccess) write(path.join(dir, 'common', 'access.js'), "'use strict';\n" +
    'const base = require(' + JSON.stringify(path.join(ROOT, 'common', 'access.js')) + ').guestTools;\n' +
    'module.exports = { guestTools: (s, c) => [...base(s, c), ...(' + JSON.stringify(extra || null) + ' && s === c && c === "codex" ? [' + JSON.stringify(extra || '') + '] : [])] };\n');
  return dir;
}
// Поддельная MCP-проба: гость получает список release-кода плюс правка tweak.
function probe(list, calls) {
  return async (file, env) => {
    const s = path.basename(path.dirname(file));
    calls.push([s, env.MOST_CLIENT, env.MOST_PROBE_GUEST || '']);
    if (!env.MOST_PROBE_GUEST) return {};
    return { tools: list(s, env.MOST_CLIENT).map(name => ({ name })) };
  };
}
const state = () => fs.mkdtempSync(path.join(RUN, 'deploy-state-'));
const id = 'b'.repeat(40);

test('О1: ожидаемый список гостя берётся из релиза; новый инструмент не ломает пробу', async () => {
  const extra = 'codex_new_tool';
  assert(!running('codex', 'codex').includes(extra), 'работающий код не должен знать инструмент');
  const dir = release(extra), calls = [];
  const withExtra = (s, c) => [...running(s, c), ...(s === c && c === 'codex' ? [extra] : [])];
  await probeRelease()(dir, path.join(RUN, 'repo'), id, state(), { probe: probe(withExtra, calls) }, async () => {});
  const marker = JSON.parse(fs.readFileSync(path.join(dir, 'probe-ok.json'), 'utf8'));
  assert.equal(marker.commit, id); assert.deepEqual(marker.servers, servers);
  // Проверены все гости из client-configs (CODEX и AGY), а не только codex.
  const guests = calls.filter(c => c[2] === 'full').map(c => c[1] + ':' + c[0]).sort();
  assert.deepEqual(guests, [...configs.CODEX.map(s => 'codex:' + s), ...configs.AGY.map(s => 'antigravity:' + s)].sort());
});

test('О2: лишний или недостающий инструмент гостя — отказ, метки нет', async () => {
  const dir1 = release();
  const plus = (s, c) => [...running(s, c), ...(s === 'team' && c === 'antigravity' ? ['team_extra'] : [])];
  await assert.rejects(probeRelease()(dir1, path.join(RUN, 'repo'), id, state(), { probe: probe(plus, []) }, async () => {}),
    /Гостевой сервер предоставил неверный список инструментов/);
  assert(!fs.existsSync(path.join(dir1, 'probe-ok.json')));
  const dir2 = release('codex_new_tool');
  // Релиз ждёт новый инструмент, а гость его не дал — отказ.
  await assert.rejects(probeRelease()(dir2, path.join(RUN, 'repo'), id, state(), { probe: probe(running, []) }, async () => {}),
    /Гостевой сервер предоставил неверный список инструментов/);
  assert(!fs.existsSync(path.join(dir2, 'probe-ok.json')));
  // Повтор вместо недостающего при той же длине — отказ (Codex b9ad7442: ['a','a'] против ['a','b']).
  const dir3 = release(), dup = (s, c) => { const l = running(s, c); return s === 'team' && c === 'codex' ? [l[0], ...l.slice(0, -1)] : l; };
  assert(new Set(dup('team', 'codex')).size < dup('team', 'codex').length && dup('team', 'codex').length === running('team', 'codex').length);
  await assert.rejects(probeRelease()(dir3, path.join(RUN, 'repo'), id, state(), { probe: probe(dup, []) }, async () => {}),
    /Гостевой сервер предоставил неверный список инструментов/);
  assert(!fs.existsSync(path.join(dir3, 'probe-ok.json')));
  // Повтор в списке самого релиза — тоже отказ, ещё до сравнения.
  const dir4 = path.join(RUN, 'release-dup'); for (const s of servers) write(path.join(dir4, 'servers', s, 'index.js'), '');
  write(path.join(dir4, 'common', 'access.js'), "module.exports = { guestTools: () => ['x', 'x'] };\n");
  await assert.rejects(probeRelease()(dir4, path.join(RUN, 'repo'), id, state(), { probe: probe(running, []) }, async () => {}),
    /В релизе неверный список инструментов гостя/);
});

test('О3: в релизе нет common/access.js — понятный отказ, метки нет', async () => {
  const dir = release(undefined, false);
  await assert.rejects(probeRelease()(dir, path.join(RUN, 'repo'), id, state(), { probe: probe(running, []) }, async () => {}),
    /В релизе нет списка инструментов гостя/);
  assert(!fs.existsSync(path.join(dir, 'probe-ok.json')));
  const bad = path.join(RUN, 'release-bad'); for (const s of servers) write(path.join(bad, 'servers', s, 'index.js'), '');
  write(path.join(bad, 'common', 'access.js'), 'module.exports = {};\n');
  await assert.rejects(probeRelease()(bad, path.join(RUN, 'repo'), id, state(), { probe: probe(running, []) }, async () => {}),
    /В релизе нет списка инструментов гостя \(guestTools\)/);
  // Список считает отдельный процесс: зависший модуль и модуль, завершивший процесс без ответа, — отказ, установщик жив.
  const hang = path.join(RUN, 'release-hang'), quit = path.join(RUN, 'release-quit');
  for (const d of [hang, quit]) for (const s of servers) write(path.join(d, 'servers', s, 'index.js'), '');
  write(path.join(hang, 'common', 'access.js'), 'for (;;) {}\n');
  write(path.join(quit, 'common', 'access.js'), 'process.exit(0);\n');
  const keep = process.env.MOST_GUEST_LIST_TIMEOUT_MS; process.env.MOST_GUEST_LIST_TIMEOUT_MS = '1500';
  try {
    await assert.rejects(probeRelease()(hang, path.join(RUN, 'repo'), id, state(), { probe: probe(running, []) }, async () => {}), /не ответил за 2 с/);
  } finally { if (keep === undefined) delete process.env.MOST_GUEST_LIST_TIMEOUT_MS; else process.env.MOST_GUEST_LIST_TIMEOUT_MS = keep; }
  await assert.rejects(probeRelease()(quit, path.join(RUN, 'repo'), id, state(), { probe: probe(running, []) }, async () => {}), /неверный ответ/);
  for (const d of [hang, quit]) assert(!fs.existsSync(path.join(d, 'probe-ok.json')));
});

test('О4: закрытая работа напоминаний не даёт, открытая — даёт', async () => {
  const root = path.join(RUN, 'works-root'), hourAgo = new Date(Date.now() - 3600000).toISOString();
  const work = (name, closed) => ({ name, title: 'Работа ' + name, owner: 'claude', created_at: hourAgo, ...(closed ? { closed: true } : {}),
    stages: [{ id: 's1', state: 'выдан без принятия' }] }); // как у закрытых 14.10 работ (замысел О4)
  json(path.join(root, 'works', 'zakryta.json'), work('zakryta', true));
  json(path.join(root, 'works', 'otkryta.json'), work('otkryta', false));
  const r = require('../common/work-owner').reminder(root, Date.now(), { owner: 'claude' });
  assert.match(r, /Работа otkryta/); assert.doesNotMatch(r, /Работа zakryta/);
  // Без closed: true прежнее поведение — напоминание есть.
  json(path.join(root, 'works', 'zakryta.json'), work('zakryta', false));
  assert.match(require('../common/work-owner').reminder(root, Date.now(), { owner: 'claude' }), /Работа zakryta/);
});

test('О5: чужая отметка готовности (grok) — справка без «⚠», расхождение своих — по-прежнему «⚠»', async () => {
  const root = path.join(RUN, 'drift-repo'), st = path.join(RUN, 'drift-state');
  fs.mkdirSync(root, { recursive: true });
  const git = (...a) => cp.execFileSync('git', ['-c', 'safe.directory=*', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); write(path.join(root, '.gitignore'), 'live/\n'); git('add', '.'); git('commit', '-q', '-m', 'база');
  const head = git('rev-parse', 'HEAD'), rel = path.join(root, 'live', head);
  json(path.join(root, 'live', 'deployed.json'), { commit: head, release: rel, method: 'test', at: new Date().toISOString() });
  for (const s of servers) json(path.join(st, 'ready', s + '.json'), { release: rel });
  json(path.join(st, 'ready', 'grok.json'), { release: path.join(root, 'live', 'c'.repeat(40)) });
  const drift = require('../common/release-drift');
  let rows = drift.lines(root, st);
  assert(rows.includes('Устаревшая отметка готовности: grok.json'), rows.join('\n'));
  assert(!rows.some(r => /Серверы запущены не из записанной установки/.test(r)), rows.join('\n'));
  json(path.join(st, 'ready', 'codex.json'), { release: path.join(root, 'live', 'd'.repeat(40)) });
  rows = drift.lines(root, st);
  assert(rows.includes('⚠ Серверы запущены не из записанной установки'), rows.join('\n'));
});

test('О6: путь к Codex после обновления приложения ищется заново (Р4)', async () => {
  const bin = path.join(RUN, 'local', 'OpenAI', 'Codex', 'bin'), exe = d => path.join(bin, d, 'codex.exe');
  const keep = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA, CODEX_PATH: process.env.CODEX_PATH }, now = Date.now;
  // Отдельная копия модуля сервера на каждый вызов: свой запомненный путь, как у нового процесса сервера.
  const codexApi = () => {
    const Module = require('module'), file = path.join(ROOT, 'servers/codex/index.js');
    const m = new Module(file, module); m.filename = file; m.paths = [...Module._nodeModulePaths(path.dirname(file)), path.join(ROOT, 'node_modules')];
    const source = fs.readFileSync(file, 'utf8'), end = source.lastIndexOf('\n(async () => {');
    assert(end > 0);
    m._compile(source.slice(0, end) + '\nmodule.exports = { currentBinary };', file);
    return m.exports;
  };
  let shift = 0; const later = ms => { shift += ms; };
  try {
    Date.now = () => now() + shift;
    // where.exe/which не находятся — поиск идёт по LOCALAPPDATA\OpenAI\Codex\bin, как у установленного приложения.
    delete process.env.CODEX_PATH; process.env.PATH = path.join(RUN, 'empty'); process.env.LOCALAPPDATA = path.join(RUN, 'local');
    Object.assign(process.env, { MOST_CLIENT: 'claude', MOST_CODEX_JOBS_DIR: path.join(RUN, 'codex-jobs'), MOST_CODEX_ARCHIVE_DIR: path.join(RUN, 'archive') });
    write(exe('aaaa'), '');
    const api = codexApi();
    assert.strictEqual(api.currentBinary(), exe('aaaa'));
    fs.renameSync(path.join(bin, 'aaaa'), path.join(bin, 'bbbb')); // обновление приложения: новая папка bin\<хеш>
    assert.strictEqual(api.currentBinary(), exe('bbbb'));
    fs.rmSync(path.join(bin, 'bbbb'), { recursive: true, force: true }); // пустой bin
    assert.strictEqual(api.currentBinary(), null);
    write(exe('cccc'), ''); // без найденного пути повторный поиск — не чаще раза в минуту
    assert.strictEqual(api.currentBinary(), null);
    later(61000);
    assert.strictEqual(api.currentBinary(), exe('cccc'));
    fs.rmSync(bin, { recursive: true, force: true }); // bin нет вовсе
    assert.strictEqual(api.currentBinary(), null);
    // Явный CODEX_PATH: пропавший файл не подменяется найденным в bin; вернулся — найден не раньше чем через минуту.
    write(exe('dddd'), ''); const own = path.join(RUN, 'own', 'codex.exe'); process.env.CODEX_PATH = own;
    const explicit = codexApi();
    assert.strictEqual(explicit.currentBinary(), null);
    write(own, ''); assert.strictEqual(explicit.currentBinary(), null);
    later(61000); assert.strictEqual(explicit.currentBinary(), own);
    fs.rmSync(path.dirname(own), { recursive: true, force: true });
    assert.strictEqual(explicit.currentBinary(), null);
  } finally {
    Date.now = now;
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ПРОЙДЕНО: ' + name); }
    catch (e) { failed++; console.error('ПРОВАЛ: ' + name + '\n' + (e.stack || e)); }
  }
  console.log('Итого: пройдено ' + (tests.length - failed) + ', провалено ' + failed + ', пропущено 0');
  if (!process.env.MOST_TEST_KEEP) try { fs.rmSync(RUN, { recursive: true, force: true }); } catch {}
  process.exitCode = failed ? 1 : 0;
})();
