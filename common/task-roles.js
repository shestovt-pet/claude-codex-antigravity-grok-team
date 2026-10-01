'use strict';
// Per-task flexible roles (incr1). Propose + human confirm. No who=claude forgery.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
const WHO = new Set(['claude', 'codex', 'antigravity', 'grok', 'user']);
const KINDS = new Set(['code', 'review', 'design', 'ops', 'fallback']);
const STATUSES = new Set(['proposed', 'confirmed', 'expired', 'superseded']);

function sha(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

function contentHashOf(rec) {
  const copy = Object.assign({}, rec);
  delete copy.contentHash;
  delete copy.confirmId;
  delete copy.confirmedBy;
  delete copy.confirmedAt;
  return sha(JSON.stringify(copy));
}

function normalizeSlots(slots) {
  if (!slots || typeof slots !== 'object') throw new Error('roles: slots required');
  const out = {};
  if (slots.orchestrator != null) {
    if (!WHO.has(slots.orchestrator)) throw new Error('roles: bad orchestrator');
    out.orchestrator = slots.orchestrator;
  }
  if (slots.coder != null) {
    if (!WHO.has(slots.coder)) throw new Error('roles: bad coder');
    out.coder = slots.coder;
  }
  if (slots.reviewer != null) {
    const list = Array.isArray(slots.reviewer) ? slots.reviewer : [slots.reviewer];
    if (!list.length) throw new Error('roles: reviewer empty');
    for (const r of list) if (!WHO.has(r)) throw new Error('roles: bad reviewer ' + r);
    out.reviewer = list;
  }
  if (slots.judge != null) {
    if (!WHO.has(slots.judge)) throw new Error('roles: bad judge');
    out.judge = slots.judge;
  }
  if (slots.offline != null) {
    const list = Array.isArray(slots.offline) ? slots.offline : [slots.offline];
    for (const r of list) if (!WHO.has(r)) throw new Error('roles: bad offline ' + r);
    out.offline = list;
  } else {
    out.offline = [];
  }
  return out;
}

/**
 * Validate slots against policy + optional detect snapshot.
 * opts: { kind, detectAdvice, claudeOnline }
 */
function validateSlots(slots, opts = {}) {
  const s = normalizeSlots(slots);
  const errors = [];
  if (!s.orchestrator) errors.push('orchestrator required');
  if (!s.judge) errors.push('judge required');
  if (s.judge !== 'user') {
    // Non-user judge only allowed for soft kinds; ops/fallback/merge path still needs user.
    if (opts.kind === 'ops' || opts.kind === 'fallback') {
      errors.push('judge must be user for kind=' + opts.kind);
    }
  }
  if (s.coder && s.reviewer && s.reviewer.includes(s.coder)) {
    errors.push('self-review forbidden: coder must not be in reviewer');
  }
  if (s.coder && (!s.reviewer || !s.reviewer.length)) {
    errors.push('coder set but reviewer missing');
  }
  const offline = new Set(s.offline || []);
  if (s.orchestrator && offline.has(s.orchestrator)) {
    errors.push('orchestrator is marked offline');
  }
  if (s.coder && offline.has(s.coder)) {
    errors.push('coder is marked offline');
  }
  // Claude orchestrator only if detect says online (or unknown and not advise_enter).
  const claudeOnline = opts.claudeOnline;
  const advice = opts.detectAdvice;
  if (s.orchestrator === 'claude') {
    if (claudeOnline === false || advice === 'advise_enter' || advice === 'hold_fallback') {
      errors.push('orchestrator=claude forbidden while Claude looks unavailable (use detect + confirm)');
    }
  }
  // Never allow forging: offline must include claude if we know Desktop is down and slots still list claude elsewhere as active — already covered.
  if (errors.length) {
    const err = new Error('roles validate: ' + errors.join('; '));
    err.errors = errors;
    throw err;
  }
  return s;
}

function defaultHeuristic(kind, detect) {
  const k = KINDS.has(kind) ? kind : 'code';
  const claudeOnline = detect && detect.desktopAlive === true && detect.mcpAlive === true
    && detect.advice !== 'advise_enter' && detect.advice !== 'hold_fallback';
  const offline = [];
  if (!claudeOnline) offline.push('claude');

  const base = {
    judge: 'user',
    offline,
  };

  if (k === 'code') {
    return Object.assign(base, {
      orchestrator: claudeOnline ? 'claude' : 'grok',
      coder: 'codex',
      reviewer: ['antigravity'],
    });
  }
  if (k === 'review') {
    return Object.assign(base, {
      orchestrator: claudeOnline ? 'claude' : 'grok',
      reviewer: ['codex', 'antigravity'],
    });
  }
  if (k === 'design') {
    return Object.assign(base, {
      orchestrator: claudeOnline ? 'claude' : 'antigravity',
      reviewer: ['codex'],
    });
  }
  if (k === 'ops') {
    return Object.assign(base, {
      orchestrator: 'user',
      reviewer: ['codex', 'antigravity'],
    });
  }
  // fallback
  return Object.assign(base, {
    orchestrator: 'grok',
    coder: 'codex',
    reviewer: ['antigravity'],
  });
}

function worksRolesPath(worksRoot, work) {
  const safe = String(work || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safe) throw new Error('roles: bad work name');
  return path.join(worksRoot, safe, 'roles.json');
}

function fallbackRolesPath(fallbackDir, work) {
  const safe = String(work || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return path.join(fallbackDir, 'roles', safe + '.json');
}

function loadDetect(repoRoot) {
  try {
    const detect = require(path.join(repoRoot, 'common', 'fallback-detect.js'));
    return detect.evaluate({ repo: repoRoot, sharedStateDir: path.join(repoRoot, 'state') });
  } catch {
    return null;
  }
}

/**
 * Propose roles for a work. Does not confirm.
 * opts: { worksRoot, fallbackDir, repoRoot, work, kind, slots, by, reason, generation, detect }
 */
function propose(opts = {}) {
  const work = opts.work;
  if (!work) throw new Error('roles-propose: --work required');
  const worksRoot = opts.worksRoot || path.join(opts.repoRoot || 'C:\\most', 'works');
  const kind = opts.kind || 'code';
  if (!KINDS.has(kind)) throw new Error('roles: unknown kind ' + kind);

  const detect = opts.detect || loadDetect(opts.repoRoot || 'C:\\most');
  const claudeOnline = !!(detect && detect.desktopAlive && detect.mcpAlive
    && detect.advice !== 'advise_enter' && detect.advice !== 'hold_fallback');

  let slots;
  if (opts.slots) {
    slots = typeof opts.slots === 'string' ? JSON.parse(opts.slots) : opts.slots;
  } else {
    slots = defaultHeuristic(kind, detect);
  }
  slots = validateSlots(slots, {
    kind,
    detectAdvice: detect && detect.advice,
    claudeOnline,
  });

  const now = new Date().toISOString();
  const rec = {
    version: VERSION,
    work: String(work).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64),
    status: 'proposed',
    kind,
    proposedBy: opts.by || 'rules',
    proposedAt: now,
    confirmedBy: null,
    confirmedAt: null,
    confirmId: null,
    generation: Number.isInteger(opts.generation) ? opts.generation : 0,
    detectAdvice: detect ? detect.advice : null,
    slots,
    reason: opts.reason || ('heuristic kind=' + kind),
  };
  rec.contentHash = contentHashOf(rec);

  const dest = worksRolesPath(worksRoot, work);
  const prev = readJson(dest);
  if (prev && prev.status === 'confirmed' && !opts.allowSupersedeConfirmed) {
    // Keep confirmed active; store new proposal beside it until human confirms.
    const proposedPath = dest.replace(/roles\.json$/, 'roles.proposed.json');
    writeJsonAtomic(proposedPath, rec);
    if (opts.fallbackDir) {
      writeJsonAtomic(fallbackRolesPath(opts.fallbackDir, work).replace(/\.json$/, '.proposed.json'), rec);
    }
    return Object.assign({}, rec, { note: 'proposed beside confirmed; confirm will supersede active' });
  }
  if (prev && (prev.status === 'proposed' || prev.status === 'confirmed')) {
    prev.status = 'superseded';
    prev.supersededAt = now;
    writeJsonAtomic(dest + '.prev', prev);
  }
  writeJsonAtomic(dest, rec);

  if (opts.fallbackDir) {
    writeJsonAtomic(fallbackRolesPath(opts.fallbackDir, work), rec);
  }

  return rec;
}

function get(opts = {}) {
  const worksRoot = opts.worksRoot || path.join(opts.repoRoot || 'C:\\most', 'works');
  const dest = worksRolesPath(worksRoot, opts.work);
  const rec = readJson(dest);
  const pending = readJson(dest.replace(/roles\.json$/, 'roles.proposed.json'));
  if (!rec && !pending) return { work: opts.work, status: 'none' };
  if (!rec) {
    return { work: opts.work, status: 'proposed', roles: pending, pendingProposal: pending };
  }
  let detect = null;
  try { detect = loadDetect(opts.repoRoot || 'C:\\most'); } catch {}
  return {
    roles: rec,
    pendingProposal: pending || null,
    availability: detect ? {
      advice: detect.advice,
      desktopAlive: detect.desktopAlive,
      mcpAlive: detect.mcpAlive,
      reason: detect.reason,
    } : null,
  };
}

/**
 * Mark proposed roles as confirmed. Caller must have already consumed user-confirm.
 */
function confirm(opts = {}) {
  const worksRoot = opts.worksRoot || path.join(opts.repoRoot || 'C:\\most', 'works');
  const dest = worksRolesPath(worksRoot, opts.work);
  const proposedPath = dest.replace(/roles\.json$/, 'roles.proposed.json');
  let rec = readJson(dest);
  const side = readJson(proposedPath);
  if (side && side.status === 'proposed') {
    // Confirming the side proposal; will supersede active confirmed
    if (rec && rec.status === 'confirmed') {
      rec.status = 'superseded';
      rec.supersededAt = new Date().toISOString();
      writeJsonAtomic(dest + '.prev', rec);
    }
    rec = side;
    try { fs.unlinkSync(proposedPath); } catch {}
  }
  if (!rec || rec.status !== 'proposed') {
    throw new Error('roles-confirm: no proposed roles for work');
  }
  if (opts.contentHash && opts.contentHash !== rec.contentHash) {
    throw new Error('roles-confirm: contentHash mismatch (proposal changed)');
  }
  if (opts.generation != null && Number(opts.generation) !== Number(rec.generation)) {
    throw new Error('roles-confirm: generation mismatch');
  }
  // Re-validate at confirm time with fresh detect
  const detect = opts.detect || loadDetect(opts.repoRoot || 'C:\\most');
  const claudeOnline = !!(detect && detect.desktopAlive && detect.mcpAlive
    && detect.advice !== 'advise_enter' && detect.advice !== 'hold_fallback');
  validateSlots(rec.slots, {
    kind: rec.kind,
    detectAdvice: detect && detect.advice,
    claudeOnline,
  });

  rec.status = 'confirmed';
  rec.confirmedBy = 'user';
  rec.confirmedAt = new Date().toISOString();
  rec.confirmId = opts.confirmId || null;
  writeJsonAtomic(dest, rec);
  if (opts.fallbackDir) {
    writeJsonAtomic(fallbackRolesPath(opts.fallbackDir, opts.work), rec);
  }
  return rec;
}

function clear(opts = {}) {
  const worksRoot = opts.worksRoot || path.join(opts.repoRoot || 'C:\\most', 'works');
  const dest = worksRolesPath(worksRoot, opts.work);
  const rec = readJson(dest);
  if (!rec) return { work: opts.work, status: 'none' };
  rec.status = 'superseded';
  rec.supersededAt = new Date().toISOString();
  rec.clearReason = opts.reason || 'cleared';
  writeJsonAtomic(dest, rec);
  if (opts.fallbackDir) {
    writeJsonAtomic(fallbackRolesPath(opts.fallbackDir, opts.work), rec);
  }
  return rec;
}

module.exports = {
  VERSION,
  WHO,
  KINDS,
  propose,
  get,
  confirm,
  clear,
  validateSlots,
  defaultHeuristic,
  contentHashOf,
  worksRolesPath,
  normalizeSlots,
};
