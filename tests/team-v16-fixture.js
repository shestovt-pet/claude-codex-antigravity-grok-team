'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const RUN = fs.mkdtempSync(path.join(__dirname, '.tmp-v16-'));
const root = path.join(RUN, 'repo'), project = path.join(RUN, 'project');
fs.mkdirSync(root); fs.mkdirSync(project);
Object.assign(process.env, { MOST_REPO_ROOT: root, MOST_STATE_DIR: path.join(root, 'state'),
  MOST_CODEX_JOBS_DIR: path.join(root, 'state', 'codex-jobs'), MOST_CODEX_ARCHIVE_DIR: '',
  MOST_CLIENT: 'claude', MOST_NOTIFY: 'off', MOST_AFTER_DEPLOY: 'off', MOST_FALLBACK_DIR: path.join(RUN, 'fallback') });
process.env.MOST_CLAUDE_CONFIGS = '[]';
delete process.env.MOST_AUTHORITY;
const gate = require('../common/stage-gate'), stores = require('../common/team-store');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const json = (f, x) => write(f, JSON.stringify(x));
let seq = 0;
function fixture(opts = {}) {
  const w = { name: 'work-' + (++seq), folder: project, stages: [{ title: 'Итог', weight: 100, accept_criteria: 'Проверено',
    state: 'план', level: 'обычный', author: { family: 'anthropic', model: 'claude' }, version: 'version-' + seq, ...opts }] };
  gate.normalize(w, null);
  const s = w.stages[0]; s.version = gate.version(w, s);
  return { w, s };
}
function job(f, who = 'codex', count = 0, opts = {}) {
  const id = 'job-' + (++seq), dir = stores.roots()[who];
  let text = 'Ответ ' + id + '\n' + (count ? 'НЕ ПРИНЯТО: ' + count + ' блокирующих' : 'ПРИНЯТО');
  if (who === 'grok') text += '\nКОНТРОЛЬ ' + 'a'.repeat(64) + '\nКОНЕЦ ОТВЕТА';
  const j = { id, work: f.w.name, stage: f.s.id, stageId: f.s.id, role: 'проверка', status: 'done',
    startedAt: new Date(Date.now() + seq * 1000).toISOString(), finishedAt: new Date(Date.now() + seq * 1000 + 1).toISOString(),
    task: f.s.version, model: who === 'antigravity' ? 'gemini-3.8-flash-high' : who === 'grok' ? 'grok-4' : 'gpt-6', ...opts };
  if (who === 'antigravity') {
    j.workName = j.work; json(path.join(dir, id, 'card.json'), j);
    write(path.join(dir, id, 'result.txt'), text); json(path.join(dir, id, 'meta.json'), { hash: sha(text) });
  } else {
    j.resultFile = id + '.result.txt'; if (who === 'grok') j.resultHash = sha(text);
    json(path.join(dir, id + '.json'), j); write(path.join(dir, j.resultFile), text);
  }
  return id;
}
function fresh(f, fields = '', count = 0) {
  const p = path.join(project, '.most', 'reviews', 'fresh-' + (++seq) + '.txt');
  write(p, 'version: ' + f.s.version + '\nсемья: anthropic\nмодель: claude-sonnet-4.6\n' + fields + '\nответ ' + seq + '\n' +
    (count ? 'НЕ ПРИНЯТО: ' + count + ' блокирующих' : 'ПРИНЯТО'));
  gate.registerFile(f.w, f.s, p, f.s.version); return p;
}
function dismiss(f, id, reason = 'проверено по источнику') {
  const d = { kind: 'dismiss', version: f.s.version, job_id: id, reason, at: new Date(Date.now() + (++seq) * 1000).toISOString() };
  (f.s.decisions ||= []).push(d); return d;
}
async function accept(f, opts = {}, old) {
  f.s.state = 'принят';
  f.s.reviews = gate.allJobs().filter(j => (j.workName || j.work) === f.w.name && j.role === 'проверка' && j.status === 'done' && j.task.includes(f.s.version)).map(j => j.id);
  Object.assign(f.s, opts); return gate.evaluate(f.w, f.s, old);
}
async function run(tests) {
  let failed = 0;
  for (const [name, fn] of tests) try { await fn(); console.log('OK ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
  console.log('Итого: пройдено ' + (tests.length - failed) + ', провалено ' + failed);
  process.exitCode = failed ? 1 : 0;
}
module.exports = { RUN, root, project, gate, stores, sha, write, json, fixture, job, fresh, dismiss, accept, run };
