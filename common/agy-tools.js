'use strict';
const names = ['team_status', 'team_rules', 'team_work', 'codex_status', 'codex_result', 'codex_send',
  'grok_status', 'grok_result', 'grok_send'];
function allowed(call) {
  let name = call.name || call.tool || call.function?.name || '', args = call.arguments || call.args || call.parameters || call.function?.arguments || {};
  try { if (typeof args === 'string') args = JSON.parse(args); } catch { return false; }
  let server;
  if (name === 'call_mcp_tool') { server = args.serverName || args.server_name || args.server; name = args.toolName || args.tool_name || args.tool || ''; args = args.arguments || args.args || args.input || {}; }
  const match = names.find(n => [n, 'mcp__' + n.split('_')[0] + '__' + n, n.split('_')[0] + '/' + n, 'mcp_' + n.split('_')[0] + '_' + n].includes(name));
  if (!match) return false;
  if (server && server !== match.split('_')[0]) return false;
  try { if (typeof args === 'string') args = JSON.parse(args); } catch { return false; }
  return !(match === 'team_work' && !['get', 'list'].includes(args.action)) && !(match === 'codex_send' && args.write) && !(match === 'team_status' && (args.claude_usage || args.claude_quota || args.notify_test));
}
function forbidden(calls) {
  if (!Array.isArray(calls)) calls = [calls];
  return calls.some(c => {
    if (allowed(c)) return false;
    const name = c.name || c.tool || c.function?.name || '';
    return /mcp|team_|codex_|grok_|write|replace|run_command|execute|delete|create|edit|terminal|shell|move|rename|subagent|manage_task/i.test(name);
  });
}
module.exports = { allowed, forbidden };
