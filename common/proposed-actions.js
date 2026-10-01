'use strict';
// Increment 3: Grok/webhook structured proposals -> host actions.
// Free-form reply text is NEVER executed as shell. who=claude is forbidden.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_TYPES = new Set([
  'status', 'list', 'jobs.list', 'jobs.stop', 'confirm-request', 'roles.propose',
]);

const BEGIN = 'FALLBACK_ACTIONS_BEGIN';
const END = 'FALLBACK_ACTIONS_END';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
}

function actionsDir(fallbackDir) {
  const d = path.join(fallbackDir, 'proposed-actions');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function extractBlock(text) {
  const s = String(text || '');
  const i = s.indexOf(BEGIN);
  const j = s.indexOf(END);
  if (i < 0 || j < 0 || j <= i) {
    throw new Error('proposed-actions: missing FALLBACK_ACTIONS_BEGIN/END block');
  }
  const raw = s.slice(i + BEGIN.length, j).trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    throw new Error('proposed-actions: JSON parse failed: ' + e.message);
  }
  return parsed;
}

function validateAction(action, idx) {
  const label = 'action[' + idx + ']';
  if (!action || typeof action !== 'object') throw new Error(label + ': not an object');
  if (!ALLOWED_TYPES.has(action.type)) {
    throw new Error(label + ': type "' + action.type + '" not allowed. Allowed: ' + [...ALLOWED_TYPES].join(', '));
  }
  const blob = JSON.stringify(action);
  if (/who\s*=\s*claude|"who"\s*:\s*"claude"/i.test(blob)) {
    throw new Error(label + ': forging who=claude is forbidden');
  }
  if (/team_change|deploy\.js|C:\\\\most\\\\live|MOST_CLIENT\s*=\s*claude/i.test(blob)) {
    throw new Error(label + ': forbidden target (team_change/deploy/live/MOST_CLIENT=claude)');
  }
  if (action.type === 'jobs.stop') {
    if (!action.who || !['codex', 'antigravity', 'grok'].includes(action.who)) {
      throw new Error(label + ': jobs.stop needs who=codex|antigravity|grok');
    }
    if (!action.id || !/^[a-zA-Z0-9_-]{1,80}$/.test(action.id)) {
      throw new Error(label + ': jobs.stop needs id');
    }
  }
  if (action.type === 'confirm-request') {
    if (!action.action) throw new Error(label + ': confirm-request needs action');
  }
  return { type: action.type, who: action.who, id: action.id, action: action.action, args: action.args || null };
}

function parseProposal(text, { source } = {}) {
  const parsed = extractBlock(text);
  if (parsed.version !== 1) throw new Error('proposed-actions: version must be 1');
  if (!Array.isArray(parsed.actions) || !parsed.actions.length) {
    throw new Error('proposed-actions: actions[] required');
  }
  const actions = parsed.actions.map((a, i) => validateAction(a, i));
  return {
    version: 1,
    source: source || parsed.source || 'grok',
    note: parsed.note || null,
    actions,
  };
}

function storeProposal(fallbackDir, proposal, { rawText } = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const rec = {
    id,
    status: 'pending',
    createdAt: new Date().toISOString(),
    source: proposal.source,
    note: proposal.note,
    actions: proposal.actions,
    rawHash: rawText ? crypto.createHash('sha256').update(rawText, 'utf8').digest('hex') : null,
    appliedAt: null,
    results: null,
  };
  writeJson(path.join(actionsDir(fallbackDir), id + '.json'), rec);
  return rec;
}

function listProposals(fallbackDir) {
  const dir = actionsDir(fallbackDir);
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(dir, n))).filter(Boolean);
}

function loadProposal(fallbackDir, id) {
  if (!/^[a-f0-9]{16}$/.test(String(id || ''))) throw new Error('proposed-actions: bad id');
  return readJson(path.join(actionsDir(fallbackDir), id + '.json'));
}

function markApplied(fallbackDir, id, results) {
  const rec = loadProposal(fallbackDir, id);
  if (!rec) throw new Error('proposed-actions: not found');
  if (rec.status !== 'pending') throw new Error('proposed-actions: not pending (' + rec.status + ')');
  rec.status = 'applied';
  rec.appliedAt = new Date().toISOString();
  rec.results = results;
  writeJson(path.join(actionsDir(fallbackDir), id + '.json'), rec);
  return rec;
}

module.exports = {
  ALLOWED_TYPES, BEGIN, END,
  parseProposal, storeProposal, listProposals, loadProposal, markApplied, validateAction, extractBlock,
};