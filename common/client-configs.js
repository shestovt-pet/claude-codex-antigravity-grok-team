'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const begin = '# most:begin (правит team_change deploy)', end = '# most:end';
function paths() {
  const home = process.env.USERPROFILE || os.homedir();
  return [
    { file: process.env.MOST_CODEX_CONFIG || path.join(home, '.codex/config.toml'), kind: 'codex' },
    { file: process.env.MOST_AGY_MCP_CONFIG || path.join(home, '.gemini/config/mcp_config.json'), kind: 'agy' },
    { file: process.env.MOST_AGY_CONFIG || (process.env.MOST_AGY_MCP_CONFIG ? path.join(path.dirname(process.env.MOST_AGY_MCP_CONFIG), 'config.json') : path.join(home, '.gemini/config/config.json')), kind: 'permissions' },
  ];
}
function block(text) {
  const parsed = require('./toml-records').document(text), marks = [];
  let depth = 0;
  for (const t of parsed.tokens) {
    if (['[', '{'].includes(t.type)) depth++;
    if ([']', '}'].includes(t.type)) depth--;
    if (t.type !== 'comment' || depth !== 0) continue;
    const from = text.lastIndexOf('\n', t.start - 1) + 1;
    if (!/^[ \t\uFEFF]*$/.test(text.slice(from, t.start)) || !/^#\s*most:(?:begin|end)\b/.test(t.value)) continue;
    marks.push({ value: t.value.trimEnd(), from, to: text[t.end] === '\n' ? t.end + 1 : t.end });
  }
  if (marks.length && (marks.length !== 2 || marks[0].value !== begin || marks[1].value !== end)) throw Error('Повреждённые или повторные метки подключений Codex.');
  const from = marks[0]?.from ?? text.length, to = marks[1]?.to ?? text.length;
  for (const r of parsed.records) {
    if (r.start >= from && r.start < to) continue;
    if (r.path[0] === 'mcp_servers' && ((r.path.length === 1 && !r.header) || ['team', 'antigravity', 'grok'].includes(r.path[1])))
      throw Error('Одноимённые ключи или таблицы подключений Codex находятся вне служебного блока.');
  }
  return { from, to, exists: !!marks.length, parsed };
}
function equal(a, b) {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
const entries = (config, names) => Object.fromEntries(names.map(n => [n, config?.mcpServers?.[n] ?? null]));
function literal(value) {
  if (/[\r\n']/.test(value)) throw Error('Путь нельзя записать литеральной строкой TOML.');
  return "'" + value + "'";
}
function toml(text, release, root, state, node, file = 'конфиге Codex') {
  state = path.join(root, 'state');
  const b = block(text), eol = text.includes('\r\n') ? '\r\n' : '\n';
  const current = b.parsed.root.mcp_servers || {};
  require('./ownership').assertOwn(b.exists ? current : {}, ['team', 'antigravity', 'grok'], root, file);
  const lines = [begin];
  for (const n of ['team', 'antigravity', 'grok']) lines.push(`[mcp_servers.${n}]`, 'command = ' + literal(node), 'args = [' + literal(path.join(release, 'servers', n, 'index.js')) + ']', 'startup_timeout_sec = 30', "default_tools_approval_mode = 'approve'", `[mcp_servers.${n}.env]`, 'MOST_REPO_ROOT = ' + literal(root), 'MOST_STATE_DIR = ' + literal(state), "MOST_CLIENT = 'codex'");
  lines.push(end);
  return text.slice(0, b.from) + (!b.exists && text && !text.endsWith('\n') ? eol : '') + lines.join(eol) + eol + text.slice(b.to);
}
const grants = ['team/team_status', 'team/team_rules', 'team/team_work', 'codex/codex_status', 'codex/codex_result', 'codex/codex_send', 'grok/grok_send', 'grok/grok_status', 'grok/grok_result'].map(n => 'mcp(' + n + ')');
function jsonConfig(config, kind, release, root, state, node, file = 'конфиге Antigravity') {
  state = path.join(root, 'state');
  const out = structuredClone(config);
  if (kind === 'permissions') {
    out.userSettings ||= {}; out.userSettings.globalPermissionGrants ||= {};
    const old = out.userSettings.globalPermissionGrants.allow || [];
    if (!Array.isArray(old)) throw Error('Некорректный список разрешений Antigravity.');
    out.userSettings.globalPermissionGrants.allow = [...new Set([...old, ...grants])];
  } else {
    out.mcpServers ||= {};
    require('./ownership').assertOwn(out.mcpServers, ['team', 'codex', 'grok'], root, file);
    for (const n of ['team', 'codex', 'grok']) out.mcpServers[n] = { command: node, args: [path.join(release, 'servers', n, 'index.js')], env: { MOST_REPO_ROOT: root, MOST_STATE_DIR: state, MOST_CLIENT: 'antigravity' } };
  }
  return out;
}
function plans(snapshots, release, root, state, node) {
  const agy = snapshots.find(s => s.kind === 'agy');
  const agySameRelease = !!agy && ['team', 'codex', 'grok'].every(n => agy.config.mcpServers?.[n]?.args?.[0] === path.join(release, 'servers', n, 'index.js'));
  return snapshots.flatMap(s => {
    let next, same, sameRelease = false;
    if (s.kind === 'codex') {
      next = toml(s.text, release, root, state, node, s.file);
      const old = block(s.text).parsed.root.mcp_servers || {}, wanted = block(next).parsed.root.mcp_servers;
      same = equal({team: old.team, antigravity: old.antigravity, grok: old.grok},
        {team: wanted.team, antigravity: wanted.antigravity, grok: wanted.grok});
      sameRelease = ['team', 'antigravity', 'grok'].every(n => old[n]?.args?.[0] === path.join(release, 'servers', n, 'index.js'));
    } else {
      const wanted = jsonConfig(s.config, s.kind, release, root, state, node, s.file);
      same = s.kind === 'permissions'
        ? equal(grants.filter(g => s.config.userSettings?.globalPermissionGrants?.allow?.includes(g)), grants)
        : equal(entries(s.config, ['team', 'codex', 'grok']), entries(wanted, ['team', 'codex', 'grok']));
      sameRelease = s.kind === 'agy' && ['team', 'codex', 'grok'].every(n => s.config.mcpServers?.[n]?.args?.[0] === path.join(release, 'servers', n, 'index.js'));
      if (s.kind === 'permissions') sameRelease = agySameRelease;
      next = JSON.stringify(wanted, null, 2) + '\n';
    }
    return same ? [] : [{ ...s, next, backup: !sameRelease }];
  });
}
function status() {
  return paths().filter(p => p.kind !== 'permissions').map(({file, kind}) => {
    if (!fs.existsSync(file)) return file + ': не подключён';
    try {
      const s = require('./deploy').snapshot(file);
      if (kind === 'codex') {
        const managed = block(s.text).parsed.root.mcp_servers || {};
        const args = ['team', 'antigravity', 'grok'].map(n => managed[n]?.args?.[0]).filter(Boolean);
        return 'Codex: ' + (args.join('; ') || 'не подключён');
      }
      return 'Antigravity: ' + ['team', 'codex', 'grok'].map(n => n + ' → ' + (s.config.mcpServers?.[n]?.args?.[0] || 'не подключён')).join('; ');
    } catch { return file + ': ошибка чтения подключений'; }
  }).join('\n');
}
function restore(s, prev, kind) {
  if (kind === 'codex') {
    const b = block(s.text), old = block(prev.text);
    return s.text.slice(0, b.from) + prev.text.slice(old.from, old.to) + s.text.slice(b.to);
  }
  const out = structuredClone(s.config);
  if (kind === 'permissions') {
    const was = prev.config.userSettings?.globalPermissionGrants?.allow || [];
    if (out.userSettings?.globalPermissionGrants) out.userSettings.globalPermissionGrants.allow = [...new Set([...(out.userSettings.globalPermissionGrants.allow || []).filter(x => !grants.includes(x)), ...was])];
  } else {
    out.mcpServers ||= {};
    for (const n of ['team', 'codex', 'grok']) { if (prev.config.mcpServers?.[n]) out.mcpServers[n] = prev.config.mcpServers[n]; else delete out.mcpServers[n]; }
  }
  return JSON.stringify(out, null, 2) + '\n';
}
module.exports = { paths, plans, toml, block, status, grants, restore, equal, entries, jsonConfig };
