'use strict';
// E2E: propose → confirm-request → reveal → confirm (isolated fallback dir)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const implRoot = path.resolve(__dirname, '..');
const rolesPath = path.join(implRoot, 'common', 'task-roles.js');
const cli = path.join(implRoot, 'tools', 'task-roles-cli.js');
const roles = require(rolesPath);
const confirm = require('C:/most/common/user-confirm.js');

function assert(c, m) { if (!c) throw new Error('FAIL: ' + m); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'most-roles-e2e-'));
const worksRoot = path.join(tmp, 'works');
const fallbackDir = path.join(tmp, 'fallback');
fs.mkdirSync(worksRoot, { recursive: true });
fs.mkdirSync(fallbackDir, { recursive: true });

const detect = { advice: 'advise_enter', desktopAlive: false, mcpAlive: false };
const proposed = roles.propose({
  worksRoot, fallbackDir, work: 'e2e-1', kind: 'fallback', by: 'rules', detect,
});
assert(proposed.slots.orchestrator === 'grok', 'orch grok');

const challenge = confirm.createChallenge(fallbackDir, {
  action: 'roles.confirm',
  generation: proposed.generation || 0,
  meta: { work: 'e2e-1', contentHash: proposed.contentHash },
  targetHash: proposed.contentHash,
});
assert(challenge.id, 'challenge id');

process.env.MOST_FALLBACK_HUMAN = '1';
const revealed = confirm.revealToken(fallbackDir, challenge.id);
assert(revealed.token, 'token');

const used = confirm.consume(fallbackDir, {
  id: challenge.id,
  token: revealed.token,
  action: 'roles.confirm',
  generation: proposed.generation || 0,
  meta: { work: 'e2e-1', contentHash: proposed.contentHash },
  targetHash: proposed.contentHash,
});
assert(used.id === challenge.id, 'consumed');

const confirmed = roles.confirm({
  worksRoot, fallbackDir, work: 'e2e-1',
  confirmId: used.id, contentHash: proposed.contentHash, detect,
});
assert(confirmed.status === 'confirmed', 'confirmed');

// CLI propose smoke
const r = spawnSync(process.execPath, [cli, 'propose', '--work', 'e2e-cli', '--kind', 'review', '--works-root', worksRoot, '--fallback-dir', fallbackDir], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { MOST_REPO_ROOT: implRoot }),
});
// CLI resolveRepo points to impl parent (.. of tools) = implRoot when MOST_REPO_ROOT set; task-roles loads from common under repo OR .work path.
// Our cli looks for common/task-roles.js under MOST_REPO_ROOT — copy or point works.
console.log('cli status', r.status, (r.stdout || '').slice(0, 200), (r.stderr || '').slice(0, 200));

console.log(JSON.stringify({ ok: true, tmp, work: 'e2e-1', status: confirmed.status, slots: confirmed.slots }, null, 2));
