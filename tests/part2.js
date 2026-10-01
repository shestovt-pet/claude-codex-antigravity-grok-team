'use strict';
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  assert = require('assert'),
  crypto = require('crypto'),
  cp = require('child_process');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'most-part2-')),
  ROOT = path.resolve(__dirname, '..');
process.env.MOST_STATE_DIR = path.join(RUN, 'state');
process.env.MOST_TEST_KEEP = '1';
process.env.MOST_CODEX_ARCHIVE_DIR = path.join(RUN, 'archive');
process.env.MOST_CODEX_SESSIONS = path.join(RUN, 'sessions');
process.env.CODEX_PATH = path.join(__dirname, 'fake-codex.js');
process.env.MOST_CLAUDE_CONFIGS = '[]';
process.env.MOST_CODEX_CONFIG = path.join(RUN, 'missing-codex.toml');
process.env.MOST_AGY_MCP_CONFIG = path.join(RUN, 'missing-agy.json');
process.env.MOST_AGY_CONFIG = path.join(RUN, 'missing-permissions.json');
const { Team } = require('../common/team'),
  g = require('../common/team-git'),
  d = require('../common/deploy'),
  stores = require('../common/team-store');
let passed = 0,
  failed = 0,
  skipped = 0;
const tests = [];
function test(label, fn, git = false) {
  tests.push({ label, fn, git });
}
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const json = (file, obj) => write(file, JSON.stringify(obj));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const rejects = (fn, pattern) => assert.rejects(async () => fn(), pattern);
function repo(label) {
  const root = path.join(RUN, label);
  fs.mkdirSync(root);
  g.git(root, ['init', '-b', 'main']);
  g.git(root, ['config', 'user.email', 'test@example.invalid']);
  g.git(root, ['config', 'user.name', 'Испытание']);
  write(path.join(root, '.gitignore'), '.work/\nlive/\nworks/\n');
  write(path.join(root, 'file.txt'), 'база');
  for (const n of ['common', 'claude', 'antigravity', 'roles'])
    write(path.join(root, 'rules', n + '.md'), 'принятые правила ' + n);
  g.git(root, ['add', '-A']);
  g.git(root, ['commit', '-m', 'База']);
  return root;
}
async function change(label) {
  const root = repo(label),
    state = path.join(RUN, label + '-state'),
    team = new Team(root, state);
  await team.change({ action: 'start', name: 'one', request: 'Запрос пользователя для старых проверок', design_file: path.join(root, 'file.txt') });
  const legacy = read(team.changeFile('one')); delete legacy.request; delete legacy.requestMark; json(team.changeFile('one'), legacy);
  const folder = path.join(root, '.work/one');
  g.git(folder, ['config', 'user.email', 'test@example.invalid']);
  g.git(folder, ['config', 'user.name', 'Испытание']);
  write(path.join(folder, 'file.txt'), 'кандидат');
  await team.change({ action: 'commit', name: 'one', message: 'Кандидат' });
  require('./grok-fixture').accepted(team, 'one');
  const c = read(team.changeFile('one'));
  return { root, team, folder, c };
}
async function vote(x, who = 'claude') {
  return x.team.change({
    action: 'verdict',
    name: 'one',
    who,
    base: x.c.base,
    candidate: x.c.candidate,
    decision: 'ПРИНЯТО',
    job_id: who === 'claude' ? undefined : job(x, who),
  });
}
function job(x, who, patch = {}) {
  const id = 'review-' + crypto.randomUUID(),
    r = stores.roots(),
    result = who === 'codex' ? path.join(r.codex, id + '.txt') : path.join(r.antigravity, id, 'result.txt');
  write(result, 'Проверено\nПРИНЯТО\n');
  const card = {
    id,
    status: 'done',
    task: x.c.base + ' → ' + x.c.candidate,
    write: false,
    mode: 'review',
    resultFile: result,
    ...patch,
  };
  json(who === 'codex' ? path.join(r.codex, id + '.json') : path.join(r.antigravity, id, 'card.json'), card);
  if (who === 'antigravity')
    json(path.join(r.antigravity, id, 'meta.json'), {
      hash: crypto.createHash('sha256').update(fs.readFileSync(result)).digest('hex'),
    });
  return id;
}
async function accept(x) {
  require('./grok-fixture').accepted(x.team, 'one');
  for (const who of ['claude', 'codex', 'antigravity']) await vote(x, who);
}
function configs(label, rootLabel = label) {
  // Старые записи своей установки указывают в её корень (team-v11 Р1: чужое не трогаем и не присваиваем).
  fs.mkdirSync(path.join(RUN, rootLabel), { recursive: true });
  const root = fs.realpathSync(path.join(RUN, rootLabel));
  // Файлы прежних серверов существуют: откат проверяет, что возвращаемые пути живы.
  write(path.join(root, 'servers/most.js'), '');
  write(path.join(root, 'node_modules/mcp-server-google-antigravity/index.js'), '');
  return ['a', 'b'].map((n) => {
    const file = path.join(RUN, label, n + '.json');
    json(file, {
      theme: 'тёмная',
      mcpServers: {
        most: { command: 'old', args: [path.join(root, 'servers/most.js')] },
        oldagy: { command: 'npx', args: ['-y', path.join(root, 'node_modules/mcp-server-google-antigravity')] },
        other: { command: 'keep', args: ['a'] },
        codex: { command: 'old', env: { KEEP: 'yes', MOST_REPO_ROOT: root } },
      },
    });
    return file;
  });
}
const mock = {
  archive: async (root, id, temp) => {
    for (const n of ['team', 'codex', 'antigravity', 'grok']) write(path.join(temp, 'servers', n, 'index.js'), '');
  },
  install: async () => {},
  probe: async (file, env) => {
    const n = path.basename(path.dirname(file));
    return { tools: (env.MOST_CLIENT === 'claude' ? [] : n === 'team' ? ['team_status', 'team_rules', 'team_work'] : [n + '_status', n + '_send', n + '_result']).map(name => ({name})) };
  },
};
const simple = path.join(RUN, 'work-root');
fs.mkdirSync(simple);
const team = new Team(simple, path.join(RUN, 'work-state'));
const stages = [
  { title: 'Первый', weight: 40, accept_criteria: 'проверка', state: 'план' },
  { title: 'Второй', weight: 60, accept_criteria: 'проверка', state: 'план' },
];
test('Работы: создание, гонка редакций, доказательство, процент, напоминания', async () => {
  await team.work({
    owner: 'test-owner', action: 'create',
    name: 'work',
    expected_revision: 0,
    goal: 'Цель',
    done_criteria: 'Итог',
    stages,
    next_step: 'Начать',
    reminders: ['a', 'a'],
  });
  const accepted = structuredClone(stages);
  require('./legacy-work')(team, 'work');
  accepted[0] = { ...accepted[0], state: 'принят', evidence: 'Тест выполнен', version: 'v1' };
  const results = await Promise.allSettled([
    team.work({ owner: 'test-owner', action: 'update', name: 'work', expected_revision: 1, stages: accepted }),
    new Team(simple, team.state).work({
      owner: 'test-owner', action: 'update',
      name: 'work',
      expected_revision: 1,
      next_step: 'Другой чат',
    }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const current = read(team.workFile('work'));
  assert.equal(current.revision, 2);
  assert.equal(current.stages[0].state, 'принят');
  assert.match(await team.work({ owner: 'test-owner', action: 'get', name: 'work' }), /Принято 40 %/);
  assert.deepEqual(current.reminders, ['a']);
  await rejects(() => team.work({ owner: 'test-owner', action: 'update', name: 'work', expected_revision: 1 }), /изменил другой чат/);
  await rejects(() => team.work({ owner: 'test-owner', action: 'update', name: 'work', expected_revision: 2, stages }), /пояснения/);
  await team.work({
    owner: 'test-owner', action: 'update',
    name: 'work',
    expected_revision: 2,
    stages,
    plan_change: 'Нужна повторная проверка',
  });
  assert.match(await team.work({ owner: 'test-owner', action: 'get', name: 'work' }), /Принято 0 %/);
  assert.equal(read(team.workFile('work')).plan_changes.length, 1);
  await rejects(
    () =>
      team.work({
        owner: 'test-owner', action: 'update',
        name: 'work',
        expected_revision: 3,
        stages: [{ ...stages[0], weight: 100, state: 'принят' }],
      }),
    /доказательства/,
  );
});
test('Границы: шаблон имён и выход за корень', async () => {
  for (const n of ['../x', 'A', 'a/b', 'x'.repeat(41), '-x;whoami']) assert.throws(() => g.name(n));
  assert.throws(() => g.inside(simple, '../outside'), /корень/);
  await rejects(() => team.work({ owner: 'test-owner', action: 'get', name: '../x' }), /Имя/);
});
test('Границы: переход каталога', async () => {
  const outside = path.join(RUN, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(simple, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => g.inside(simple, 'linked', 'a'), /корень|Ссылки/);
});
test('Хранилища: старые задания доступны только как архив, не как голос', async () => {
  json(path.join(stores.roots().archive, 'old.json'), { id: 'old', status: 'done' });
  assert(stores.list('codex').jobs.some((j) => j.id === 'old' && j.archived));
  assert.throws(() => stores.review('codex', 'old', 'a'.repeat(40), 'b'.repeat(40)), /завершённое/);
});
test('Конфиги: сохраняются чужие записи и поля, удаляется старый npx', async () => {
  const f = configs('config-unit')[0],
    old = read(f),
    root = fs.realpathSync(path.join(RUN, 'config-unit')),
    n = d.configFor(old, path.join(root, 'live/abc'), root);
  assert.equal(n.theme, old.theme);
  assert.deepEqual(n.mcpServers.other, old.mcpServers.other);
  assert(!n.mcpServers.most && !n.mcpServers.oldagy);
  assert.equal(n.mcpServers.codex.env.KEEP, 'yes');
  assert.equal(n.mcpServers.team.env.MOST_REPO_ROOT, root);
});
test('Сбой второго конфига восстанавливает первый без изменения .prev', async () => {
  const files = configs('config-failure'),
    before = files.map((f) => fs.readFileSync(f, 'utf8'));
  write(files[0] + '.prev', 'предыдущий');
  const plans = files.map((f) => ({ ...d.snapshot(f), next: '{}', backup: true }));
  await rejects(
    () =>
      d.switchConfigs(plans, async (stage) => {
        if (stage === 'config2') throw Error('занятый файл');
      }),
    /восстановлены/,
  );
  files.forEach((f, i) => assert.equal(fs.readFileSync(f, 'utf8'), before[i]));
  assert.equal(fs.readFileSync(files[0] + '.prev', 'utf8'), 'предыдущий');
});
test('Изменённый извне конфиг не затирается', async () => {
  const file = configs('config-race')[0],
    s = d.snapshot(file);
  write(file, '{"changed":true}');
  await rejects(() => d.switchConfigs([{ ...s, next: '{}', backup: true }]), /изменён другим/);
  assert.equal(read(file).changed, true);
});
test('Частичный сбой явно сообщается при чужой правке первого конфига', async () => {
  const files = configs('partial');
  await rejects(
    () =>
      d.switchConfigs(
        files.map((f) => ({ ...d.snapshot(f), next: '{}', backup: true })),
        async (stage) => {
          if (stage === 'config2') {
            write(files[0], '{"external":true}');
            throw Error('сбой');
          }
        },
      ),
    /Обновлено частично/,
  );
  assert.equal(read(files[0]).external, true);
});
test('MCP: четыре инструмента, формат, русские описания', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'),
    { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const tr = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'servers/team/index.js')],
      env: { ...process.env, MOST_REPO_ROOT: simple },
      stderr: 'pipe',
    }),
    cl = new Client({ name: 'test', version: '1' });
  try {
    await cl.connect(tr);
    const list = await cl.listTools();
    assert.equal(list.tools.length, 4);
    for (const t of list.tools)
      assert(
        !/most_|poruch|itog|perenesti|papka|rezhim|fayl|stroki|opora|zamechaniya|pravka|tekst|kuda|polno|zhdat|chernovik/.test(
          t.description,
        ),
      );
    const r = await cl.callTool({ name: 'team_work', arguments: { owner: 'test-owner', action: 'get', name: 'work' } });
    assert.match(r.content[0].text, /Команда · сводка ·/);
    assert.match(r.content[0].text, /Дальше:/);
  } finally {
    await cl.close();
    await tr.close();
  }
});
test('team-v7: team_rules выдаёт roles отдельно и в all из main через MCP', async () => {
  const root = repo('rules-roles'), t = new Team(root), commit = g.hash(root);
  write(path.join(root, 'rules/roles.md'), 'НЕЗАФИКСИРОВАННАЯ ПРАВКА РОЛЕЙ');
  for (const part of ['roles', 'all']) {
    const text = t.rules(part);
    assert(text.includes(commit));
    assert.equal(text.split('Правила roles:').length - 1, 1);
    assert.match(text, /принятые правила roles/);
    assert(!text.includes('НЕЗАФИКСИРОВАННАЯ'));
  }
  assert(!t.rules('roles').includes('Правила common:'));
  assert.match(t.rules('all'), /принятые правила common/);
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js'),
    { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(ROOT, 'servers/team/index.js')],
    env: { ...process.env, MOST_REPO_ROOT: root }, stderr: 'pipe' });
  const client = new Client({ name: 'rules-roles-test', version: '1' });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find(t => t.name === 'team_rules');
    assert(tool.inputSchema.properties.part.enum.includes('roles'));
    for (const part of ['roles', 'all']) {
      const reply = await client.callTool({ name: 'team_rules', arguments: { part } });
      assert(!reply.isError);
      assert(reply.content[0].text.includes(t.rules(part)));
    }
  } finally { await client.close(); await transport.close(); }
}, true);

test('Квота Claude: старый снимок не заменяет новый; статус не запускает поручений', async () => {
  const q = { percent: 20, source: 'снимок', taken_at: '2026-09-26T20:00:00Z' };
  const result = await team.status(q);
  assert.match(result, /Claude — использовано 20/);
  await team.status({ ...q, percent: 99, taken_at: '2026-09-25T20:00:00Z' });
  assert.equal(read(path.join(team.state, 'claude-quota.json')).percent, 20);
  await rejects(() => team.status({ ...q, taken_at: 'не дата' }), /Некорректный/);
});
test(
  'Правила читаются из коммита main, рабочая правка не попадает',
  async () => {
    const root = repo('rules'),
      t = new Team(root);
    write(path.join(root, 'rules/common.md'), 'ЧЕРНОВИК');
    assert.match(t.rules('all'), /принятые правила common/);
    assert(!t.rules('all').includes('ЧЕРНОВИК'));
    assert.match(t.rules('antigravity'), /принятые правила antigravity/);
    assert(!t.rules('claude').includes('принятые правила common'));
  },
  true,
);
test(
  'start создаёт самостоятельный клон и относительный origin; diff постраничный',
  async () => {
    const x = await change('clone');
    assert.equal(g.git(x.folder, ['remote', 'get-url', 'origin']).trim(), '../..');
    assert(fs.statSync(path.join(x.folder, '.git')).isDirectory());
    assert.match(await x.team.change({ action: 'diff', name: 'one' }), /кандидат/);
    assert.match(await x.team.change({ action: 'list' }), /one/);
  },
  true,
);
test(
  'Ворота: без вердиктов и на другую пару слияния нет',
  async () => {
    const x = await change('missing');
    await rejects(() => x.team.change({ action: 'merge', name: 'one' }), /Нет действующего/);
    await rejects(
      () =>
        x.team.change({
          action: 'verdict',
          name: 'one',
          who: 'claude',
          base: '0'.repeat(40),
          candidate: x.c.candidate,
          decision: 'ПРИНЯТО',
        }),
      /другой паре/,
    );
    assert.equal(g.hash(x.root), x.c.base);
  },
  true,
);
test(
  'Ворота: нет хеша кандидата, неверный ответ, режим записи и продолженный сеанс',
  async () => {
    const x = await change('bad-job');
    for (const patch of [{ task: x.c.base }, { write: true }, { previous: 'author' }, { status: 'running' }]) {
      const id = job(x, 'codex', patch);
      await rejects(() =>
        x.team.change({
          action: 'verdict',
          name: 'one',
          who: 'codex',
          base: x.c.base,
          candidate: x.c.candidate,
          decision: 'ПРИНЯТО',
          job_id: id,
        }),
      );
    }
    const id = job(x, 'codex');
    write(read(path.join(stores.roots().codex, id + '.json')).resultFile, 'НЕ ПРИНЯТО: 1 блокирующих');
    assert.throws(() => stores.review('codex', id, x.c.base, x.c.candidate), /Последняя строка/);
  },
  true,
);
test(
  'Ворота: решение пользователя заменяет ровно один голос',
  async () => {
    const x = await change('user');
    await vote(x);
    await x.team.change({
      action: 'verdict',
      name: 'one',
      who: 'user',
      base: x.c.base,
      candidate: x.c.candidate,
      decision: 'РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ',
      replaces: 'codex',
      quote: 'Принимаю вместо Codex',
    });
    await rejects(() => x.team.change({ action: 'merge', name: 'one' }), /antigravity/);
    await vote(x, 'antigravity');
    await x.team.change({ action: 'merge', name: 'one' });
    assert.equal(g.hash(x.root), x.c.candidate);
  },
  true,
);
test(
  'Ворота: клон строгий; корень блокируют отслеживаемые изменения и индекс',
  async () => {
    const x = await change('dirty');
    await accept(x);
    write(path.join(x.folder, 'file.txt'), 'ещё');
    await rejects(() => x.team.change({ action: 'merge', name: 'one' }), /грязные/);
    write(path.join(x.folder, 'file.txt'), 'кандидат');
    write(path.join(x.root, 'file.txt'), 'грязный отслеживаемый');
    await rejects(() => x.team.change({ action: 'merge', name: 'one' }), /грязные/);
    g.git(x.root, ['add', 'file.txt']);
    write(path.join(x.root, 'file.txt'), 'база');
    await rejects(() => x.team.change({ action: 'merge', name: 'one' }), /грязные/);
    g.git(x.root, ['add', 'file.txt']);
    write(path.join(x.root, 'untracked.txt'), 'личный файл');
    await x.team.change({ action: 'merge', name: 'one' });
    assert.equal(g.hash(x.root), x.c.candidate);
    assert.equal(fs.readFileSync(path.join(x.root, 'untracked.txt'), 'utf8'), 'личный файл');
  },
  true,
);
test(
  'Ворота: main ушёл вперёд, старые голоса не публикуют',
  async () => {
    const x = await change('moved-main');
    await accept(x);
    write(path.join(x.root, 'file.txt'), 'новая база');
    g.git(x.root, ['add', '-A']);
    g.git(x.root, ['commit', '-m', 'Новая база']);
    await rejects(() => x.team.change({ action: 'merge', name: 'one' }), /ушёл вперёд/);
  },
  true,
);
test(
  'Ворота: новый commit аннулирует все вердикты',
  async () => {
    const x = await change('invalidate');
    await accept(x);
    write(path.join(x.folder, 'file.txt'), 'новый кандидат');
    await x.team.change({ action: 'commit', name: 'one', message: 'Новый' });
    assert.equal(read(x.team.changeFile('one')).verdicts.length, 0);
    await rejects(() => x.team.change({ action: 'merge', name: 'one' }), /Нет действующего/);
  },
  true,
);
test(
  'Ворота: два одновременных merge публикуют ровно один раз',
  async () => {
    const x = await change('parallel');
    await accept(x);
    const results = await Promise.allSettled([
      x.team.change({ action: 'merge', name: 'one' }),
      new Team(x.root, x.team.state).change({ action: 'merge', name: 'one' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(g.hash(x.root), x.c.candidate);
  },
  true,
);
for (const stage of ['archive', 'install', 'probe', 'publish', 'config1', 'config2'])
  test(
    'Развёртывание: сбой стадии ' + stage,
    async () => {
      const root = repo('fail-' + stage),
        files = configs('fail-' + stage),
        before = files.map((f) => fs.readFileSync(f, 'utf8'));
      await rejects(
        () =>
          d.deploy(
            { root, configs: files },
            {
              ...mock,
              hook: async (s) => {
                if (s === stage) throw Error('сбой ' + stage);
              },
            },
          ),
        /сбой/,
      );
      files.forEach((f, i) => {
        assert.equal(fs.readFileSync(f, 'utf8'), before[i]);
        assert(!fs.existsSync(f + '.prev'));
      });
    },
    true,
  );
test(
  'Повторный deploy сохраняет .prev и релиз; rollback сохраняет чужие поля',
  async () => {
    const root = repo('repeat'),
      files = configs('repeat');
    await d.deploy({ root, configs: files }, mock);
    const backups = files.map((f) => fs.readFileSync(f + '.prev', 'utf8')),
      mtimes = files.map((f) => fs.statSync(f + '.prev').mtimeMs);
    await d.deploy(
      { root, configs: files },
      {
        ...mock,
        archive: () => {
          throw Error('повторная сборка');
        },
      },
    );
    files.forEach((f, i) => {
      assert.equal(fs.readFileSync(f + '.prev', 'utf8'), backups[i]);
      assert.equal(fs.statSync(f + '.prev').mtimeMs, mtimes[i]);
      const c = read(f);
      c.theme = 'светлая';
      json(f, c);
    });
    await d.rollback({ root, configs: files });
    files.forEach((f) => {
      assert.equal(read(f).theme, 'светлая');
      assert.equal(read(f).mcpServers.most.command, 'old');
    });
  },
  true,
);
test(
  'dry-run CLI не создаёт релиз, блокировки и .prev',
  async () => {
    const root = repo('dry'),
      files = configs('dry'),
      state = path.join(RUN, 'dry-state');
    const out = cp.execFileSync(
      process.execPath,
      [path.join(ROOT, 'tools/deploy.js'), '--root', root, '--config', files[0], '--dry-run'],
      { encoding: 'utf8', env: { ...process.env, MOST_STATE_DIR: state }, windowsHide: true },
    );
    assert.match(out, /изменений нет/);
    assert(!fs.existsSync(path.join(root, 'live')));
    assert(!fs.existsSync(state));
    assert(!fs.existsSync(files[0] + '.prev'));
  },
  true,
);
test(
  'Реальный git archive берёт коммит, а не рабочую папку',
  async () => {
    const root = repo('archive-release'),
      files = configs('archive-release');
    for (const n of ['team', 'codex', 'antigravity', 'grok']) write(path.join(root, 'servers', n, 'index.js'), 'принятый');
    g.git(root, ['add', '-A']);
    g.git(root, ['commit', '-m', 'Серверы']);
    write(path.join(root, 'servers/team/index.js'), 'непринятый');
    await d.deploy({ root, configs: files }, { install: mock.install, probe: mock.probe });
    assert.equal(fs.readFileSync(path.join(root, 'live', g.hash(root), 'servers/team/index.js'), 'utf8'), 'принятый');
  },
  true,
);

async function workers(requests) {
  const children = requests.map(() =>
    cp.fork(path.join(__dirname, 'team-worker.js'), [], { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }),
  );
  await Promise.all(
    children.map(
      (c) =>
        new Promise((resolve, reject) => {
          c.once('error', reject);
          c.once('message', resolve);
        }),
    ),
  );
  return Promise.all(
    children.map(
      (c, i) =>
        new Promise((resolve, reject) => {
          c.once('message', resolve);
          c.once('error', reject);
          c.send(requests[i]);
        }),
    ),
  );
}
test('Два процесса: одна редакция работы принимается один раз', async () => {
  const root = path.join(RUN, 'process-work');
  fs.mkdirSync(root);
  const state = path.join(RUN, 'process-work-state'),
    t = new Team(root, state);
  await t.work({
    owner: 'test-owner', action: 'create',
    name: 'w',
    expected_revision: 0,
    goal: 'Цель',
    done_criteria: 'Готово',
    stages,
    next_step: 'Проверить',
  });
  const request = {
    root,
    state,
    method: 'work',
    args: { owner: 'test-owner', action: 'update', name: 'w', expected_revision: 1, next_step: 'Изменено' },
  };
  const r = await workers([request, request]);
  assert.equal(r.filter((x) => x.ok).length, 1);
  assert.equal(read(t.workFile('w')).revision, 2);
});
test(
  'Два процесса: merge не публикуется дважды',
  async () => {
    const x = await change('process-merge');
    await accept(x);
    const request = { root: x.root, state: x.team.state, method: 'change', args: { action: 'merge', name: 'one' } };
    const r = await workers([request, request]);
    assert.equal(r.filter((x) => x.ok).length, 1);
    assert.equal(g.hash(x.root), x.c.candidate);
  },
  true,
);
test('Windows: действительно занятый второй конфиг', async () => {
  if (process.platform !== 'win32') return;
  const files = configs('busy-real'),
    before = files.map((f) => fs.readFileSync(f, 'utf8'));
  const script =
    "$f=[IO.File]::Open('" +
    files[1].replace(/'/g, "''") +
    "',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); [Console]::WriteLine('READY'); [Console]::ReadLine() | Out-Null; $f.Dispose()";
  const plans = files.map((f) => ({ ...d.snapshot(f), next: '{}', backup: true }));
  const child = cp.spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', resolve);
  });
  try {
    await rejects(() => d.switchConfigs(plans), /восстановлены/);
  } finally {
    child.stdin.end('\n');
    await new Promise((r) => child.once('close', r));
  }
  files.forEach((f, i) => assert.equal(fs.readFileSync(f, 'utf8'), before[i]));
});
test(
  'Повторный релиз с исправлением команды не затирает .prev',
  async () => {
    const root = repo('repair'),
      files = configs('repair');
    await d.deploy({ root, configs: files }, mock);
    const prev = fs.readFileSync(files[0] + '.prev', 'utf8'),
      c = read(files[0]);
    c.mcpServers.team.command = 'node';
    json(files[0], c);
    await d.deploy({ root, configs: files }, mock);
    assert.equal(fs.readFileSync(files[0] + '.prev', 'utf8'), prev);
  },
  true,
);

test('Правила: отсутствие части в main не скрывает остальные', async () => {
  const root = repo('missing-rules');
  g.git(root, ['rm', 'rules/claude.md']);
  g.git(root, ['commit', '-m', 'Без части правил']);
  const t = new Team(root);
  assert.match(t.rules('all'), /в main нет rules\/claude.md/);
  assert.match(t.rules('all'), /принятые правила antigravity/);
  assert.match(t.rules('all'), /принятые правила common/);
  assert.match(t.rules('claude'), /в main нет rules\/claude.md/);
}, true);

test('Откат: нет .prev, повреждённая .prev и сбой записи не мешают другому конфигу', async () => {
  for (const kind of ['missing', 'broken', 'write']) {
    const root = repo('rollback-' + kind), files = configs('rollback-' + kind);
    const before = fs.readFileSync(files[0], 'utf8');
    if (kind === 'broken') write(files[0] + '.prev', '{');
    if (kind === 'write') json(files[0] + '.prev', { mcpServers: {} });
    json(files[1] + '.prev', { mcpServers: { team: { command: 'previous' } } });
    const out = await d.rollback({ root, configs: files }, { hook: async (_, p) => {
      if (kind === 'write' && p.file === files[0]) throw Error('занят');
    } });
    assert.match(out, /отказ в откате/);
    if (kind === 'missing') assert.match(out, /нет резервного конфига/);
    assert.equal(fs.readFileSync(files[0], 'utf8'), before);
    assert.equal(read(files[1]).mcpServers.team.command, 'previous');
    assert.equal(read(files[1]).theme, 'тёмная');
  }
}, true);

test('Работы: повреждённая карточка не мешает list, get и status', async () => {
  write(team.workFile('broken'), '{broken');
  json(team.workFile('invalid'), {});
  const out = await team.work({ action: 'list' });
  assert.match(out, /карточка повреждена: broken.json/);
  assert.match(out, /карточка повреждена: invalid.json/);
  assert.match(out, /work · редакция/);
  assert.match(await team.work({ owner: 'test-owner', action: 'get', name: 'work' }), /Цель/);
  assert.match(await team.work({ owner: 'test-owner', action: 'get', name: 'broken' }), /карточка повреждена/);
  assert.match(await team.status(undefined, undefined, undefined, true), /карточка повреждена: broken.json/);
});

test('Статус: сбои квот, работ, репозитория, релизов и поручений изолированы', async () => {
  const quota = require('../common/quota'), oldQuota = quota.codexQuota, oldList = stores.list;
  const oldWorks = team.works;
  write(path.join(team.state, 'claude-quota.json'), '{');
  write(path.join(simple, 'live/deployed.json'), '{');
  quota.codexQuota = async () => { throw Error('таймаут квоты'); };
  stores.list = (who) => { if (who === 'codex') throw Error('сбой поручений'); return oldList(who); };
  team.works = () => { throw Error('сбой работ'); };
  try {
    const out = await team.status(undefined, undefined, undefined, true);
    for (const text of ['Claude — данные не предоставлены: ошибка чтения снимка', 'таймаут квоты', 'Работы: ошибка: сбой работ',
      'Репозиторий:', 'Релизы: ошибка:', 'сбой поручений', 'Поручения antigravity:', 'team: версия процесса'])
      assert(out.includes(text), text + '\n' + out);
  } finally { quota.codexQuota = oldQuota; stores.list = oldList; team.works = oldWorks; }
});

test('Атомарная запись: ошибка rename удаляет временный файл; ошибка удаления не скрывает причину', async () => {
  const file = path.join(RUN, 'atomic.json'), oldRename = fs.renameSync, oldUnlink = fs.unlinkSync;
  let tmp, attempts = 0;
  fs.renameSync = (from) => { tmp = from; throw Error('rename failed'); };
  try {
    assert.throws(() => g.atomic(file, '{}'), /rename failed/);
    assert(!fs.existsSync(tmp));
    fs.unlinkSync = () => { attempts++; throw Error('unlink failed'); };
    assert.throws(() => g.atomic(file, '{}'), /rename failed/);
    assert.equal(attempts, 1);
  } finally { fs.renameSync = oldRename; fs.unlinkSync = oldUnlink; }
});

function cli(args, cwd, env = {}) {
  return cp.execFileSync(process.execPath, [path.join(ROOT, 'tools/deploy.js'), ...args], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 60000,
  });
}

test('Bootstrap CLI: настоящий архив, готовые зависимости, три MCP запуска, раздельные конфиги', async () => {
  const root = repo('bootstrap'), files = configs('bootstrap-configs', 'bootstrap');
  for (const dir of ['common', 'servers']) fs.cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  g.git(root, ['add', '-A']);
  g.git(root, ['commit', '-m', 'Серверы bootstrap']);
  const live = path.join(root, 'live'); fs.mkdirSync(live);
  const forbidden = path.join(RUN, 'must-not-be-created');
  const env = { MOST_STATE_DIR: forbidden, LOCALAPPDATA: forbidden, APPDATA: forbidden,
    MOST_CLAUDE_CONFIGS: '{не читается в release-only', MOST_TEST_WRITE_ROOT: live,
    NODE_OPTIONS: '--require ' + JSON.stringify(path.join(__dirname, 'deploy-write-guard.js')) };
  const before = files.map(f => fs.readFileSync(f, 'utf8'));
  assert.match(cli(['--root', root, '--release-only', '--dry-run'], live, env), /изменений нет/);
  assert.deepEqual(fs.readdirSync(live), []);
  assert.match(cli(['--root', root, '--release-only', '--node-modules-from', path.resolve(path.dirname(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')), '../../../../..')], live, env), /прошёл пробный запуск/);
  const release = path.join(live, g.hash(root));
  assert(fs.existsSync(path.join(release, 'probe-ok.json')));
  assert(fs.existsSync(path.join(release, 'node_modules/@modelcontextprotocol/sdk/package.json')));
  assert(fs.existsSync(path.join(live, '.deploy-state/locks')));
  assert(!fs.existsSync(forbidden));
  assert(!fs.existsSync(path.join(live, 'deployed.json')));
  files.forEach((f, i) => { assert.equal(fs.readFileSync(f, 'utf8'), before[i]); assert(!fs.existsSync(f + '.prev')); });
  const marker = fs.readFileSync(path.join(release, 'probe-ok.json'), 'utf8');
  for (const f of files) {
    env.MOST_TEST_WRITE_ROOT = RUN;
    assert.match(cli(['--config-only', '--release', release, '--config', f, '--dry-run'], path.dirname(f), env), /изменений нет/);
    assert.equal(fs.readFileSync(f, 'utf8'), before[files.indexOf(f)]);
    assert(!fs.existsSync(f + '.prev'));
    assert.match(cli(['--config-only', '--release', release, '--config', f], path.dirname(f), env), /Конфиги обновлены/);
    assert.equal(read(f).theme, 'тёмная');
    assert.equal(read(f).mcpServers.other.command, 'keep');
    assert.equal(read(f).mcpServers.team.env.MOST_REPO_ROOT, root);
    assert.equal(read(f).mcpServers.team.args[0], path.join(release, 'servers/team/index.js'));
    const backup = fs.readFileSync(f + '.prev', 'utf8');
    assert.equal(backup, before[files.indexOf(f)]);
    cli(['--config-only', '--release', release, '--config', f], path.dirname(f), env);
    assert.equal(fs.readFileSync(f + '.prev', 'utf8'), backup);
  }
  assert.equal(fs.readFileSync(path.join(release, 'probe-ok.json'), 'utf8'), marker);
  assert(!fs.existsSync(forbidden));
  assert.equal(read(path.join(live, 'deployed.json')).commit, g.hash(root));
  env.MOST_TEST_WRITE_ROOT = live;
  const state = path.join(live, 'custom-state');
  cli(['--root', root, '--release-only', '--state-dir', state], live, env);
  assert(fs.existsSync(path.join(state, 'locks')));
}, true);

test('Bootstrap CLI: config-only отклоняет непроверенный релиз, отсутствующие параметры и конфликты', async () => {
  const release = path.join(RUN, 'untested-release'); fs.mkdirSync(release);
  const file = configs('untested')[0], before = fs.readFileSync(file, 'utf8');
  assert.throws(() => cli(['--config-only', '--release', release, '--config', file], path.dirname(file)), /метки успешного пробного запуска/);
  for (const args of [
    ['--config-only', '--release', release, '--config', file],
    ['--config-only', '--config', file],
    ['--config-only', '--release', release],
    ['--release-only', '--config-only'],
    ['--release-only', '--rollback'],
    ['--config-only', '--release', release, '--config', file, '--node-modules-from', ROOT],
  ]) assert.throws(() => cli(args, path.dirname(file)));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert(!fs.existsSync(file + '.prev'));
  assert(!fs.existsSync(path.join(path.dirname(file), '.deploy-state')));
});

test('Bootstrap: провал пробного запуска не публикует релиз и метку', async () => {
  const root = repo('bootstrap-fail'), state = path.join(root, 'live/state');
  await rejects(() => d.deploy({ root, releaseOnly: true, stateDir: state }, {
    ...mock, probe: async () => { throw Error('проверка не пройдена'); },
  }), /проверка не пройдена/);
  assert(!fs.existsSync(path.join(root, 'live', g.hash(root))));
  const preparing = fs.readdirSync(path.join(root, 'live')).find(n => n.startsWith('.preparing'));
  assert(!fs.existsSync(path.join(root, 'live', preparing, 'probe-ok.json')));
}, true);

test('Замок репозитория общий при разных state-dir', async () => {
  await d.locked(simple, async () => {
    await rejects(() => d.locked(simple, async () => assert.fail('второй владелец'), path.join(RUN, 'second-lock-state')), /занят/);
  }, path.join(RUN, 'first-lock-state'));
});

test('Откат: отсутствующий прежний сервер не меняет конфиг; config-only работает без репозитория', async () => {
  const root = repo('rollback-paths'), files = configs('rollback-paths'), old = path.join(RUN, 'old-server.js');
  write(old, '// прежний сервер');
  const absent = path.join(RUN, 'missing-server.js');
  json(files[0] + '.prev', { mcpServers: { most: { command: process.execPath, args: [absent] } } });
  json(files[1] + '.prev', { mcpServers: { most: { command: process.execPath, args: [old] } } });
  const before = fs.readFileSync(files[0], 'utf8');
  const out = await d.rollback({ root, configs: files });
  assert.match(out, /прежний сервер .*missing-server.js больше не существует — откат невозможен/);
  assert.equal(fs.readFileSync(files[0], 'utf8'), before);
  assert.equal(read(files[1]).mcpServers.most.args[0], old);
  const env = { MOST_TEST_WRITE_ROOT: path.dirname(files[0]), MOST_STATE_DIR: path.join(RUN, 'forbidden-rollback'),
    NODE_OPTIONS: '--require ' + JSON.stringify(path.join(__dirname, 'deploy-write-guard.js')) };
  assert.match(cli(['--config-only', '--rollback', '--config', files[0]], path.dirname(files[0]), env), /откат невозможен/);
  assert.equal(fs.readFileSync(files[0], 'utf8'), before);
  json(files[0] + '.prev', { mcpServers: { most: { command: process.execPath, args: [old] } } });
  assert.match(cli(['--config-only', '--rollback', '--config', files[0]], path.dirname(files[0]), env), /возвращён/);
  assert.equal(read(files[0]).mcpServers.most.args[0], old);
  assert.equal(read(files[0]).theme, 'тёмная');
  assert(!fs.existsSync(env.MOST_STATE_DIR));
}, true);

test('Bootstrap принимает коммит вне main; обычный team deploy отклоняет его', async () => {
  const root = repo('non-main'), t = new Team(root);
  const base = g.hash(root);
  g.git(root, ['checkout', '-b', 'candidate']); write(path.join(root, 'file.txt'), 'новая версия');
  g.git(root, ['add', '-A']); g.git(root, ['commit', '-m', 'Кандидат']);
  const candidate = g.git(root, ['rev-parse', 'HEAD']).trim();
  assert.equal(g.hash(root), base);
  assert.match(await d.deploy({ root, commit: candidate, releaseOnly: true }, mock), /прошёл пробный запуск/);
  assert(fs.existsSync(path.join(root, 'live', candidate, 'probe-ok.json')));
  await rejects(() => t.change({ action: 'deploy', commit: candidate }));
  assert.throws(() => g.deployGit(root, ['config', '--global', 'safe.directory', '*']), /не разрешена/);
}, true);

test('Отрицательные вердикты помощников сохраняются, но не разрешают слияние', async () => {
  const x = await change('negative-verdict');
  await vote(x);
  for (const who of ['codex', 'antigravity']) {
    const id = job(x, who), card = stores.list(who, false).jobs.find(j => j.id === id);
    const file = who === 'codex' ? card.resultFile : path.join(path.dirname(card.cardFile), 'result.txt');
    const text = 'Есть замечания\nНЕ ПРИНЯТО: 2 блокирующих\n'; write(file, text);
    if (who === 'antigravity') json(path.join(path.dirname(file), 'meta.json'), { hash: crypto.createHash('sha256').update(text).digest('hex') });
    const a = { action: 'verdict', name: 'one', who, job_id: id, base: x.c.base, candidate: x.c.candidate };
    await rejects(() => x.team.change({ ...a, decision: 'ПРИНЯТО' }), /Последняя строка/);
    await x.team.change({ ...a, decision: 'НЕ ПРИНЯТО' });
    assert.equal(read(x.team.changeFile('one')).verdicts.find(v => v.who === who).decision, 'НЕ ПРИНЯТО');
    await rejects(() => x.team.change({ action: 'merge', name: 'one' }), /Нет действующего/);
  }
  await vote(x, 'codex'); await vote(x, 'antigravity');
  await x.team.change({ action: 'merge', name: 'one' });
  assert.equal(g.hash(x.root), x.c.candidate);
}, true);

test('team: исчезнувшие после перечисления карточки пропускаются', async () => {
  const file = team.workFile('gone'); json(file, {});
  const jobFile = path.join(stores.roots().codex, 'gone.json'); json(jobFile, {});
  const original = fs.readFileSync;
  fs.readFileSync = function(p, ...args) {
    if ([file, jobFile].includes(String(p))) throw Object.assign(Error('исчез'), { code: 'ENOENT' });
    return original.call(this, p, ...args);
  };
  try {
    assert((await team.work({ action: 'list' })).includes('work ·'));
    const list = stores.list('codex'); assert(!list.errors.some(e => e.includes('gone.json')));
    const out = await team.status(undefined, undefined, undefined, true); assert(out.includes('Версия team:'));
  } finally { fs.readFileSync = original; }
});

test('Откат: конфигурация пользователя most + cmd /c npx, существующий и отсутствующий сервер', async () => {
  const root = repo('rollback-cmd'), files = configs('rollback-cmd');
  // Эти две записи сверены с обоими конфигами Claude пользователя; секретов здесь нет.
  let server = 'C:/most/index.js';
  if (process.platform !== 'win32' || !fs.existsSync(server)) {
    server = path.join(RUN, 'old-most/index.js'); write(server, '// прежний сервер');
  }
  console.log('Проверка прежнего most: ' + server);
  const previous = { mcpServers: {
    most: { command: 'node', args: [server] },
    antigravity: { command: 'cmd', args: ['/c', 'npx', '-y', 'mcp-server-google-antigravity'] },
  } };
  json(files[0] + '.prev', previous);
  const missing = structuredClone(previous);
  missing.mcpServers.most.args = [path.join(RUN, 'absent-most/index.js')];
  json(files[1] + '.prev', missing);
  const original = files.map(f => fs.readFileSync(f, 'utf8'));
  const out = await d.rollback({ root, configs: files });
  assert(out.includes(files[0] + ': возвращён'), out);
  assert.match(out, /прежний сервер .*absent-most.*больше не существует/);
  assert.deepEqual(read(files[0]).mcpServers.most, previous.mcpServers.most);
  assert.deepEqual(read(files[0]).mcpServers.antigravity, previous.mcpServers.antigravity);
  assert.equal(read(files[0]).theme, 'тёмная');
  assert.equal(read(files[0]).mcpServers.other.command, 'keep');
  assert.equal(fs.readFileSync(files[1], 'utf8'), original[1]);
  write(files[0], original[0]);
  assert.match(cli(['--config-only', '--rollback', '--config', files[0]], path.dirname(files[0])), /возвращён/);
  assert.deepEqual(read(files[0]).mcpServers.antigravity, previous.mcpServers.antigravity);
  assert.match(cli(['--config-only', '--rollback', '--config', files[1]], path.dirname(files[1])), /откат невозможен/);
  assert.equal(fs.readFileSync(files[1], 'utf8'), original[1]);
}, true);

test('Откат: ключи cmd и npx пропускаются; пути скриптов проверяются', async () => {
  const file = configs('rollback-flags')[0];
  for (const server of [
    { command: 'cmd', args: ['/k', 'npx', '-y', '--quiet', 'mcp-server-google-antigravity'] },
    { command: 'npx', args: ['-y', '--quiet', 'mcp-server-google-antigravity'] },
  ]) {
    json(file + '.prev', { mcpServers: { antigravity: server } });
    assert.match(await d.rollback({ configOnly: true, configs: [file] }), /возвращён/);
    assert.deepEqual(read(file).mcpServers.antigravity, server);
  }
  for (const script of ['absent.js', './absent.mjs', 'absent.cjs']) {
    json(file + '.prev', { mcpServers: { most: { command: 'node', args: [script] } } });
    const before = fs.readFileSync(file, 'utf8');
    assert.match(await d.rollback({ configOnly: true, configs: [file] }), /откат невозможен/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

(async () => {
  console.log('Временная папка части 2: ' + RUN);
  let gitAvailable = true;
  try {
    repo('permission-check');
  } catch (e) {
    gitAvailable = false;
    console.log('ОГРАНИЧЕНИЕ GIT: ' + e.message);
  }
  for (const t of tests) {
    if (t.git && !gitAvailable) {
      skipped++;
      console.log('ПРОПУЩЕНО: ' + t.label);
      continue;
    }
    try {
      await t.fn();
      passed++;
      console.log('ДА: ' + t.label);
    } catch (e) {
      failed++;
      console.log('ПРОВАЛ: ' + t.label + '\n' + e.stack);
    }
  }
  console.log('Итого дополнительно: пройдено ' + passed + ', провалено ' + failed + ', пропущено ' + skipped);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
