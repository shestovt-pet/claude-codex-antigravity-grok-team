'use strict';
const path = require('path');
const fs = require('fs');
const assert = (c, m) => { if (!c) throw new Error(m); };
const access = require('C:/most/common/access.js');
const host = require('C:/most/tools/host-fallback.js');

const smokeDir = path.join('C:/most/.work/_grok_fallback_conductor', 'state-smoke', 'incr4-' + Date.now());
fs.mkdirSync(smokeDir, { recursive: true });
fs.writeFileSync(path.join(smokeDir, 'session.json'), JSON.stringify({
  mode: 'fallback', conductor: 'user+host', authority: 'user', generation: 1,
}, null, 2));

const saved = process.env.MOST_CLIENT;
const savedAuth = process.env.MOST_AUTHORITY;
const savedFb = process.env.MOST_FALLBACK_DIR;
delete process.env.MOST_CLIENT;
delete process.env.MOST_AUTHORITY;
process.env.MOST_FALLBACK_DIR = smokeDir;

try {
  assert(access.client() === 'unknown', 'empty client unknown');
  assert(access.guest({ fallbackDir: smokeDir }) === true, 'unknown guest');

  process.env.MOST_CLIENT = 'claude';
  assert(access.guest({ fallbackDir: smokeDir }) === true, 'claude+authority=user is guest');
  let denied = false;
  try { access.guard('team', 'team_change', {}, { fallbackDir: smokeDir }); } catch (e) { denied = true; }
  assert(denied, 'team_change denied under authority=user');

  // MOST_AUTHORITY spoof must not override active fallback session
  process.env.MOST_AUTHORITY = 'claude';
  assert(access.authority({ fallbackDir: smokeDir }) === 'user', 'session wins over env spoof');
  assert(access.guest({ fallbackDir: smokeDir }) === true, 'still guest under spoof');
  let spoofDenied = false;
  try { access.guard('team', 'team_change', {}, { fallbackDir: smokeDir }); } catch (e) { spoofDenied = true; }
  assert(spoofDenied, 'team_change denied under MOST_AUTHORITY spoof');
  delete process.env.MOST_AUTHORITY;

  // Peer as authority blocked when no user session overrides
  delete process.env.MOST_FALLBACK_DIR;
  const emptyDir = path.join('C:/most/.work/_grok_fallback_conductor', 'state-smoke', 'incr4-empty-' + Date.now());
  fs.mkdirSync(emptyDir, { recursive: true });
  process.env.MOST_AUTHORITY = 'grok';
  process.env.MOST_CLIENT = 'codex';
  let peer = false;
  try { access.assertPeerNotJudge({ fallbackDir: emptyDir }); } catch (e) { peer = /peer|gate judge/i.test(e.message); }
  assert(peer, 'peer authority blocked');
  delete process.env.MOST_AUTHORITY;

  process.env.MOST_FALLBACK_DIR = smokeDir;
  const desc = host.status({ fallbackDir: smokeDir, sharedState: false }).accessDraft;
  assert(desc.emptyClientDefaultsToClaude === false, 'flag');
  assert(desc.claudeClientIgnoresAuthority === false, 'claudeClientIgnoresAuthority false');

  console.log(JSON.stringify({ ok: true, increment: 4, smokeDir, describe: desc }, null, 2));
} finally {
  if (saved === undefined) delete process.env.MOST_CLIENT; else process.env.MOST_CLIENT = saved;
  if (savedAuth === undefined) delete process.env.MOST_AUTHORITY; else process.env.MOST_AUTHORITY = savedAuth;
  if (savedFb === undefined) delete process.env.MOST_FALLBACK_DIR; else process.env.MOST_FALLBACK_DIR = savedFb;
}