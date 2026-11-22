'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), cp = require('child_process'), vm = require('vm');
const f = require('./fixtures/team-v43/fixture');
const KEEP = process.env.MOST_TEST_KEEP;
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'team-v43-'));
Object.assign(process.env, f.env(RUN));
const boot = require('../tools/deploy-bootstrap'), runner = require('./runner-support');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const tests = [], test = (name, fn) => tests.push([name, fn]);
// Публичная копия без истории: закреплённый коммит base (cc88996c…) отсутствует — проверки старого релиза
// (old: true, git archive base) строить из рабочего дерева нельзя, их пропускаем (замысел team-v47, разд. 13.3).
const SKIP = Symbol('skip');
const hasBase = (() => { try { cp.execFileSync('git', ['-C', f.source, 'cat-file', '-e', f.base + '^{commit}'], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; } })();
const skipOld = () => { if (!hasBase) throw Object.assign(Error('публичная копия без истории: коммит ' + f.base + ' отсутствует'), { [SKIP]: true }); };
const root = path.join(RUN, 'корень & (тест) с пробелом'), other = path.join(RUN, 'other');
fs.mkdirSync(root); fs.mkdirSync(other);
// Состав нового релиза после forward-миграции team-v46 (claude — устанавливаемый сервер).
const servers = ['team', 'claude', 'codex', 'antigravity', 'deepseek', 'kimi'];
// Старый релиз (коммит base) собран кодом до claude-сервера: его проверяет старый deploy, у которого claude не адаптер.
const oldServers = ['team', 'codex', 'antigravity', 'deepseek'];
let current, old;
function historicalState(root) {
  // Отдельная история создаётся самим старым кодом; текущий журнал никогда не обрезается.
  const store = require(path.join(old, 'common/members-store.js')).create(path.join(root, 'state'));
  store.update(store.read().rev, n => { Object.assign(n.members.find(m => m.id === 'deepseek').roles, { receives: true, sends: true, writer: true, voter: true }); },
    { action: 'activate', who: 'claude', reason: 'Историческая фикстура до Kimi', quote: 'Проверка' }, { phase: 'B' });
  assert(!store.history().some(e => e.after.members.some(m => m.adapter === 'kimi-cli')));
}
const ok = result => assert.equal(result.status, 0, result.stderr + result.stdout);
const snapshot = files => files.map(file => [fs.readFileSync(file).toString('hex'), fs.statSync(file).mtimeMs]);
test('Подготовка: локальные пакеты и архив базы, фаза B из собственного корня', () => {
  f.phaseB(root);
  current = f.release(root, 'b'.repeat(40), { servers });
  old = hasBase ? f.release(root, f.base, { old: true, servers: oldServers }) : null;
  assert.equal(read(path.join(root, 'state/members.json')).phase, 'B');
  assert.equal(typeof require(path.join(current, 'node_modules/yaml')).parseDocument, 'function');
});
test('Импорт CLI не читает argv, env и yaml; parseArgs использует переданные args', () => {
  const code = `const assert=require('assert'); const before={...process.env}; process.argv=['node','x','--bad'];
    const cli=require(${JSON.stringify(path.join(f.source, 'tools/deploy.js'))}); assert.deepEqual({...process.env},before);
    assert(!Object.keys(require.cache).some(p=>p.endsWith('common/deploy.js')||p.endsWith('common\\\\deploy.js')));
    assert.equal(cli.parseArgs(['--root','x','--release-only']).options.root,'x');`;
  ok(cp.spawnSync(process.execPath, ['-e', code], { env: f.env(other), encoding: 'utf8' }));
});
test('Сборка и полный цикл: папка кода вместо cwd, без преждевременной метки', () => {
  const code = `const assert=require('assert');delete process.env.MOST_REPO_ROOT;delete process.env.MOST_STATE_DIR;
    const cli=require(${JSON.stringify(path.join(f.source, 'tools/deploy.js'))});
    (async()=>{ for(const args of [['--release-only'],[]]) {delete process.env.MOST_REPO_ROOT;
      await cli.main(args,{deploy:async o=>{assert.equal(o.root,${JSON.stringify(f.source)});assert.equal(!!o.external,!args.length);return 'ok'},print(){}});}})().catch(e=>{console.error(e);process.exitCode=1});`;
  ok(cp.spawnSync(process.execPath, ['-e', code], { cwd: other, env: f.env(other), encoding: 'utf8' }));
});
test('Ручной CLI: root из args/env; источник дерева и неизвестный root отклоняются', () => {
  const config = path.join(root, 'manual.json'); f.json(config, { foreign: true });
  const args = ['--config-only', '--release', current, '--config', config, '--dry-run'];
  const env = f.env(root);
  ok(f.cli(current, args, env, other));
  delete env.MOST_REPO_ROOT; ok(f.cli(current, ['--root', root, ...args], env, other));
  const before = snapshot([config]);
  assert.notEqual(f.cli(current, args, env, other).status, 0);
  assert.match(f.cli(f.source, ['--root', root, ...args], env, other).stderr, /CLI готового релиза/);
  assert.deepEqual(snapshot([config]), before);
});
test('MOST_STATE_DIR отклоняется до common и записи во всех режимах изменения', () => {
  const config = path.join(root, 'manual.json');
  const before = snapshot([config, path.join(root, 'state/members.json')]);
  const otherBefore = fs.readdirSync(other);
  for (const args of [[], ['--rollback'], ['--config-only','--rollback'], ['--clients-only','--rollback'],
    ['--config-only','--release',current,'--config',config], ['--clients-only','--release',current]]) {
    const run = f.cli(current, ['--root',root,...args], { ...f.env(root), MOST_STATE_DIR: other });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /MOST_STATE_DIR/);
  }
  assert.deepEqual(snapshot([config, path.join(root, 'state/members.json')]), before);
  assert.deepEqual(fs.readdirSync(other), otherBefore);
  assert.doesNotThrow(() => boot.stateRoot(root, { MOST_STATE_DIR: path.join(root, 'state') }));
  assert.doesNotThrow(() => boot.stateRoot(other, { MOST_STATE_DIR: path.join(other, 'state') }));
});
test('Метку чужого корня отклоняет prepare до повторной пробы', async () => {
  const r = f.release(RUN, 'c'.repeat(40));
  const marker = path.join(r, 'probe-ok.json'), config = path.join(RUN, 'prepare.json'); f.json(config, {});
  f.json(marker, { ...read(marker), root: other, servers: [] });
  const before = snapshot([marker, config]);
  await assert.rejects(require('../common/deploy').configure({ root: RUN, release: r, configs: [config] },
    { probe: () => assert.fail('повторная проба недопустима') }), /другому корню/);
  assert.deepEqual(snapshot([marker, config]), before);
});
test('Result: действующий файл и алиас допустимы; чужие поля/статусы и структура запрещены', () => {
  skipOld();
  const file = f.operation(root, current), cli = path.join(current, 'tools/deploy.js'), original = read(file);
  assert.equal(boot.resultContext({result:file,release:current},cli).root, fs.realpathSync.native(root));
  const alias = path.join(RUN,'alias'); fs.symlinkSync(root, alias, 'junction');
  assert.equal(boot.resultContext({result:path.join(alias,'state/deploy-ops/install.json'),release:current,root:alias},cli).file, file);
  if (process.platform === 'win32') assert.equal(boot.resultContext({result:file.toUpperCase(),release:current.toUpperCase()},cli.toUpperCase()).root.toLowerCase(),root.toLowerCase());
  for (const patch of [{id:'other'}, {id:'../install'}, {root:other}, {release:old}, {status:'завершено'}, {status:'проба'}]) {
    f.json(file, {...original,...patch}); const before = snapshot([file]);
    assert.throws(()=>boot.resultContext({result:file,release:current,root},cli)); assert.deepEqual(snapshot([file]),before);
  }
  f.json(file,original);
  assert.throws(()=>boot.resultContext({result:file,release:old},cli));
  assert.throws(()=>boot.resultContext({result:file},cli),/требует --release/);
  assert.throws(()=>boot.resultContext({result:file,release:current,root:other},cli));
  assert.throws(()=>boot.resultContext({result:file,release:current},path.join(f.source,'tools/deploy.js')));
  const outside = path.join(other,'install.json'); f.json(outside,original);
  assert.throws(()=>boot.resultContext({result:outside,release:current},cli));
  const marker = path.join(current,'probe-ok.json'), value=read(marker); f.json(marker,{...value,root:other});
  assert.throws(()=>boot.resultContext({result:file,release:current},cli)); f.json(marker,value);
});
test('Result: повторная проверка перед execute оставляет завершённую операцию без изменений', async () => {
  const file=f.operation(root,current,'race'), options={root,release:current,result:file};
  boot.resultContext(options,path.join(current,'tools/deploy.js'));
  f.json(file,{...read(file),status:'завершено'}); const before=snapshot([file]);
  await assert.rejects(require('../common/deploy-ops').execute(options,()=>assert.fail('action'),
    {validateResult:()=>boot.resultContext(options,path.join(current,'tools/deploy.js'))}));
  assert.deepEqual(snapshot([file]),before); assert(!fs.existsSync(file+'.pid'));
});
test('CLI ранний отказ не перезаписывает result, метку, реестр или конфиги', () => {
  const result=f.operation(root,current,'rejected'), config=path.join(root,'rejected.json');f.json(config,{});
  f.json(result,{...read(result),status:'завершено'});
  const files=[result,config,path.join(current,'probe-ok.json'),path.join(root,'state/members.json')],before=snapshot(files);
  const env=f.env(root);delete env.MOST_REPO_ROOT;delete env.MOST_STATE_DIR;
  const run=f.cli(current,['--config-only','--release',current,'--config',config,'--result',result],env,other);
  assert.notEqual(run.status,0);assert.match(run.stderr,/принадлежность или статус/);
  assert.deepEqual(snapshot(files),before);assert(!fs.existsSync(result+'.pid'));assert(!fs.existsSync(config+'.prev'));
});
test('Локальный yaml: родитель, наружная ссылка и похожий префикс не годятся', () => {
  const parent=path.join(RUN,'dependencies');fs.mkdirSync(parent);
  fs.cpSync(path.join(f.source,'node_modules/yaml'),path.join(parent,'node_modules/yaml'),{recursive:true});
  for(const kind of ['missing','parent','outside','prefix','correct']) {
    const dir=path.join(parent,kind); f.write(path.join(dir,'tools/deploy.js'),'');
    if(kind==='outside')fs.symlinkSync(path.join(parent,'node_modules'),path.join(dir,'node_modules'),'junction');
    if(kind==='prefix') {fs.mkdirSync(path.join(dir,'node_modules'));fs.cpSync(path.join(parent,'node_modules/yaml'),path.join(dir,'node_modules-extra/yaml'),{recursive:true});fs.symlinkSync(path.join(dir,'node_modules-extra/yaml'),path.join(dir,'node_modules/yaml'),'junction');}
    if(kind==='correct')fs.cpSync(path.join(parent,'node_modules'),path.join(dir,'node_modules'),{recursive:true});
    if(kind==='correct')assert.doesNotThrow(()=>boot.localYaml(dir,path.join(dir,'tools/deploy.js')));
    else assert.throws(()=>boot.localYaml(dir,path.join(dir,'tools/deploy.js')),/локальная зависимость yaml/);
  }
  assert(!boot.within('C:\\a','D:\\a')); assert(!boot.within(root,root)); assert(!boot.within(root,root+'-extra'));
});
test('Команда cmd: точная передача данных, запрещённые символы, длина и завершающий слеш', () => {
  const ops=require('../common/deploy-ops'), dir=path.join(RUN,'argv');f.write(path.join(dir,'tools/deploy.js'),`console.log(JSON.stringify([process.env.MOST_REPO_ROOT,...process.argv.slice(2)]))`);
  const args=['пробел ы',"апостроф'",'(скобки)&данные','trailing\\'];
  const line=ops.commandLine(dir,args,root);
  const cmd=path.join(process.env.SystemRoot||'C:\\Windows','System32/cmd.exe');
  const command=line.slice(line.indexOf(' /d ')+4); // /v:off /s /c ... после пути и /d
  const result=cp.spawnSync(cmd, ['/d',command], {windowsVerbatimArguments:true,env:f.env(root),encoding:'utf8'});
  ok(result);assert.deepEqual(JSON.parse(result.stdout.trim()),[root,...args]);
  for(const bad of ['%','!','^','"','\n','\r','\0','\x7f']) assert.throws(()=>ops.commandLine(dir,[bad],root));
  assert.throws(()=>ops.commandLine(dir,['x'.repeat(8191)],root),/слишком длинная/);
  assert.throws(()=>ops.commandLine(dir,[],path.parse(root).root),/разделителем/);
});
test('Матрица: старый start → новый CLI, новый → новый; старый CLI после Kimi отвергнут', async () => {
  skipOld();
  for (const [from,originalTo,setRoot] of [[old,current,false],[current,old,true],[current,current,true]]) {
    const preKimi=from===old, refused=originalTo===old, r=preKimi?path.join(RUN,'matrix-pre-kimi'):root;
    if(preKimi)historicalState(r);
    const to=preKimi?f.release(r,'f'.repeat(40),{servers,installed:false}):originalTo;
    if(preKimi)fs.cpSync(path.join(f.source,'servers'),path.join(to,'servers'),{recursive:true});
    const historyBefore=preKimi?fs.readFileSync(path.join(r,'state/members-log.jsonl'),'utf8'):null;
    const config=path.join(r,'matrix-'+path.basename(from).slice(0,2)+'-'+path.basename(to).slice(0,2)+'.json');f.json(config,{});
    const code=`const assert=require('assert'),cp=require('child_process'),fs=require('fs'),path=require('path');
      const ops=require(${JSON.stringify(path.join(from,'common/deploy-ops.js'))});
      ops.start({root:${JSON.stringify(r)},release:${JSON.stringify(to)},configs:[${JSON.stringify(config)}],cleanup:false},{launch:async(release,args,r)=>{
        let env={...process.env};delete env.MOST_REPO_ROOT;delete env.MOST_STATE_DIR;
        ${setRoot ? `const line=require(${JSON.stringify(path.join(f.source,'common/deploy-ops.js'))}).commandLine(release,args,r);const index=line.indexOf(' /d ');const run=cp.spawnSync(line.slice(1,index-1),['/d',line.slice(index+4)],{env,encoding:'utf8',windowsVerbatimArguments:true});` : `assert(!args.includes('--root'));const run=cp.spawnSync(process.execPath,[path.join(release,'tools/deploy.js'),...args],{env,encoding:'utf8'});`}
        ${refused ? `assert.notEqual(run.status,0);throw Error(run.stderr+run.stdout);` : `assert.equal(run.status,0,run.stderr+run.stdout);return process.pid;`}
      }}).then(t=>{${refused ? `assert.fail('Старый CLI не должен принять журнал Kimi')` : `assert.match(t,/завершено/);console.log(t)`}}).catch(e=>{${refused ? `assert.match(e.message,/kimi-cli|Реестр участников/);console.log('Старый CLI отвергнут')` : `console.error(e);process.exitCode=1`}});`;
    ok(cp.spawnSync(process.execPath,['-e',code],{cwd:other,env:f.env(r),encoding:'utf8',timeout:600000}));
    if(preKimi) {
      const state=path.join(r,'state'),store=require('../common/members-store').create(state),reg=store.read();
      assert(fs.readFileSync(store.log,'utf8').startsWith(historyBefore),'исторический журнал сохранён');
      const events=store.history().filter(e=>e.action==='team-v56-kimi');assert.equal(events.length,1);
      assert(!events[0].before.members.some(m=>m.adapter==='kimi-cli'));
      const kimi=reg.members.find(m=>m.adapter==='kimi-cli');assert.equal(kimi.state,'paused');assert.equal(kimi.pause.kind,'manual');
      assert.equal(events[0].after.members.find(m=>m.adapter==='kimi-cli').pause.kind,'manual');
      const op=read(path.join(state,'kimi-migration.json'));assert.equal(op.status,'complete');
      assert.deepEqual(op.steps.map(s=>[s.name,s.status]),[['stop','done'],['migrate','done']]);
      assert(!fs.existsSync(path.join(state,'restart-hold.json')));
      assert.equal(read(path.join(state,'restart-claims',op.id+'.json')).decision,'отмена');
    }
    if(refused)assert.deepEqual(read(config),{});
    else {const servers=read(config).mcpServers;assert(servers.deepseek);assert.equal(servers.team.env.MOST_REPO_ROOT,r);}
  }
  const ops=require('../common/deploy-ops').list(root,{reconcile:false});
  for(const op of ops.filter(o=>!['install','race','rejected'].includes(o.id))) {
    if(op.release===old){assert.equal(op.status,'отказ');assert.match(op.reason,/kimi-cli|Реестр участников/);continue;}
    assert.equal(op.status,'завершено');assert(Number.isInteger(op.pid));assert(fs.existsSync(path.join(root,'state/deploy-ops',op.id+'.json.pid')));
  }
  // Реестр корня фазы B: роли DeepSeek из f.phaseB сохранились — внешний шаг читал именно root/state/members.json.
  const reg=read(path.join(root,'state/members.json'));assert.equal(reg.phase,'B');
  const ds=reg.members.find(m=>m.id==='deepseek');
  assert.equal(ds.roles.writer,true);assert.equal(ds.roles.voter,true);assert.equal(ds.roles.receives,true);
});
test('База без env root видит фазу A/три сервера; новый CLI без env читает корень result', () => {
  skipOld();
  const env=f.env(root);delete env.MOST_REPO_ROOT;delete env.MOST_STATE_DIR;
  const observe=cp.spawnSync(process.execPath,['-e',`const m=require(${JSON.stringify(path.join(old,'common/members.js'))});console.log(JSON.stringify({phase:m.snapshot().phase,servers:m.installedServers}))`],{env,cwd:other,encoding:'utf8'});
  ok(observe);assert.equal(JSON.parse(observe.stdout).phase,'A');assert.equal(JSON.parse(observe.stdout).servers.length,3);
  // Вторая половина: новый CLI без MOST_REPO_ROOT/MOST_STATE_DIR находит корень из --result.
  // Релиз с install-phase A: DeepSeek попадает в конфиг только из реестра корня (фаза B), а не из релиза по умолчанию.
  const r=path.join(RUN,'result-root');fs.mkdirSync(r);f.phaseB(r);
  const before=read(path.join(r,'state/members.json'));assert.equal(before.phase,'B');
  const ds0=before.members.find(m=>m.id==='deepseek');
  assert.equal(ds0.roles.writer,true);assert.equal(ds0.roles.voter,true);assert.equal(ds0.roles.receives,true);
  const rel=f.release(r,'e'.repeat(40),{servers,installPhase:'A'});
  const config=path.join(r,'config.json');f.json(config,{});
  const result=f.operation(r,rel,'result-read');
  const child=f.env(r);delete child.MOST_REPO_ROOT;delete child.MOST_STATE_DIR;
  ok(f.cli(rel,['--config-only','--release',rel,'--config',config,'--result',result],child,other));
  const mcp=read(config).mcpServers;
  for(const s of servers)assert(mcp[s],'сервер '+s+' отсутствует — реестр корня (фаза B) не прочитан');
  assert.equal(mcp.team.env.MOST_REPO_ROOT,r);
});
test('Версия dsh в серверном пути: t=0, границы, TTL после null, отказ на t=0 и override', () => {
  const source=fs.readFileSync(path.join(f.source,'servers/deepseek/index.js'),'utf8');
  const fragment=source.slice(source.indexOf('const dshVersion ='),source.indexOf('\nfunction file(id)'));
  function harness(initial) {
    let now=0,calls=0,value=initial;const env={};
    const context={currentBinary:()=> 'fake',execFileSync:()=>{calls++;if(value===null)throw Error('probe');return value;},require:name=>name.endsWith('version-cache')?
      probe=>require('../common/version-cache')(probe,()=>now,()=>env.MOST_DSH_VERSION):{command:x=>x,viaShell:()=>false}};
    vm.createContext(context);vm.runInContext(fragment+'\nthis.version=dshVersion;',context);
    return { context, setNow:n=>{now=n}, setValue:v=>{value=v}, calls:()=>calls, env };
  }
  const h=harness('1.0.0');
  assert.equal(h.context.version(),'1.0.0');assert.equal(h.calls(),1);
  for(const n of [59999,60000]){h.setNow(n);assert.equal(h.context.version(),'1.0.0');assert.equal(h.calls(),1);}
  h.setNow(60001);h.setValue('2.0.0');assert.equal(h.context.version(),'2.0.0');assert.equal(h.calls(),2);
  h.setNow(120002);h.setValue(null);assert.equal(h.context.version(),null);assert.equal(h.calls(),3);
  h.setNow(120003);assert.equal(h.context.version(),null);assert.equal(h.calls(),3); // кэш null в пределах TTL
  h.setNow(180003);h.setValue('2.0.0');assert.equal(h.context.version(),'2.0.0');assert.equal(h.calls(),4); // TTL истёк — новая проба
  h.setNow(-1);h.setValue('3.0.0');assert.equal(h.context.version(),'3.0.0');assert.equal(h.calls(),5);
  h.env.MOST_DSH_VERSION='override';assert.equal(h.context.version(),'override');assert.equal(h.calls(),5);
  // Отказ пробы в начальной точке t=0 тоже кэшируется, а не выдаёт прежнюю версию.
  const z=harness(null);
  assert.equal(z.context.version(),null);assert.equal(z.calls(),1);
  z.setNow(60000);assert.equal(z.context.version(),null);assert.equal(z.calls(),1);
  z.setNow(60001);assert.equal(z.context.version(),null);assert.equal(z.calls(),2);
});
test('База: исходная серверная функция действительно удерживала успешную версию после 60 с', () => {
  skipOld();
  const source=fs.readFileSync(path.join(old,'servers/deepseek/index.js'),'utf8');
  const fragment=source.slice(source.indexOf('let _dshVer'),source.indexOf('\nfunction file(id)'));
  let now=1,calls=0,value='1.0.0';
  const context={process:{env:{}},Date:{now:()=>now},currentBinary:()=> 'fake',execFileSync:()=>{calls++;return value;},require:()=>({command:x=>x,viaShell:()=>false})};
  vm.createContext(context);vm.runInContext(fragment+'\nthis.version=dshVersion;',context);
  assert.equal(context.version(),'1.0.0');now+=60001;value='2.0.0';assert.equal(context.version(),'1.0.0');assert.equal(calls,1);
});
test('Runner: таблица исходов и закрытый список окружения', () => {
  for(const [text,code,signal,F,S] of [['Итого: пройдено 1, провалено 0',0,null,0,0],['Итого: пройдено 1, провалено 2',0,null,2,0],['Итого: пройдено 1, провалено 2',1,null,2,0],['Итого: пройдено 1, провалено 0',1,null,0,1],['Итого: пройдено 0, провалено 0',0,null,0,0],['bad',0,null,0,1],['Итого: пройдено 1, провалено 2',null,'SIGTERM',2,1],['Итого: проверок пройдено 154, провалено 1, пропущено 3.',1,null,1,0],['Итого дополнительно: пройдено 134, провалено 2.',1,null,2,0]]) {
    const r=runner.outcome(text,code,signal);assert.equal(r.failures,F);assert.equal(r.failedSuites,S);
  }
  const parent={PATH:'keep',MOST_CLIENT:'dirty',MOST_REPO_ROOT:'dirty',MOST_JOB_ID:'dirty',MOST_AUTHORITY:'dirty',MOST_FALLBACK_DIR:'dirty',MOST_STATE_DIR:'dirty',MOST_TEST_STATUS_SOURCE:'dirty',MOST_UNKNOWN:'dirty',most_unknown2:'dirty',MOST_TEST_OUTPUT:'dirty'};
  const env=runner.environment(parent,RUN);assert.equal(env.PATH,'keep');assert(!Object.values(env).includes('dirty'));assert.equal(env.MOST_NOTIFY,'off');
  for(const name of ['../x','..','a/b','C:\\x'])assert.throws(()=>runner.logPath(__dirname,name));
  assert.equal(runner.logPath(__dirname,'own.txt'),path.join(__dirname,'own.txt'));
  assert.equal(runner.logPath(__dirname,'own.txt',RUN),path.join(RUN,'own.txt'));
  assert.throws(()=>runner.logPath(__dirname,'../x',RUN));
  assert.throws(()=>runner.logPath(__dirname,'own.txt','relative'),/абсолютная/);
  assert.throws(()=>runner.logPath(__dirname,'own.txt',__filename),/папка/);
  assert.throws(()=>runner.logPath(__dirname,'own.txt',path.join(RUN,'missing')));
});
test('Runner: spawn error не мешает следующим, смешанный итог и нулевые прогоны', async () => {
  const {EventEmitter}=require('events');let calls=0;
  const spawn=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdout.setEncoding=child.stderr.setEncoding=()=>{};
    const n=calls++;process.nextTick(()=>{if(n===0)child.emit('error',Error('spawn error'));else {child.stdout.emit('data','Итого: пройдено 2, провалено 1, пропущено 3\n');child.stderr.emit('data','stderr kept\n');child.emit('close',0,null);}});return child;};
  let log='';const r=await runner.runSuites(['a','b'],{dir:RUN,env:{},spawn,write:s=>{log+=s}});assert.equal(calls,2);assert.equal(r.code,1);assert.equal(r.failures,1);assert.equal(r.failedSuites,1);assert.match(log,/stderr kept/);
  await assert.rejects(runner.runSuites([],{dir:RUN}),/не выбран/);
  const script=path.join(RUN,'zero.js');
  for(const summary of ['Итого: пройдено 0, провалено 0, пропущено 4','Итого: пройдено 0, провалено 0, пропущено 0']) {
    f.write(script,"console.log('"+summary+"')");let zlog='';
    const z=await runner.runSuites(['zero.js'],{dir:RUN,env:f.env(RUN),write:s=>{zlog+=s}});
    assert.equal(z.code,1);assert.equal(z.failures,0);assert.equal(z.failedSuites,0);assert.equal(z.passed,0);
    assert.match(zlog,/нет распознанных выполненных проверок/);
  }
  const envScript=path.join(RUN,'env-child.js');
  f.write(envScript,`const assert=require('assert');assert(!Object.values(process.env).includes('dirty'));assert.equal(process.env.MOST_NOTIFY,'off');assert(!process.env.MOST_TEST_OUTPUT);console.log('Итого: пройдено 1, провалено 0')`);
  for(const parent of [process.env,{...process.env,MOST_CLIENT:'dirty',MOST_REPO_ROOT:'dirty',MOST_JOB_ID:'dirty',MOST_AUTHORITY:'dirty',MOST_FALLBACK_DIR:'dirty',MOST_STATE_DIR:'dirty',MOST_TEST_STATUS_SOURCE:'dirty',MOST_UNKNOWN:'dirty',most_extra:'dirty',MOST_TEST_OUTPUT:'dirty'}])
    assert.equal((await runner.runSuites(['env-child.js'],{dir:RUN,env:runner.environment(parent,RUN),write(){}})).code,0);
});
test('Runner: .git/main, origin/main не замена; cwd и MOST_REPO_ROOT не выбирают репозиторий', () => {
  assert.doesNotThrow(()=>runner.mainBranch(f.source));assert.throws(()=>runner.mainBranch(other),/нет .git/);
  assert.throws(()=>runner.mainBranch(other,()=>({error:Error('no git')})),/Git недоступен/);
  const dir=path.join(RUN,'git');fs.mkdirSync(dir);cp.execFileSync('git',['init','-b','other',dir],{windowsHide:true,stdio:'pipe'});
  assert.throws(()=>runner.mainBranch(dir),/локальная ветка main/);
  const bundle=path.join(RUN,'main.bundle');cp.execFileSync('git',['-C',f.source,'bundle','create',bundle,'refs/heads/main'],{windowsHide:true,stdio:'pipe'});
  cp.execFileSync('git',['-C',dir,'fetch',bundle,'main:refs/remotes/origin/main'],{windowsHide:true,stdio:'pipe'});
  assert.throws(()=>runner.mainBranch(dir),/локальная ветка main/);
  const run=cp.spawnSync(process.execPath,[path.join(f.source,'tests/run.js'),'unknown.js'],{cwd:other,env:{...f.env(other),MOST_REPO_ROOT:other},encoding:'utf8'});assert.match(run.stderr,/Неизвестный набор/);
});
test('Откаты: каждый корень в отдельном процессе; пустая история допустима, фаза B и новые ворота запрещены', () => {
  for(const kind of ['empty','phaseB','gates']) {
    const r=path.join(RUN,'rollback-'+kind);fs.mkdirSync(r);
    const config=path.join(r,'config.json'), script=path.join(r,'old/index.js');f.write(script,'');f.json(config,{});
    f.json(config+'.prev',{mcpServers:{team:{command:process.execPath,args:[script]}}});
    if(kind==='phaseB')f.phaseB(r);
    if(kind==='gates')f.json(path.join(r,'works/new.json'),{stages:[{id:'s',rules_version:16}]});
    const before=snapshot([config]);
    const result=cp.spawnSync(process.execPath,[path.join(__dirname,'fixtures/team-v43/rollback.js'),JSON.stringify({root:r,configs:[config],configOnly:true})],{env:f.env(r),encoding:'utf8'});
    if(kind==='empty'){ok(result);assert.match(result.stdout,/возвращён/);}
    else {assert.match(result.stdout+result.stderr,kind==='phaseB'?/ниже кандидата А запрещён/:/новых ворот/);assert.deepEqual(snapshot([config]),before);}
  }
});
test('Сводки: тот же релиз позже, строгие поля/даты, чтение не меняет историю', async () => {
  skipOld();
  const r=RUN, release=path.join(r,'live','d'.repeat(40));fs.mkdirSync(release,{recursive:true});
  const file=f.operation(r,release,'stale'), marker=path.join(r,'live/deployed.json');
  const op={...read(file),status:'отказ',reason:'fixture refusal',updatedAt:'2026-10-25T19:27:35.659Z'};
  const m={commit:'d'.repeat(40),release,at:'2026-10-25T19:38:14.328Z'};f.json(file,op);f.json(marker,m);
  const status=require('../common/deploy-status');assert(status.hidden(op,m,r));
  for(const patch of [{at:op.updatedAt},{at:'bad'},{at:'2026-10-25T19:00:00Z'},{commit:'dddddddd'},{commit:'e'.repeat(40)},{release:old}])assert(!status.hidden(op,{...m,...patch},r));
  for(const patch of [{status:'перезапуск не подтверждён'},{status:'прервана'},{status:'откат'},{status:'запущена'},{root:other},{updatedAt:undefined},{release:'missing'}])assert(!status.hidden({...op,...patch},m,r));
  assert(status.hidden(op,{...m,at:'2026-10-25T22:38:14.328+03:00'},r));
  assert(!status.superseded({valid:false}));
  assert(!status.superseded({valid:true,status:'отказ',sameRoot:true,sameRelease:true,direct:true,commit:m.commit,names:[],at:2,updatedAt:1}));
  const {Team}=require('../common/team'), team=new Team(r), before=snapshot([file,marker]);
  const historical=path.join(RUN,'historical-summary');historicalState(historical);
  const historicalRelease=path.join(historical,'live','d'.repeat(40));fs.mkdirSync(historicalRelease,{recursive:true});
  const historicalFile=f.operation(historical,historicalRelease,'stale');
  f.json(historicalFile,{...op,root:historical,release:historicalRelease});
  f.json(path.join(historical,'live/deployed.json'),{...m,release:historicalRelease});
  const baseline=`const assert=require('assert');
    require(${JSON.stringify(path.join(old,'common/quota-line.js'))}).quotaLine=async()=> 'Фиксированная квота';
    const {Team}=require(${JSON.stringify(path.join(old,'common/team.js'))});const t=new Team(${JSON.stringify(historical)});
    (async()=>{for(const full of [false,true])assert((await t.status(undefined,undefined,undefined,full)).includes('Установка stale: отказ'));})().catch(e=>{console.error(e);process.exitCode=1});`;
  ok(cp.spawnSync(process.execPath,['-e',baseline],{cwd:other,env:{...f.env(historical),CODEX_PATH:path.join(historical,'missing-codex.exe'),MOST_TEST_BOOT_AT:'2000-01-01T00:00:00Z'},encoding:'utf8'}));
  for(const full of [false,true]) {const text=await team.status(undefined,undefined,undefined,full);assert(!text.includes('Установка stale:'),text);assert(text.includes('Последнее развёртывание:'),text);}
  assert.deepEqual(snapshot([file,marker]),before);
  f.json(marker,{...m,at:op.updatedAt});
  for(const full of [false,true])assert((await team.status(undefined,undefined,undefined,full)).includes('Установка stale: отказ'));
  f.write(marker, '{broken');
  const brokenBefore=snapshot([file,marker]);
  for(const full of [false,true])assert((await team.status(undefined,undefined,undefined,full)).includes('Установка stale: отказ'));
  assert.deepEqual(snapshot([file,marker]),brokenBefore);
});
(async()=>{let passed=0,failed=0,skipped=0;try{for(const [name,fn] of tests){try{await fn();passed++;console.log('ДА: '+name)}catch(e){if(e&&e[SKIP]){skipped++;console.log('ПРОПУСК: '+name+' — '+e.message)}else{failed++;console.log('ПРОВАЛ: '+name+'\n'+e.stack)}}}}finally{if(!KEEP){try{fs.rmSync(RUN,{recursive:true,force:true})}catch(e){console.log('Не удалось удалить временный каталог '+RUN+': '+e.message)}}}console.log('Итого: пройдено '+passed+', провалено '+failed+', пропущено '+skipped);process.exitCode=failed?1:0;})();
