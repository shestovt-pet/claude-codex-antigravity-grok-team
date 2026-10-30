'use strict';
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const f = require('./team-v16-fixture'), members = require('../common/members'), storeLib = require('../common/members-store');
const meta = { action: 'test', who: 'claude', reason: 'ревью google частей 1–3' };
const edit = fn => members.store().update(members.rev(), fn, meta);
async function roster(fn, run) {
  const before = structuredClone(members.all()); edit(fn);
  try { return await run(); } finally { edit(n => { n.members = before; }); }
}
const tests = [];
for (const initial of [true, false]) for (const point of ['before-log', 'after-log', 'before-good', 'after-good', 'before-file', 'after-file']) {
  tests.push(['Журнал: ' + (initial ? 'init' : 'update') + ', обрыв ' + point, () => {
    const s = storeLib.create(path.join(f.RUN, 'wal-' + initial + '-' + point));
    if (!initial) s.read();
    const write = fs.writeFileSync, rename = fs.renameSync; let fired = false;
    const crash = () => { fired = true; throw Error('обрыв записи'); };
    fs.writeFileSync = function(target, data, ...args) {
      const log = typeof target === 'number' && typeof data === 'string' && data.includes('"after":') && data.includes('"action":');
      if (log && point === 'before-log') crash();
      const out = write.call(fs, target, data, ...args);
      if (log && point === 'after-log') crash();
      return out;
    };
    fs.renameSync = function(a, b) {
      const which = b === s.good ? 'good' : b === s.file ? 'file' : '';
      if (point === 'before-' + which) crash();
      const out = rename.call(fs, a, b);
      if (point === 'after-' + which) crash();
      return out;
    };
    try { assert.throws(() => initial ? s.read() : s.update(0, n => { n.members[0].specialization = 'новая'; }, meta), /обрыв/); }
    finally { fs.writeFileSync = write; fs.renameSync = rename; }
    assert(fired);
    const expected = initial || point === 'before-log' ? 0 : 1;
    const recovered = s.read(); assert.equal(recovered.rev, expected);
    if (!initial && point !== 'before-log') assert.equal(recovered.members[0].specialization, 'новая', 'данные записи сохранены');
    assert.equal(s.history().filter(e => e.action === 'init').length, 1, 'инициализация записана один раз');
    assert.equal(s.update(expected, () => {}, meta).rev, expected + 1);
    assert.equal(JSON.parse(fs.readFileSync(s.file)).rev, expected + 1);
  }]);
}
tests.push(
  ['Доступ: битые оба снимка закрывают apply, cancel, word, send и принятие', () => {
    const s = members.store(); s.read(); const old = [s.file, s.good].map(p => fs.readFileSync(p));
    try {
      fs.writeFileSync(s.file, '{'); fs.writeFileSync(s.good, '{');
      for (const [server,tool,args] of [['antigravity','antigravity_apply',{}],['antigravity','antigravity_cancel',{}],['codex','codex_cancel',{}],['grok','grok_cancel',{}],['team','team_word',{action:'record'}],['codex','codex_send',{}],['team','team_work',{action:'update'}],['team','team_change',{action:'merge'}]])
        assert.throws(() => require('../common/access').guard(server,tool,args), /Реестр участников/, tool);
    } finally { [s.file,s.good].forEach((p,i)=>fs.writeFileSync(p,old[i])); }
  }],
  ['Маршрут: переименованный получатель, writer и admission выбираются по адаптеру', async () => {
    await roster(n => { const m=n.members.find(m=>m.id==='codex');m.state='removed'; n.members.push({...structuredClone(m),id:'renamed',state:'active'}); }, () => {
      assert.doesNotThrow(()=>require('../common/access').guard('codex','codex_send',{write:true}));
      const server={name:'codex',startedAt:new Date().toISOString()};
      const admitted=require('../common/restart-hold').admit(path.join(f.root,'state'),server,{early:true});
      assert.notEqual(admitted.kind,'members');
      edit(n=>n.members.find(m=>m.id==='renamed').roles.writer=false);
      assert.throws(()=>require('../common/access').guard('codex','codex_send',{write:true}), /запис|writer/);
    });
  }],
  ['Отмена: переименованный codex использует замок codex_job', async () => {
    await roster(n=>{n.members.push({...structuredClone(n.members.find(m=>m.id==='codex')),id:'other-code'});}, async()=>{
      const id='renamed-cancel',file=path.join(f.stores.roots()['other-code'],id+'.json');
      f.json(file,{id,status:'queued'}); const locks=require('../common/locks'),original=locks.waitLock;let kind;
      locks.waitLock=async(k,...args)=>{kind=k;return original(k,...args);};
      try {assert.equal((await require('../common/job-cancel').cancel('other-code',id)).status,'cancelled');assert.equal(kind,'codex_job');}
      finally{locks.waitLock=original;}
    });
  }],
  ['Запись: даже Claude не отправляет write получателю без writer', async () => {
    await roster(n => { n.members.find(m => m.id === 'codex').roles.writer = false; }, () => {
      const access = require('../common/access');
      assert.doesNotThrow(() => access.guard('codex', 'codex_send', { write: false }));
      assert.throws(() => access.guard('codex', 'codex_send', { write: true }), /writer/);
    });
  }],
  ['Запуск: переименованный получатель допускается независимо от id сервера', async () => {
    const hold = require('../common/restart-hold'), state = path.join(f.RUN, 'admit-state');
    const store = require('../common/members-store').create(state);
    store.read();
    // Переименование выполняется в том же реестре, который читает admit.
    store.update(store.read().rev, n => { n.members.find(m => m.id === 'codex').id = 'renamed'; }, { action: 'test', who: 'claude', reason: 'переименование получателя' });
    const result = hold.admit(state, { name: 'codex', startedAt: new Date().toISOString() }, { early: true });
    assert.notEqual(result.kind, 'members', JSON.stringify(result));
    store.update(store.read().rev, n => { n.members.find(m => m.id === 'renamed').state = 'removed'; }, { action: 'test', who: 'claude', reason: 'контроль допуска' });
    const none = hold.admit(state, { name: 'codex', startedAt: new Date().toISOString() }, { early: true });
    assert.equal(none.ok, false, 'без получателя запуск не допускается'); assert.equal(none.kind, 'members');
    assert.match(none.reason, /получателя/);
  }],
  ['Пауза А: active/voters/seats/task-roles и сводка сохраняют голосующего', async () => {
    await roster(n=>{const m=n.members.find(m=>m.id==='antigravity');m.state='paused';m.pause={kind:'manual',scope:'participant',since:new Date().toISOString(),until:null,next_probe:null};},async()=>{
      assert(members.active().some(m=>m.id==='antigravity'));assert(members.voters().some(m=>m.id==='antigravity'));
      assert([...require('../common/team-seats').SEATS].includes('antigravity'));
      assert(require('../common/task-roles').defaultHeuristic('code',{}).reviewer.includes('antigravity'));
      assert.match(members.describe(true),/Antigravity.*пауза/);
      const stage = f.fixture(); f.job(stage, 'codex');
      await assert.rejects(() => f.accept(stage), /обязательн|ждёт|двух|два/, 'одного голоса мало');
      f.job(stage, 'antigravity'); await f.accept(stage); assert.equal(stage.s.state, 'принят');
    });
  }],
  ['Кворум А: удалённый обязательный голосующий не уменьшает team_change', async () => {
    await roster(n=>{n.members.find(m=>m.id==='antigravity').state='removed';},()=>{
      assert.throws(()=>[...require('../common/team-seats').SEATS], /ждёт|обязательн/);
    });
  }],
  ['Кворум А: anthropic не принимается одним голосом (v14 и v15)', async () => {
    for(const version of [14,15]) await roster(n=>{n.members.find(m=>m.id==='antigravity').state='removed';},async()=>{
      const stage=f.fixture();stage.s.rules_version=version;f.job(stage,'codex');
      await assert.rejects(()=>f.accept(stage),/обязательн|двух|два|ждёт|состав/);
    });
  }],
  ['Слово: голосующий без fallback_conductor допустим, новые слова Grok запрещены',async()=>{
    await roster(n=>{n.members.push({...structuredClone(n.members.find(m=>m.id==='codex')),id:'voter-only',roles:{...n.members.find(m=>m.id==='codex').roles,fallback_conductor:false}});},()=>{
      const words=require('../common/user-word');assert.equal(words.entry({who_down:'voter-only',quote:'отвалился'}).who_down,'voter-only');assert.throws(()=>words.entry({who_down:'grok',quote:'отвалился'}),/who_down/);
    });
  }],
  ['Откат: чистый исходный конфиг — отключение, а не релиз ниже А',async()=>{
    const d=require('../common/deploy'),root=path.join(f.RUN,'clean-rollback'),file=path.join(root,'claude.json');
    storeLib.create(path.join(root,'state')).read(); f.json(file,{mcpServers:{team:{command:process.execPath,args:[path.join(root,'live/current/servers/team/index.js')]}}});f.json(file+'.prev',{});
    assert.match(await d.rollback({root,configs:[file],configOnly:true}),/возвращён/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).mcpServers,{});
  }],
  ['Откат: файл разрешений не снимает notion по неизвестному целевому релизу',async()=>{
    const d=require('../common/deploy'),p=require('../common/agy-mcp-permissions'),root=path.join(f.RUN,'permissions-rollback');
    storeLib.create(path.join(root,'state')).read();
    const release=path.join(root,'live/current'),settings=path.join(root,'settings.json'),file=path.join(root,'permissions.json');
    f.write(path.join(release,'common/agy-mcp-permissions.js'),'// 3.8');
    await d.switchConfigs(p.plans(release,root,{file:settings}));
    f.json(file,{userSettings:{globalPermissionGrants:{allow:['current']}}});f.json(file+'.prev',{userSettings:{globalPermissionGrants:{allow:['old']}}});
    const before=fs.readFileSync(settings,'utf8'),env={...process.env};process.env.MOST_AGY_CONFIG=file;process.env.MOST_AGY_CLI_SETTINGS=settings;
    try {assert.match(await d.rollback({root,configs:[file],configOnly:true}),/возвращён/);assert.equal(fs.readFileSync(settings,'utf8'),before);}
    finally {process.env.MOST_AGY_CONFIG=env.MOST_AGY_CONFIG||'';process.env.MOST_AGY_CLI_SETTINGS=env.MOST_AGY_CLI_SETTINGS||'';}
  }],
  ['Клиенты: личный config не занимает стандартный; rulesFile не дублируется',()=>{
    const m=structuredClone(members.get('codex')),rows=[{...m,id:'custom',adapter_params:{client_config:path.join(f.RUN,'custom.toml')}},{...m,id:'default'},{...m,id:'another',adapter_params:{client_config:path.join(f.RUN,'another.toml')}}];
    const clients=require('../common/member-clients').all(rows);assert.equal(clients.length,3);
    const rules=clients.map(c=>c.rulesFile).filter(Boolean);assert.equal(new Set(rules).size,rules.length);
  }],
  ['DSH: точный откат отсутствующего eol и insert со следующими строками',()=>{
    const y=require('../common/dsh-config');
    for(const old of ['- id: personal','- id: personal\r\n','- id: personal\n',''])assert.equal(y.restore(y.render(old,f.root,f.root,process.execPath),old),old);
    const entry={id:'mcp-most-team',config:{serverName:'team'}};
    assert.equal(y.block('# most:begin\n- insert: '+JSON.stringify([entry])+'\n- '+JSON.stringify({...entry,id:'mcp-most-codex',config:{serverName:'codex'}})+'\n# most:end').entries.length,2);
  }],
  ['MCP: USERPROFILE и mcp_allow переименованного agy-cli',async()=>{
    const old=process.env.MOST_AGY_CLI_SETTINGS,home=process.env.USERPROFILE;delete process.env.MOST_AGY_CLI_SETTINGS;process.env.USERPROFILE=f.RUN;
    try{assert.equal(require('../common/agy-mcp-permissions').settingsPath(),path.join(f.RUN,'.gemini/antigravity-cli/settings.json'));}
    finally{if(old===undefined)delete process.env.MOST_AGY_CLI_SETTINGS;else process.env.MOST_AGY_CLI_SETTINGS=old;if(home===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=home;}
    await roster(n=>{const m=n.members.find(m=>m.id==='antigravity');m.id='renamed-agy';m.mcp_allow=['notion/API-get-self'];},()=>{
      const a=require('../common/agy-tools');
      assert(a.allowed({name:'mcp_notion_API-get-self'}), 'маска переименованного участника действует');
      assert(!a.allowed({name:'mcp_notion_delete-page'}), 'чужая маска не подставляется');
    });
  }],
  ['История: removed сохраняет provenance; повреждение реестра не роняет format',async()=>{
    await roster(n=>{n.members.find(m=>m.id==='codex').state='removed';},()=>{
      const p=require('../common/provenance').reviewerInfo({},'codex');assert.equal(p.transport,'codex-cli');assert.equal(p.family,'openai');
    });
    const s=members.store(),old=[s.file,s.good].map(p=>fs.readFileSync(p));
    try{fs.writeFileSync(s.file,'{');fs.writeFileSync(s.good,'{');assert.doesNotThrow(()=>require('../common/format').format('Codex',{id:'read',status:'done'},'ответ'));}
    finally{[s.file,s.good].forEach((p,i)=>fs.writeFileSync(p,old[i]));}
  }],
  ['Модели: deepseek только строковый префикс',()=>{
    const family=require('../common/model-family').family;
    assert.equal(family({toString:()=> 'deepseek-r1'}),null);assert.equal(family('foreign-deepseek'),null);assert.equal(family('deepseek-r1'),'deepseek');
  }]
);
for (const initial of [true, false]) for (const boundary of ['log', 'good', 'file']) tests.push(['Завершение процесса: ' + initial + '/' + boundary, () => {
  const cp = require('child_process'), dir = path.join(f.RUN, 'exit-' + initial + '-' + boundary), s = storeLib.create(dir);
  if (!initial) s.read();
  const source = `const fs=require('fs'),store=require(${JSON.stringify(require.resolve('../common/members-store'))}).create(${JSON.stringify(dir)});
const write=fs.writeFileSync,rename=fs.renameSync;
fs.writeFileSync=function(p,d,...a){const out=write.call(fs,p,d,...a);if(${JSON.stringify(boundary)}==='log'&&typeof p==='number'&&typeof d==='string'&&d.includes('"after":'))process.exit(77);return out;};
fs.renameSync=function(a,b){const out=rename(a,b);if(b===store[${JSON.stringify(boundary)}])process.exit(77);return out;};
${initial ? 'store.read()' : 'store.update(0,()=>{}, {action:"test",who:"claude",reason:"обрыв"})'};`;
  const child = cp.spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 77, child.stderr); assert(fs.existsSync(s.lock));
  assert.equal(s.read().rev, initial ? 0 : 1); assert.equal(s.update(initial ? 0 : 1, () => {}, meta).rev, initial ? 1 : 2);
}]);
tests.push(['Задачи: все внешние голосующие участвуют в reviewer', async () => {
  await roster(n => n.members.push({ ...structuredClone(n.members.find(m => m.id === 'antigravity')), id: 'extra-voter', family: 'other' }), () => {
    for (const kind of ['code', 'fallback']) assert(require('../common/task-roles').defaultHeuristic(kind, {}).reviewer.includes('extra-voter'));
  });
}]);
tests.push(['Grok: новые вердикты запрещены, прежнее слово читается', async () => {
  const team = new (require('../common/team').Team)(f.root);
  for (const action of ['design', 'verdict']) await assert.rejects(() => team.change({ action, who: 'grok' }), /Grok выключен/);
  const words = require('../common/user-word');
  await words.append({ who_down: 'grok', quote: 'историческая запись', source: 'chat-claude', recorded_by: 'claude' });
  assert(words.read().some(r => r.who_down === 'grok'));
}]);
tests.push(['История: свежесть codex-ревью проверяется по адаптеру даже после remove', async () => {
  const stage = f.fixture();
  await roster(n => { const m = n.members.find(x => x.id === 'codex'); m.id = 'legacy-codex'; m.state = 'removed'; }, () => {
    f.job(stage, 'legacy-codex', 0, { task: '#old-review', previous: null, write: false });
    f.job(stage, 'legacy-codex', 0, { task: '#old-review', previous: 'old-session', write: false });
    f.job(stage, 'legacy-codex', 0, { task: '#old-review', previous: null, write: true });
    const rows = require('../common/team-seats').reviewJobs({ requestMark: '#old-review' }, 'legacy-codex');
    assert.equal(rows.length, 1); assert(!rows[0].write && !rows[0].previous);
  });
}]);
tests.push(['Сводка: точка после всех участников, в том числе после agy-cli', async () => {
  await roster(n => n.members.push({ ...structuredClone(n.members.find(m => m.id === 'codex')), id: 'last', title: 'Last' }), () => {
    const line = require('../common/summary').loadLine(path.join(f.root, 'state'), {}).split('\n')[0];
    assert.match(line, /Last — 0 поручений\.$/); assert(!line.includes('.;'));
  });
}]);
tests.push(['Откат: most, аргументы node и неизвестная цель не обходят phase A', async () => {
  const d = require('../common/deploy'), root = path.join(f.RUN, 'rollback-targets');
  storeLib.create(path.join(root, 'state')).read();
  const script = path.join(root, 'base', 'servers', 'team', 'index.js'); f.write(script, '// база');
  const supported = path.join(root, 'phase-a', 'servers', 'team', 'index.js'); f.write(supported, '// A');
  f.write(path.join(root, 'phase-a', 'common', 'members-store.js'), '// A');
  const ok = { team: { command: process.execPath, args: ['--no-warnings', supported] } };
  const okFile = path.join(root, 'flags-ok.json'); f.json(okFile, { mcpServers: {} }); f.json(okFile + '.prev', { mcpServers: ok });
  assert.match(await d.rollback({ root, configs: [okFile], configOnly: true }), /возвращён/);
  assert.equal(JSON.parse(fs.readFileSync(okFile)).mcpServers.team.args[0], '--no-warnings');
  assert.equal(JSON.parse(fs.readFileSync(okFile)).mcpServers.team.args[1], supported);
  for (const [name, config] of Object.entries({ most: { most: { command: process.execPath, args: [script] } },
    flags: { team: { command: process.execPath, args: ['--no-warnings', script] } }, unknown: { team: { command: 'unknown-server', args: [] } },
    mixed: { team: { command: process.execPath, args: [supported] }, most: { command: process.execPath, args: [script] } } })) {
    const file = path.join(root, name + '.json'); f.json(file, { mcpServers: {} }); f.json(file + '.prev', { mcpServers: config });
    const before = fs.readFileSync(file, 'utf8');
    // Решение пользователя: fail-fast — rollback бросает (замысел team-v47, разд. 13.4).
    await assert.rejects(() => d.rollback({ root, configs: [file], configOnly: true }), /Откат ниже кандидата А запрещён/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
}]);
f.run(tests);
