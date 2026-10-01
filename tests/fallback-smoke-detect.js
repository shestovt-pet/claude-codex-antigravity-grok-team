'use strict';
const assert = (c, m) => { if (!c) throw new Error(m); };
const detect = require('../common/fallback-detect');

// 1) advise enter when Claude/process/MCP dead
{
  const r = detect.evaluate({
    mode: 'left',
    desktopReady: [{ name: 'team', pid: 1, alive: false }],
    claudeProcs: [],
    claudeQuota: null,
    pendingJobs: 0,
    now: Date.parse('2026-10-01T12:00:00Z'),
  });
  assert(r.policy === 'advise_and_confirm', 'policy');
  assert(r.advice === 'advise_enter', 'want enter got ' + r.advice);
  assert(r.enterScore >= 3, 'enterScore');
}

// 2) advise leave when desktop alive + team ready + queue drained while in fallback
{
  const r = detect.evaluate({
    mode: 'fallback',
    desktopReady: [{ name: 'team', pid: 42, alive: true }],
    claudeProcs: [{ name: 'claude.exe', pid: 99 }],
    claudeQuota: { calls: 1, source: 'журнал', taken_at: '2026-09-27T08:58:49Z' },
    pendingJobs: 0,
    now: Date.parse('2026-10-01T12:00:00Z'),
  });
  assert(r.advice === 'advise_leave', 'want leave got ' + r.advice + ' leave=' + r.leaveScore + ' enter=' + r.enterScore);
}

// 3) session journal alone must NOT force enter
{
  const r = detect.evaluate({
    mode: null,
    desktopReady: [{ name: 'team', pid: 42, alive: true }],
    claudeProcs: [{ name: 'claude.exe', pid: 99 }],
    claudeQuota: { calls: 94, written: 1, reread: 1, window_h: 5, source: 'журнал сеанса Cowork (5 ч)', taken_at: '2026-09-27T08:58:49Z' },
    pendingJobs: 0,
    now: Date.parse('2026-10-01T12:00:00Z'),
  });
  assert(r.advice === 'hold', 'journal must not enter: ' + r.advice);
  assert(r.notes.some((n) => /журнал сеанса/.test(n)), 'note about journal');
}

// 4) explicit percent=0 recommends enter
{
  const r = detect.evaluate({
    mode: 'left',
    desktopReady: [{ name: 'team', pid: 42, alive: true }],
    claudeProcs: [{ name: 'claude.exe', pid: 99 }],
    claudeQuota: { percent: 0, resets_at: '2026-10-02T00:00:00Z', source: 'ui', taken_at: '2026-10-01T10:00:00Z' },
    pendingJobs: 0,
    now: Date.parse('2026-10-01T12:00:00Z'),
  });
  assert(r.enterSignals.some((s) => s.id === 'claude_quota_exhausted'), 'quota signal');
  // alone weight 2 < 3, so hold unless other signals — document threshold
  assert(r.advice === 'hold', 'quota alone weight 2 should hold');
}

// 5) percent=0 + dead team => enter
{
  const r = detect.evaluate({
    mode: null,
    desktopReady: [{ name: 'team', pid: 1, alive: false }],
    claudeProcs: [],
    claudeQuota: { percent: 0, resets_at: '2026-10-02T00:00:00Z', source: 'ui', taken_at: '2026-10-01T10:00:00Z' },
    pendingJobs: 0,
    now: Date.parse('2026-10-01T12:00:00Z'),
  });
  assert(r.advice === 'advise_enter', 'dead+quota enter');
}

// 6) never claims auto enter
{
  const r = detect.evaluate({ mode: 'left', desktopReady: [], claudeProcs: [], claudeQuota: null, pendingJobs: 0 });
  assert(r.policy === 'advise_and_confirm', 'no auto');
}

console.log(JSON.stringify({ ok: true, cases: 6 }, null, 2));
