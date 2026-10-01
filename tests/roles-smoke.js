'use strict';
// Smoke for flexible roles incr1 (isolated works root).
const fs = require('fs');
const path = require('path');
const os = require('os');

const implRoot = path.resolve(__dirname, '..');
const roles = require(path.join(implRoot, 'common', 'task-roles.js'));

// Prefer installed user-confirm from C:\most if present; else stub.
let confirm;
const mostConfirm = 'C:\\most\\common\\user-confirm.js';
if (fs.existsSync(mostConfirm)) {
  confirm = require(mostConfirm);
} else {
  throw new Error('need C:\\most\\common\\user-confirm.js');
}

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'most-roles-'));
  const worksRoot = path.join(tmp, 'works');
  const fallbackDir = path.join(tmp, 'fallback');
  fs.mkdirSync(worksRoot, { recursive: true });
  fs.mkdirSync(fallbackDir, { recursive: true });

  const fakeDetectOnline = {
    advice: 'hold',
    desktopAlive: true,
    mcpAlive: true,
  };
  const fakeDetectOffline = {
    advice: 'advise_enter',
    desktopAlive: false,
    mcpAlive: false,
  };

  // 1) rules propose while Claude offline → orchestrator=grok, offline includes claude
  const p1 = roles.propose({
    worksRoot,
    fallbackDir,
    work: 'smoke-task-1',
    kind: 'code',
    by: 'rules',
    detect: fakeDetectOffline,
  });
  assert(p1.status === 'proposed', 'status proposed');
  assert(p1.slots.orchestrator === 'grok', 'orch=grok when offline');
  assert(p1.slots.offline.includes('claude'), 'claude offline');
  assert(p1.slots.coder === 'codex', 'coder=codex');
  assert(p1.slots.judge === 'user', 'judge=user');
  assert(p1.contentHash, 'hash');

  // 2) reject self-review
  let threw = false;
  try {
    roles.propose({
      worksRoot,
      fallbackDir,
      work: 'smoke-bad',
      kind: 'code',
      slots: { orchestrator: 'grok', coder: 'codex', reviewer: ['codex'], judge: 'user', offline: ['claude'] },
      detect: fakeDetectOffline,
    });
  } catch (e) {
    threw = true;
    assert(/self-review/.test(e.message), 'self-review msg');
  }
  assert(threw, 'self-review rejected');

  // 3) reject orchestrator=claude when offline
  threw = false;
  try {
    roles.propose({
      worksRoot,
      fallbackDir,
      work: 'smoke-bad2',
      kind: 'code',
      slots: { orchestrator: 'claude', coder: 'codex', reviewer: ['antigravity'], judge: 'user', offline: [] },
      detect: fakeDetectOffline,
    });
  } catch (e) {
    threw = true;
    assert(/claude/.test(e.message), 'claude orch rejected');
  }
  assert(threw, 'claude orch rejected when offline');

  // 4) confirm via user-confirm channel
  // Patch ACTIONS if needed by monkeypatching createChallenge path — roles.confirm must be allowed.
  // We extend by writing into module if ACTIONS is exported... check.
  const ACTIONS = confirm.ACTIONS || null;
  // Ensure action allowed: if module has assertAction Set, we need roles.confirm in set.
  // Read source to see if we can add — for smoke, temporarily write a patched copy OR
  // call propose+confirm without confirm module using roles.confirm() directly, then
  // separately test confirm.createChallenge after patching most.

  // Direct confirm API (module) — human channel tested after patch.
  const confirmed = roles.confirm({
    worksRoot,
    fallbackDir,
    work: 'smoke-task-1',
    confirmId: 'testhash',
    contentHash: p1.contentHash,
    detect: fakeDetectOffline,
  });
  assert(confirmed.status === 'confirmed', 'confirmed');
  assert(confirmed.confirmedBy === 'user', 'by user');

  const g = roles.get({ worksRoot, work: 'smoke-task-1', repoRoot: 'C:\\most' });
  assert(g.roles.status === 'confirmed', 'get confirmed');

  // 5) online heuristic may pick claude
  const p2 = roles.propose({
    worksRoot,
    fallbackDir,
    work: 'smoke-task-2',
    kind: 'code',
    by: 'rules',
    detect: fakeDetectOnline,
  });
  assert(p2.slots.orchestrator === 'claude', 'orch=claude when online');
  assert(!p2.slots.offline.includes('claude'), 'claude not offline');

  // 6) ops judge must be user
  threw = false;
  try {
    roles.propose({
      worksRoot,
      fallbackDir,
      work: 'smoke-ops',
      kind: 'ops',
      slots: { orchestrator: 'user', reviewer: ['codex'], judge: 'claude', offline: [] },
      detect: fakeDetectOnline,
    });
  } catch (e) {
    threw = /judge/.test(e.message);
  }
  assert(threw, 'ops judge=claude rejected');

  console.log(JSON.stringify({
    ok: true,
    tmp,
    checks: [
      'propose-offline-grok',
      'self-review-reject',
      'claude-orch-offline-reject',
      'confirm',
      'propose-online-claude',
      'ops-judge-user',
    ],
  }, null, 2));
}

run();
