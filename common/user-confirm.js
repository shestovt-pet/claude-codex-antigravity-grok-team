'use strict';
// Independent user-confirm channel (increment 2, hardened).
// Token is NEVER returned to callers unless MOST_FALLBACK_HUMAN=1 (set by fallback.cmd).
// Consume is atomic (rename). Bound to action+generation+optional targetHash.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTL_MS = 15 * 60 * 1000;
const ACTIONS = new Set([
  'enter', 'leave', 'jobs.stop', 'jobs.enqueue', 'actions.apply', 'generation.transfer',
]);

function sha(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function confirmDir(fallbackDir) {
  const d = path.join(fallbackDir, 'confirm');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
}

function assertAction(action) {
  if (!ACTIONS.has(action)) {
    throw new Error('confirm: unknown action "' + action + '". Allowed: ' + [...ACTIONS].join(', '));
  }
}

function createChallenge(fallbackDir, { action, generation, meta, targetHash } = {}) {
  assertAction(action);
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error('confirm: generation required (integer >= 0)');
  }
  if (action === 'jobs.stop') {
    if (!meta || !meta.who || !meta.id) {
      throw new Error('confirm: jobs.stop requires meta.who and meta.id');
    }
  }
  if (action === 'jobs.enqueue') {
    if (!meta || !meta.who) throw new Error('confirm: jobs.enqueue requires meta.who');
  }
  if (action === 'actions.apply') {
    if (!meta || !meta.id || !targetHash) {
      throw new Error('confirm: actions.apply requires meta.id and targetHash (proposal content)');
    }
  }
  const id = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const rec = {
    id,
    action,
    generation,
    meta: meta || null,
    targetHash: targetHash || null,
    tokenHash: sha(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
    usedAt: null,
    status: 'pending',
  };
  writeJson(path.join(confirmDir(fallbackDir), id + '.json'), rec);
  // Token only on disk for human reveal; not in API object by default.
  const tokenPath = path.join(confirmDir(fallbackDir), id + '.token');
  fs.writeFileSync(tokenPath, token + '\n', { encoding: 'utf8', flag: 'wx' });
  const out = {
    id,
    action,
    generation,
    expiresAt: rec.expiresAt,
    meta: rec.meta,
    targetHash: rec.targetHash,
    note: 'Token is NOT returned to agents. Human: run confirm-reveal via fallback.cmd (MOST_FALLBACK_HUMAN=1).',
  };
  if (process.env.MOST_FALLBACK_HUMAN === '1') {
    out.token = token;
    out.tokenPath = tokenPath;
    out.note = 'Human session: token included once. Pass --confirm-id and --confirm-token.';
  }
  return out;
}

function revealToken(fallbackDir, id) {
  if (process.env.MOST_FALLBACK_HUMAN !== '1') {
    throw new Error('confirm-reveal denied: set MOST_FALLBACK_HUMAN=1 (fallback.cmd does this for humans)');
  }
  if (!/^[a-f0-9]{16}$/.test(String(id || ''))) throw new Error('confirm: bad id');
  const tokenPath = path.join(confirmDir(fallbackDir), id + '.token');
  if (!fs.existsSync(tokenPath)) throw new Error('confirm: token file missing (already revealed/consumed?)');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  const rec = load(fallbackDir, id);
  return { id, token, action: rec && rec.action, generation: rec && rec.generation, expiresAt: rec && rec.expiresAt };
}

function publicView(rec) {
  if (!rec) return null;
  return {
    id: rec.id,
    action: rec.action,
    generation: rec.generation,
    meta: rec.meta,
    targetHash: rec.targetHash || null,
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    usedAt: rec.usedAt,
    status: rec.status,
  };
}

function load(fallbackDir, id) {
  if (!/^[a-f0-9]{16}$/.test(String(id || ''))) throw new Error('confirm: bad id');
  return readJson(path.join(confirmDir(fallbackDir), id + '.json'));
}

function listPending(fallbackDir) {
  const dir = confirmDir(fallbackDir);
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => {
    return publicView(readJson(path.join(dir, n)));
  }).filter(Boolean).filter((r) => r.status === 'pending');
}

function consume(fallbackDir, { id, token, action, generation, targetHash } = {}) {
  assertAction(action);
  if (!/^[a-f0-9]{16}$/.test(String(id || ''))) throw new Error('confirm: bad id');
  const dir = confirmDir(fallbackDir);
  const src = path.resolve(dir, id + '.json');
  if (!src.startsWith(path.resolve(dir) + path.sep)) throw new Error('confirm: path escape');
  const pendingName = path.join(dir, id + '.pending-consume');
  // Atomic claim: rename json -> pending-consume (exclusive). Concurrent consumer fails.
  try {
    fs.renameSync(src, pendingName);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('confirm: challenge not found or already claimed');
    throw e;
  }
  let rec;
  try {
    rec = readJson(pendingName);
    if (!rec) throw new Error('confirm: corrupt challenge');
    if (rec.status !== 'pending') throw new Error('confirm: already used/revoked (' + rec.status + ')');
    if (rec.action !== action) {
      throw new Error('confirm: action mismatch (expected ' + rec.action + ', got ' + action + ')');
    }
    if (rec.generation !== generation) {
      throw new Error('confirm: generation mismatch (expected ' + rec.generation + ', got ' + generation + ')');
    }
    if (rec.targetHash) {
      if (!targetHash || targetHash !== rec.targetHash) {
        throw new Error('confirm: targetHash mismatch (content changed or missing)');
      }
    }
    if (Date.parse(rec.expiresAt) < Date.now()) {
      rec.status = 'expired';
      writeJson(path.join(dir, id + '.json'), rec);
      try { fs.unlinkSync(pendingName); } catch {}
      throw new Error('confirm: challenge expired');
    }
    if (!token) throw new Error('confirm: bad token');
    const a = Buffer.from(sha(token), 'hex');
    const b = Buffer.from(rec.tokenHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('confirm: bad token');
    rec.status = 'used';
    rec.usedAt = new Date().toISOString();
    writeJson(path.join(dir, id + '.json'), rec);
    try { fs.unlinkSync(pendingName); } catch {}
    try { fs.unlinkSync(path.join(dir, id + '.token')); } catch {}
    return publicView(rec);
  } catch (e) {
    // restore pending if still claimed and not written as used
    try {
      if (fs.existsSync(pendingName) && !fs.existsSync(src)) {
        const cur = readJson(pendingName);
        if (cur && cur.status === 'pending') fs.renameSync(pendingName, src);
      }
    } catch {}
    throw e;
  }
}

function requireConfirmArgs(opts, actionLabel) {
  if (!opts || !opts.confirmId || !opts.confirmToken) {
    throw new Error(
      (actionLabel || 'action') +
      ' needs independent channel: confirm-request + human confirm-reveal, then --confirm-id/--confirm-token.'
    );
  }
}

module.exports = {
  ACTIONS, TTL_MS, createChallenge, revealToken, consume, load, listPending, publicView, requireConfirmArgs, sha,
};