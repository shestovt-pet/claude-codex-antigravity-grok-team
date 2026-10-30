'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const f = require('./team-v16-fixture'), d = require('../common/deploy'), p = require('../common/agy-mcp-permissions');
const a = require('../common/agy-tools'), members = require('../common/members');
// Независимый эталон разрешений Antigravity: прежний набор поручений + Notion (замысел 3.8).
const ALLOW = ['mcp(team/team_status)', 'mcp(team/team_rules)', 'mcp(team/team_work)', 'mcp(codex/codex_status)', 'mcp(codex/codex_result)', 'mcp(codex/codex_send)', 'mcp(notion/*)'];
const release = path.join(f.root, 'live', 'a'.repeat(40)), base = path.join(f.root, 'live', 'b'.repeat(40));
f.write(path.join(release, 'common/agy-mcp-permissions.js'), '// поддержка 3.8');
for (const dir of [release, base]) for (const name of ['team', 'codex', 'antigravity']) f.write(path.join(dir, 'servers', name, 'index.js'), '');
let seq = 0;
function fixture(config) {
  const file = path.join(f.RUN, 'settings-' + (++seq), 'settings.json');
  if (config !== undefined) f.write(file, JSON.stringify(config, null, 4) + '\n');
  return { file, before: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
}
const install = x => d.switchConfigs(p.plans(release, f.root, x));
const rollback = (x, target = base) => d.switchConfigs(p.plans(target, f.root, { ...x, rollback: true }));
const read = x => JSON.parse(fs.readFileSync(x.file, 'utf8'));
const cases = [];
for (const server of ['notion', 'team', 'codex', 'antigravity', 'comfyui', 'pbta']) cases.push(['Н1/' + server + ': все формы MCP проверяют server/tool', () => {
  const calls = [
    { name: 'call_mcp_tool', args: { server, tool: 'API-get-self' } },
    { function: { name: 'call_mcp_tool', arguments: JSON.stringify({ serverName: server, toolName: 'API-get-self' }) } },
    { name: 'mcp_' + server + '_API-get-self' }, { name: 'mcp__' + server + '__API-get-self' },
    { name: server + '/API-get-self' }, { name: 'list_resources', args: { server } }, { name: 'read_resource', args: { server_name: server, uri: 'anything' } },
  ];
  for (const call of calls) { assert.equal(a.allowed(call), server === 'notion', JSON.stringify(call)); assert.equal(a.forbidden(call), server !== 'notion'); }
}]);
cases.push(
  ['Н2: пустой реестр разрешений запрещает все формы MCP и меняет текст поручения', () => {
    const store = members.store(), old = store.read().members;
    store.update(members.rev(), n => { n.members.find(m => m.id === 'antigravity').mcp_allow = []; }, { action: 'test', who: 'test', reason: 'пустые права' });
    try { for (const call of [{ name: 'mcp_notion_API-get-self' }, { name: 'call_mcp_tool', args: { server: 'notion', tool: 'API-get-self' } }, { name: 'list_resources', args: { server: 'notion' } }, { name: 'read_resource', args: { server: 'notion' } }]) assert(a.forbidden(call)); assert.match(a.instruction(), /нет разрешённых MCP/); }
    finally { store.update(members.rev(), n => { n.members = old; }, { action: 'test', who: 'test', reason: 'возврат' }); }
    assert.match(a.instruction(), /notion\/\*/);
  }],
  ['Н3: точная маска, неизвестный сервер, отсутствие сервера, неверный JSON и противоречивые поля', () => {
    assert(a.allowed({ name: 'mcp_notion_API-get-self' }, ['notion/API-get-self']));
    assert(!a.allowed({ name: 'mcp_notion_delete-page' }, ['notion/API-get-self']));
    for (const c of [{ name: 'mcp_unknown_tool' }, { name: 'list_resources' }, { name: 'read_resource' }, { name: 'call_mcp_tool', args: '{' }, { name: 'call_mcp_tool', args: { server: 'team', serverName: 'notion', tool: 'get' } }]) assert(a.forbidden(c));
    assert(a.forbidden({ name: 'run_command' })); assert(a.forbidden({ name: 'write_to_file' })); assert(!a.forbidden({ name: 'read_file' }));
    assert(a.forbidden({ name: {} })); assert(a.forbidden(null));
    const value = require('../common/members-default')(); value.members[2].mcp_allow = ['*/get']; assert.throws(() => require('../common/members-store').validate(value), /mcp_allow/);
  }],
  ['Н4: установка сохраняет deny/ask/прочее; резервная копия существует до записи', async () => {
    const x = fixture({ permissions: { allow: ['read_file(x)'], deny: ['shell(*)'], ask: ['write(*)'] }, other: { keep: 1 } });
    await d.switchConfigs(p.plans(release, f.root, x), async (step, plan) => {
      if (plan?.file === x.file) { const saved = JSON.parse(fs.readFileSync(x.file + '.most-mcp-backup.json')); assert.equal(saved.text, x.before); assert.equal(fs.readFileSync(x.file, 'utf8'), x.before); }
    });
    assert.deepEqual(read(x), { permissions: { allow: ['read_file(x)', ...ALLOW], deny: ['shell(*)'], ask: ['write(*)'] }, other: { keep: 1 } });
    await rollback(x); assert.equal(fs.readFileSync(x.file, 'utf8'), x.before);
  }],
  ['Н5: отсутствующий settings создаётся; повтор не меняет копию; откат возвращает отсутствие', async () => {
    const x = fixture(); await install(x); const before = fs.readFileSync(x.file + '.most-mcp-backup.json', 'utf8');
    assert.deepEqual(read(x), { permissions: { allow: ALLOW } });
    assert.deepEqual(p.plans(release, f.root, x), []); await install(x); assert.equal(fs.readFileSync(x.file + '.most-mcp-backup.json', 'utf8'), before);
    await rollback(x); assert(!fs.existsSync(x.file)); await rollback(x); assert(!fs.existsSync(x.file));
    await install(x); assert(read(x).permissions.allow.includes('mcp(notion/*)'));
  }],
  ['Н6: заранее существовавшее правило и его повторы сохраняются после установки/отката', async () => {
    const x = fixture({ permissions: { allow: [...ALLOW.filter(a => a !== 'mcp(notion/*)'), 'mcp(notion/*)', 'other', 'mcp(notion/*)'], deny: ['keep'] }, other: 1 });
    await install(x); assert.equal(fs.readFileSync(x.file, 'utf8'), x.before); await install(x); await rollback(x); assert.equal(fs.readFileSync(x.file, 'utf8'), x.before);
  }],
  ['Н7: откат на поддерживающий 3.8 релиз оставляет правило; на базу снимает только своё', async () => {
    const x = fixture({ other: 1 }); await install(x); await rollback(x, release); assert.deepEqual(read(x).permissions.allow, ALLOW);
    const config = read(x); config.permissions.allow.push('user-added'); config.permissions.deny = ['user-deny']; f.json(x.file, config);
    await rollback(x); assert.deepEqual(read(x), { other: 1, permissions: { allow: ['user-added'], deny: ['user-deny'] } });
    assert.deepEqual(p.plans(base, f.root, fixture()), []);
  }],
  ['Н8: сбой следующего конфига компенсирует настройки и созданную копию', async () => {
    const x = fixture(), other = fixture({ keep: 1 });
    const plans = [...p.plans(release, f.root, x), { ...d.snapshot(other.file), next: '{}' }];
    await assert.rejects(() => d.switchConfigs(plans, async (_, plan) => { if (plan.file === other.file) throw Error('сбой'); }), /сбой/);
    assert(!fs.existsSync(x.file)); assert(!fs.existsSync(x.file + '.most-mcp-backup.json')); assert.equal(fs.readFileSync(other.file, 'utf8'), other.before);
  }],
  ['Н9: конкурентная правка и битые настройки дают отказ до перезаписи', async () => {
    const x = fixture({ keep: 1 }), plans = p.plans(release, f.root, x); f.json(x.file, { keep: 2 });
    await assert.rejects(() => d.switchConfigs(plans), /изменён/); assert.deepEqual(read(x), { keep: 2 });
    f.write(x.file, '{'); assert.throws(() => p.plans(release, f.root, x), /Некорректный/);
  }],
  ['Н10: deploy.rollback учитывает поддержку 3.8 целевым релизом', async () => {
    const x = fixture({ keep: 1 }), config = path.join(f.RUN, 'claude-' + (++seq) + '.json');
      const root = path.join(f.RUN, 'notion-rollback-pristine'); fs.mkdirSync(root);
    const old = process.env.MOST_AGY_CLI_SETTINGS; process.env.MOST_AGY_CLI_SETTINGS = x.file;
    try {
        await d.switchConfigs(p.plans(release, root, x));
      for (const target of [release, base]) {
          f.json(config, d.configFor({}, release, root)); f.json(config + '.prev', d.configFor({}, target, root));
          // Корень без инициализированного реестра: граница А здесь ещё не пересечена.
          assert(!fs.existsSync(path.join(root, 'state/members.json')));
          const result = await d.rollback({ root, configs: [config], configOnly: true, stateDir: path.join(f.RUN, 'rollback-state') });
        assert.match(result, /возвращён/); assert(!result.includes('отказ'), result);
        assert.equal(read(x).permissions?.allow?.includes('mcp(notion/*)') || false, target === release);
      }
    } finally { if (old === undefined) delete process.env.MOST_AGY_CLI_SETTINGS; else process.env.MOST_AGY_CLI_SETTINGS = old; }
  }],
  ['Н11: настоящий configure создаёт settings, повтор идемпотентен, старый релиз не ставит правило', async () => {
    const x = fixture(), config = path.join(f.RUN, 'configure-' + (++seq) + '.json');
    const old = process.env.MOST_AGY_CLI_SETTINGS; process.env.MOST_AGY_CLI_SETTINGS = x.file;
    try {
      f.json(config, {});
      for (const target of [base, release, release]) {
        f.json(path.join(target, 'probe-ok.json'), { commit: path.basename(target), root: f.root, servers: [...members.servers], at: new Date().toISOString() });
        const result = await d.configure({ release: target, configs: [config], stateDir: path.join(f.RUN, 'configure-state') });
        assert.match(result, /Конфиги обновлены/);
        if (target === base) assert(!fs.existsSync(x.file));
        else { assert.deepEqual(read(x), { permissions: { allow: ALLOW } }); assert.deepEqual(p.plans(target, f.root, x), []); }
      }
    } finally { if (old === undefined) delete process.env.MOST_AGY_CLI_SETTINGS; else process.env.MOST_AGY_CLI_SETTINGS = old; }
  }],
  ['Н12: после отката новая установка сохраняет добавленное пользователем правило; BOM сохраняется', async () => {
    const x = fixture(); await install(x); await rollback(x);
    const text = '\uFEFF' + JSON.stringify({ permissions: { allow: ['mcp(notion/*)', 'keep'] } }, null, 4) + '\r\n';
    f.write(x.file, text); await install(x); await rollback(x); assert.equal(fs.readFileSync(x.file, 'utf8'), text);
  }],
  ['Н13: установщик и текст поручения читают изменённую точную маску и пустой список из реестра', async () => {
    const store = members.store(), before = store.read().members, x = fixture();
    const set = masks => store.update(members.rev(), n => { n.members.find(m => m.id === 'antigravity').mcp_allow = masks; }, { action: 'test', who: 'test', reason: 'права из реестра' });
    try {
      set(['notion/API-get-self']); await install(x); assert.deepEqual(read(x).permissions.allow, ['mcp(notion/API-get-self)']);
      assert.match(a.instruction(), /notion\/API-get-self/); assert(a.allowed({ name: 'mcp_notion_API-get-self' })); assert(!a.allowed({ name: 'mcp_notion_delete-page' }));
      set([]); await install(x); assert(!fs.existsSync(x.file)); assert(a.forbidden({ name: 'mcp_notion_API-get-self' }));
    } finally { store.update(members.rev(), n => { n.members = before; }, { action: 'test', who: 'test', reason: 'возврат' }); }
  }],
  ['Н14: прерванный откат можно повторить до и после записи настроек', async () => {
    const x = fixture(); await install(x);
    const plans = p.plans(base, f.root, { ...x, rollback: true });
    assert.equal(plans[0].file, x.file); assert.equal(plans.at(-1).file, x.file + '.most-mcp-backup.json');
    assert.equal(JSON.parse(fs.readFileSync(plans.at(-1).file)).active, true);
    await d.switchConfigs([plans[0]]); // Устойчивая запись до прерывания процесса.
    assert(!fs.existsSync(x.file)); assert.equal(JSON.parse(fs.readFileSync(plans.at(-1).file)).active, true);
    await rollback(x); assert(!fs.existsSync(x.file)); assert.equal(JSON.parse(fs.readFileSync(plans.at(-1).file)).active, false);
  }],
  ['Н15: откат двух конфигов с файлом разрешений доходит до конца и повторяется', async () => {
    const x = fixture({ keep: 1 }); await install(x);
    const root = path.join(f.RUN, 'multi-rollback-' + (++seq)); fs.mkdirSync(root, { recursive: true });
    require('../common/team-git').git(root, ['init', '-b', 'main']);
    const configs = [1, 2].map(i => {
      const file = path.join(root, 'claude-' + i + '.json');
      f.json(file, { mcpServers: { team: { command: process.execPath, args: [path.join(release, 'servers/team/index.js')] } } });
      f.json(file + '.prev', { mcpServers: { team: { command: process.execPath, args: [path.join(base, 'servers/team/index.js')] } } });
      return file;
    });
    const old = process.env.MOST_AGY_CLI_SETTINGS; process.env.MOST_AGY_CLI_SETTINGS = x.file;
    try {
      const first = await d.rollback({ root, configs, stateDir: path.join(root, 'locks') });
      assert(!/отказ/.test(first), first);
      assert.equal((first.match(/возвращён/g) || []).length, 2, first);
      for (const file of configs) assert(JSON.parse(fs.readFileSync(file)).mcpServers.team.args.includes(path.join(base, 'servers/team/index.js')), file);
      assert.equal(read(x).keep, 1); assert.deepEqual(read(x).permissions?.allow ?? [], []);
      const before = configs.map(file => fs.readFileSync(file, 'utf8'));
      const second = await d.rollback({ root, configs, stateDir: path.join(root, 'locks') });
      assert(!/отказ/.test(second), second);
      assert.equal((second.match(/возвращён/g) || []).length, 2, second);
      configs.forEach((file, i) => assert.equal(fs.readFileSync(file, 'utf8'), before[i]));
      assert.equal(read(x).keep, 1);
    } finally { if (old === undefined) delete process.env.MOST_AGY_CLI_SETTINGS; else process.env.MOST_AGY_CLI_SETTINGS = old; }
  }],
  ['Н16: откат первой установки в пустые конфиги снимает управляемые разрешения', async () => {
    const x = fixture({ other: 1, permissions: { allow: ['user-keep'], deny: ['deny-1'], ask: ['ask-1'] } }); await install(x);
    const root = path.join(f.RUN, 'empty-rollback-' + (++seq)); fs.mkdirSync(root, { recursive: true });
    require('../common/team-git').git(root, ['init', '-b', 'main']);
    const configs = [1, 2].map(i => {
      const file = path.join(root, 'claude-' + i + '.json');
      f.json(file, { mcpServers: { team: { command: process.execPath, args: [path.join(release, 'servers/team/index.js')] } } });
      f.json(file + '.prev', { mcpServers: {} });
      return file;
    });
    const old = process.env.MOST_AGY_CLI_SETTINGS; process.env.MOST_AGY_CLI_SETTINGS = x.file;
    try {
      const first = await d.rollback({ root, configs, stateDir: path.join(root, 'locks') });
      assert(!/отказ/.test(first), first);
      assert.equal((first.match(/возвращён/g) || []).length, 2, first);
      for (const file of configs) assert.deepEqual(JSON.parse(fs.readFileSync(file)).mcpServers, {}, file);
      const config = read(x);
      assert.deepEqual(config.permissions.allow, ['user-keep'], 'управляемые разрешения сняты');
      assert.deepEqual(config.permissions.deny, ['deny-1']); assert.deepEqual(config.permissions.ask, ['ask-1']); assert.equal(config.other, 1);
      assert(!fs.readFileSync(x.file, 'utf8').includes('mcp('));
      const text = fs.readFileSync(x.file, 'utf8');
      const second = await d.rollback({ root, configs, stateDir: path.join(root, 'locks') });
      assert(!/отказ/.test(second), second);
      assert.equal(fs.readFileSync(x.file, 'utf8'), text);
      assert.deepEqual(read(x).permissions.allow, ['user-keep']);
    } finally { if (old === undefined) delete process.env.MOST_AGY_CLI_SETTINGS; else process.env.MOST_AGY_CLI_SETTINGS = old; }
  }],
);
f.run(cases);
