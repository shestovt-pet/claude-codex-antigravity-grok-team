'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { RUN, stores, sha, write, json, run } = require('./team-v16-fixture');
const cw = require('../common/consilium-workflow');
let serial = 0, order = 0;
const timestamp = () => new Date(Date.now() + (++order) * 1000).toISOString();
async function fixture(family = 'anthropic', level = 'обычный') {
  const dir = path.join(RUN, 'workflow-' + (++serial)); fs.mkdirSync(dir);
  const request = 'Проверить результат.'; write(path.join(dir, 'request.txt'), request);
  const w = { schema_version: 2, work_id: 'workflow-' + serial, quorum: cw.QUORUM,
    request: { path: 'request.txt', sha256: sha(request) }, requirements: [{ id: 'r', quote: request, evidence_needed: 'Результат' }], stages: [] };
  for (const [i, kind] of ['discussion', 'plan', 'execution', 'final'].entries()) {
    write(path.join(dir, 's' + i + '.txt'), 'Материал ' + i);
    w.stages.push({ id: 's' + i, kind, author: { family, model: family }, level: i === 0 ? 'обычный' : level,
      depends_on: i ? ['s' + (i - 1)] : [], addresses: ['r'], criteria: ['Проверено'], material: [{ path: 's' + i + '.txt' }], reviews: [] });
  }
  const file = path.join(dir, 'workflow.json'), save = () => json(file, w), s = w.stages[1];
  const check = () => { save(); return cw.run(file, { intent: 'accept', stage: s.id, adapter: cw.bridgeAdapter() }); };
  function vote(stage, who, accepted = true, opts = {}) {
    const id = 'wf-job-' + serial + '-' + (++order), hashes = stage.material.map(m => sha(fs.readFileSync(path.join(dir, m.path))));
    const task = `workflow_work: ${w.work_id}\nworkflow_stage: ${stage.id}\nsnapshot_sha256: ${stage.snapshot_sha256}\n` + hashes.join('\n') + '\n' + (opts.extra || '');
    const payload = `snapshot_sha256: ${stage.snapshot_sha256}\n${accepted ? 'ПРИНЯТО' : 'НЕ ПРИНЯТО: 1 блокирующих'}`;
    const text = payload + (who === 'grok' ? '\nКОНТРОЛЬ ' + 'a'.repeat(64) + '\nКОНЕЦ ОТВЕТА' : '');
    const card = { id, work: w.work_id, stageId: stage.id, role: 'проверка', status: 'done', startedAt: timestamp(), finishedAt: timestamp(),
      task, model: who === 'antigravity' ? 'gemini-3.8-flash-high' : who === 'grok' ? 'grok-4' : 'gpt-6', ...opts };
    const root = stores.roots()[who];
    if (who === 'antigravity') {
      json(path.join(root, id, 'card.json'), card); write(path.join(root, id, 'result.txt'), text); json(path.join(root, id, 'meta.json'), { hash: sha(text) });
    } else {
      card.resultFile = id + '.result.txt'; if (who === 'grok') card.resultHash = sha(text);
      json(path.join(root, id + '.json'), card); write(path.join(root, card.resultFile), text);
    }
    const ref = { source: 'bridge', participant: who, job_id: id, task_sha256: sha(cw.taskText(card)), response_sha256: sha(text) };
    if (opts.list !== false && card.status === 'done') stage.reviews.push(ref);
    return id;
  }
  function dismiss(id) {
    const d = { kind: 'dismiss', version: s.snapshot_sha256, job_id: id, reason: 'причина отклонения', at: timestamp() };
    (s.decisions ||= []).push(d); return d;
  }
  function helper(id, replacement = 'grok', additional = false) {
    const name = '.most/reviews/fresh-' + (++order) + '.txt';
    write(path.join(dir, name), `snapshot_sha256: ${s.snapshot_sha256}\nfamily: anthropic\nmodel: claude-opus-4.6\n` +
      (additional ? '' : `replacement: ${replacement}\nevidence: ${id}\n`) + 'ответ ' + order + '\nПРИНЯТО');
    if (additional) (s.fresh_reviews ||= []).push({ path: name });
    else (s.decisions ||= []).push({ kind: 'replace', version: s.snapshot_sha256, replacement, evidence: id,
      family: 'anthropic', model: 'claude-opus-4.6', reason: 'недоступность', at: timestamp(), file: { path: name, sha256: sha(fs.readFileSync(path.join(dir, name))) } });
    return name;
  }
  save(); w.stages[0].snapshot_sha256 = (await cw.run(file, { intent: 'snapshot', stage: 's0' })).snapshot_sha256;
  vote(w.stages[0], 'codex'); vote(w.stages[0], 'antigravity'); save();
  s.snapshot_sha256 = (await cw.run(file, { intent: 'snapshot', stage: s.id })).snapshot_sha256;
  save(); return { dir, w, s, save, file, check, voteStage: vote, vote: (who, yes = true, opts = {}) => vote(s, who, yes, opts), dismiss, helper };
}
const tests = [], test = (n, fn) => tests.push([n, fn]);
test('Р12.12, 16: два голоса; скрытый отказ; причина без нового снимка и положительных голосов', async () => {
  const f = await fixture(); f.vote('codex'); f.vote('antigravity');
  assert.equal((await f.check()).ready, true);
  const id = f.vote('grok', false, { list: false }); await assert.rejects(f.check(), /НЕ ПРИНЯТО/);
  const old = f.s.snapshot_sha256; f.dismiss(id); const result = await f.check();
  assert.equal(result.ready, true); assert.equal(result.snapshot_sha256, old); assert.match(JSON.stringify(result), /особое мнение/);
});
test('Р12.3, 6, 9: одно принятие и две сессии Gemini — не кворум', async () => {
  const f = await fixture(); f.vote('antigravity'); f.vote('antigravity'); await assert.rejects(f.check(), /два ПРИНЯТО/);
  const lost = f.vote('grok', true, { status: 'lost' }); f.helper(lost); await assert.rejects(f.check(), /не занимает место/);
});
test('Р12.4: один lost и помощник для автора Gemini', async () => {
  const f = await fixture('google'); f.vote('codex'); const id = f.vote('grok', true, { status: 'lost' }); f.helper(id);
  assert.equal((await f.check()).ready, true);
});
test('Р12.5: отклонение, затем пересмотр тем же проверяющим', async () => {
  const f = await fixture('google'); f.vote('codex'); const id = f.vote('grok', false), d = f.dismiss(id);
  await assert.rejects(f.check(), /ждёт пересмотра/);
  f.vote('grok'); await assert.rejects(f.check(), /ждёт пересмотра/);
  f.vote('grok', true, { extra: id + '\n' + d.reason }); assert.equal((await f.check()).ready, true);
});
test('Р12.5б: повторный блокирующий', async () => {
  const f = await fixture('google'); f.vote('codex'); const id = f.vote('grok', false), d = f.dismiss(id);
  f.vote('grok', false, { extra: id + '\n' + d.reason }); await assert.rejects(f.check(), /НЕ ПРИНЯТО/);
});
test('Р12.5в: потерян пересмотр с причиной, замена помощником', async () => {
  const f = await fixture('google'); f.vote('codex'); const id = f.vote('grok', false), d = f.dismiss(id);
  const lost = f.vote('grok', true, { status: 'lost', extra: id + '\n' + d.reason }); f.helper(lost);
  assert.equal((await f.check()).ready, true);
});
test('Р12.7: поздний отказ снова блокирует; у Claude отклоняется', async () => {
  const f = await fixture(); f.vote('codex'); f.vote('antigravity'); await f.check();
  const id = f.vote('grok', false); await assert.rejects(f.check(), /НЕ ПРИНЯТО/); f.dismiss(id); assert.equal((await f.check()).ready, true);
});
test('Р12.7б: поздний отказ у Gemini после отклонения ждёт пересмотра', async () => {
  const f = await fixture('google'); f.vote('codex'); f.vote('grok'); await f.check();
  const id = f.vote('grok', false); f.dismiss(id); await assert.rejects(f.check(), /ждёт пересмотра/);
});
test('Р12.8: высокий риск, один файл дважды запрещён', async () => {
  const f = await fixture('google', 'высокий'); f.vote('codex'); const id = f.vote('grok', true, { status: 'lost' });
  const name = f.helper(id); f.s.fresh_reviews = [{ path: name }]; await assert.rejects(f.check(), /дважды/);
  f.helper(null, null, true); assert.equal((await f.check()).ready, true);
});
test('Р12.13, 17: старый lost после готового отказа не доказательство', async () => {
  const f = await fixture('google'); f.vote('codex'); const lost = f.vote('grok', true, { status: 'lost' });
  const no = f.vote('grok', false); f.dismiss(no); f.helper(lost); await assert.rejects(f.check(), /недоступности|ждёт пересмотра/);
});
for (const status of ['running', 'cancelled', 'delivery_unclear', 'stop_unconfirmed', 'unexpected']) test('Р12.18: ' + status + ' не основание замены', async () => {
  const f = await fixture('google'); f.vote('codex'); const id = f.vote('grok', true, { status }); f.helper(id);
  await assert.rejects(f.check(), /недоступности/);
});
test('дополнение: старый сбой при новом идущем поручении', async () => {
  const f = await fixture('google'); f.vote('codex'); const id = f.vote('grok', true, { status: 'failed' });
  f.vote('grok', true, { status: 'running' }); f.helper(id); await assert.rejects(f.check(), /недоступности/);
});
test('Р12.15: сам находит отказ прошлой редакции', async () => {
  const f = await fixture(); f.vote('grok', false);
  write(path.join(f.dir, 's1.txt'), 'исправленный материал'); f.save();
  f.s.snapshot_sha256 = (await cw.run(f.file, { intent: 'snapshot', stage: f.s.id })).snapshot_sha256;
  f.s.reviews = [];
  f.vote('codex'); f.vote('antigravity'); assert.match(JSON.stringify(await f.check()), /исправлено без подтверждения/);
});
test('автор входит в хеш снимка; журнал решений не входит', async () => {
  const f = await fixture(), original = f.s.snapshot_sha256;
  f.s.author = { family: 'google', model: 'gemini' }; f.save();
  const changed = await cw.run(f.file, { intent: 'snapshot', stage: f.s.id }); assert.notEqual(changed.snapshot_sha256, original);
});
test('версия 1 сохраняет требование трёх голосов', async () => {
  const f = await fixture(); f.w.schema_version = 1; f.save();
  const first = f.w.stages[0]; first.snapshot_sha256 = (await cw.run(f.file, { intent: 'snapshot', stage: first.id })).snapshot_sha256;
  f.save(); await assert.rejects(cw.run(f.file, { intent: 'accept', stage: first.id }), /три/);
});
test('Р12.21: готовый поздний ответ вместо lost читается хранилищем; отказ блокирует', async () => {
  for (const accepted of [true, false]) {
    const f = await fixture('google'); f.vote('codex');
    const id = f.vote('grok', accepted, { status: 'lost' }); f.helper(id); await f.check();
    const p = path.join(stores.roots().grok, id + '.json'), card = JSON.parse(fs.readFileSync(p));
    json(p, { ...card, status: 'done', finishedAt: timestamp() });
    if (accepted) assert.equal((await f.check()).ready, true);
    else await assert.rejects(f.check(), /НЕ ПРИНЯТО/);
  }
});
test('версия 2: полный путь до deliver с двумя семьями на каждом этапе', async () => {
  const f = await fixture(); f.vote('codex'); f.vote('antigravity'); await f.check();
  f.w.stages.at(-1).coverage = [{ requirement_id: 'r', result: 'met', evidence_refs: ['s3.txt'], limitations: '' }];
  for (const stage of f.w.stages.slice(2)) {
    stage.accepted_plan_sha256 = f.s.snapshot_sha256; f.save();
    stage.snapshot_sha256 = (await cw.run(f.file, { intent: 'snapshot', stage: stage.id })).snapshot_sha256;
    f.voteStage(stage, 'codex'); f.voteStage(stage, 'antigravity'); f.save();
  }
  const r = await cw.run(f.file, { intent: 'deliver' }); assert.equal(r.ready, true); assert.equal(r.accepted.length, 4);
});
run(tests);
