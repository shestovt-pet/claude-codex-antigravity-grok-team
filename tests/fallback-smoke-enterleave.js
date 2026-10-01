'use strict';
const fs = require('fs');
const path = require('path');
const assert = (c, m) => { if (!c) throw new Error(m); };
const host = require('C:/most/tools/host-fallback.js');
const confirm = require('C:/most/common/user-confirm.js');

const smokeDir = path.join('C:/most/.work/_grok_fallback_conductor', 'state-smoke', 'enterleave-' + Date.now());
fs.mkdirSync(smokeDir, { recursive: true });
const opts = { fallbackDir: smokeDir, sharedState: false };

function reveal(id) {
  process.env.MOST_FALLBACK_HUMAN = '1';
  return confirm.revealToken(smokeDir, id);
}

(async () => {
  const chIn = host.confirmRequest({ ...opts, action: 'enter' });
  assert(!chIn.token, 'no token in request response');
  const tokIn = reveal(chIn.id);
  const entered = await host.enter({ ...opts, confirmId: chIn.id, confirmToken: tokIn.token });
  assert(entered.session.mode === 'fallback', 'not fallback');
  assert(entered.session.generation === 1, 'gen1');
  const owned = (entered.hostReady || []).filter((x) => x.owned);
  assert(owned.length === 4, 'owned ' + owned.length);

  // leave bumps generation
  const chOut = host.confirmRequest({ ...opts, action: 'leave' });
  const tokOut = reveal(chOut.id);
  const left = await host.leave({ ...opts, confirmId: chOut.id, confirmToken: tokOut.token });
  assert(left.mode === 'left' && left.stop.allDead === true, 'leave failed');
  assert(left.generation === 2, 'generation not bumped on leave: ' + left.generation);

  // old enter challenge generation no longer matches for jobs at gen1... pending confirms for gen1 should fail on gen2
  const chOld = host.confirmRequest({ ...opts, action: 'jobs.enqueue', meta: { who: 'codex' }, generation: 1 });
  // force-create with generation 1 via module
  // actually confirmRequest uses currentGeneration which is now 2; create with explicit:
  const forced = confirm.createChallenge(smokeDir, { action: 'jobs.enqueue', generation: 1, meta: { who: 'codex' } });
  process.env.MOST_FALLBACK_HUMAN = '1';
  const tokForced = confirm.revealToken(smokeDir, forced.id);
  let stale = false;
  try {
    await host.enqueueJob({ ...opts, who: 'codex', task: 'should fail', confirmId: forced.id, confirmToken: tokForced.token });
  } catch (e) { stale = /generation mismatch/i.test(e.message); }
  assert(stale, 'stale generation confirm must fail after leave');

  console.log(JSON.stringify({ ok: true, smokeDir, owned: owned.map((x) => x.name), leaveGen: left.generation }, null, 2));
})().catch((e) => { console.error('ENTERLEAVE FAIL', e); process.exit(1); });