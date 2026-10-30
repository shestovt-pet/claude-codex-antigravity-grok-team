'use strict';
// Increment 4 live: client !== authority. Empty MOST_CLIENT => unknown (not claude).
// Peer never gate judge. Active fallback session authority=user wins over MOST_AUTHORITY spoof.
// Preserves ready() + queued + Russian guest errors so Claude Desktop path stays intact when MOST_CLIENT=claude and no fallback session.
const fs = require('fs');
const path = require('path');

function client() {
  const c0 = process.env.MOST_CLIENT;
  let c;
  if (!c0 || !String(c0).trim()) {
    // Under active fallback (authority=user): empty is unknown — never forge claude.
    // Outside fallback: historic default 'claude' so Desktop/tests without env stay conductor.
    if (authority() === 'user') return 'unknown';
    c = 'claude';
  } else c = String(c0).trim();
  if (c === 'job' && require('./job-identity').currentJob()?.member === 'claude') return 'claude-print';
  return c;
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
  // team-v46: claude-print всегда гость (исполнитель не наследует роли дирижёра); сопоставление — memberForClient.
  try { if (!require('./members').memberForClient(c)?.roles.conductor) return true; }
  catch { if (c !== 'claude') return true; } // Повреждение: прежний основной клиент сохраняет доступ к диагностике; записи ниже закрыты.
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
  return !isGateJudge(a);
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
  const member = require('./members').memberForClient(c);
  if (!member && c !== 'grok') return []; // Grok: совместимость прежней пробы
  if (member && !member.roles.sends) return server === 'team' ? ['team_status', 'team_rules', 'team_work'] : [server + '_status', server + '_result'];
  if (server === 'team') return ['team_status', 'team_rules', 'team_work'];
  return (c === 'claude' ? 'codex' : c) === server ? [] : [server + '_status', server + '_send', server + '_result'];
}

// Инструменты гостя при старте (team-v19, К2): у гостей codex и antigravity — team_word и сервер своей семьи; право
// пользоваться ими проверяет guard при вызове; чат Codex получает свой сервер и вне запасного режима (team-v25).
function guestTools(server, c) {
  // Live guests: codex / antigravity / claude-print. Fallback also: grok guest, claude-named-as-guest.
  const member = require('./members').memberForClient(c);
  if (!member && c !== 'grok') return []; // Grok: совместимость прежней пробы
  // team-v46: исполнитель claude-print не вызывает собственный сервер claude — исключено явно, не из сопоставления.
  if (c === 'claude-print' && server === 'claude') return [];
  if (member && !member.roles.sends) return server === 'team' ? ['team_status', 'team_rules', 'team_work'] : [server + '_status', server + '_result'];
  const seat = !!member?.roles.fallback_conductor;
  if (server === 'team') return ['team_status', 'team_rules', 'team_work', 'team_ask', 'team_ask_result', ...(seat ? ['team_word'] : [])];
  const base = [server + '_status', server + '_send', server + '_result'];
  if (seat && c === server) return [...base, ...(server === 'antigravity' ? ['antigravity_apply', 'antigravity_cancel'] : ['codex_cancel'])];
  const peer = c === 'claude' ? 'codex' : c;
  if (peer === server) return [];
  return [...base, ...(seat && server === 'antigravity' ? ['antigravity_apply'] : [])];
}

function guard(server, tool, a = {}, opts = {}) {
  const readOnly = /_(?:result|status)$/.test(tool) && !(tool === 'team_status' && (a.claude_quota || a.claude_usage || a.notify_test)) ||
    tool === 'team_rules' || tool === 'team_work' && ['get', 'list'].includes(a.action) || tool === 'team_word' && a.action === 'list';
  if (!readOnly) require('./members').snapshot();
  if (tool === 'codex_send' && a.full_access && guest(opts))
    throw Error('Гостю полный доступ Codex запрещён; изменения не выполнены.');
  if (tool === 'deepseek_send' && a.full_access && guest(opts))
    throw Error('Гостю полный доступ DeepSeek запрещён; изменения не выполнены.');
  // team-v46: полный доступ Claude-исполнителю ставит только дирижёр; запись — как у Codex (проверяется ниже).
  if (tool === 'claude_send' && a.full_access && guest(opts))
    throw Error('Гостю полный доступ Claude запрещён; изменения не выполнены.');
  // Права дирижёра запасного режима (team-v19, К2) снимают запреты гостю на изменение работ и запись по поручению.
  const fallback = require('./fallback'), conductor = guest(opts) && fallback.conductorAllows(server, tool, a);
  if (!allowed(server, tool, opts) || (guest(opts) && (
    (tool === 'team_work' && !['get', 'list'].includes(a.action) && !conductor) ||
    (tool === 'team_status' && (a.claude_quota || a.claude_usage || a.notify_test)) ||
    (tool === 'codex_send' && a.write && !require('./members').canWrite(client()) && !conductor) ||
    (tool === 'deepseek_send' && a.write && !require('./members').canWrite(client()) && !conductor) ||
    (tool === 'claude_send' && a.write && !require('./members').canWrite(client()) && !conductor) ||
    tool === 'deepseek_cancel' ||
    tool === 'team_change'
  ))) {
    throw Error('Гостю это действие запрещено; изменения не выполнены.');
  }
  if (/_send$/.test(tool) && server !== 'grok') {
    const members = require('./members'), recipient = members.receiver(server);
    if (!members.canSend(client(), recipient?.id)) throw Error('Реестр участников запрещает отправку этому получателю.');
    if (a.write && !members.canWrite(recipient.id)) throw Error('Реестр участников запрещает запись: получателю нужна роль writer.');
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
