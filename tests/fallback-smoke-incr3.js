'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = (c, m) => { if (!c) throw new Error(m); };
const host = require('C:/most/tools/host-fallback.js');
const confirm = require('C:/most/common/user-confirm.js');
const proposed = require('C:/most/common/proposed-actions.js');

const smokeDir = path.join('C:/most/.work/_grok_fallback_conductor', 'state-smoke', 'incr3-' + Date.now());
fs.mkdirSync(smokeDir, { recursive: true });
const opts = { fallbackDir: smokeDir, sharedState: false };

function reveal(id) {
  process.env.MOST_FALLBACK_HUMAN = '1';
  return confirm.revealToken(smokeDir, id);
}

(async () => {
  let forged = false;
  try {
    proposed.parseProposal('FALLBACK_ACTIONS_BEGIN\n{"version":1,"actions":[{"type":"jobs.stop","who":"codex","id":"x","note":"who=claude"}]}\nFALLBACK_ACTIONS_END');
  } catch (e) { forged = /who=claude|forbidden/i.test(e.message); }
  assert(forged, 'must reject who=claude');

  const text = ['FALLBACK_ACTIONS_BEGIN', JSON.stringify({ version: 1, source: 'grok', actions: [{ type: 'jobs.list' }, { type: 'status' }] }), 'FALLBACK_ACTIONS_END'].join('\n');
  const ingested = host.actionsIngest({ ...opts, text });
  const rec = proposed.loadProposal(smokeDir, ingested.stored.id);
  const contentHash = crypto.createHash('sha256').update(JSON.stringify({ id: rec.id, actions: rec.actions, source: rec.source }), 'utf8').digest('hex');

  const ch = host.confirmRequest({ ...opts, action: 'actions.apply', meta: { id: ingested.stored.id }, targetHash: contentHash });
  assert(!ch.token, 'no token to agent');
  const tok = reveal(ch.id);

  // Tamper proposal after confirm
  rec.actions.push({ type: 'status' });
  fs.writeFileSync(path.join(smokeDir, 'proposed-actions', ingested.stored.id + '.json'), JSON.stringify(rec, null, 2));

  let tamper = false;
  try {
    await host.actionsApply({ ...opts, id: ingested.stored.id, confirmId: ch.id, confirmToken: tok.token });
  } catch (e) { tamper = /targetHash|content changed|mismatch/i.test(e.message); }
  assert(tamper, 'tampered proposal must fail apply');

  // Fresh proposal + confirm + apply
  const text2 = ['FALLBACK_ACTIONS_BEGIN', JSON.stringify({ version: 1, source: 'grok', actions: [{ type: 'status' }] }), 'FALLBACK_ACTIONS_END'].join('\n');
  const ing2 = host.actionsIngest({ ...opts, text: text2 });
  const rec2 = proposed.loadProposal(smokeDir, ing2.stored.id);
  const hash2 = crypto.createHash('sha256').update(JSON.stringify({ id: rec2.id, actions: rec2.actions, source: rec2.source }), 'utf8').digest('hex');
  const ch2 = host.confirmRequest({ ...opts, action: 'actions.apply', meta: { id: ing2.stored.id }, targetHash: hash2 });
  const tok2 = reveal(ch2.id);
  const applied = await host.actionsApply({ ...opts, id: ing2.stored.id, confirmId: ch2.id, confirmToken: tok2.token });
  assert(applied.applied.status === 'applied', 'apply failed');

  console.log(JSON.stringify({ ok: true, increment: 3, smokeDir, checks: ['reject-who-claude', 'tamper-detect', 'apply-ok'] }, null, 2));
})().catch((e) => { console.error('SMOKE3 FAIL', e); process.exit(1); });