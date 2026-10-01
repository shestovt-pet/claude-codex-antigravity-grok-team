'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-review-'));
process.env.MOST_STATE_DIR = path.join(RUN, 'state');
process.env.MOST_NOTIFY = 'file:' + path.join(RUN, 'notify.jsonl');
const write = (f, s) => { fs.mkdirSync(path.dirname(f), {recursive:true}); fs.writeFileSync(f,s); };
const json = (f, o) => write(f,JSON.stringify(o));
const read = f => JSON.parse(fs.readFileSync(f,'utf8'));
const cc = require('../common/client-configs'), d = require('../common/deploy'), cli = require('../tools/deploy');
const tests = []; const test = (name,fn) => tests.push({name,fn}); let passed=0,failed=0;
const begin='# most:begin (правит team_change deploy)', end='# most:end';
function release(id) {
  const dir=path.join(RUN,'live',id.repeat(40));
  for(const n of ['antigravity','codex','team','grok'])write(path.join(dir,'servers',n,'index.js'),'// подделка релиза');
  json(path.join(dir,'probe-ok.json'),{commit:id.repeat(40),root:RUN,servers:['antigravity','codex','team','grok'],at:new Date().toISOString()});
  return dir;
}
const oldRelease=release('a'), current=release('b');
test('F1: метки и похожие таблицы внутри обоих видов многострочных строк — только данные',()=>{
  for(const quote of ["'''", '"""']) {
    const text='\uFEFF# чужой текст\r\nnote = '+quote+'\r\n'+begin+'\r\n[mcp_servers.team]\r\nmcp_servers.antigravity.command = "keep"\r\n'+end+'\r\n'+quote+'\r\n';
    assert(!cc.block(text).exists);
    const next=cc.toml(text,current,RUN,RUN,process.execPath);assert(Buffer.from(next).subarray(0,Buffer.byteLength(text)).equals(Buffer.from(text)));
    assert.equal(cc.toml(next,current,RUN,RUN,process.execPath),next);
  }
});
test('F1: экранированные кавычки, комментарии и метки внутри массивов',()=>{
  const text='note = "escaped \\" # most:begin"\nvalues = [\n # most:begin\n "keep",\n # most:end\n]\n';
  assert(!cc.block(text).exists);assert(cc.toml(text,current,RUN,RUN,'node').startsWith(text));
  const trailing='x = "keep" # most:begin\n';assert(cc.toml(trailing,current,RUN,RUN,'node').startsWith(trailing));
});
test('F1: таблицы, точечные ключи, кавычки в ключах и встроенные таблицы конфликтуют',()=>{
  for(const text of [
    '[mcp_servers.team]\ncommand="keep"\n', '[mcp_servers.antigravity.env]\nKEY="keep"\n',
    'mcp_servers.team.command = "keep"\n', '"mcp_servers"."antigravity".command = "keep"\n',
    'mcp_servers = { team = { command = "keep" } }\n', 'mcp_servers = { other = { command = "keep" } }\n',
    '[mcp_servers]\nteam.command="keep"\n', '["mcp_servers"]\nantigravity = {command="keep"}\n',
    '[[mcp_servers.team]]\ncommand="keep"\n', 'mcp_servers."te\\u0061m".command="keep"\n',
  ]) assert.throws(()=>cc.toml(text,current,RUN,RUN,'node'),/вне служебного блока/,text);
  const foreign='[mcp_servers.other]\ncommand="keep"\n';assert(cc.toml(foreign,current,RUN,RUN,'node').startsWith(foreign));
});
test('F1: повреждённые и повторные настоящие метки отклоняются',()=>{
  for(const text of [begin+'\n',end+'\n',end+'\n'+begin+'\n',begin+'\n'+end+'\n'+begin+'\n'+end+'\n','# most:begin повреждено\n'+end+'\n'])
    assert.throws(()=>cc.toml(text,current,RUN,RUN,'node'),/метки/);
});
test('F2: TOML сравнивается по разобранным значениям, форматирование сохраняется',()=>{
  const base=cc.toml('# keep\n',current,RUN,RUN,process.execPath);
  const formatted=base.replace('startup_timeout_sec = 30','startup_timeout_sec=3_0').replaceAll(' = ', '   =   ').replace("MOST_CLIENT   =   'codex'",'MOST_CLIENT="codex"');
  assert.deepEqual(cc.plans([{kind:'codex',file:'none',text:formatted}],current,RUN,RUN,process.execPath),[]);
  const previous=process.env.MOST_CODEX_CONFIG, file=path.join(RUN,'formatted.toml');
  try {write(file,formatted);process.env.MOST_CODEX_CONFIG=file;assert(cc.status().includes(path.join(current,'servers/team/index.js')));}
  finally {process.env.MOST_CODEX_CONFIG=previous;}
});
const files={codex:path.join(RUN,'clients/config.toml'),agy:path.join(RUN,'clients/mcp_config.json'),permissions:path.join(RUN,'clients/config.json'),claude:path.join(RUN,'claude/settings.json')};
process.env.MOST_CODEX_CONFIG=files.codex;process.env.MOST_AGY_MCP_CONFIG=files.agy;process.env.MOST_AGY_CONFIG=files.permissions;
process.env.MOST_CLAUDE_CONFIGS=JSON.stringify([files.claude]);
function seed() {
  write(files.codex,cc.toml('# чужие байты\r\n',oldRelease,RUN,process.env.MOST_STATE_DIR,process.execPath));
  json(files.agy,{foreign:'keep',mcpServers:{team:{command:process.execPath,args:[path.join(oldRelease,'servers/team/index.js')]},codex:{command:process.execPath,args:[path.join(oldRelease,'servers/codex/index.js')]}}});
  json(files.permissions,{userSettings:{globalPermissionGrants:{allow:['keep']}}});
  json(files.claude,d.configFor({foreign:'keep'},oldRelease,RUN));
}
test('F6: clients-only dry-run не пишет и не запускает перезапуск',async()=>{
  seed();const before=Object.values(files).map(f=>fs.readFileSync(f,'utf8'));
  const result=await d.configureClients({release:current,dryRun:true,restartClaude:true},{restart:{launch:()=>assert.fail('перезапуск')}});
  assert.match(result,/изменений нет/);Object.values(files).forEach((f,i)=>{assert.equal(fs.readFileSync(f,'utf8'),before[i]);assert(!fs.existsSync(f+'.prev'));});
});
test('F6: конфликт TOML отклоняет clients-only до любой записи',async()=>{
  const before=fs.readFileSync(files.agy,'utf8');write(files.codex,'mcp_servers.team.command="keep"\n');
  await assert.rejects(d.configureClients({release:current}),/вне служебного блока/);assert.equal(fs.readFileSync(files.agy,'utf8'),before);assert(!fs.existsSync(files.agy+'.prev'));seed();
});
let original, backups;
test('F2/F6: установка клиентов сохраняет .prev и не трогает Claude',async()=>{
  original=Object.fromEntries(Object.entries(files).map(([k,f])=>[k,fs.readFileSync(f,'utf8')]));
  await d.configureClients({release:current});assert.equal(fs.readFileSync(files.claude,'utf8'),original.claude);
  for(const k of ['codex','agy','permissions'])assert.equal(fs.readFileSync(files[k]+'.prev','utf8'),original[k]);
  await d.configure({release:current,configs:[files.claude]});
  backups=Object.fromEntries(Object.entries(files).map(([k,f])=>[k,{text:fs.readFileSync(f+'.prev','utf8'),mtime:fs.statSync(f+'.prev').mtimeMs}]));
});
test('F2: переформатирование JSON, иной порядок полей и тот же релиз не меняют .prev',async()=>{
  for(const k of ['agy','permissions','claude']) {const obj=read(files[k]);write(files[k],JSON.stringify(Object.fromEntries(Object.entries(obj).reverse()),null,4));}
  const before=Object.fromEntries(Object.entries(files).map(([k,f])=>[k,fs.readFileSync(f,'utf8')]));
  await d.configureClients({release:current});await d.configure({release:current,configs:[files.claude]});
  for(const [k,f] of Object.entries(files)) {assert.equal(fs.readFileSync(f,'utf8'),before[k]);assert.equal(fs.readFileSync(f+'.prev','utf8'),backups[k].text);assert.equal(fs.statSync(f+'.prev').mtimeMs,backups[k].mtime);}
});
test('F2: исправление записи того же релиза тоже сохраняет предыдущие подключения',async()=>{
  for(const k of ['agy','claude']) {const obj=read(files[k]);obj.mcpServers.team.command='node';json(files[k],obj);}
  const permissions=read(files.permissions);permissions.userSettings.globalPermissionGrants.allow=['keep'];json(files.permissions,permissions);
  await d.configureClients({release:current});await d.configure({release:current,configs:[files.claude]});
  for(const [k,f] of Object.entries(files))assert.equal(fs.readFileSync(f+'.prev','utf8'),backups[k].text);
});
test('F2: rollback возвращает предыдущий релиз после повторной установки',async()=>{
  await d.rollback({configs:Object.values(files),configOnly:true});
  assert.equal(fs.readFileSync(files.codex,'utf8'),original.codex);
  for(const k of ['agy','claude'])assert.equal(read(files[k]).mcpServers.team.args[0],path.join(oldRelease,'servers/team/index.js'));
  assert.deepEqual(read(files.permissions).userSettings.globalPermissionGrants.allow,['keep']);
});
test('F6: restart-claude вызывается после записи для обоих режимов',async()=>{
  for(const kind of ['clients','config']) {
    let started=false;
    const deps={restart:{launch:async(file,{log,runId})=>{started=true;const f=kind==='clients'?files.agy:files.claude;assert.equal(read(f).mcpServers.team.args[0],path.join(current,'servers/team/index.js'));write(log,'запущен '+runId+'\n');}}};
    const result=await (kind==='clients'?d.configureClients({release:current,restartClaude:true},deps):d.configure({release:current,configs:[files.claude],restartClaude:true},deps));
    assert(started);assert.match(result,/Перезапуск Claude запланирован \([a-f0-9-]+\)/);assert.match(result,/\.log/);
  }
});
test('F6: ошибка записи исключает перезапуск и компенсирует предыдущие изменения',async()=>{
  const before=fs.readFileSync(files.codex,'utf8');
  await assert.rejects(d.configureClients({release:oldRelease,restartClaude:true},{hook:async label=>{if(label==='config2')throw Error('сбой');},restart:{launch:()=>assert.fail('перезапуск')}}),/сбой/);
  assert.equal(fs.readFileSync(files.codex,'utf8'),before);
});
test('F6: разбор параметров и выбор обработчика без реального перезапуска',async()=>{
  for(const mode of ['--clients-only','--config-only']) {
    const args=[mode,'--release',current,'--restart-claude','--dry-run',...(mode==='--config-only'?['--config',files.claude]:[])];
    const parsed=cli.parseArgs(args).options;assert(parsed.restartClaude&&parsed.dryRun);assert.equal(parsed.release,current);
    const handler=async opts=>{assert(opts.restartClaude);return 'проверено';};
    assert.equal(await cli.main(args,{configureClients:handler,configure:handler,deploy:()=>assert.fail('сборка'),print:()=>{}}),'проверено');
  }
  for(const args of [['--clients-only'],['--clients-only','--config-only'],['--clients-only','--release-only'],['--clients-only','--release',current,'--config',files.claude],['--clients-only','--release',current,'--commit','main'],['--clients-only','--release',current,'--node-modules-from',RUN],['--clients-only','--release',current,'--rollback'],['--restart-claude'],['--config-only','--restart-claude'],['--config-only','--release',current,'--restart-claude','--rollback']])assert.throws(()=>cli.parseArgs(args));
});
test('F5: без closes используется критерий приёмки',async()=>{
  const {Team}=require('../common/team'),t=new Team(RUN,path.join(RUN,'team'));
  const stages=[{title:'Этап',weight:100,accept_criteria:'Проверенный итог для пользователя',state:'план'}];
  await t.work({owner: 'test-owner', action: 'create',name:'fallback',expected_revision:0,goal:'Цель',done_criteria:'Итог',next_step:'Дальше',stages});
  stages[0]={...stages[0],state:'принят',evidence:'Доказательство',version:'1'};
  require('./legacy-work')(t, 'fallback');
  const out=await t.work({owner: 'test-owner', action: 'update',name:'fallback',expected_revision:1,stages});assert.match(out,/сделано: Доказательство · это закрывает: Проверенный итог для пользователя · дальше: Дальше/);
  assert.match(fs.readFileSync(path.join(RUN,'notify.jsonl'),'utf8'),/это закрывает: Проверенный итог для пользователя/);
});

test('L1: перенос из двух прежних мест с сохранением конфликтов и без старых замков',async()=>{
  const root=path.join(RUN,'migration'),state=path.join(root,'state'),local=path.join(root,'redirected-local');
  const env={LOCALAPPDATA:local,MOST_CLIENT:'claude'};
  json(path.join(local,'most/jobs/same/card.json'),{source:'local'});
  json(path.join(root,'live/.deploy-state/jobs/same/card.json'),{source:'deploy'});
  json(path.join(root,'live/.deploy-state/codex-jobs/old.json'),{id:'old'});
  json(path.join(local,'most/team/claude-quota.json'),{percent:12});
  json(path.join(local,'most/locks/old.json'),{});json(path.join(root,'live/.deploy-state/ready/team.json'),{});
  const {migrate}=require('../common/state-migration');
  assert.equal(await migrate({root,state,env:{...env,MOST_CLIENT:'codex'}}),undefined);assert(!fs.existsSync(state));
  assert.equal(await migrate({root,state,env:{...env,MOST_PROBE_ONLY:'1'}}),undefined);assert(!fs.existsSync(state));
  fs.mkdirSync(state);const result=await migrate({root,state,env});assert.equal(result.copied,4);assert.equal(result.conflicts.length,1);
  assert.equal(read(path.join(state,'jobs/same/card.json')).source,'local');assert.equal(read(path.join(state,'team/claude-quota.json')).percent,12);
  assert(!fs.existsSync(path.join(state,'locks/old.json')));assert(!fs.existsSync(path.join(state,'ready')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(state,'migration.log'),'utf8')).copied,4);
  json(path.join(local,'most/codex-jobs/later.json'),{});await migrate({root,state,env});assert(fs.existsSync(path.join(state,'codex-jobs/later/card.json')));
});
test('L1–L2: configure и clients-only отделяют хранилище от блокировок',async()=>{
  const lockState=path.join(RUN,'only-deploy-locks');
  await d.configure({release:current,configs:[files.claude],stateDir:lockState});
  await d.configureClients({release:current,stateDir:lockState});
  for(const n of ['team','codex','antigravity','grok'])assert.equal(read(files.claude).mcpServers[n].env.MOST_STATE_DIR,path.join(RUN,'state'));
  for(const n of ['team','codex'])assert.equal(read(files.agy).mcpServers[n].env.MOST_STATE_DIR,path.join(RUN,'state'));
  const text=fs.readFileSync(files.codex,'utf8'), servers=cc.block(text).parsed.root.mcp_servers;
  for(const n of ['team','antigravity']){assert.equal(servers[n].env.MOST_STATE_DIR,path.join(RUN,'state'));assert.equal(servers[n].default_tools_approval_mode,'approve');}
  assert.equal(cc.toml(text,current,RUN,lockState,process.execPath),text);
  assert.throws(()=>cc.toml(text+'\n[mcp_servers.team]\ndefault_tools_approval_mode = "approve"\n',current,RUN,lockState,process.execPath),/вне служебного/);
  await require('../common/restart').restart({root:RUN,release:current,state:lockState},{launch:async(file,{log,runId})=>{
    assert(fs.readFileSync(file,'utf8').includes("$state = '"+path.join(RUN,'state')+"'"));write(log,'запущен '+runId+'\n');
  }});
});
test('L3: преобразование строк сохраняет строгую проверку и значения по умолчанию',()=>{
  const {z}=require('zod'),{compatible}=require('../common/schema');
  const schema=z.object(compatible({flag:z.boolean().default(false),n:z.number().int().min(0).max(40).optional(),obj:z.object({n:z.number().positive()}).optional(),list:z.array(z.number()).optional()}));
  assert.deepEqual(schema.parse({flag:'false',n:'40',obj:'{"n":"2"}',list:'["3"]'}),{flag:false,n:40,obj:{n:2},list:[3]});
  assert.deepEqual(schema.parse({}),{flag:false});assert.equal(schema.parse({flag:'true'}).flag,true);
  for(const flag of ['1','yes','FALSE','',null,1])assert(!schema.safeParse({flag}).success);
  for(const n of ['',' ','NaN','Infinity','1e999','41','-1','1.5','0x10',true,null])assert(!schema.safeParse({n}).success);
  for(const obj of ['bad','[]','null','{"n":"-2"}','{"n":true}'])assert(!schema.safeParse({obj}).success);
});
test('L1–L3: MCP принимает строки и сохраняет запреты гостя',async()=>{
  const {Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
  const root=path.join(RUN,'mcp-strings');fs.mkdirSync(root);
  json(path.join(root,'local/most/team/migrated.json'),{preserved:true});
  for(const client of ['claude','codex']){
    const transport=new StdioClientTransport({command:process.execPath,args:[path.join(__dirname,'../servers/team/index.js')],env:{...process.env,MOST_REPO_ROOT:root,MOST_STATE_DIR:path.join(root,'state'),LOCALAPPDATA:path.join(root,'local'),MOST_CLIENT:client,MOST_NOTIFY:'off'},stderr:'pipe'});
    const c=new Client({name:'test',version:'1'});await c.connect(transport);
    try{
      const call=args=>c.callTool({name:'team_status',arguments:args});
      const out=await call({notify_test:'false',full:'true'});assert(!out.isError,JSON.stringify(out));assert(out.content[0].text.includes(path.join(root,'state')));
      assert.equal(read(path.join(root,'state/team/migrated.json')).preserved,true);
      for(const key of ['claude_usage','claude_quota']){
        const value=key==='claude_usage'?{calls:'2',written:'3',reread:'4',window_h:'5',taken_at:new Date().toISOString(),source:'test'}:{percent:'25',taken_at:new Date().toISOString(),source:'test'};
        const r=await call({[key]:JSON.stringify(value)});assert.equal(!!r.isError,client==='codex',JSON.stringify(r));
      }
      assert((await call({notify_test:'yes'})).isError);
      const notify=await call({notify_test:'true'});assert.equal(!!notify.isError,client==='codex');
      if(client==='claude'){
        const r=await c.callTool({name:'team_change',arguments:{action:'list',restart_claude:'false',from_char:'0'}});assert(!r.isError,JSON.stringify(r));
        assert((await c.callTool({name:'team_change',arguments:{action:'list',restart_claude:'no'}})).isError);
      }
    }finally{await c.close();}
  }
});

(async()=>{for(const {name,fn} of tests){try{await fn();passed++;console.log('✓ '+name);}catch(e){failed++;console.error('ПРОВАЛ '+name+'\n'+e.stack);}}console.log(`Итого: пройдено ${passed}, провалено ${failed}`);process.exitCode=failed?1:0;})().catch(e=>{console.error(e);process.exitCode=1;});
