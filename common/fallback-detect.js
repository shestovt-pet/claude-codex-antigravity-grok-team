'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Advise-only: never enter/leave by itself. Auto-failover remains forbidden. */

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

function listDesktopReady(sharedStateDir) {
  const dir = path.join(sharedStateDir, 'ready');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => {
    const j = readJson(path.join(dir, n)) || {};
    return {
      name: n.replace(/\.json$/, ''),
      pid: j.pid,
      release: j.release,
      startedAt: j.startedAt,
      alive: alive(j.pid),
    };
  });
}

function claudeDesktopProcesses() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(claude|Claude)' } | Select-Object Name,ProcessId | ConvertTo-Json -Compress"],
      { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 2e6 },
    ).trim();
    if (!out) return [];
    const rows = JSON.parse(out);
    const list = Array.isArray(rows) ? rows : [rows];
    return list.filter((r) => Number.isInteger(r.ProcessId)).map((r) => ({ name: r.Name, pid: r.ProcessId }));
  } catch {
    return [];
  }
}

function readClaudeQuota(sharedStateDir) {
  return readJson(path.join(sharedStateDir, 'team', 'claude-quota.json'));
}

function sessionMode(fallbackDir) {
  const s = readJson(path.join(fallbackDir, 'session.json'));
  return s && typeof s.mode === 'string' ? s.mode : null;
}

function hostJobsPending(fallbackDir) {
  const dir = path.join(fallbackDir, 'jobs');
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const j = readJson(path.join(dir, name));
    if (!j) continue;
    if (j.archived) continue;
    if (j.status === 'done' || j.status === 'cancelled' || j.status === 'failed') continue;
    n += 1;
  }
  return n;
}

/**
 * Evaluate advice for enter/leave. Pure observation — does not mutate session.
 * opts: { sharedStateDir, fallbackDir, now, desktopReady, claudeProcs, claudeQuota, mode, pendingJobs }
 */
function evaluate(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const shared = opts.sharedStateDir || path.join(opts.repo || 'C:\\most', 'state');
  const fallbackDir = opts.fallbackDir || null;
  const desktopReady = opts.desktopReady || listDesktopReady(shared);
  const claudeProcs = opts.claudeProcs || claudeDesktopProcesses();
  const quota = opts.claudeQuota !== undefined ? opts.claudeQuota : readClaudeQuota(shared);
  const mode = opts.mode !== undefined ? opts.mode : (fallbackDir ? sessionMode(fallbackDir) : null);
  const pendingJobs = opts.pendingJobs !== undefined
    ? opts.pendingJobs
    : (fallbackDir ? hostJobsPending(fallbackDir) : 0);

  const teamReady = desktopReady.find((r) => r.name === 'team');
  const aliveReady = desktopReady.filter((r) => r.alive);
  const desktopAlive = claudeProcs.length > 0;
  const mcpAlive = !!(teamReady && teamReady.alive);

  const enterSignals = [];
  const leaveSignals = [];
  const notes = [];

  // ready/*.json is a start marker, not a heartbeat — treat dead PIDs as strong unavailability.
  if (!desktopAlive) enterSignals.push({ id: 'claude_process_absent', weight: 3, detail: 'Процесс Claude Desktop не найден' });
  if (!mcpAlive) enterSignals.push({ id: 'desktop_team_ready_dead', weight: 3, detail: 'state/ready/team.json PID мёртв или отсутствует' });
  if (desktopReady.length && aliveReady.length === 0) {
    enterSignals.push({ id: 'desktop_ready_all_dead', weight: 2, detail: 'Все desktop ready-маркеры мертвы' });
  }

  // Quota journal: only explicit percent/resets_at counts as limit signal. Session-call counters alone do not.
  if (quota && Number.isFinite(quota.percent)) {
    if (quota.percent <= 0) {
      const resetMs = quota.resets_at ? Date.parse(quota.resets_at) : NaN;
      if (!Number.isFinite(resetMs) || resetMs > now) {
        enterSignals.push({
          id: 'claude_quota_exhausted',
          weight: 2,
          detail: 'claude-quota.json percent=0' + (quota.resets_at ? ('; resets_at=' + quota.resets_at) : ''),
        });
      }
    }
  } else if (quota && quota.calls !== undefined) {
    notes.push('claude-quota.json — журнал сеанса Cowork, не Anthropic remaining%; сам по себе не включает fallback');
  } else {
    notes.push('Нет снимка квоты Claude Desktop (настоящего Anthropic quota API у Codex/Agy нет)');
  }

  // Leave signals when Claude looks available again.
  if (desktopAlive) leaveSignals.push({ id: 'claude_process_alive', weight: 3, detail: 'Процесс Claude Desktop найден (' + claudeProcs.length + ')' });
  if (mcpAlive) leaveSignals.push({ id: 'desktop_team_ready_alive', weight: 3, detail: 'state/ready/team.json жив' });
  if (quota && Number.isFinite(quota.percent) && quota.percent > 0) {
    leaveSignals.push({ id: 'claude_quota_remaining', weight: 1, detail: 'claude-quota.json percent=' + quota.percent });
  }
  if (quota && quota.resets_at && Number.isFinite(Date.parse(quota.resets_at)) && Date.parse(quota.resets_at) <= now) {
    leaveSignals.push({ id: 'claude_quota_reset_passed', weight: 1, detail: 'resets_at уже прошёл' });
  }
  if (mode === 'fallback' && pendingJobs === 0) {
    leaveSignals.push({ id: 'fallback_queue_drained', weight: 1, detail: 'В host jobs нет активных поручений' });
  } else if (mode === 'fallback' && pendingJobs > 0) {
    notes.push('Перед leave: активных host jobs = ' + pendingJobs);
  }

  notes.push('Agy remainingFraction для Claude — пул Antigravity, не подписка Claude Desktop; не используем как сигнал enter/leave Desktop');
  notes.push('Политика: advise_and_confirm — авто-enter/leave запрещены');

  const enterScore = enterSignals.reduce((n, s) => n + s.weight, 0);
  const leaveScore = leaveSignals.reduce((n, s) => n + s.weight, 0);

  let advice = 'hold';
  let reason = 'Недостаточно сигналов';
  if (mode === 'fallback') {
    if (leaveScore >= 6 && enterScore < 3) {
      advice = 'advise_leave';
      reason = 'Claude Desktop снова выглядит доступным; подтвердите leave';
    } else if (enterScore >= 3) {
      advice = 'hold_fallback';
      reason = 'Fallback уже активен; сигналы недоступности Claude ещё есть';
    } else {
      advice = 'hold_fallback';
      reason = 'Fallback активен; leave пока не рекомендуем';
    }
  } else if (enterScore >= 3) {
    advice = 'advise_enter';
    reason = 'Claude Desktop выглядит недоступным; подтвердите enter';
  }

  return {
    policy: 'advise_and_confirm',
    mode: mode || 'none',
    advice,
    reason,
    enterScore,
    leaveScore,
    enterSignals,
    leaveSignals,
    desktopAlive,
    mcpAlive,
    desktopReady,
    claudeProcs,
    pendingJobs,
    quota: quota
      ? {
          hasPercent: Number.isFinite(quota.percent),
          percent: Number.isFinite(quota.percent) ? quota.percent : null,
          resets_at: quota.resets_at || null,
          source: quota.source || null,
          taken_at: quota.taken_at || null,
          calls: quota.calls,
        }
      : null,
    notes,
    taken_at: new Date(now).toISOString(),
  };
}

module.exports = {
  evaluate,
  listDesktopReady,
  claudeDesktopProcesses,
  readClaudeQuota,
  sessionMode,
  hostJobsPending,
};