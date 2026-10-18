'use strict';
// Diagnostic only: production sources are instrumented in memory, never saved.
const fs = require('fs'), path = require('path'), Module = require('module');
const { performance } = require('perf_hooks');
// MOST_CLIENT=claude задаётся вызывающим процессом, полномочия не подменяются.
// node tools/status-timing.js [--release DIR] [--output DIR] [--root DIR]
//   [--state DIR] [--baseline DIR] — baseline сверяет этапы на той же копии состояния.
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--release', '--output', '--root', '--state', '--baseline'].includes(key) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--'))
    throw Error('Параметры: --release, --output, --root, --state, --baseline; после каждого нужна папка.');
  options[key.slice(2)] = path.resolve(process.argv[i + 1]);
}
if (process.env.MOST_CLIENT !== 'claude') throw Error('Запустите вручную с MOST_CLIENT=claude.');
const packageRoot = path.resolve(__dirname, '..');
const root = options.root || process.env.MOST_REPO_ROOT || (path.basename(path.dirname(packageRoot)) === 'live' ? path.resolve(packageRoot, '../..') : packageRoot);
const release = fs.realpathSync(options.release || path.join(root, 'live', JSON.parse(fs.readFileSync(path.join(root, 'live/deployed.json'), 'utf8')).commit));
const outputDir = options.output || fs.mkdtempSync(path.join(require('os').tmpdir(), 'most-status-timing-'));
if (outputDir === __dirname || outputDir.startsWith(__dirname + path.sep)) throw Error('Папка вывода должна быть вне tools/.');
fs.mkdirSync(outputDir, { recursive: true });
process.env.MOST_REPO_ROOT = root;
process.env.MOST_STATE_DIR = options.state || process.env.MOST_STATE_DIR || path.join(root, 'state');
for (const k of ['TEMP', 'TMP', 'TMPDIR']) process.env[k] = outputDir;
const write = fs.writeFileSync.bind(fs);
const output = path.join(outputDir, 'timings-two-runs.jsonl');
const logFd = fs.openSync(output, 'w');
const resultFd = fs.openSync(path.join(outputDir, 'summary-two-runs.txt'), 'w');
const auditFd = fs.openSync(path.join(outputDir, 'read-audit-two-runs.jsonl'), 'w');
const verdictFd = options.baseline && fs.openSync(path.join(outputDir, 'stage-verdicts.json'), 'w');
console.log('Релиз: ' + release + '\nМатериалы замера: ' + outputDir);
const records = [], reads = new Map();
let run = 0;
function emit(row) { row = {run, ...row}; records.push(row); write(logFd, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)); }
global.__timing = async function(label, fn) {
  const start = performance.now(); emit({ event: 'start', label, at: new Date().toISOString() });
  try { return await fn(); }
  finally { emit({ event: 'end', label, ms: +(performance.now() - start).toFixed(3), at: new Date().toISOString() }); }
};
const readFile = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const start = performance.now();
  try { return readFile.call(this, file, ...args); }
  finally { const p = String(file); const v = reads.get(p) || { count: 0, ms: 0 }; v.count++; v.ms += performance.now() - start; reads.set(p, v); }
};
// Fail closed on writes by loaded JS. Child processes are restricted to the
// read-only commands already used by the inspected summary/quota modules.
for (const n of ['writeFile','writeFileSync','appendFile','appendFileSync','mkdir','mkdirSync','rename','renameSync','unlink','unlinkSync','rm','rmSync','rmdir','rmdirSync','truncate','truncateSync','copyFile','copyFileSync','createWriteStream']) {
  fs[n] = (...a) => { emit({event:'blocked-write', method:n, path:String(a[0])}); throw Error('Diagnostic prohibits filesystem mutation: ' + n); };
  if (fs.promises[n]) fs.promises[n] = fs[n];
}
const open = fs.openSync;
fs.openSync = function(file, flags, ...args) { if (flags !== 'r' && flags !== 0) throw Error('Diagnostic prohibits writable open'); return open.call(this,file,flags,...args); };
const cp = require('child_process');
for (const key of ['execFileSync','spawnSync','spawn','execFile']) {
  const original = cp[key];
  cp[key] = function(bin, args, ...rest) {
    const safe = ['git','where.exe','powershell.exe'].includes(String(bin).toLowerCase()) || args?.includes('app-server');
    if (!safe) throw Error('Unapproved diagnostic child process: ' + bin);
    emit({event:'child', method:key, binary:bin, args});
    const t = performance.now();
    const value = original.call(this,bin,args,...rest);
    if (key.endsWith('Sync')) emit({event:'child-end', binary:bin, ms: +(performance.now()-t).toFixed(3)});
    return value;
  };
}
const loader = Module._extensions['.js'];
Module._extensions['.js'] = function(mod, filename) {
  if (!filename.startsWith(release + path.sep)) return loader(mod,filename);
  let code = readFile(filename,'utf8');
  if (filename === path.join(release,'common','team.js')) {
    code = code.replace('await fn();', 'await global.__timing("team: " + title, fn);');
    code = code.replace("const quota = await require('./quota-line').quotaLine(", "const quota = await global.__timing('quota total', () => require('./quota-line').quotaLine(");
    code = code.replace('agyModel: scope.agy_model });', 'agyModel: scope.agy_model }));');
  }
  if (filename === path.join(release,'common','summary.js')) {
    code = code.replace('const section = async fn => { try { await fn(); }', 'let sectionNumber = 0; const section = async fn => { const n = ++sectionNumber; try { await global.__timing("compact section " + n, fn); }');
  }
  if (filename === path.join(release,'common','quota.js')) {
    code = code.replace('return await appServer(binary, timeout);', "return await global.__timing('Codex app-server', () => appServer(binary, timeout));");
    code = code.replace('rollout(threadId) || {', "(await global.__timing('Codex rollout fallback', () => rollout(threadId))) || {");
  }
  mod._compile(code,filename);
};
function wrap(obj,key,label) {
  const original=obj[key];
  obj[key]=function(...args) { return global.__timing(typeof label === 'function' ? label(...args) : label, () => original.apply(this,args)); };
}
const req = n => require(path.join(release,'common',n));
const store=req('team-store'); const originalList=store.list;
const listStats={};
store.list=function(who,...args) { const t=performance.now(); const r=originalList.call(this,who,...args); const v=listStats[who] ||= {calls:0,ms:0,cards:0,errors:0}; v.calls++;v.ms+=performance.now()-t;v.cards=r.jobs.length;v.errors+=r.errors.length;return r; };
wrap(req('agy-quota'),'agySnapshot','Antigravity quota');
const snapshots = path.join(release, 'common/job-snapshot.js');
if (fs.existsSync(snapshots)) {
  const snapshot = require(snapshots), create = snapshot.create;
  snapshot.create = function(...args) { const t = performance.now(); try { return create(...args); } finally { emit({ event: 'end', label: 'job snapshot', ms: performance.now() - t }); } };
}
wrap(req('stage-gate'),'evaluate',(w,s) => 'stage ' + w.name + ' / ' + s.id);
wrap(req('locks'),'ownerState','ownerState');
(async()=>{
  const {Team}=req('team'); const team=new Team();
  if (options.baseline) {
    const Before = require(path.join(options.baseline, 'common/team')).Team;
    const before = new Before(root, team.state);
    const evaluate = async (t, snapshot) => Promise.all(t.works().map(w => w.error ? w : t.refreshWork(t.workFile(w.name), { readOnly: true, snapshot })));
    const oldVerdicts = await evaluate(before), newVerdicts = await evaluate(team, fs.existsSync(snapshots) ? require(snapshots).create() : undefined);
    write(verdictFd, JSON.stringify({ baseline: options.baseline, release, oldVerdicts, newVerdicts }, null, 2));
    require('assert').deepStrictEqual(newVerdicts, oldVerdicts, 'Вердикты этапов различаются');
    emit({ event: 'verdicts-equal', works: newVerdicts.length });
  }
  const roots = store.roots();
  const cardReads = () => Object.fromEntries(['codex', 'antigravity', 'archive'].map(who => {
    const dir = roots[who];
    return [who, [...reads].filter(([file]) => dir && file.startsWith(dir + path.sep) &&
      (path.basename(file) === 'card.json' || (path.dirname(file) === dir && file.endsWith('.json'))))
      .reduce((n, [, value]) => n + value.count, 0)];
  }));
  for (run = 1; run <= 2; run++) {
  for (const key of Object.keys(listStats)) delete listStats[key];
  reads.clear();
  const total=performance.now();
  const result=await global.__timing('STATUS TOTAL',()=>team.status(undefined,undefined,false,false,{}));
  emit({event:'summary',wallMs:performance.now()-total,listStats,cardReads:cardReads()});
  write(auditFd,JSON.stringify({ run, reads: [...reads].map(([file,v])=>({file,...v})) }) + '\n');
  write(resultFd,'\nRUN ' + run + '\n' + result + '\n','utf8');
  }
  for (const fd of [logFd, resultFd, auditFd, verdictFd].filter(x => typeof x === 'number')) fs.closeSync(fd);
})().catch(e=>{emit({event:'fatal',error:e.stack});process.exitCode=1;});
