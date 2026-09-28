'use strict';
// Этот набор проверяет запасной путь и прежний тестовый agy.
process.env.MOST_AGY_INPUT_FORMAT = 'legacy';
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-trio-'));
process.env.MOST_STATE_DIR = path.join(RUN, 'state');
process.env.MOST_REPO_ROOT = RUN;
process.env.MOST_NOTIFY = 'file:' + path.join(RUN, 'notifications.jsonl');
process.env.MOST_CODEX_JOBS_DIR = path.join(RUN, 'state/codex-jobs');
process.env.MOST_CODEX_ARCHIVE_DIR = path.join(RUN, 'archive');
process.env.MOST_CODEX_SESSIONS = path.join(RUN, 'sessions');
process.env.CODEX_PATH = path.join(__dirname, 'fake-codex.js');
process.env.MOST_CLAUDE_CONFIGS = '[]';
const write = (p, text) => { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, text); };
const json = (p, obj) => write(p, JSON.stringify(obj));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const { Team } = require('../common/team'), g = require('../common/team-git'), d = require('../common/deploy');
const q = require('../common/quota'), aq = require('../common/agy-quota'), cc = require('../common/client-configs');
const tests = []; let passed = 0, failed = 0;
const test = (name, fn) => tests.push({name, fn});
const request = 'Пользователь просит сделать видимый и проверенный результат.';
const design = path.join(RUN, 'design.txt'); write(design, 'замысел');
const root = path.join(RUN, 'repo'); fs.mkdirSync(root);
g.git(root, ['init', '-b', 'main']); g.git(root, ['config', 'user.name', 'Тест']); g.git(root, ['config', 'user.email', 'test@example.invalid']);
write(path.join(root, '.gitignore'), '.work/\nworks/\nlive/\n'); write(path.join(root, 'base.txt'), 'база');
g.git(root, ['add', '-A']); g.git(root, ['commit', '-m', 'База теста']);
const t = new Team(root, path.join(RUN, 'team'));
let c, clone;
function job(who, task, result = 'ПРИНЯТО', id = crypto.randomUUID()) {
  const dir = who === 'codex' ? process.env.MOST_CODEX_JOBS_DIR : path.join(process.env.MOST_STATE_DIR, 'jobs', id);
  const file = path.join(dir, who === 'codex' ? id + '.txt' : 'result.txt'); write(file, result);
  json(path.join(dir, who === 'codex' ? id + '.json' : 'card.json'), {id, status:'done', write:false, task, mode:'review', resultFile:file});
  if (who !== 'codex') json(path.join(dir, 'meta.json'), {hash:sha(result)});
  return id;
}
async function vote(who, result = 'ПРИНЯТО') {
  c = read(t.changeFile('one'));
  return t.change({ action:'design', name:'one', who, decision:result === 'ПРИНЯТО' ? result : 'НЕ ПРИНЯТО', job_id:job(who, c.requestMark + ' ' + c.designHash, result) });
}
test('A1: отказ без запроса до создания рабочей копии', async () => {
  await assert.rejects(t.change({action:'start',name:'missing'}), /запрос пользователя/);
  assert(!fs.existsSync(path.join(root,'.work/missing')));
});
test('A1: запрос, метка, хеш и абсолютный замысел', async () => {
  const out = await t.change({action:'start',name:'one',request,design_file:design});
  c = read(t.changeFile('one')); clone = t.clone('one');
  assert.equal(c.requestMark, '#' + sha(request).slice(0,8)); assert.equal(c.designHash,sha('замысел')); assert(out.includes(c.designHash));
  g.git(clone,['config','user.name','Тест']); g.git(clone,['config','user.email','test@example.invalid']);
});
test('A3: commit без ворот отвергнут и индекс не меняется', async () => {
  write(path.join(clone,'base.txt'),'кандидат');
  await assert.rejects(t.change({action:'commit',name:'one',message:'Кандидат'}), /Сначала ворота замысла/);
  assert.equal(g.git(clone,['diff','--cached']), '');
});
test('A2: ревью требует метку, хеш и точную последнюю строку', async () => {
  for (const [task,result] of [[c.designHash,'ПРИНЯТО'], [c.requestMark,'ПРИНЯТО'], [c.requestMark+' '+c.designHash,'НЕ ПРИНЯТО: 0 блокирующих']])
    await assert.rejects(t.change({action:'design',name:'one',who:'codex',decision:'ПРИНЯТО',job_id:job('codex',task,result)}));
  await vote('codex'); await vote('antigravity');
});
test('A2: смена файла аннулирует принятия даже при commit', async () => {
  write(design, 'новый замысел');
  await assert.rejects(t.change({action:'commit',name:'one',message:'Кандидат'}), /Сначала ворота/);
  assert.equal(read(t.changeFile('one')).designVotes.length,0);
});
test('A2: Claude заменяет голос только после двух разных отрицательных ревью', async () => {
  const args = {action:'design',name:'one',who:'claude',decision:'ПРИНЯТО',replaces:'codex',note:'Два замечания проверены по фактам'};
  await assert.rejects(t.change(args), /двух отрицательных/);
  await vote('codex','НЕ ПРИНЯТО: 1 блокирующих');
  c = read(t.changeFile('one'));
  await assert.rejects(t.change({action:'design',name:'one',who:'codex',decision:'НЕ ПРИНЯТО',job_id:c.designVotes[0].job_id}), /уже записано/);
  await assert.rejects(t.change(args), /двух отрицательных/);
  await vote('codex','НЕ ПРИНЯТО: 2 блокирующих'); await t.change(args); await vote('antigravity');
  await t.change({action:'commit',name:'one',message:'Кандидат'}); c = read(t.changeFile('one'));
});
test('A4: запрос — первый блок diff', async () => assert((await t.change({action:'diff',name:'one'})).startsWith('Запрос пользователя '+c.requestMark)));
test('A5–A6: метка ревью и системное замечание', async () => {
  const a = {action:'verdict',name:'one',who:'codex',base:c.base,candidate:c.candidate,decision:'ПРИНЯТО'};
  await assert.rejects(t.change({...a,job_id:job('codex',c.base+' '+c.candidate)}), /метки запроса/);
  await t.change({...a,job_id:job('codex',c.requestMark+' '+c.base+' '+c.candidate,'[улучшение] [системное] Проверка\nПРИНЯТО')});
  await t.change({...a,who:'antigravity',job_id:job('antigravity',c.requestMark+' '+c.base+' '+c.candidate,'[системное] Второе замечание\nПРИНЯТО')});
  assert.equal(read(t.changeFile('one')).systemic.length,2);
  await assert.rejects(t.change({action:'merge',name:'one'}), /системные замечания/);
});
test('A7: старая карточка без запроса фиксируется без ворот', async () => {
  const old = read(t.changeFile('one')); delete old.request; delete old.requestMark; json(t.changeFile('one'),old);
  write(path.join(clone,'legacy.txt'),'старое'); await t.change({action:'commit',name:'one',message:'Старое изменение'});
  assert.match(await t.change({action:'diff',name:'one'}), /запрос не сохранён/);
});
test('A6: системное замечание закрывается кодом с уроком либо ссылкой Claude на существующий урок', async () => {
  const card=()=>read(t.changeFile('one'));
  async function verdict(who,note) {const c=card();return t.change({action:'verdict',name:'one',who,base:c.base,candidate:c.candidate,decision:'ПРИНЯТО',note,job_id:who==='claude'?undefined:job(who,c.base+' '+c.candidate)});}
  await verdict('claude','системное — открыто в уроке 7');
  await assert.rejects(t.change({action:'merge',name:'one'}),/системные замечания/);
  write(path.join(clone,'lessons.md'),'## 7. Проверка\n');await t.change({action:'commit',name:'one',message:'Урок'});
  await verdict('claude','системное — открыто в уроке 7');
  await assert.rejects(t.change({action:'merge',name:'one'}),/Нет действующего принятия: codex/);
  await verdict('claude');
  write(path.join(clone,'lessons.md'),'## 7. Проверка\nГде закрыто: код\nПроверка: тест\n');
  write(path.join(clone,'common/check.js'),'// исправление');await t.change({action:'commit',name:'one',message:'Закрыто системное замечание'});
  await assert.rejects(t.change({action:'merge',name:'one'}), e => card().systemic.every(v => e.message.includes(v.job_id)));
  const ids=card().systemic.map(v=>v.job_id.slice(0,8));
  fs.appendFileSync(path.join(clone,'lessons.md'),ids[0]+'\n');await t.change({action:'commit',name:'one',message:'Первое замечание'});
  await assert.rejects(t.change({action:'merge',name:'one'}),e=>e.message.includes(card().systemic[1].job_id) && !e.message.includes(card().systemic[0].job_id));
  fs.appendFileSync(path.join(clone,'lessons.md'),ids[1]+'\n');await t.change({action:'commit',name:'one',message:'Оба замечания'});
  for(const who of ['claude','codex','antigravity'])await verdict(who);
  require('./grok-fixture').accepted(t, 'one');
  assert.match(await t.change({action:'merge',name:'one'}),/Слито в main/);
});
test('B1: все limitId и окна; отсутствие пятичасового окна объяснено', () => {
  const reset = Math.floor(Date.now()/1000)+36000;
  const data = q.limitsSnapshot({rateLimits:{limitId:'codex',planType:'prolite',primary:{windowDurationMins:10080,usedPercent:27,resetsAt:reset}},rateLimitsByLimitId:{extra:{primary:{windowDurationMins:300,usedPercent:10,resetsAt:reset},secondary:{windowDurationMins:60,usedPercent:5,resetsAt:reset}}}});
  assert.equal(data.all.length,3); const out=q.quotaText(data); assert.match(out,/secondary отсутствует/); assert.match(out,/использовано 27 %/); assert.match(out,/60 мин/);
});
const agyData = {userStatus:{email:'test@example.invalid',cascadeModelConfigData:{clientModelConfigs:[{label:'Gemini 3.1 Pro (High)',quotaInfo:{remainingFraction:.95,resetTime:'2027-01-01T00:00:00Z'}},{label:'Gemini 3.8 Flash (Medium)',quotaInfo:{remainingFraction:.95,resetTime:'2027-01-01T00:00:00Z'}},{label:'Другая модель',quotaInfo:{remainingFraction:.95,resetTime:'2027-01-01T00:00:00Z'}}]}}};
test('B2: группировка моделей, аккаунт, отсутствие личных данных', () => {
  const out=aq.parseQuota(agyData,'other@example.invalid'); assert.match(out,/не совпадает/); assert.match(out,/и ещё 1/); assert.match(out,/осталось 95 %/); assert(!out.includes('@'));
  assert.match(aq.parseQuota(agyData,'test@example.invalid'),/аккаунт agy совпадает/);
  assert.equal(aq.parseQuota({csrf_token:'SECRET'}),'формат ответа изменился');
});
test('B2: подмена и закрытое приложение', async () => {
  process.env.MOST_AGY_QUOTA_FILE=path.join(RUN,'quota.json');json(process.env.MOST_AGY_QUOTA_FILE,{closed:true}); assert.match(await aq.collect(),/приложение Antigravity закрыто/);
  json(process.env.MOST_AGY_QUOTA_FILE,agyData); assert.match(await aq.collect(),/осталось 95 %/);
});
test('B2: местный запрос передаёт токен только в заголовке; последний аккаунт и кэш',async()=>{
  const cp=require('child_process'),http=require('http'),{EventEmitter}=require('events');const oldExec=cp.execFile,oldRequest=http.request,oldFile=process.env.MOST_AGY_QUOTA_FILE;
  const log=path.join(RUN,'agy-log');fs.mkdirSync(log);process.env.MOST_AGY_LOG_DIR=log;write(path.join(log,'cli-test.log'),'applyAuthResult: email=wrong@example.invalid\napplyAuthResult: email=test@example.invalid\n');
  let calls=0;delete process.env.MOST_AGY_QUOTA_FILE;
  cp.execFile=(bin,args,opts,cb)=>{calls++;assert.equal(bin,'powershell.exe');assert(opts.timeout<=8000);cb(null,args.at(-1).includes('Get-CimInstance')?JSON.stringify([{ProcessId:123,Name:'language_server.exe',CommandLine:'--csrf_token SECRET'}]):'12345');};
  http.request=(opts,cb)=>{
    assert.equal(opts.hostname,'127.0.0.1');assert.equal(opts.headers['X-Codeium-Csrf-Token'],'SECRET');assert.equal(opts.headers['Connect-Protocol-Version'],'1');
    const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{assert.equal(JSON.parse(body).metadata.locale,'ru');queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.setEncoding=()=>{};cb(res);res.emit('data',JSON.stringify(agyData));res.emit('end');});};return req;
  };
  try {
    const text=await aq.agyQuota();assert.match(text,/аккаунт agy совпадает/);assert(!text.includes('SECRET'));assert(!text.includes('@'));
    const count=calls;assert.equal(await aq.agyQuota(),text);assert.equal(calls,count);
  } finally {cp.execFile=oldExec;http.request=oldRequest;process.env.MOST_AGY_QUOTA_FILE=oldFile;}
});
test('B3–B4: замер Claude и единая строка', async () => {
  const out=await t.status(undefined,{calls:341,written:200000,reread:107200000,window_h:5,taken_at:new Date().toISOString(),source:'проверка'});
  assert.match(out,/замер сеанса \(не процент лимита\)/); assert.match(out,/Claude перегружен/); assert.equal((out.match(/Квоты:/g)||[]).length,1); assert(!out.includes('Квота Codex:'));
});
test('C1: краткая памятка по умолчанию и оглавление',()=>assert.match(t.rules(),/Памятка не найдена. Части: brief/));
test('D1–D2: уведомления в файл и журнал',async()=>{
  const title='Текст " $() <xml> &'; const out=await require('../common/notify').notify(title,'сообщение'); assert.equal(out,'передано системе');
  assert(fs.readFileSync(path.join(RUN,'notifications.jsonl'),'utf8').includes('сообщение'));
  assert(fs.readFileSync(path.join(process.env.MOST_STATE_DIR,'notify.log'),'utf8').includes('передано системе'));
  assert.match(await t.status(undefined,undefined,true),/Пробное уведомление: передано системе/);
});
test('D3: первое принятие этапа уведомляет один раз',async()=>{
  const stages=[{title:'Этап',weight:100,accept_criteria:'Проверка',closes:'Пункт 2 запроса',state:'план'}];
  await t.work({owner: 'test-owner', action: 'create',name:'work',expected_revision:0,goal:'Цель',done_criteria:'Итог',next_step:'Готово',stages});
  stages[0]={...stages[0],state:'принят',evidence:'Проверено',version:'1'};
  const accepted=await t.work({owner: 'test-owner', action: 'update',name:'work',expected_revision:1,stages});
  assert.match(accepted,/сделано: Проверено · это закрывает: Пункт 2 запроса · дальше: Готово/);
  assert.match(fs.readFileSync(path.join(RUN,'notifications.jsonl'),'utf8'),/это закрывает: Пункт 2 запроса/);
  const before=fs.readFileSync(path.join(RUN,'notifications.jsonl'),'utf8');
  await t.work({owner: 'test-owner', action: 'update',name:'work',expected_revision:2,next_step:'Завершено'});
  assert.equal(fs.readFileSync(path.join(RUN,'notifications.jsonl'),'utf8'),before);
});
test('D4–D5: долгий запуск один раз; квота с известным сбросом не исчерпывает пробы',async()=>{
  const j={id:'long',status:'running',startedAt:new Date(Date.now()-700000).toISOString()};
  const mutate=async(id,fn)=>fn(j); await require('../common/progress').longRunning('Codex',[j],mutate);
  const before=fs.readFileSync(path.join(RUN,'notifications.jsonl'),'utf8'); await require('../common/progress').longRunning('Codex',[j],mutate); assert.equal(fs.readFileSync(path.join(RUN,'notifications.jsonl'),'utf8'),before);
  const failure={kind:'quota',resetsAt:new Date(Date.now()+100000).toISOString(),message:'Квота'};
  assert.equal(q.retryPlan({quotaAttempts:12},failure).status,'waiting_quota'); assert.equal(q.retryPlan({quotaAttempts:12},{kind:'quota'}).status,'failed'); assert.equal(q.retryPlan({write:true},failure).status,'needs_decision');
});
test('D5: уведомления об ожидании, продолжении, отказе и решении',async()=>{
  const n=require('../common/notify');const waiting={id:'quota',status:'waiting_quota',nextAttemptAt:'завтра',work:'work'};
  n.transition('Codex',{status:'running'},waiting);n.transition('Codex',waiting,{...waiting,status:'running'});
  n.transition('Antigravity',{status:'running'},{id:'failed',status:'failed',error:'исчерпаны пробы'});
  n.transition('Codex',{status:'running'},{id:'write',status:'needs_decision',retryKind:'quota'});
  const out=fs.readFileSync(path.join(RUN,'notifications.jsonl'),'utf8');for(const text of ['Codex ждёт квоту','Codex продолжил поручение quota','Решение за Claude','с записью остановлено'])assert(out.includes(text));
});
test('E1: ограничения до исполнения',async()=>{
  process.env.MOST_CLIENT='codex';
  assert.throws(()=>require('../common/access').guard('team','team_status',{notify_test:true}),/Гостю/);
  await assert.rejects(t.change({action:'start',name:'guest',request,design_file:design}),/Гостю/);
  await assert.rejects(t.work({owner: 'test-owner', action: 'create',name:'guest'}),/Гостю/);
  assert(!fs.existsSync(path.join(root,'.work/guest'))); delete process.env.MOST_CLIENT;
});
test('E1: гостевые списки инструментов, очередь и основной исполнитель обоих мостов',async()=>{
  const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
  for (const who of ['codex','antigravity']) {
    const state=path.join(RUN,'queue-'+who), folder=path.join(RUN,'project-'+who);fs.mkdirSync(folder);
    const env={...process.env,MOST_REPO_ROOT:root,MOST_STATE_DIR:state,MOST_CODEX_JOBS_DIR:path.join(state,'codex-jobs'),MOST_JOURNAL:path.join(state,'agy.log'),MOST_INPUT_DIR:path.join(state,'input'),AGY_PATH:path.join(__dirname,'fake-agy.js'),MOST_TEST_KEEP:'1',MOST_QUEUE_TICK_MS:'50'};
    const clients=[];
    async function connect(server,client) {
      const transport=new StdioClientTransport({command:process.execPath,args:[path.join(__dirname,'../servers',server,'index.js')],env:{...env,MOST_CLIENT:client},stderr:'pipe'});
      const c=new Client({name:'test',version:'1'});await c.connect(transport);clients.push(c);return c;
    }
    try {
      const guest=await connect(who,who==='codex'?'antigravity':'codex');
      const listed=(await guest.listTools()).tools.map(t=>t.name);assert.deepEqual(listed.sort(),[who+'_send',who+'_status',who+'_result'].sort());
      const forbidden=await guest.callTool({name:who+'_cancel',arguments:{id:'none'}});assert(forbidden.isError);
      if(who==='codex')assert((await guest.callTool({name:'codex_send',arguments:{folder,task:'Проверка',write:true}})).isError);
      const out=await guest.callTool({name:who+'_send',arguments:{folder,task:'[[FAKE:accept]] Проверка',stage:'Этап',work:'work',owner:'test-owner',...(who==='antigravity'?{mode:'text'}:{write:'false'})}});
      assert(!out.isError,JSON.stringify(out));const text=out.content[0].text;assert.match(text,/В ОЧЕРЕДИ/);assert.match(text,/выполнит основной сервер/);assert.match(text,/Принято 100 %/);
      const id=text.match(/Номер поручения: (\S+)/)[1];
      write(path.join(folder,'_antigravity_result.txt'),'ЧУЖОЙ ЧЕРНОВИК');
      const file=who==='codex'?path.join(state,'codex-jobs',id+'.json'):path.join(state,'jobs',id,'card.json');
      await new Promise(r=>setTimeout(r,150));assert.equal(read(file).status,'queued');assert(!fs.existsSync(path.join(state,'ready',who+'.json')));
      const queued=await guest.callTool({name:who+'_result',arguments:{id,wait_sec:'0',from_char:'0'}});assert.match(queued.content[0].text,/выполнит основной сервер/);assert(!queued.content[0].text.includes('undefined'));
      const main=await connect(who,'claude');
      const until=Date.now()+12000;while(read(file).status!=='done'&&Date.now()<until)await new Promise(r=>setTimeout(r,100));assert.equal(read(file).status,'done');
      assert.equal(fs.readFileSync(path.join(folder,'_antigravity_result.txt'),'utf8'),'ЧУЖОЙ ЧЕРНОВИК');
      assert.deepEqual(fs.readdirSync(folder),['_antigravity_result.txt']);
      if(who==='antigravity') {
        const denied=await main.callTool({name:'antigravity_apply',arguments:{id,to:path.join(folder,'new.txt')}});
        assert(denied.isError);assert.match(denied.content[0].text,/Перенос гостевого поручения запрещён/);assert(!fs.existsSync(path.join(folder,'new.txt')));
      }
      assert.equal(read(path.join(state,'ready',who+'.json')).release,path.resolve(__dirname,'..'));
      const result=await guest.callTool({name:who+'_result',arguments:{id}});assert.match(result.content[0].text,/Принято 100 %/);
      const team=await connect('team','codex');const teamTools=(await team.listTools()).tools;assert.deepEqual(teamTools.map(t=>t.name).sort(),['team_rules','team_status','team_work']);
      assert(teamTools.find(t=>t.name==='team_work').inputSchema.properties.stages.items.properties.closes);
      assert((await team.callTool({name:'team_status',arguments:{notify_test:true}})).isError);
      assert((await team.callTool({name:'team_work',arguments:{owner: 'test-owner', action: 'create',name:'no'}})).isError);
    } finally {for(const c of clients.reverse())await c.close();}
  }
});
test('E2: допустимые MCP-вызовы и запреты',()=>{
  const a=require('../common/agy-tools'); assert(a.allowed({name:'call_mcp_tool',args:{tool_name:'team_status'}})); assert(a.allowed({name:'mcp__team__team_work',args:{owner: 'test-owner', action: 'get'}}));
  assert(!a.allowed({name:'mcp__team__team_work',args:{owner: 'test-owner', action: 'update'}})); assert(a.forbidden([{name:'run_command'}])); assert(a.forbidden([{name:'invoke_subagent'}]));
});
test('E3: TOML сохраняет посторонние байты, повтор и конфликты',()=>{
  const text='\uFEFF# чужой текст\r\nmodel = "value"\r\n'; const first=cc.toml(text,root,root,RUN,process.execPath);
  assert(first.startsWith(text)); assert.equal(cc.toml(first,root,root,RUN,process.execPath),first);
  assert.throws(()=>cc.toml(first+'# most:end\n',root,root,RUN,'node'),/метки/);
  assert.throws(()=>cc.toml('[mcp_servers.team]\n',root,root,RUN,'node'),/вне служебного/);
});
test('E3: JSON, резервная копия, откат, компенсация',async()=>{
  const file=path.join(RUN,'mcp.json');process.env.MOST_AGY_MCP_CONFIG=file;json(file,{foreign:{secret:'KEEP'},mcpServers:{other:{command:'keep'}}});
  const s={...d.snapshot(file),kind:'agy'}, plans=cc.plans([s],root,root,RUN,process.execPath);
  await d.switchConfigs(plans); assert.equal(read(file).foreign.secret,'KEEP');assert.equal(read(file).mcpServers.team.env.MOST_CLIENT,'antigravity'); assert(!read(file).mcpServers.antigravity);
  await d.rollback({root,configs:[file]}); assert.deepEqual(read(file),s.config);
  const a=path.join(RUN,'a.json'),b=path.join(RUN,'b.json');json(a,{});json(b,{});
  await assert.rejects(d.switchConfigs([a,b].map(file=>({...d.snapshot(file),next:'{"x":1}',backup:true})),async label=>{if(label==='config2')throw Error('сбой')}));assert.deepEqual(read(a),{});
});
test('E3–E4: deploy обновляет три приложения; повтор и откат всех файлов',async()=>{
  const saved={};for(const k of ['MOST_CODEX_CONFIG','MOST_AGY_MCP_CONFIG','MOST_AGY_CONFIG','MOST_CLAUDE_CONFIGS'])saved[k]=process.env[k];
  const dir=path.join(RUN,'deploy'); fs.mkdirSync(dir);
  const codex=path.join(dir,'config.toml'),agy=path.join(dir,'mcp.json'),permissions=path.join(dir,'permissions.json'),claude=path.join(dir,'claude.json');
  process.env.MOST_CODEX_CONFIG=codex;process.env.MOST_AGY_MCP_CONFIG=agy;process.env.MOST_AGY_CONFIG=permissions;process.env.MOST_CLAUDE_CONFIGS=JSON.stringify([claude]);
  write(codex,'# чужие байты\r\nmodel = "keep"\r\n');json(agy,{foreign:123});json(permissions,{userSettings:{globalPermissionGrants:{allow:['keep']}}});json(claude,{foreign:456});
  const before=[codex,agy,permissions,claude].map(f=>fs.readFileSync(f,'utf8')), calls=[];
  const deps={archive:async(root,commit,temp)=>{for(const n of ['team','codex','antigravity','grok'])write(path.join(temp,'servers',n,'index.js'),'// подделка');},install:async()=>{},probe:async(file,env)=>{calls.push(env.MOST_CLIENT);return {tools:(env.MOST_CLIENT==='claude'?[]:path.basename(path.dirname(file))==='team'?['team_status','team_rules','team_work']:['status','send','result'].map(n=>path.basename(path.dirname(file))+'_'+n)).map(name=>({name}))};}};
  try {
    await d.deploy({root,stateDir:path.join(RUN,'deploy-state')},deps);assert.equal(calls.length,10);
    const after=[codex,agy,permissions,claude].map(f=>fs.readFileSync(f,'utf8'));assert(after[0].startsWith(before[0]));
    assert.equal(read(agy).foreign,123);assert.equal(read(claude).foreign,456);assert.equal(read(claude).mcpServers.team.env.MOST_STATE_DIR,read(agy).mcpServers.team.env.MOST_STATE_DIR);
    assert.equal(read(claude).mcpServers.team.env.MOST_STATE_DIR,path.join(root,'state'));
    let restarted=false;
    const restartDeps={...deps,restart:{launch:async(file,{log,runId})=>{restarted=true;assert(read(claude).mcpServers.team);write(log,'запущен '+runId+'\n');}}};
    assert.match(await d.deploy({root,stateDir:path.join(RUN,'deploy-state'),restartClaude:true},restartDeps),/Перезапуск Claude запланирован/);assert(restarted);
    [codex,agy,permissions,claude].forEach((f,i)=>assert.equal(fs.readFileSync(f+'.prev','utf8'),before[i]));
    assert.match(await d.rollback({root}),/возвращён/);assert.equal(fs.readFileSync(codex,'utf8'),before[0]);assert.equal(read(agy).foreign,123);assert(!read(agy).mcpServers.team);assert.deepEqual(read(permissions).userSettings.globalPermissionGrants.allow,['keep']);
    write(codex,'# most:begin повреждено\n');const current=fs.readFileSync(claude,'utf8');restarted=false;await assert.rejects(d.deploy({root,restartClaude:true},restartDeps),/метки/);assert(!restarted);assert.equal(fs.readFileSync(claude,'utf8'),current);
  } finally {for(const [k,v] of Object.entries(saved))v===undefined?delete process.env[k]:process.env[k]=v;}
});
test('F1–F3: готовность, сценарий всех серверов и подтверждение запуска',async()=>{
  require('../common/access').ready('team'); assert.equal(read(path.join(process.env.MOST_STATE_DIR,'ready/team.json')).pid,process.pid);
  const restart=require('../common/restart'); const text=restart.script({runId:'test',log:'log',release:root,state:RUN});
  for(const part of ["@('team', 'codex', 'antigravity', 'grok')",'startedAt','AddSeconds(300)','CloseMainWindow','Start-Sleep -Seconds 8','if (-not (Get-Process']) assert(text.includes(part));
  const out=await restart.restart({root,release:root,state:RUN},{launch:async(file,{log,runId})=>write(log,'запущен '+runId+'\n')});assert.match(out,/Перезапуск Claude запланирован/);
  await assert.rejects(restart.restart({root,release:root,state:RUN},{waitMs:30,launch:async(file,{log})=>write(log,'запущен старый-запуск\n')}),/не подтверждён/);
  assert.match(restart.launchCommand('C:\\x.ps1'),/-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\x\.ps1"/);
  process.env.MOST_CLIENT='codex';require('../common/access').ready('guest');assert(!fs.existsSync(path.join(process.env.MOST_STATE_DIR,'ready/guest.json')));delete process.env.MOST_CLIENT;
  process.env.MOST_PROBE_ONLY='1';require('../common/access').ready('probe');assert(!fs.existsSync(path.join(process.env.MOST_STATE_DIR,'ready/probe.json')));delete process.env.MOST_PROBE_ONLY;
  assert.match(require('../common/format').format('Команда',{status:'done'}),/^Команда · сводка ·/);
});
(async()=>{for(const {name,fn} of tests){try{await fn();passed++;console.log('✓ '+name);}catch(e){failed++;console.error('ПРОВАЛ '+name+'\n'+e.stack);}}console.log(`Итого: пройдено ${passed}, провалено ${failed}`);process.exitCode=failed?1:0;})().catch(e=>{console.error(e);process.exitCode=1;});
