'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const f = require('./team-v16-fixture'), members = require('../common/members');
const deploy = require('../common/deploy'), live = require('../common/live-jobs');
const v43 = require('./fixtures/team-v43/fixture');
const meta = { action: 'test', who: 'claude', reason: 'ревью e22f961b', quote: 'Проверочный участник' };
const change = fn => members.store().update(members.rev(), fn, meta);
const add = () => change(n => n.members.push({ ...structuredClone(members.get('codex')), id: 'zzz',
  adapter_params: { client_config: path.join(f.RUN, 'zzz.toml') } }));
const command = action => require('../common/team-members').run({ action, id: 'zzz', expected_rev: members.rev(), reason: meta.reason, quote: meta.quote });
function probeRelease() {
  const Module = require('module'), file = path.resolve(__dirname, '../common/deploy.js');
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.probeRelease = probeRelease;', file);
  return m.exports.probeRelease;
}
function releaseFiles(release) {
  const root = path.resolve(__dirname, '..');
  for (const name of members.servers) f.write(path.join(release, 'servers', name, 'index.js'),
    'const app = require(' + JSON.stringify(path.join(root, 'servers', name, 'index.js')) + ');' +
    (name === 'team' ? 'app.server.connect(new (require(' + JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')) + ').StdioServerTransport)());' : ''));
  f.write(path.join(release, 'common/access.js'), 'module.exports = require(' + JSON.stringify(path.join(root, 'common/access.js')) + ');');
}
function releaseCli(root) { return path.join(v43.release(root, 'c'.repeat(40)), 'tools', 'deploy.js'); }
f.run([
  ['Р1: remove отказывает для идущего, ожидающего и неподтверждённо остановленного поручения', () => {
    add(); const file = path.join(f.root, 'state/zzz-jobs/job.json');
    try {
      command('pause');
      for (const patch of [{ status: 'running' }, { status: 'queued' }, { status: 'waiting_quota' }, { status: 'applying' },
        { status: 'cancelled', stopUnconfirmed: { pid: 999999 } }, { status: 'stop_unconfirmed' }]) {
        f.json(file, { id: 'job', ...patch }); const rev = members.rev(), count = members.store().history().length;
        assert.throws(() => command('remove'), /незавершённые поручения.*job/);
        assert.equal(members.rev(), rev); assert.equal(members.store().history().length, count);
        assert.equal(members.get('zzz').state, 'paused');
      }
      f.json(file, { id: 'job', status: 'stop_confirmed' }); command('remove');
      assert(!members.get('zzz'));
    } finally { f.json(file, { id: 'job', status: 'done' }); }
  }],
  ['Р1: поручение удалённого и неизвестного участника блокирует настоящий путь restart', async () => {
    const state = path.join(f.root, 'state'), file = path.join(state, 'zzz-jobs/job.json');
    const orphan = path.join(state, 'orphan-jobs/card/card.json');
    f.json(file, { id: 'removed', status: 'running' });
    f.json(orphan, { id: 'unknown', status: 'applying' });
    const hold = require('../common/restart-hold'), begin = hold.begin, abort = hold.abort;
    let aborted = 0, launched = 0;
    hold.begin = async () => ({ runId: 'test' }); hold.abort = async () => { aborted++; return true; };
    try {
      const jobs = await live.running({ stateDir: state });
      assert.deepEqual(jobs.map(j => j.who).sort(), ['orphan', 'zzz']);
      await assert.rejects(() => require('../common/restart').restart({ root: f.root, release: f.root, state },
        { launch: async () => { launched++; } }), e => /не перезапущен.*идут поручения/s.test(e.message) &&
          /zzz/.test(e.message) && /orphan/.test(e.message));
      assert.equal(aborted, 1); assert.equal(launched, 0);
      f.json(file, { id: 'removed', status: 'stop_unconfirmed', owner: { instance: 'dead-review-owner' } });
      assert((await live.running({ stateDir: state })).some(j => j.id === 'removed'));
    } finally {
      hold.begin = begin; hold.abort = abort;
      f.json(file, { status: 'done' }); f.json(orphan, { status: 'done' });
    }
  }],
  ['Р2: настоящая MCP-проба zzz читает тот же проверенный снимок, что ожидание из релиза', async () => {
    change(n => { const m = n.members.find(m => m.id === 'zzz'); m.state = 'active'; m.pause = null; });
    const release = path.join(f.RUN, 'probe-release'); releaseFiles(release);
    const { warning, ...expected } = members.snapshot();
    const calls = [];
    try {
      await probeRelease()(release, f.root, 'a'.repeat(40), path.join(f.RUN, 'probe-locks'), {
        probe: async (file, env) => {
          assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.MOST_STATE_DIR, 'members.json'))), expected);
          assert.notEqual(env.MOST_STATE_DIR, path.join(f.root, 'state'));
          assert.equal(path.resolve(env.MOST_STATE_DIR).slice(0, path.resolve(path.join(f.RUN, 'probe-locks')).length), path.resolve(path.join(f.RUN, 'probe-locks')));
          assert(path.basename(env.MOST_STATE_DIR).startsWith('.probe-'));
          if (!calls.length) change(n => n.members.find(m => m.id === 'zzz').state = 'removed');
          calls.push([env.MOST_CLIENT, env.MOST_PROBE_GUEST]);
          return require('../common/probe').probe(file, env);
        },
      }, async () => {});
      assert.equal(calls.filter(([c, guest]) => c === 'zzz' && guest === 'full').length, 3);
      assert.equal(JSON.parse(fs.readFileSync(path.join(release, 'probe-ok.json'))).commit, 'a'.repeat(40));
    } finally { change(n => n.members.find(m => m.id === 'zzz').state = 'removed'); }
  }],
  ['Р2: deploy с zzz и client_config публикует релиз и переключает его подключение', async () => {
    change(n => n.members.find(m => m.id === 'zzz').state = 'active');
    const git = require('../common/team-git').git;
    git(f.root, ['init', '-b', 'main']); git(f.root, ['config', 'user.name', 'Тест']); git(f.root, ['config', 'user.email', 'test@example.invalid']);
    f.write(path.join(f.root, '.gitignore'), 'state/\nlive/\n'); f.write(path.join(f.root, 'base.txt'), 'проверка установки');
    git(f.root, ['add', '.gitignore', 'base.txt']); git(f.root, ['commit', '-m', 'Тестовая база']);
    const client = members.get('zzz').adapter_params.client_config, config = path.join(f.RUN, 'deploy-claude.json');
    f.write(client, '# чужие настройки\n'); f.json(config, { foreign: true });
    try {
      const result = await deploy.deploy({ root: f.root, configs: [config], stateDir: path.join(f.RUN, 'install-locks') }, {
        archive: async (_root, _commit, temp) => {
          releaseFiles(temp);
          for (const name of ['members.js', 'members-store.js', 'members-default.js', 'paths.js'])
            f.write(path.join(temp, 'common', name), fs.readFileSync(path.resolve(__dirname, '../common', name)));
        }, install: async () => {},
      });
      assert.match(result, /Развёрнуто/);
      const deployed = JSON.parse(fs.readFileSync(path.join(f.root, 'live/deployed.json')));
      assert(deployed.configs.includes(client));
      assert(fs.existsSync(path.join(deployed.release, 'probe-ok.json')));
      const connections = require('../common/toml-records').document(fs.readFileSync(client, 'utf8')).root.mcp_servers;
      assert.equal(connections.team.env.MOST_CLIENT, 'zzz');
      assert.equal(connections.team.args[0], path.join(deployed.release, 'servers/team/index.js'));
      assert.equal(JSON.parse(fs.readFileSync(config)).foreign, true);
    } finally { change(n => n.members.find(m => m.id === 'zzz').state = 'removed'); }
  }],
  ['Р2: повреждённый исходный реестр запрещает пробу, last-good допустим', async () => {
    const s = members.store(), main = fs.readFileSync(s.file), good = fs.readFileSync(s.good);
    const release = path.join(f.RUN, 'probe-release');
    try {
      fs.writeFileSync(s.file, '{'); fs.writeFileSync(s.good, '{');
      let calls = 0;
      await assert.rejects(() => probeRelease()(release, f.root, 'b'.repeat(40), path.join(f.RUN, 'bad-probe-locks'),
        { probe: async () => { calls++; } }, async () => {}), /остановлены/);
      assert.equal(calls, 0);
      fs.writeFileSync(s.good, good);
      await probeRelease()(release, f.root, 'b'.repeat(40), path.join(f.RUN, 'good-probe-locks'),
        { probe: async (_file, env) => {
          assert.equal(JSON.parse(fs.readFileSync(path.join(env.MOST_STATE_DIR, 'members.json'))).rev, members.rev());
        } }, async () => {});
    } finally { fs.writeFileSync(s.file, main); fs.writeFileSync(s.good, good); }
  }],
  ['Р3–Р4: отдельный --state-dir не обходит phase; битый основной реестр читается через last-good', async () => {
    const root = path.join(f.RUN, 'rollback-boundary'), state = path.join(root, 'state');
    const s = require('../common/members-store').create(state); s.read();
    const file = path.join(root, 'claude.json'), legacy = path.join(root, 'legacy/servers/team/index.js');
    f.write(legacy, '// релиз до А'); f.json(file, { marker: 'current' });
    f.json(file + '.prev', { mcpServers: { team: { command: process.execPath, args: [legacy] } } });
    // Решение пользователя: fail-fast — rollback бросает, CLI выходит ненулевым кодом с сообщением в stderr (замысел team-v47, разд. 13.4).
    const cli = require('child_process').spawnSync(process.execPath,
      [releaseCli(root), '--root', root, '--config-only', '--rollback', '--config', file,
        '--state-dir', path.join(f.RUN, 'cli-other-locks')], { encoding: 'utf8', windowsHide: true, timeout: 20000,
        env: { ...process.env, MOST_STATE_DIR: path.join(root, 'state') } });
    assert.notEqual(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stderr, /Откат ниже кандидата А запрещён.*phase A, rev 0/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { marker: 'current' });
    for (const corrupt of [false, true]) {
      if (corrupt) fs.writeFileSync(s.file, '{');
      await assert.rejects(() => deploy.rollback({ root, configs: [file], configOnly: true, stateDir: path.join(f.RUN, 'other-locks') }), /Откат ниже кандидата А запрещён.*phase A, rev 0/);
      assert.deepEqual(JSON.parse(fs.readFileSync(file)), { marker: 'current' });
    }
    fs.writeFileSync(s.good, '{');
    await assert.rejects(() => deploy.rollback({ root, configs: [file], configOnly: true, stateDir: path.join(f.RUN, 'other-locks') }), /остановлены/);
  }],
  ['8ea9c668: clients-only rollback проверяет phase явного --root, а не корня окружения', () => {
    const root = path.join(f.RUN, 'clients-rollback-root'), ambient = path.join(f.RUN, 'clients-rollback-ambient');
    const store = require('../common/members-store').create(path.join(root, 'state'));
    assert.equal(store.read().rev, 0);
    const file = path.join(root, 'mcp.json'), legacy = path.join(root, 'legacy/servers/team/index.js');
    f.write(legacy, '// релиз до реестра');
    f.json(file, { marker: 'current' });
    f.json(file + '.prev', { mcpServers: { team: { command: process.execPath, args: [legacy] } } });
    const current = fs.readFileSync(file, 'utf8'), previous = fs.readFileSync(file + '.prev', 'utf8');
    // Решение пользователя: fail-fast — CLI выходит ненулевым кодом, сообщение в stderr (замысел team-v47, разд. 13.4).
    const output = require('child_process').spawnSync(process.execPath,
      [releaseCli(root), '--clients-only', '--rollback', '--root', root], {
        encoding: 'utf8', windowsHide: true, timeout: 20000,
        env: { ...process.env, MOST_REPO_ROOT: ambient, MOST_STATE_DIR: path.join(root, 'state'),
          MOST_AGY_MCP_CONFIG: file, MOST_CODEX_CONFIG: path.join(root, 'absent.toml'),
          MOST_DSH_CONFIG: path.join(root, 'absent.yml'), MOST_AGY_CONFIG: path.join(root, 'absent-permissions.json'),
          MOST_CODEX_RULES: path.join(root, 'absent-codex.md'), MOST_AGY_RULES: path.join(root, 'absent-agy.md'),
          MOST_DSH_RULES: path.join(root, 'absent-dsh.md'), MOST_AGY_CLI_SETTINGS: path.join(root, 'absent-settings.json') },
      });
    assert.notEqual(output.status, 0, output.stdout + output.stderr);
    assert.match(output.stderr, /Откат ниже кандидата А запрещён.*phase A, rev 0/);
    assert.equal(fs.readFileSync(file, 'utf8'), current);
    assert.equal(fs.readFileSync(file + '.prev', 'utf8'), previous);
    assert(!fs.existsSync(path.join(ambient, 'state/members.json')));
  }],
  ['Р6: правила берут состав из team_status и сохраняют прежний кворум А', () => {
    const files = ['AGENTS.md', 'README.md', 'docs/consilium-workflow.md', 'rules/fallback.md',
      'rules/antigravity.md', 'rules/common.md', 'rules/brief.md', 'skill/helpers/SKILL.md', 'skill/vtm-hronika/SKILL.md'];
    for (const file of files) {
      const full = path.resolve(__dirname, '..', file);
      // Личный скилл исключён из публичной выгрузки (tools/export-public.js): там файла нет, проверять нечего.
      if (file === 'skill/vtm-hronika/SKILL.md' && !fs.existsSync(full)) continue;
      const text = fs.readFileSync(full, 'utf8');
      assert(!/другая из двух семей|У пользователя два помощника|всем троим|обоих помощников|с двумя помощниками|Claude — дирижёр\. Помощники:/.test(text), file);
      assert(text.includes('team_status'), file);
    }
    const helpers = fs.readFileSync(path.resolve(__dirname, '../skill/helpers/SKILL.md'), 'utf8');
    // team-v39: кворум работ «2 из 3» (решения пользователя 12.10 и 20.10; сервер v16).
    assert(helpers.includes('Работу проверяют две внешние голосующие семьи из team_status, кроме семей авторов'));
    assert(helpers.includes('Автор я: после разбора хватает «ПРИНЯТО» двух внешних голосующих семей из team_status; отклонённое замечание идёт пользователю особым мнением.'));
    const fallback = fs.readFileSync(path.resolve(__dirname, '../rules/fallback.md'), 'utf8');
    assert(fallback.includes('проверяют две внешние голосующие семьи из team_status («2 из 3»), кроме семей авторов'));
  }],
  ['Р5: частичный сбой DSH и повтор возвращают одну цель, .prev неизменна', async () => {
    const root = path.join(f.RUN, 'rollback-dsh-partial'), file = path.join(root, 'cordis.patch.yml');
    const yaml = require('../common/dsh-config'), oldEnv = process.env.MOST_DSH_CONFIG;
    const old = yaml.render('- id: personal\n', path.join(root, 'live', 'a'.repeat(40)), root, process.execPath);
    const current = yaml.render(old, path.join(root, 'live', 'b'.repeat(40)), root, process.execPath);
    f.write(file, current); f.write(file + '.prev', old); process.env.MOST_DSH_CONFIG = file;
    const read = fs.readFileSync, rename = fs.renameSync; let published = false;
    try {
      // Публикация прошла, последующая проверка и компенсация получили отказ диска.
      fs.renameSync = (a, b) => { const r = rename(a, b); if (b === file) published = true; return r; };
      fs.readFileSync = (p, ...args) => { if (p === file && published) throw Error('тест: диск временно недоступен'); return read(p, ...args); };
      const result = await deploy.rollback({ root, configs: [file], configOnly: true, stateDir: path.join(root, 'locks') });
      assert.match(result, /Обновлено частично/);
    } finally { fs.readFileSync = read; fs.renameSync = rename; }
    try {
      assert.equal(read(file, 'utf8'), old); assert.equal(read(file + '.prev', 'utf8'), old);
      assert.equal(read(file + '.rollback-backup', 'utf8'), current);
      for (let i = 0; i < 2; i++) {
        assert.match(await deploy.rollback({ root, configs: [file], configOnly: true, stateDir: path.join(root, 'locks') }), /возвращён/);
        assert.equal(read(file, 'utf8'), old); assert.equal(read(file + '.prev', 'utf8'), old);
      }
    } finally { if (oldEnv === undefined) delete process.env.MOST_DSH_CONFIG; else process.env.MOST_DSH_CONFIG = oldEnv; }
  }],
  ['Р7: каталоги пробы реестра убираются после успеха и после сбоя', async () => {
    const release = path.join(f.RUN, 'clean-probe-release'); releaseFiles(release);
    const id = 'b'.repeat(40), ok = path.join(f.RUN, 'clean-probe-ok'), fail = path.join(f.RUN, 'clean-probe-fail');
    const inside = (env, dir) => {
      assert.equal(path.resolve(env.MOST_STATE_DIR).slice(0, path.resolve(dir).length), path.resolve(dir));
      assert(path.basename(env.MOST_STATE_DIR).startsWith('.probe-'));
    };
    await probeRelease()(release, f.root, id, ok, { probe: async (_file, env) => { inside(env, ok); return {}; } }, async () => {});
    assert.deepEqual(fs.readdirSync(ok).filter(n => n.startsWith('.probe-')), []);
    await assert.rejects(() => probeRelease()(release, f.root, id, fail,
      { probe: async (_file, env) => { inside(env, fail); throw Error('тест: проба упала'); } }, async () => {}), /проба упала/);
    assert.deepEqual(fs.readdirSync(fail).filter(n => n.startsWith('.probe-')), []);
  }],
  ['Р9: откат при инициализированном реестре разрешён в релиз кандидата А', async () => {
    const root = path.join(f.RUN, 'rollback-allowed'), state = path.join(root, 'state');
    require('../common/members-store').create(state).read();
    const release = path.join(root, 'live', 'a'.repeat(40));
    for (const name of members.servers) f.write(path.join(release, 'servers', name, 'index.js'), '');
    for (const name of ['members.js', 'members-store.js', 'members-default.js', 'paths.js'])
      f.write(path.join(release, 'common', name), fs.readFileSync(path.resolve(__dirname, '../common', name)));
    const file = path.join(root, 'claude.json'), target = path.join(release, 'servers/team/index.js');
    f.json(file, { mcpServers: { team: { command: 'current', args: [] } } });
    f.json(file + '.prev', { mcpServers: { team: { command: process.execPath, args: [target] } } });
    const out = await deploy.rollback({ root, configs: [file], configOnly: true, stateDir: path.join(root, 'locks') });
    assert.match(out, /возвращён/);
    assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers.team.args[0], target);
  }],
  ['Р8: тексты правки — состав из team_status, строчная «обязательны», без «нет Claude CLI» и «трёх серверов»', () => {
    const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const agents = read('AGENTS.md');
    assert(!agents.includes('## Участники и их роли')); assert(!/- \*\*(?:Claude|Codex|Antigravity)\*\*:/.test(agents));
    assert(agents.includes('Участники и специализации — из team_status'));
    const roles = read('rules/roles.md');
    assert(roles.includes('**Codex** — критик логики и проверяемости замысла и итога; код и автотесты.'));
    assert(roles.includes('**Antigravity** — автор литературного текста, содержательная правка, обязательные ревью.'));
    assert(roles.includes('**Claude** — дирижёр: ставит задачи'));
    assert(!roles.includes('Ему же — поиск по диску')); assert(!roles.includes('судья и организатор'));
    assert(!read('rules/common.md').includes('нет Claude CLI'));
    assert(read('rules/instructions.md').includes('В team_change обязательны голосующие'));
    for (const file of ['rules/brief.md', 'rules/claude.md']) assert(!read(file).includes('трёх серверов'), file);
    const section = read('rules/helpers/member-section.md');
    assert.equal(section.split('Участники и специализации — из team_status').length - 1, 1);
    assert(section.includes('Общие правила — team_rules part=common.'));
  }],
]);
