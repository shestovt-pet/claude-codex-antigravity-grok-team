'use strict';
/**
 * Intent write-bridge for collegium dashboard (JUDGE-write 2026-10-02).
 * SoT: works/<work>/_handoff/intents/<id>.json
 * Flow: draft → confirm → enqueue (file ± host jobs-enqueue / CLI fallback).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { repoRoot } = require('../../../common/paths');

const AGENTS = new Set(['codex', 'antigravity', 'grok']);
const WORK_RE = /^[a-z0-9-]{1,40}$/;
const ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const TASK_MAX = 20000;

function intentsDir(work) {
  return path.join(repoRoot, 'works', work, '_handoff', 'intents');
}

function intentPath(work, id) {
  return path.join(intentsDir(work), id + '.json');
}

function assertWork(work) {
  if (!work || !WORK_RE.test(work)) {
    throw Object.assign(new Error('bad work name'), { status: 400 });
  }
  const base = path.join(repoRoot, 'works', work);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw Object.assign(new Error('work folder not found'), { status: 404 });
  }
  const card = path.join(repoRoot, 'works', work + '.json');
  if (!fs.existsSync(card)) {
    throw Object.assign(new Error('work card not found'), { status: 404 });
  }
}

function assertInside(file, root) {
  const resolved = path.resolve(file);
  const rootR = path.resolve(root);
  if (!(resolved === rootR || resolved.startsWith(rootR + path.sep))) {
    throw Object.assign(new Error('path outside allowlist'), { status: 403 });
  }
}

function readIntent(work, id) {
  assertWork(work);
  if (!id || !ID_RE.test(id)) throw Object.assign(new Error('bad intent id'), { status: 400 });
  const file = intentPath(work, id);
  assertInside(file, intentsDir(work));
  if (!fs.existsSync(file)) throw Object.assign(new Error('intent not found'), { status: 404 });
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeIntent(rec) {
  assertWork(rec.work);
  const dir = intentsDir(rec.work);
  fs.mkdirSync(dir, { recursive: true });
  const file = intentPath(rec.work, rec.id);
  assertInside(file, dir);
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { ...rec, path: file };
}

function listIntents({ work, status, limit = 80 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 80, 1), 200);
  let works = [];
  if (work) {
    assertWork(work);
    works = [work];
  } else {
    const root = path.join(repoRoot, 'works');
    works = fs.readdirSync(root).filter((n) => {
      try {
        return fs.statSync(path.join(root, n)).isDirectory()
          && fs.existsSync(path.join(root, n, '_handoff', 'intents'));
      } catch { return false; }
    });
  }
  const all = [];
  for (const w of works) {
    const dir = intentsDir(w);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (status && rec.status !== status) continue;
        all.push({
          id: rec.id,
          work: rec.work || w,
          who: rec.who,
          status: rec.status,
          task_preview: String(rec.task || '').slice(0, 140),
          createdAt: rec.createdAt,
          confirmedAt: rec.confirmedAt || null,
          enqueuedAt: rec.enqueuedAt || null,
          jobId: rec.jobId || null,
          channel: rec.channel || null,
          dispatchStatus: rec.dispatchStatus || null,
          jobStatus: rec.jobStatus || null,
          path: path.join(dir, name),
        });
      } catch { /* skip bad */ }
    }
  }
  all.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  return { total_matched: all.length, returned: Math.min(all.length, lim), intents: all.slice(0, lim) };
}

function buildCli(rec, confirmId) {
  const fb = path.join(repoRoot, 'scripts', 'fallback.cmd');
  const taskEsc = String(rec.task).replace(/"/g, '\\"');
  const lines = [
    fb + ' confirm-request jobs.enqueue --who ' + rec.who,
    fb + ' confirm-reveal <confirmId>',
    fb + ' jobs-enqueue --who ' + rec.who
      + ' --work ' + rec.work
      + ' --task "' + taskEsc + '"'
      + ' --confirm-id <confirmId> --confirm-token <token>',
  ];
  if (confirmId) {
    lines[1] = fb + ' confirm-reveal ' + confirmId;
    lines[2] = fb + ' jobs-enqueue --who ' + rec.who
      + ' --work ' + rec.work
      + ' --task "' + taskEsc + '"'
      + ' --confirm-id ' + confirmId + ' --confirm-token <token-from-reveal>';
  }
  return lines;
}

function detectFallback() {
  try {
    const data = require('./data');
    if (typeof data.getFallbackStatus === 'function') return data.getFallbackStatus();
  } catch { /* ignore */ }
  try {
    const detect = require('../../../common/fallback-detect');
    const r = detect.evaluate({ repo: repoRoot });
    return {
      level: (!r.desktopAlive && !r.mcpAlive) ? 'bad' : ((!r.desktopAlive || !r.mcpAlive) ? 'warn' : 'ok'),
      desktopAlive: !!r.desktopAlive,
      mcpAlive: !!r.mcpAlive,
      advice: r.advice || null,
      banner_ru: r.reason || null,
      mode: r.advice || null,
    };
  } catch { /* ignore */ }
  return null;
}

function tryConfirmRequest(who) {
  try {
    const host = require('../../../tools/host-fallback');
    const ch = host.confirmRequest({ action: 'jobs.enqueue', meta: { who } });
    return { ok: true, challenge: ch };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function tryEnqueueJob({ who, task, work, confirmId, confirmToken, id }) {
  try {
    const host = require('../../../tools/host-fallback');
    // enqueueJob is async
    return host.enqueueJob({
      who,
      task,
      work,
      confirmId,
      confirmToken,
      id: id && ID_RE.test(id) ? id : undefined,
    }).then((r) => ({ ok: true, result: r }))
      .catch((e) => ({ ok: false, error: e.message || String(e) }));
  } catch (e) {
    return Promise.resolve({ ok: false, error: e.message || String(e) });
  }
}

function createDraft({ work, who, task } = {}) {
  assertWork(work);
  if (!AGENTS.has(who)) throw Object.assign(new Error('who must be codex|antigravity|grok'), { status: 400 });
  const text = String(task || '').trim();
  if (text.length < 3) throw Object.assign(new Error('task required (min 3 chars)'), { status: 400 });
  if (text.length > TASK_MAX) throw Object.assign(new Error('task too long'), { status: 400 });
  const id = 'i' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const now = new Date().toISOString();
  const rec = {
    id,
    work,
    who,
    task: text,
    status: 'draft',
    createdAt: now,
    confirmedAt: null,
    enqueuedAt: null,
    jobId: null,
    channel: null,
    fallbackConfirmId: null,
    cli_fallback: buildCli({ work, who, task: text }),
    note: 'draft intent under _handoff/intents (JUDGE-write W2); not yet confirmed',
    source: 'dashboard-write-bridge',
  };
  return writeIntent(rec);
}

function confirmIntent(work, id) {
  const rec = readIntent(work, id);
  if (rec.status !== 'draft') {
    throw Object.assign(new Error('confirm only from draft (status=' + rec.status + ')'), { status: 409 });
  }
  rec.status = 'confirmed';
  rec.confirmedAt = new Date().toISOString();
  rec.note = 'human confirmed in dashboard UI (directive confirm); host jobs.enqueue still needs fallback token';
  rec.cli_fallback = buildCli(rec);
  return writeIntent(rec);
}

async function enqueueIntent(work, id, { confirmId, confirmToken } = {}) {
  const rec = readIntent(work, id);
  if (rec.status !== 'confirmed' && rec.status !== 'enqueued') {
    throw Object.assign(new Error('enqueue requires confirmed intent (status=' + rec.status + ')'), { status: 409 });
  }
  const detect = detectFallback();
  const desktopDead = detect && (detect.desktopAlive === false || detect.mcpAlive === false
    || detect.level === 'bad' || detect.advice === 'hold_fallback' || detect.mode === 'fallback');

  let hostJob = null;
  let hostError = null;
  let challenge = null;

  if (confirmId && confirmToken) {
    const enq = await tryEnqueueJob({
      who: rec.who,
      task: rec.task,
      work: rec.work,
      confirmId,
      confirmToken,
      id: rec.id,
    });
    if (enq.ok) {
      hostJob = enq.result;
      rec.jobId = (enq.result && (enq.result.id || (enq.result.result && enq.result.result.id))) || rec.id || null;
      rec.channel = 'host-fallback';
      rec.fallbackConfirmId = confirmId;
      rec.dispatchStatus = 'host_queued';
      rec.note = 'enqueued via host-fallback jobs-enqueue after human token (isolated host state)';
    } else {
      hostError = enq.error;
      rec.dispatchStatus = 'host_error';
      rec.note = 'host enqueue failed: ' + hostError + '. Intent SoT kept; retry with token or CLI.';
    }
  } else {
    const cr = tryConfirmRequest(rec.who);
    if (cr.ok) {
      challenge = cr.challenge;
      rec.fallbackConfirmId = challenge.id || challenge.confirmId || null;
    } else {
      hostError = cr.error;
    }
    // Without token we do NOT claim a most job exists.
    if (!hostJob) {
      rec.dispatchStatus = 'intent_only';
      rec.channel = 'intent-file+cli';
      rec.note = 'intent SoT written; most job NOT queued yet. Insert confirm-reveal token in UI or run cli_fallback.';
    }
  }

  rec.status = 'enqueued';
  rec.enqueuedAt = new Date().toISOString();
  if (!rec.dispatchStatus) {
    rec.dispatchStatus = hostJob ? 'host_queued' : (hostError ? 'host_error' : 'intent_only');
  }
  if (!rec.channel) {
    rec.channel = hostJob ? 'host-fallback' : 'intent-file+cli';
  }
  rec.cli_fallback = buildCli(rec, rec.fallbackConfirmId);
  rec.detect_hint = detect ? {
    level: detect.level || detect.mode || null,
    desktopAlive: detect.desktopAlive,
    mcpAlive: detect.mcpAlive,
    advice: detect.advice || null,
    banner_ru: detect.banner_ru || null,
  } : null;
  rec.needsToken = rec.dispatchStatus === 'intent_only';
  rec.mcp_dead_hint = !!(desktopDead || hostError || rec.dispatchStatus !== 'host_queued');

  const saved = writeIntent(rec);
  return {
    intent: saved,
    hostJob,
    hostError,
    challenge: challenge ? {
      id: challenge.id || challenge.confirmId || null,
      action: challenge.action || 'jobs.enqueue',
      reveal_cmd: path.join(repoRoot, 'scripts', 'fallback.cmd') + ' confirm-reveal ' + (challenge.id || challenge.confirmId || '<confirmId>'),
      note: challenge.note || 'Token NOT returned to dashboard; human must confirm-reveal via fallback.cmd, then paste token in UI',
    } : null,
    cli_fallback: saved.cli_fallback,
    mcp_dead_hint: !!saved.mcp_dead_hint,
    dispatchStatus: saved.dispatchStatus,
  };
}

module.exports = {
  listIntents,
  readIntent,
  createDraft,
  confirmIntent,
  enqueueIntent,
  intentsDir,
  AGENTS,
};
