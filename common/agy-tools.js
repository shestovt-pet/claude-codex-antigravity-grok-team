'use strict';
// Разрешения MCP поручения берутся только из реестра (замысел 3.8).
// Прежний набор поручений Antigravity (team_status, team_rules, team_work get|list,
// codex_status/result/send без write) сохранён: его задаёт members-default.
const MASK = require('./members-store').MCP_MASK;
function masks() { return require('./members').receiver('antigravity')?.mcp_allow || []; }
function target(call) {
  const name = call?.name || call?.tool || call?.function?.name || '';
  if (typeof name !== 'string' || !name) return null;
  let args = call?.arguments || call?.args || call?.parameters || call?.function?.arguments || {};
  try { if (typeof args === 'string') args = JSON.parse(args); } catch { return null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (['call_mcp_tool', 'list_resources', 'read_resource'].includes(name)) {
    const servers = [args.serverName, args.server_name, args.server].filter(x => x !== undefined);
    const tools = name === 'call_mcp_tool' ? [args.toolName, args.tool_name, args.tool].filter(x => x !== undefined) : [name];
    // Прежний вид вызова: сервер не указан, а имя инструмента начинается с team_/codex_.
    if (!servers.length && name === 'call_mcp_tool' && tools.length === 1) {
      const pref = String(tools[0]).match(/^(team|codex|grok|deepseek|claude)_/);
      if (pref) servers.push(pref[1]);
    }
    if (!servers.length || !tools.length || new Set(servers).size !== 1 || new Set(tools).size !== 1) return null;
    // Аргументы вложенного вызова проверяются так же, как у прямого имени инструмента.
    let inner = args.arguments || args.args || args.input || {};
    try { if (typeof inner === 'string') inner = JSON.parse(inner); } catch { return null; }
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
    return { server: servers[0], tool: tools[0], args: inner };
  }
  const m = name.match(/^mcp__([a-zA-Z0-9_-]+)__([a-zA-Z0-9_.-]+)$/) ||
    name.match(/^mcp_([a-zA-Z0-9-]+)_([a-zA-Z0-9_.-]+)$/) ||
    name.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (m) return { server: m[1], tool: m[2], args };
  // Прежние имена без сервера: team_status, codex_send и т.п.
  const bare = name.match(/^(team|codex|grok|deepseek|claude)_([a-z0-9_]+)$/);
  return bare ? { server: bare[1], tool: name, args } : null;
}
// team-v48e Г4e: вторая маска (пишущий codex/deepseek_send, team_work-изменение, deepseek_cancel, team_status usage) снята
// безусловно (тумблер MOST_STRICT_REGISTRY удалён) — действие решает только mcp_allow и серверный guard. Первая маска
// (maskOk, строгая сверка mcp_allow) сохраняется ниже — это подлинность разрешений, не лимит.
function withinLimits() {
  return true;
}
function allowed(call, allow = masks()) {
  const t = target(call);
  if (!t || !/^[a-zA-Z0-9_-]+$/.test(t.server) || !/^[a-zA-Z0-9_.-]+$/.test(t.tool)) return false;
  const maskOk = Array.isArray(allow) && allow.some(mask => typeof mask === 'string' && MASK.test(mask) &&
    mask.split('/')[0] === t.server && ['*', t.tool].includes(mask.split('/')[1]));
  return maskOk && withinLimits(t);
}
function forbidden(calls) {
  if (!Array.isArray(calls)) calls = [calls];
  return calls.some(c => {
    if (allowed(c)) return false;
    const name = c?.name || c?.tool || c?.function?.name || '';
    if (typeof name !== 'string' || !name) return true;
    return /mcp|list_resources|read_resource|\/|team_|codex_|antigravity_|grok_|deepseek_|claude_|write|replace|run_command|execute|delete|create|edit|terminal|shell|move|rename|subagent|manage_task/i.test(name);
  });
}
function instruction() {
  const allow = masks();
  return '- MCP разрешены только по маскам из реестра: ' + (allow.length ? allow.join(', ') : 'нет разрешённых MCP') + '. Остальные MCP запрещены. Запись во внешнем сервисе — только по поручению.';
}
module.exports = { allowed, forbidden, masks, instruction, MASK };
