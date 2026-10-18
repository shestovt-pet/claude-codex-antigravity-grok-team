'use strict';
// Increment 4 live: client !== authority. Empty MOST_CLIENT => unknown (not claude).
// Peer never gate judge. Active fallback session authority=user wins over MOST_AUTHORITY spoof.
// Preserves ready() + queued + Russian guest errors so Claude Desktop path stays intact when MOST_CLIENT=claude and no fallback session.
const fs = require('fs');
const path = require('path');

function client() {
  const c = process.env.MOST_CLIENT;
  if (!c || !String(c).trim()) {
    // Under active fallback (authority=user): empty is unknown — never forge claude.
    // Outside fallback: historic default 'claude' so Desktop/tests without env stay conductor.
    if (authority() === 'user') return 'unknown';
    return 'claude';
  }
  return String(c).trim();
}

function readSessionAuthority(fallbackDir) {
  if (!fallbackDir) {
    if (process.env.MOST_FALLBACK_DIR) fallbackDir = process.env.MOST_FALLBACK_DIR;
    else return null;
  }
  try {
    const s = JSON.parse(fs.readFileSync(path.join(fallbackDir, 'session.json'), 'utf8'));
    if (s && s.authority) return s.authority;
    if (s && s.mode === 'fallback' && s.conductor) return 'user';
    if (s && s.mode === 'left') return 'claude';
  } catch {}
  return null;
}

function authority(opts = {}) {
  const fromSession = readSessionAuthority(opts.fallbackDir);
  // Active fallback session cannot be overridden by env spoof.
  if (fromSession === 'user') return 'user';
  if (process.env.MOST_AUTHORITY && String(process.env.MOST_AUTHORITY).trim()) {
    return String(process.env.MOST_AUTHORITY).trim();
  }
  if (fromSession) return fromSession;
  return null;
}

function guest(opts = {}) {
  const c = client();
  if (c !== 'claude') return true;
  const a = authority(opts);
  if (a === 'user') return true;
  if (a == null && process.env.MOST_FALLBACK_DIR) {
    const a2 = authority({ fallbackDir: process.env.MOST_FALLBACK_DIR, ...opts });
    if (a2 === 'user') return true;
  }
  return false;
}

function isGateJudge(role) {
  return role === 'user' || role === 'claude';
}

function peerIsAuthority(opts = {}) {
  const a = authority(opts);
  if (!a) return false;
  return ['grok', 'codex', 'antigravity', 'unknown'].includes(a);
}

function assertPeerNotJudge(opts = {}) {
  const a = authority(opts);
  if (a && !isGateJudge(a)) {
    throw new Error('access: peer/authority "' + a + '" cannot be gate judge (client=' + client() + ')');
  }
  if (peerIsAuthority(opts)) {
    throw new Error('access: peer must not be authority');
  }
}

function allowed(server, tool, opts = {}) {
  assertPeerNotJudge(opts);
  if (tool === 'team_change' || /deploy/i.test(tool)) {
    const a = authority(opts);
    if (a === 'user') return false; // fallback: gate mutations only via host+confirm
    if (a != null && a !== 'claude') return false;
    if (guest(opts)) return false;
  }
  if (!guest(opts)) return true;
  // Установщик прежнего релиза проверяет гостя прежним списком; установщик team-v19 просит полный (MOST_PROBE_GUEST=full).
  if (process.env.MOST_PROBE_ONLY === '1' && process.env.MOST_PROBE_GUEST !== 'full') return legacyTools(server, client()).includes(tool);
  return guestTools(server, client()).includes(tool);
}
function legacyTools(server, c) {
  if (!['codex', 'antigravity', 'grok', 'claude'].includes(c)) return [];
  if (server === 'team') return ['team_status', 'team_rules', 'team_work'];
  return (c === 'claude' ? 'codex' : c) === server ? [] : [server + '_status', server + '_send', server + '_result'];
}

// Инструменты гостя при старте (team-v19, К2): у гостей codex и antigravity — team_word и сервер своей семьи; право
// пользоваться ими проверяет guard при вызове; чат Codex получает свой сервер и вне запасного режима (team-v25).
function guestTools(server, c) {
  // Live guests: codex / antigravity. Fallback also: grok guest, claude-named-as-guest.
  if (!['codex', 'antigravity', 'grok', 'claude'].includes(c)) return [];
  const seat = ['codex', 'antigravity'].includes(c);
  if (server === 'team') return ['team_status', 'team_rules', 'team_work', ...(seat ? ['team_word'] : [])];
  const base = [server + '_status', server + '_send', server + '_result'];
  if (seat && c === server) return [...base, ...(server === 'antigravity' ? ['antigravity_apply', 'antigravity_cancel'] : ['codex_cancel'])];
  const peer = c === 'claude' ? 'codex' : c;
  if (peer === server) return [];
  return [...base, ...(seat && server === 'antigravity' ? ['antigravity_apply'] : [])];
}

function guard(server, tool, a = {}, opts = {}) {
  if (tool === 'codex_send' && a.full_access && guest(opts))
    throw Error('Гостю полный доступ Codex запрещён; изменения не выполнены.');
  // Права дирижёра запасного режима (team-v19, К2) снимают запреты гостю на изменение работ и запись по поручению.
  const fallback = require('./fallback'), conductor = guest(opts) && fallback.conductorAllows(server, tool, a);
  if (!allowed(server, tool, opts) || (guest(opts) && (
    (tool === 'team_work' && !['get', 'list'].includes(a.action) && !conductor) ||
    (tool === 'team_status' && (a.claude_quota || a.claude_usage || a.notify_test)) ||
    (tool === 'codex_send' && a.write && client() !== 'codex' && !conductor) ||
    tool === 'team_change'
  ))) {
    throw Error('Гостю это действие запрещено; изменения не выполнены.');
  }
  fallback.guard(server, tool, a);
}

const queued = 'Поручение поставлено в очередь; выполнит основной сервер (Claude Desktop должен быть открыт)';

function ready(server) {
  if (guest() || process.env.MOST_PROBE_ONLY === '1') return;
  require('./team-git').atomic(path.join(require('./paths').stateDir, 'ready', server + '.json'), JSON.stringify({
    release: path.resolve(__dirname, '..'), pid: process.pid, startedAt: new Date().toISOString(),
  }));
}

function describe(opts = {}) {
  return {
    increment: 4,
    client: client(),
    guest: guest(opts),
    authority: authority(opts),
    emptyClientDefaultsToClaude: false, // never under authority=user; outside fallback empty still maps to claude for Desktop compat
    emptyOutsideFallbackDefaultsToClaude: true,
    peerCanBeGateJudge: false,
    claudeClientIgnoresAuthority: false,
    note: 'Live access.js incr4: client!==authority; ready/queued preserved; Claude Desktop path when MOST_CLIENT=claude and no fallback session.',
  };
}

module.exports = {
  client, guest, authority, isGateJudge, peerIsAuthority, assertPeerNotJudge,
  allowed, guestTools, guard, ready, queued, describe, readSessionAuthority,
};