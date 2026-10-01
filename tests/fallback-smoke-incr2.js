'use strict';
const fs = require('fs');
const path = require('path');
const assert = (c, m) => { if (!c) throw new Error(m); };
const host = require('C:/most/tools/host-fallback.js');
const confirm = require('C:/most/common/user-confirm.js');
const smokeDir = path.join('C:/most/.work/_grok_fallback_conductor', 'state-smoke', 'incr2-' + Date.now());
fs.mkdirSync(smokeDir, { recursive: true });

function reveal(id) {
  const prev = process.env.MOST_FALLBACK_HUMAN;
  process.env.MOST_FALLBACK_HUMAN = '1';
  try { return confirm.revealToken(smokeDir, id); }
  finally {
    if (prev === undefined) delete process.env.MOST_FALLBACK_HUMAN;
    else process.env.MOST_FALLBACK_HUMAN = prev;
  }
}

(async () => {
  const opts = { fallbackDir: smokeDir, sharedState: false };
  delete process.env.MOST_FALLBACK_HUMAN;
  const chAgent = host.confirmRequest({ ...opts, action: 'enter' });
  assert(!chAgent.token, 'agent must not receive token');
  assert(!chAgent.tokenPath, 'agent must not receive tokenPath');

  let deny = false;
  try { confirm.revealToken(smokeDir, chAgent.id); } catch (e) { deny = /MOST_FALLBACK_HUMAN/i.test(e.message); }
  assert(deny, 'reveal must deny agents');

  let badPath = false;
  try { host.status({ fallbackDir: 'C:\\\\most\\\\state', sharedState: false }); }
  catch (e) { badPath = /forbidden|allowed draft/i.test(e.message); }
  assert(badPath, 'C:\\\\most\\\\state must be rejected');

  let failed = false;
  try { await host.enter({ ...opts, legacyUserConfirm: true }); } catch (e) { failed = /confirm/i.test(e.message); }
  assert(failed, 'enter without confirm-id should fail');

  const chEnq = host.confirmRequest({ ...opts, action: 'jobs.enqueue', meta: { who: 'codex' } });
  const tokEnq = reveal(chEnq.id);
  const enq = await host.enqueueJob({
    ...opts, who: 'codex', task: 'smoke enqueue task text',
    confirmId: chEnq.id, confirmToken: tokEnq.token,
  });
  assert(enq.status === 'queued', 'enqueue failed');

  const chStop = host.confirmRequest({ ...opts, action: 'jobs.stop', meta: { who: 'codex', id: enq.id } });
  const tokStop = reveal(chStop.id);
  const stopped = await host.stopJob({
    ...opts, who: 'codex', id: enq.id,
    confirmId: chStop.id, confirmToken: tokStop.token,
  });
  assert(stopped.status === 'cancelling' || stopped.status === 'cancelled', 'stop failed: ' + stopped.status);

  console.log(JSON.stringify({ ok: true, increment: 2, smokeDir, enqueued: enq.id }, null, 2));
})().catch((e) => { console.error('SMOKE2 FAIL', e); process.exit(1); });