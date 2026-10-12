'use strict';
const {spawnSync}=require('child_process'),path=require('path');
let passed=0,failed=0;
for(const server of ['antigravity','codex','grok','team']) {
 const r=spawnSync(process.execPath,['--check',path.join(__dirname,'../servers',server,'index.js')],{encoding:'utf8'});
 if(r.status===0) passed++; else { failed++;process.stderr.write(r.stderr||''); }
}
for(const name of ['provenance','grok','artifacts','gate','ui']) {
 const r=spawnSync(process.execPath,[path.join(__dirname,'attribution-'+name+'.js')],{env:process.env,encoding:'utf8'});
 process.stdout.write((r.stdout||'').replace(/^Итого:/gm,'Вложенный итог:'));process.stderr.write(r.stderr||'');
 if(r.status===0) passed++; else { failed++;console.error('FAILED suite '+name+': '+(r.error||r.status)); }
}
console.log(`Итого: пройдено ${passed}, провалено ${failed}, пропущено 0`);
process.exitCode=failed?1:0;
