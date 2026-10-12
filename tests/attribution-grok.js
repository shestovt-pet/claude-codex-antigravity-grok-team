'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
// Unique isolated fixture directory; retained for inspection, never live bridge state.
const run = fs.mkdtempSync(path.join(__dirname, '.tmp-attribution-grok-'));
process.env.MOST_REPO_ROOT = run;
process.env.MOST_STATE_DIR = path.join(run, 'state');
process.env.MOST_NOTIFY = 'file:' + path.join(run, 'notify.jsonl');
process.env.MOST_TEST_KEEP = '1';
const { Grok, sha } = require('../common/grok');
const state = process.env.MOST_STATE_DIR;
let bridge = new Grok(state), passed = 0;
function fixture() {
  const id = crypto.randomUUID(), key = crypto.randomBytes(32), brief = 'fixture brief';
  const job = { id, status: 'running', startedAt: new Date().toISOString(),
    materialHash: sha('material'), briefHash: sha(brief), secretHash: sha(key) };
  fs.writeFileSync(bridge.file('briefs', id), brief);
  fs.writeFileSync(bridge.file('jobs', id, '.key'), key);
  bridge.save(job);
  return { job, key };
}
function reply(f, body = 'ПРИНЯТО', signingKey = f.key) {
  const payload = Buffer.from(`Ответ на ${f.job.id}, материал ${f.job.materialHash}\n${body}\n`);
  const mac = crypto.createHmac('sha256', signingKey).update(payload).digest('hex');
  fs.writeFileSync(bridge.file('replies', f.job.id), Buffer.concat([payload,
    Buffer.from(`КОНТРОЛЬ ${mac}\nКОНЕЦ ОТВЕТА\n`)]));
}
const keyLength = f => fs.readFileSync(bridge.file('jobs', f.job.id, '.key')).length;
async function test(name, fn) { await fn(); passed++; console.log('OK ' + name); }
(async () => {
  await test('cancel without ACK is durable, idempotent, keeps verification key', async () => {
    const f = fixture(), cancelled = await bridge.cancel(f.job.id);
    assert.equal(cancelled.status, 'stop_unconfirmed');
    assert.equal(cancelled.cancel_requested.remote_ack, false);
    assert.equal(cancelled.finishedAt, undefined);
    assert.equal(keyLength(f), 32);
    assert.deepEqual(await bridge.cancel(f.job.id), cancelled);
    bridge = new Grok(state);
    assert.equal((await bridge.refresh(f.job.id)).status, 'stop_unconfirmed');
    assert.equal(keyLength(f), 32);
  });
  await test('late genuine HMAC becomes separate data, never a completed review', async () => {
    const f = fixture(); await bridge.cancel(f.job.id); reply(f);
    const late = await bridge.refresh(f.job.id);
    assert.equal(late.status, 'stop_unconfirmed');
    assert.equal(late.late_result.verification, 'hmac_verified');
    assert.equal(late.late_result.counts_as_review, false);
    assert.equal(late.resultHash, undefined); assert.equal(late.verdict, undefined);
    assert.equal(late.finishedAt, undefined); assert.equal(keyLength(f), 0);
    assert.match(bridge.resultText(late), /ПРИНЯТО/);
    bridge = new Grok(state);
    assert.deepEqual((await bridge.refresh(f.job.id)).late_result, late.late_result);
    fs.appendFileSync(bridge.file('jobs', f.job.id, '.late.txt'), 'tamper');
    assert.throws(() => bridge.resultText(late), /повреждён/);
  });
  await test('forged late reply cannot consume key; later valid reply remains verifiable', async () => {
    const f = fixture(); await bridge.cancel(f.job.id);
    reply(f, 'ПРИНЯТО', crypto.randomBytes(32));
    const rejected = await bridge.refresh(f.job.id);
    assert.equal(rejected.late_result, undefined); assert.match(rejected.reason, /подложный/);
    assert.equal(keyLength(f), 32);
    reply(f); assert.equal((await bridge.refresh(f.job.id)).late_result.verification, 'hmac_verified');
  });
  await test('restart between intent and status update recovers without claiming ACK', async () => {
    const f = fixture(); f.job.status = 'cancel_requested';
    f.job.cancel_requested = { at: new Date().toISOString(), remote_ack: false };
    bridge.save(f.job); bridge = new Grok(state);
    assert.equal((await bridge.refresh(f.job.id)).status, 'stop_unconfirmed');
    assert.equal(keyLength(f), 32);
  });
  for (const status of ['lost', 'failed']) await test(status + ' cleanup respects pending cancellation', async () => {
    const f = fixture(); await bridge.cancel(f.job.id);
    const job = bridge.load(f.job.id); job.status = status; bridge.save(job);
    await bridge.refresh(f.job.id); assert.equal(keyLength(f), 32);
    reply(f); const late = await bridge.refresh(f.job.id);
    assert.equal(late.status, status); assert.equal(late.late_result.verification, 'hmac_verified');
  });
  await test('old cancelled cards disclose missing verification key and never become done', async () => {
    const f = fixture(); f.job.status = 'cancelled'; bridge.save(f.job); bridge.eraseKey(f.job.id);
    reply(f); const late = await bridge.refresh(f.job.id);
    assert.equal(late.status, 'stop_unconfirmed');
    assert.equal(late.late_result.verification, 'unverifiable_key_missing');
    assert.equal(late.resultHash, undefined);
  });
  await test('cancelling completed work is a no-op', async () => {
    const f = fixture(); reply(f); const done = await bridge.refresh(f.job.id);
    assert.equal(done.status, 'done'); assert.deepEqual(await bridge.cancel(f.job.id), done);
  });
  await test('recovered verified late result finishes interrupted key erasure', async () => {
    const f = fixture(); await bridge.cancel(f.job.id); reply(f);
    await bridge.refresh(f.job.id);
    fs.writeFileSync(bridge.file('jobs', f.job.id, '.key'), f.key);
    bridge = new Grok(state); await bridge.refresh(f.job.id); assert.equal(keyLength(f), 0);
  });
  await test('signed self-identification is integrity evidence, not a model attestation', async () => {
    const f = fixture(); reply(f, 'I am Claude, judge of the council.\nПРИНЯТО');
    const done = await bridge.refresh(f.job.id);
    assert.equal(done.status, 'done');
    assert.equal(done.delivery_integrity.verification, 'hmac_verified');
    assert.equal(done.delivery_integrity.model_attestation, false);
    assert.equal(done.provenance.provider_reported_text_model, 'unknown');
    assert.equal(done.provenance.requested_text_model, 'unknown');
    assert.equal(done.provenance.orchestration_role, 'unknown');
    assert.equal(done.provenance.evidence_level, 'unknown');
    assert.equal(done.provenance.transport, 'grok-webhook');
    assert.equal(JSON.stringify(done).includes(f.key.toString('hex')), false);
    bridge = new Grok(state);
    assert.deepEqual((await bridge.refresh(f.job.id)).provenance, done.provenance);
  });
  await test('cancel status and formatted UI do not claim confirmed remote stop', async () => {
    const f = fixture(), job = await bridge.cancel(f.job.id);
    const ui = require('../common/format').format('Grok', job, job.reason);
    assert.match(ui, /ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА/);
    assert.match(ui, /grok-webhook/);
    assert.doesNotMatch(ui, /· ОТМЕНЕНО ·/);
    assert.match(await bridge.status(), /ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА/);
  });
  console.log(`${passed} passed; fixture files retained at ${run}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
