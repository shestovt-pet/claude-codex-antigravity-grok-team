'use strict';
const client = () => process.env.MOST_CLIENT || 'claude';
const guest = () => client() !== 'claude';
function allowed(server, tool) {
  if (!guest()) return true;
  if (!['codex', 'antigravity'].includes(client())) return false;
  if (server === 'team') return ['team_status', 'team_rules', 'team_work'].includes(tool);
  return client() !== server && [server + '_status', server + '_result', server + '_send'].includes(tool);
}
function guard(server, tool, a = {}) {
  if (!allowed(server, tool) || (guest() && (
    (tool === 'team_work' && !['get', 'list'].includes(a.action)) ||
    (tool === 'team_status' && (a.claude_quota || a.claude_usage || a.notify_test)) ||
    (tool === 'codex_send' && a.write))))
    throw Error('Гостю это действие запрещено; изменения не выполнены.');
}
const queued = 'Поручение поставлено в очередь; выполнит основной сервер (Claude Desktop должен быть открыт)';
function ready(server) {
  if (guest() || process.env.MOST_PROBE_ONLY === '1') return;
  const path = require('path');
  require('./team-git').atomic(path.join(require('./paths').stateDir, 'ready', server + '.json'), JSON.stringify({
    release: path.resolve(__dirname, '..'), pid: process.pid, startedAt: new Date().toISOString(),
  }));
}
module.exports = { client, guest, allowed, guard, ready, queued };
