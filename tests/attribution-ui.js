'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=fs.mkdtempSync(path.join(__dirname,'.tmp-attribution-ui-'));
Object.assign(process.env,{MOST_REPO_ROOT:root,MOST_STATE_DIR:path.join(root,'state'),MOST_CLIENT:'codex'});
const dir=path.join(root,'state','jobs','agy-case');fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'card.json'),JSON.stringify({id:'agy-case',modelId:'claude-opus-5-5-high',status:'done',from:'codex',role:'проверка',startedAt:new Date().toISOString()}));
const ui=require('../tools/dashboard/lib/data');
const jobs=ui.getJobs({agent:'antigravity'}).jobs;
assert.equal(jobs.length,1);
assert.equal(jobs[0].provenance.transport,'agy-cli');
assert.equal(jobs[0].provenance.provider_reported_text_model,'unknown');
assert.match(jobs[0].provenance_label,/requested_only/);
assert.match(jobs[0].provenance_label,/метка конфигурации/);
const format=require('../common/format').format;
const row=format('Antigravity',{id:'agy-case',modelId:'claude-opus-5-5-high',status:'done'},'ПРИНЯТО');
assert.match(row,/requested_only/);
assert.match(row,/объявлено провайдером: unknown/);
assert.equal(ui.intentStatusRu({status:'enqueued',derivedStatus:'stop_unconfirmed'}),'остановка не подтверждена');
assert.equal(ui.intentStatusRu({status:'enqueued',derivedStatus:'cancel_requested'}),'отмена запрошена');
assert.match(ui.nextStepRu({status:'enqueued',derivedStatus:'stop_unconfirmed'}),/проверка остановки/);
const stopped=path.join(root,'state','jobs','agy-stop');fs.mkdirSync(stopped,{recursive:true});
fs.writeFileSync(path.join(stopped,'card.json'),JSON.stringify({id:'agy-stop',modelId:'gemini-3.1-pro-high',status:'failed',stopUnconfirmed:{pid:123},startedAt:new Date().toISOString()}));
const stop=ui.getJobs({agent:'antigravity'}).jobs.find(x=>x.id==='agy-stop');
assert.equal(stop.status,'stop_unconfirmed');assert.equal(stop.local_status,'failed');
assert.equal(stop.status_label,'ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА');
assert.equal(ui.getJobs({agent:'antigravity',status:'stop_unconfirmed'}).jobs[0].id,'agy-stop');
const host=require('../tools/host-fallback'), oldList=host.listJobs;
host.listJobs=()=>({jobs:[{id:'host-one',who:'antigravity',status:'failed',stopUnconfirmed:{pid:123},modelId:'gemini-3.1-pro-high'}]});
try {
 const result=ui.getHostJobs({agent:'antigravity',status:'stop_unconfirmed'});
 assert(!result.error,result.error);assert.equal(result.jobs.length,1);
 assert.equal(result.jobs[0].status,'stop_unconfirmed');assert.equal(result.jobs[0].local_status,'failed');
 assert.equal(result.jobs[0].provenance.requested_text_model,'gemini-3.1-pro-high');
} finally {host.listJobs=oldList;}
(async()=>{
 const stores=require('../common/team-store'), original=stores.list;
 stores.list=who=>({jobs:who==='antigravity'?[{id:'agy-stop',status:'failed',stopUnconfirmed:{pid:123}}]:[],errors:[]});
 try {
  const summary=await require('../common/summary').compact({root,state:path.join(root,'state','team'),works:()=>[]},'test quota');
  assert.match(summary,/antigravity agy-stop: НЕ УДАЛОСЬ · ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА/);
 } finally {stores.list=original;}
 console.log('attribution-ui: 20 checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
