'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { samePath } = require('./paths');
const begin = '# most:begin (правит team_change deploy)', end = '# most:end';
function paths() {
  const home = process.env.USERPROFILE || os.homedir();
  return [
    { file: process.env.MOST_CODEX_CONFIG || path.join(home, '.codex/config.toml'), kind: 'codex' },
    { file: process.env.MOST_AGY_MCP_CONFIG || path.join(home, '.gemini/config/mcp_config.json'), kind: 'agy' },
    { file: process.env.MOST_AGY_CONFIG || (process.env.MOST_AGY_MCP_CONFIG ? path.join(path.dirname(process.env.MOST_AGY_MCP_CONFIG), 'config.json') : path.join(home, '.gemini/config/config.json')), kind: 'permissions' },
  ];
}
// Серверы связки в приложениях (team-v19, К2): Codex получает и сервер codex, Antigravity — сервер antigravity (гостями;
// пользоваться ими может только дирижёр запасного режима).
const CODEX = require('./members').servers, AGY = require('./members').servers;
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
    if (r.path[0] === 'mcp_servers' && ((r.path.length === 1 && !r.header) || CODEX.includes(r.path[1])))
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
  require('./ownership').assertOwn(b.exists ? current : {}, CODEX, root, file);
  const lines = [begin];
  // env_vars: гость поручения-сеанса получает MOST_JOB_ID от codex exec, гость чата — нет (Р-ж).
  for (const n of CODEX) lines.push(`[mcp_servers.${n}]`, 'command = ' + literal(node), 'args = [' + literal(path.join(release, 'servers', n, 'index.js')) + ']', 'startup_timeout_sec = 30', "default_tools_approval_mode = 'approve'", 'env_vars = ["MOST_JOB_ID"]', `[mcp_servers.${n}.env]`, 'MOST_REPO_ROOT = ' + literal(root), 'MOST_STATE_DIR = ' + literal(state), "MOST_CLIENT = 'codex'");
  lines.push(end);
  return text.slice(0, b.from) + (!b.exists && text && !text.endsWith('\n') ? eol : '') + lines.join(eol) + eol + text.slice(b.to);
}
const grants = ['team/team_status', 'team/team_rules', 'team/team_work', 'team/team_word', 'codex/codex_status', 'codex/codex_result', 'codex/codex_send',
  'antigravity/antigravity_send', 'antigravity/antigravity_status', 'antigravity/antigravity_result', 'antigravity/antigravity_apply', 'antigravity/antigravity_cancel'].map(n => 'mcp(' + n + ')');
// К11: разрешение Antigravity читать корневой AGENTS.md старого релиза переводится на AGENTS.md текущего релиза.
function relinkAgents(allow, root, release) {
  const current = 'read_file(' + path.join(release, 'AGENTS.md') + ')';
  return allow.map(x => {
    const match = typeof x === 'string' && x.match(/^read_file\((.*)[\\/]live[\\/][a-f0-9]{40}[\\/]AGENTS\.md\)$/i);
    return match && samePath(match[1], root) ? current : x;
  });
}

function jsonConfig(config, kind, release, root, state, node, file = 'конфиге Antigravity', foreignGrok = false) {
  state = path.join(root, 'state');
  const out = structuredClone(config);
  if (kind === 'permissions') {
    out.userSettings ||= {}; out.userSettings.globalPermissionGrants ||= {};
    const old = out.userSettings.globalPermissionGrants.allow || [];
    if (!Array.isArray(old)) throw Error('Некорректный список разрешений Antigravity.');
    out.userSettings.globalPermissionGrants.allow = [...new Set([...relinkAgents(old.filter(g => foreignGrok || !/^mcp\(grok\//.test(g)), root, release), ...grants])];
  } else {
    out.mcpServers ||= {};
    if (out.mcpServers.grok && require('./ownership').own(out.mcpServers.grok, 'grok', root)) delete out.mcpServers.grok;
    require('./ownership').assertOwn(out.mcpServers, AGY, root, file);
    for (const n of AGY) out.mcpServers[n] = { command: node, args: [path.join(release, 'servers', n, 'index.js')], env: { MOST_REPO_ROOT: root, MOST_STATE_DIR: state, MOST_CLIENT: 'antigravity' } };
  }
  return out;
}
function plans(snapshots, release, root, state, node) {
  const agy = snapshots.find(s => s.kind === 'agy');
  const foreignGrok = !!agy?.config.mcpServers?.grok && !require('./ownership').own(agy.config.mcpServers.grok, 'grok', root);
  const agySameRelease = !!agy && AGY.every(n => agy.config.mcpServers?.[n]?.args?.[0] && samePath(agy.config.mcpServers?.[n]?.args?.[0], path.join(release, 'servers', n, 'index.js')));
  return snapshots.flatMap(s => {
    let next, same, sameRelease = false;
    if (s.kind === 'codex') {
      next = toml(s.text, release, root, state, node, s.file);
      const old = block(s.text).parsed.root.mcp_servers || {}, wanted = block(next).parsed.root.mcp_servers;
      same = equal(Object.fromEntries([...CODEX, 'grok'].map(n => [n, old[n]])), Object.fromEntries([...CODEX, 'grok'].map(n => [n, wanted[n]])));
      sameRelease = CODEX.every(n => old[n]?.args?.[0] && samePath(old[n]?.args?.[0], path.join(release, 'servers', n, 'index.js')));
    } else {
      const wanted = jsonConfig(s.config, s.kind, release, root, state, node, s.file, foreignGrok);
      same = s.kind === 'permissions'
        ? equal(grants.filter(g => s.config.userSettings?.globalPermissionGrants?.allow?.includes(g)), grants) &&
          equal(s.config.userSettings?.globalPermissionGrants?.allow || [], wanted.userSettings.globalPermissionGrants.allow.filter(x => (s.config.userSettings?.globalPermissionGrants?.allow || []).includes(x)))
        : equal(entries(s.config, [...AGY, 'grok']), entries(wanted, [...AGY, 'grok']));
      sameRelease = s.kind === 'agy' && AGY.every(n => s.config.mcpServers?.[n]?.args?.[0] && samePath(s.config.mcpServers?.[n]?.args?.[0], path.join(release, 'servers', n, 'index.js')));
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
        const args = CODEX.map(n => managed[n]?.args?.[0]).filter(Boolean);
        return 'Codex: ' + (args.join('; ') || 'не подключён');
      }
      return 'Antigravity: ' + AGY.map(n => n + ' → ' + (s.config.mcpServers?.[n]?.args?.[0] || 'не подключён')).join('; ');
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
    for (const n of [...AGY, 'grok']) { if (prev.config.mcpServers?.[n]) out.mcpServers[n] = prev.config.mcpServers[n]; else delete out.mcpServers[n]; }
  }
  return JSON.stringify(out, null, 2) + '\n';
}
// К12: процессы-гости старых релизов в приложениях Codex и Antigravity — по командной строке live\<релиз>\servers\… и предкам.
function staleGuests({ root, release }, deps = {}) {
  const rows = (deps.processes || (() => require('./fallback').processTable(true, { commandLine: true })))();
  const byPid = new Map(rows.map(r => [r.pid, r])), apps = new Set();
  for (const r of rows) {
    const candidates = require('./cleanup').cmdPaths(String(r.commandLine || '')).abs;
    const rel = candidates.map(p => p.match(/^(.*)[\\/]live[\\/]([a-f0-9]{40})[\\/]servers[\\/]/i))
      .find(m => m && samePath(m[1], root));
    if (!rel || rel[2].toLowerCase() === String(release).toLowerCase()) continue;
    // Вся цепочка предков: гость поручения codex exec основного сервера — потомок Claude Desktop, его перезапускает установка
    // (помощник с чистой памятью, У6); первое имя с «codex» ещё не значит приложение Codex.
    const names = [];
    for (let p = byPid.get(r.ppid), n = 0; p && n < 64; p = byPid.get(p.ppid), n++) names.push(String(p.name || '').toLowerCase());
    if (names.some(n => /^claude/.test(n))) continue;
    if (names.some(n => /antigravity|language_server/.test(n))) apps.add('Antigravity');
    else if (names.some(n => /codex|chatgpt/.test(n))) apps.add('Codex');
  }
  const list = ['Codex', 'Antigravity'].filter(a => apps.has(a));
  if (!list.length) return '';
  return list.join(' и ') + (list.length > 1 ? ' работают' : ' работает') + ' со старыми серверами связки; слово о Claude заработает в ' +
    (list.length > 1 ? 'них' : 'нём') + ' после перезапуска приложения.';
}
module.exports = { paths, plans, toml, block, status, grants, restore, equal, entries, jsonConfig, relinkAgents, staleGuests, CODEX, AGY };
