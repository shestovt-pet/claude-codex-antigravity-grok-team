'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { spawnSync } = require('child_process');
const cw = require('../common/consilium-workflow');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'most-workflow-'));
const state = path.join(root, 'state'); fs.mkdirSync(state);
process.env.MOST_STATE_DIR = state;
for (const p of ['jobs', 'codex-jobs', 'grok-jobs']) fs.mkdirSync(path.join(state, p));
let passed = 0, failed = 0, serial = 0;
function put(dir, name, text) { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; }
const ref = (p, value) => ({ path: p, sha256: cw.sha(value) });
async function test(name, fn) { try { await fn(); passed++; console.log('OK ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.stack); } }
async function rejected(fn, pattern) { await assert.rejects(fn, pattern); }
function fixture() {
  const dir = path.join(root, 'case-' + ++serial); fs.mkdirSync(dir);
  const request = 'Сравнить изображения. Показать проверенный результат.';
  put(dir, 'request.txt', request);
  const w = { schema_version: 1, work_id: 'test-' + serial, quorum: cw.QUORUM,
    request: ref('request.txt', request), requirements: [{ id: 'r1', quote: 'Сравнить изображения.', evidence_needed: 'Сравнение' },
      { id: 'r2', quote: 'Показать проверенный результат.', evidence_needed: 'Галерея' }], stages: [] };
  for (const [i, kind] of ['discussion', 'plan', 'execution', 'execution', 'final'].entries()) {
    const id = 's' + i; put(dir, id + '.txt', 'Материал ' + id);
    w.stages.push({ id, kind, depends_on: i ? ['s' + (i - 1)] : [], addresses: ['r1', 'r2'],
      criteria: ['Проверен исходный запрос'], material: [{ path: id + '.txt' }], reviews: [] });
  }
  w.stages.at(-1).coverage = w.requirements.map(r => ({ requirement_id: r.id, result: 'met', evidence_refs: ['s4.txt'], limitations: '' }));
  const jobs = Object.fromEntries(cw.QUORUM.map(who => [who, []]));
  const adapter = { list(who) { return jobs[who]; }, read(who, j) { return { raw: j.response, text: j.response,
    provenance: { family: ({ codex: 'openai', grok: 'xai', antigravity: 'google' })[who], mismatch: j.mismatch || false } }; } };
  const file = path.join(dir, 'workflow.json'), save = () => fs.writeFileSync(file, JSON.stringify(w));
  function vote(s, who, accepted = true, extra = {}) {
    const j = { id: w.work_id + '-' + s.id + '-' + who + '-' + jobs[who].length, role: 'проверка', status: 'done',
      finishedAt: new Date(1800000000000 + jobs[who].length * 1000).toISOString(),
      task: `workflow_work: ${w.work_id}\nworkflow_stage: ${s.id}\nsnapshot_sha256: ${s.snapshot_sha256}`,
      response: `snapshot_sha256: ${s.snapshot_sha256}\n${accepted ? 'ПРИНЯТО' : 'НЕ ПРИНЯТО: 1 блокирующих'}`, ...extra };
    jobs[who].push(j);
    return { participant: who, source: 'bridge', job_id: j.id, task_sha256: cw.sha(cw.taskText(j)), response_sha256: cw.sha(j.response) };
  }
  async function prepare(count = w.stages.length) {
    for (let i = 0; i < count; i++) {
      const s = w.stages[i]; if (i >= 2) s.accepted_plan_sha256 = w.stages[1].snapshot_sha256;
      save(); s.snapshot_sha256 = (await cw.run(file, { stage: s.id, intent: 'snapshot', adapter })).snapshot_sha256;
      s.reviews = cw.QUORUM.map(who => vote(s, who)); save();
    }
  }
  save(); return { dir, w, jobs, file, save, adapter, prepare, vote,
    check: (stage = 's4', intent = 'accept') => cw.run(file, { stage, intent, adapter }) };
}
async function main() {
  await test('полная цепь: обсуждение, план, два этапа, финал, выдача', async () => {
    const f = fixture(); await f.prepare(); assert.equal((await f.check('s4', 'deliver')).ready, true);
  });
  await test('начало этапа не требует ещё не созданного выходного файла', async () => {
    const f = fixture(); await f.prepare(2); f.w.stages[2].accepted_plan_sha256 = f.w.stages[1].snapshot_sha256;
    f.w.stages[2].material = [{ path: 'future.txt' }]; f.save(); assert.equal((await f.check('s2', 'start')).ready, true);
  });
  await test('snapshot готовит план без приёмки исторических предшественников', async () => {
    const f = fixture(); const r = await f.check('s1', 'snapshot');
    assert.equal(r.ready, false); assert.equal(r.action, 'snapshot');
    await rejected(() => f.check('s1', 'start'), /снимка/);
  });
  await test('обсуждение может содержать несогласие, план должен снять его', async () => {
    const f = fixture(); await f.prepare(1); f.w.stages[0].reviews[0] = f.vote(f.w.stages[0], 'codex', false); f.save();
    assert.equal((await f.check('s0', 'accept')).ready, true);
    assert.equal((await f.check('s1', 'start')).ready, true);
    const plan = f.w.stages[1]; plan.snapshot_sha256 = (await f.check('s1', 'snapshot')).snapshot_sha256;
    plan.reviews = cw.QUORUM.map(who => f.vote(plan, who));
    f.w.stages[2].accepted_plan_sha256 = plan.snapshot_sha256; f.save();
    assert.equal((await f.check('s2', 'start')).ready, true);
  });
  for (const [name, mutation, regex] of [
    ['нет плана', f => { f.w.stages[1].kind = 'execution'; }, /порядок/],
    ['цитата не из запроса', f => { f.w.requirements[0].quote = 'Придуманное'; }, /дословным/],
    ['пустой исходный запрос', f => { put(f.dir, 'request.txt', ' '); f.w.request.sha256 = cw.sha(' '); }, /пуст/],
    ['один голос', f => { f.w.stages[4].reviews.pop(); }, /голоса Codex/],
    ['повтор job_id', f => { f.w.stages[4].reviews[0].job_id = f.w.stages[3].reviews[0].job_id; }, /Повтор/],
    ['неизвестный источник', f => { f.w.stages[4].reviews[0].source = 'claude'; }, /источник/],
    ['изменившееся изображение', f => { put(f.dir, 's3.txt', 'Изменено'); }, /снимка/],
    ['изменившийся план', f => { put(f.dir, 's1.txt', 'Новый план'); }, /снимка/],
    ['неверный accepted_plan', f => { f.w.stages[2].accepted_plan_sha256 = '0'.repeat(64); }, /accepted_plan/],
    ['пропущенный этап', f => { f.w.stages[3].depends_on = ['s1']; }, /цепь/],
    ['подмена последовательности плана', f => { f.w.stages[3].criteria = ['Другой критерий']; }, /снимка/],
    ['старый выбранный голос', f => { f.vote(f.w.stages[4], 'codex', false); }, /последний/],
    ['новый отрицательный голос', f => { f.w.stages[4].reviews[0] = f.vote(f.w.stages[4], 'codex', false); }, /НЕ ПРИНЯТО/],
    ['отменённый ответ', f => { f.jobs.codex.at(-1).cancelled = true; }, /действующего/],
    ['поздний ответ', f => { f.jobs.codex.at(-1).lateHash = 'abc'; }, /действующего/],
    ['несовпадение семей', f => { f.jobs.codex.at(-1).mismatch = true; }, /маршрут/],
    ['нет времени завершения', f => { delete f.jobs.codex.at(-1).finishedAt; }, /время/],
    ['чужой stage в поручении', f => { f.jobs.codex.at(-1).task = f.jobs.codex.at(-1).task.replace('workflow_stage: s4', 'workflow_stage: elsewhere'); }, /ревью/],
    ['нет hash в ответе', f => { const j = f.jobs.codex.at(-1); j.response = 'ПРИНЯТО'; f.w.stages[4].reviews[0].response_sha256 = cw.sha(j.response); }, /самом ответе/],
    ['два hash в ответе', f => { const j = f.jobs.codex.at(-1); j.response = `snapshot_sha256: ${f.w.stages[4].snapshot_sha256}\n` + j.response; f.w.stages[4].reviews[0].response_sha256 = cw.sha(j.response); }, /самом ответе/],
  ]) await test(name, async () => { const f = fixture(); await f.prepare(); mutation(f); f.save(); await rejected(() => f.check(), regex); });
  await test('начало второго этапа до первого принятия запрещено', async () => {
    const f = fixture(); await f.prepare(2); f.w.stages[2].accepted_plan_sha256 = f.w.stages[1].snapshot_sha256; f.save();
    await rejected(() => f.check('s3', 'start'), /снимка/);
  });
  await test('неоднозначный порядок совпавших времён запрещён', async () => {
    const f = fixture(); await f.prepare(); f.vote(f.w.stages[4], 'codex', false, { finishedAt: f.jobs.codex.at(-1).finishedAt }); f.save();
    await rejected(() => f.check(), /порядок/);
  });
  for (const status of ['running', 'delivery_unclear', 'cancel_requested', 'stop_unconfirmed', 'stop_confirmed', 'cancelled', 'lost', 'failed'])
    await test('новое нерешённое ревью Codex не скрывается: ' + status, async () => {
      const f = fixture(); await f.prepare(); const s = f.w.stages[4];
      f.vote(s, 'codex', true, { status, finishedAt: undefined, startedAt: '2030-01-01T00:00:00.000Z',
        ...(status === 'stop_unconfirmed' ? { cancel_requested: { at: '2030-01-01T00:00:01.000Z', remote_ack: false },
          lateHash: 'late-hash', late_result: { receivedAt: '2030-01-01T00:00:02.000Z' } } : {}) });
      f.save(); await rejected(() => f.check(), /действующего/);
    });
  await test('нерешённое ревью с неизвестным порядком не пропускается', async () => {
    const f = fixture(); await f.prepare(); f.vote(f.w.stages[4], 'codex', true, { status: 'running', finishedAt: undefined });
    f.save(); await rejected(() => f.check(), /порядок/);
  });
  await test('после нерешённого ревью нужен новый действующий завершённый ответ', async () => {
    const f = fixture(); await f.prepare(); const s = f.w.stages[4];
    f.vote(s, 'codex', true, { status: 'stop_unconfirmed', finishedAt: undefined, startedAt: '2028-01-01T00:00:00Z' });
    s.reviews[0] = f.vote(s, 'codex', true, { startedAt: '2028-01-02T00:00:00Z', finishedAt: '2028-01-02T00:01:00Z' });
    f.save(); assert.equal((await f.check()).ready, true);
  });
  await test('финальное покрытие всех требований проверяется после голосов', async () => {
    const f = fixture(); f.w.stages[4].coverage.pop(); f.save(); await f.prepare(); await rejected(() => f.check(), /покрывает/);
  });
  await test('доказательство финала обязано быть фактическим материалом', async () => {
    const f = fixture(); f.w.stages[4].coverage[0].evidence_refs = ['invented.png']; f.save(); await f.prepare(); await rejected(() => f.check(), /доказательством/);
  });
  await test('CRLF, конечные пустые строки и пробелы разрешены', () => { assert.equal(cw.verdict('текст\r\n ПРИНЯТО \r\n\r\n'), true); });
  await test('текст и code fence после вердикта не игнорируются', () => {
    assert.throws(() => cw.verdict('ПРИНЯТО\nпояснение'), /вердиктом/); assert.throws(() => cw.verdict('```\nПРИНЯТО\n```'), /вердиктом/);
  });
  await test('потоковое хеширование файла больше 5 MiB', async () => {
    const f = fixture(), data = Buffer.alloc(6 * 1024 ** 2, 7); put(f.dir, 'large.bin', data);
    assert.equal((await cw.readFile(cw.context(f.dir), { path: 'large.bin' })).sha256, cw.sha(data));
  });
  await test('каждый ресурсный лимит даёт отказ', async () => {
    const f = fixture(), ctx = cw.context(f.dir); ctx.refs = cw.LIMITS.count;
    await rejected(() => cw.readFile(ctx, { path: 's0.txt' }), /числа/);
    const total = cw.context(f.dir); total.bytes = cw.LIMITS.total;
    await rejected(() => cw.readFile(total, { path: 's0.txt' }), /суммарный/);
    for (const limit of [cw.LIMITS.json, cw.LIMITS.text, cw.LIMITS.file]) {
      const p = put(f.dir, 'over-' + limit, ''); fs.truncateSync(p, limit + 1);
      await rejected(() => cw.readFile(cw.context(f.dir), { path: path.basename(p) }, limit), /размера/);
    }
  });
  await test('junction внутри корня разрешён; наружу запрещён', async () => {
    const f = fixture(); fs.mkdirSync(path.join(f.dir, 'inner')); put(f.dir, 'inner/item.txt', 'ok');
    fs.symlinkSync(path.join(f.dir, 'inner'), path.join(f.dir, 'in-link'), 'junction');
    assert.equal((await cw.readFile(cw.context(f.dir), { path: 'in-link/item.txt' })).sha256, cw.sha('ok'));
    fs.symlinkSync(root, path.join(f.dir, 'out-link'), 'junction');
    put(root, 'outside.txt', 'outside');
    await rejected(() => cw.readFile(cw.context(f.dir), { path: 'out-link/outside.txt' }), /корень/);
  });
  await test('две ссылки на один материал не считаются двумя доказательствами', async () => {
    const f = fixture(); f.w.stages[0].material.push({ path: './s0.txt' }); f.save(); await rejected(() => f.check('s0', 'snapshot'), /повтор/);
  });
  await test('неизвестный импорт Codex запрещён по умолчанию', async () => {
    const f = fixture(); await f.prepare(); f.w.stages[4].reviews[0].source = 'native_codex_import'; f.save(); await rejected(() => f.check(), /по умолчанию/);
  });
  await test('ограниченная policy + ответ с собственным hash: явно не аутентифицированный импорт', async () => {
    const f = fixture(), p = { schema_version: 1, policy_id: 'test-import', mode: 'recorded_response_not_independently_authenticated',
      scope: 'native_codex_only', enabled: true, trust_boundary: 'Локальная запись не удостоверяет авторство и полноту журнала; проверяем только явное соглашение и редакцию.' };
    const digest = cw.sha(cw.canonical(p)); p.agreement = cw.QUORUM.map(who => {
      const text = `import_policy_id: test-import\nimport_policy_sha256: ${digest}\nПРИНЯТО` +
        (who === 'grok' ? '\nконтроль ' + 'c'.repeat(64) + '\nКОНЕЦ ОТВЕТА\n' : '');
      put(f.dir, who + '-policy.txt', text); return { participant: who, job_id: who + '-actual-id', source_record: 'recorded tool response', response: ref(who + '-policy.txt', text) };
    });
    const json = JSON.stringify(p); put(f.dir, 'policy.json', json); f.w.import_policy = ref('policy.json', json); f.save(); await f.prepare();
    const s = f.w.stages[4], j = f.jobs.codex.at(-1); put(f.dir, 'native-task.txt', j.task); put(f.dir, 'native-response.txt', j.response);
    s.reviews[0] = { participant: 'codex', source: 'native_codex_import', job_id: j.id, agent_id: '/root/reviewer', thread_id: 'actual-thread-id',
      source_record: 'tool response', finishedAt: j.finishedAt, task: ref('native-task.txt', j.task), response: ref('native-response.txt', j.response) }; f.save();
    const result = await f.check(); assert.match(result.accepted.at(-1).votes[0].warning, /не аутентифицированы/);
    put(f.dir, 'native-response.txt', 'ПРИНЯТО'); s.reviews[0].response = ref('native-response.txt', 'ПРИНЯТО'); f.save();
    await rejected(() => f.check(), /самом импортированном/);
  });
  await test('реальные адаптеры AGY, Codex и Grok: схема карточек 86ed и снятие только служебного Grok footer', async () => {
    const adapter = cw.bridgeAdapter(), snapshot = 'a'.repeat(64), work = 'adapter-test', stage = 'pilot';
    for (const who of [...cw.QUORUM, 'grok']) {
      const id = 'wf-' + who, task = `workflow_work: ${work}\nworkflow_stage: ${stage}\nsnapshot_sha256: ${snapshot}`;
      const response = `snapshot_sha256: ${snapshot}\nПРИНЯТО`;
      const raw = who === 'grok' ? response + '\nконтроль ' + 'b'.repeat(64) + '\nКОНЕЦ ОТВЕТА\n' : response;
      const j = { id, task, status: 'done', role: 'проверка', finishedAt: '2026-10-03T17:00:00.000Z', model: who === 'antigravity' ? 'gemini-3.1-pro-high' : who === 'codex' ? 'gpt-6' : 'grok-4' };
      if (who === 'antigravity') { put(state, 'jobs/' + id + '/card.json', JSON.stringify(j)); put(state, 'jobs/' + id + '/result.txt', raw); put(state, 'jobs/' + id + '/meta.json', JSON.stringify({ hash: cw.sha(raw) })); }
      if (who === 'codex') { put(state, 'codex-jobs/' + id + '.json', JSON.stringify(j)); put(state, 'codex-jobs/' + id + '.attempt-0.result.txt', raw); }
      if (who === 'grok') { j.resultHash = cw.sha(raw); put(state, 'grok-jobs/' + id + '.json', JSON.stringify(j)); put(state, 'grok-jobs/' + id + '.result.txt', raw); }
      const vote = await cw.bridgeVote(adapter, who, { job_id: id, task_sha256: cw.sha(cw.taskText(j)), response_sha256: cw.sha(raw) }, work, stage, snapshot);
      assert.equal(vote.accepted, true);
      if (who === 'grok') {
        const unresolved = { id: 'wf-grok-new', task, role: 'проверка', status: 'stop_unconfirmed',
          startedAt: '2026-10-03T17:01:00.000Z', cancel_requested: { at: '2026-10-03T17:02:00.000Z', remote_ack: false },
          lateHash: cw.sha(raw), late_result: { receivedAt: '2026-10-03T17:03:00.000Z' } };
        put(state, 'grok-jobs/' + unresolved.id + '.json', JSON.stringify(unresolved));
        await rejected(() => cw.bridgeVote(adapter, who, { job_id: id, task_sha256: cw.sha(cw.taskText(j)), response_sha256: cw.sha(raw) }, work, stage, snapshot), /действующего/);
      }
    }
  });
  await test('CLI snapshot JSON и неверная команда exit 3', async () => {
    const f = fixture(), cli = path.join(__dirname, '../tools/consilium/workflow.js');
    const ok = spawnSync(process.execPath, [cli, 'snapshot', '--file', f.file, '--stage', 's0'], { encoding: 'utf8', env: process.env });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.equal(JSON.parse(ok.stdout).ready, false);
    const bad = spawnSync(process.execPath, [cli, 'exec', '--file', f.file], { encoding: 'utf8' }); assert.equal(bad.status, 3);
  });
  console.log(`Итого: пройдено ${passed}, провалено ${failed}, пропущено 0`);
  console.log('Изолированные данные тестов сохранены: ' + root); process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
