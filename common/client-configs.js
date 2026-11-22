'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { samePath } = require('./paths');
const begin = '# most:begin (правит team_change deploy)', end = '# most:end';
function paths() {
  return require('./members').installedClients.flatMap(c => [{ file: c.file, kind: c.kind, client: c.id }, ...(c.kind === 'agy' ? [{ file: process.env.MOST_AGY_CONFIG || path.join(path.dirname(c.file), 'config.json'), kind: 'permissions', client: c.id }] : [])]);
}
// Серверы связки в приложениях (team-v19, К2): Codex получает и сервер codex, Antigravity — сервер antigravity (гостями;
// пользоваться ими может только дирижёр запасного режима).
const CODEX = require('./members').installedServers, AGY = require('./members').installedServers, KIMI = require('./members').installedServers;
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
function toml(text, release, root, state, node, file = 'конфиге Codex', client = require('./members').all().filter(m => m.state !== 'removed').find(m => m.adapter === 'codex-cli')?.id) {
  state = path.join(root, 'state');
  const b = block(text), eol = text.includes('\r\n') ? '\r\n' : '\n';
  const current = b.parsed.root.mcp_servers || {};
  require('./ownership').assertOwn(b.exists ? current : {}, CODEX, root, file);
  const lines = [begin];
  // env_vars: гость поручения-сеанса получает MOST_JOB_ID от codex exec, гость чата — нет (Р-ж).
  for (const n of CODEX) lines.push(`[mcp_servers.${n}]`, 'command = ' + literal(node), 'args = [' + literal(path.join(release, 'servers', n, 'index.js')) + ']', 'startup_timeout_sec = 120', "default_tools_approval_mode = 'approve'", 'env_vars = ["MOST_JOB_ID"]', `[mcp_servers.${n}.env]`, 'MOST_REPO_ROOT = ' + literal(root), 'MOST_STATE_DIR = ' + literal(state), 'MOST_CLIENT = ' + literal(client));
  lines.push(end);
  return text.slice(0, b.from) + (!b.exists && text && !text.endsWith('\n') ? eol : '') + lines.join(eol) + eol + text.slice(b.to);
}
const grantsFor = (client = require('./members').all().filter(m => m.state !== 'removed').find(m => m.adapter === 'agy-cli')?.id) => [...require('./members').installedServers].flatMap(n => require('./access').guestTools(n, client).map(t => 'mcp(' + n + '/' + t + ')'));
const grants = require('./members').dynamic(() => grantsFor(require('./members').all().filter(m => m.state !== 'removed').find(m => m.adapter === 'agy-cli')?.id), true);
// К11: разрешение Antigravity читать корневой AGENTS.md старого релиза переводится на AGENTS.md текущего релиза.
function relinkAgents(allow, root, release) {
  const current = 'read_file(' + path.join(release, 'AGENTS.md') + ')';
  return allow.map(x => {
    const match = typeof x === 'string' && x.match(/^read_file\((.*)[\\/]live[\\/][a-f0-9]{40}[\\/]AGENTS\.md\)$/i);
    return match && samePath(match[1], root) ? current : x;
  });
}

function jsonConfig(config, kind, release, root, state, node, file = 'конфиге Antigravity', foreignGrok = false, client = require('./members').all().filter(m => m.state !== 'removed').find(m => m.adapter === 'agy-cli')?.id) {
  state = path.join(root, 'state');
  const out = structuredClone(config);
  if (kind === 'permissions') {
    out.userSettings ||= {}; out.userSettings.globalPermissionGrants ||= {};
    const old = out.userSettings.globalPermissionGrants.allow || [];
    if (!Array.isArray(old)) throw Error('Некорректный список разрешений Antigravity.');
    out.userSettings.globalPermissionGrants.allow = [...new Set([...relinkAgents(old.filter(g => foreignGrok || !/^mcp\(grok\//.test(g)), root, release), ...grantsFor(client)])];
  } else {
    out.mcpServers ||= {};
    if (out.mcpServers.grok && require('./ownership').own(out.mcpServers.grok, 'grok', root)) delete out.mcpServers.grok;
    require('./ownership').assertOwn(out.mcpServers, AGY, root, file);
    for (const n of AGY) out.mcpServers[n] = { command: node, args: [path.join(release, 'servers', n, 'index.js')], env: { MOST_REPO_ROOT: root, MOST_STATE_DIR: state, MOST_CLIENT: client } };
  }
  return out;
}
// Чат настольного Kimi (user-mcp.json ядра kimi-code): все серверы связки с полями command/args/env/enabled/deferred/
// startupTimeoutMs (schema McpServerConfigSchema, research v58-kimi-chat). Посторонние серверы и посторонние ключи
// пользователя сохраняются; одноимённый чужой сервер вне нашего владения — отказ (assertOwn, как у Antigravity).
function kimiConfig(config, release, root, state, node, file = 'настройках чата Kimi', client = require('./members').all().filter(m => m.state !== 'removed').find(m => m.adapter === 'kimi-cli')?.id) {
  state = path.join(root, 'state');
  const out = structuredClone(config || {});
  out.mcpServers = { ...out.mcpServers };
  require('./ownership').assertOwn(out.mcpServers, KIMI, root, file);
  for (const n of KIMI) out.mcpServers[n] = { command: node, args: [path.join(release, 'servers', n, 'index.js')], env: { MOST_REPO_ROOT: root, MOST_STATE_DIR: state, MOST_CLIENT: client }, enabled: true, deferred: false, startupTimeoutMs: 30000 };
  return out;
}
// Подключается ли клиент к установке: у kimi файл настроек создаётся (домашней папки kimi-code нет → не создавать, предупреждение),
// у прочих — файл настроек приложения должен существовать. Единый предикат вместо прежнего fs.existsSync(p.file) у вызывающих.
function present(p) {
  if (p.kind === 'kimi') return p.file != null && fs.existsSync(path.dirname(p.file));
  return fs.existsSync(p.file);
}
// Строка «чат Kimi подключён: <путь>» для итога установки — по каждому подключённому клиенту kimi (путь настроек найден
// сам и его домашняя папка существует). Ошибок не бросает.
function connected() {
  try { return paths().filter(p => p.kind === 'kimi' && present(p)).map(p => 'чат Kimi подключён: ' + p.file); }
  catch { return []; }
}
// Предупреждения «чат Kimi не подключён» для итога установки: участник kimi-cli есть, но путь настроек не задан, либо домашней
// папки kimi-code нет. Пусто — когда подключать нечего или всё на месте. Ошибок не бросает (итог установки не должен падать).
function warnings() {
  try {
    const members = require('./members'), out = [];
    const configured = new Set(members.installedClients.filter(c => c.kind === 'kimi').map(c => c.id));
    for (const m of members.all().filter(m => m.state !== 'removed' && m.adapter === 'kimi-cli')) {
      if (!configured.has(m.id)) { out.push('чат Kimi не подключён: не задан путь настроек (adapter_params.client_config или MOST_KIMI_MCP_CONFIG).'); continue; }
      const c = members.installedClients.find(cl => cl.id === m.id && cl.kind === 'kimi');
      if (c && c.file != null && !fs.existsSync(path.dirname(c.file))) out.push('чат Kimi не подключён: нет домашней папки kimi-code (' + path.dirname(c.file) + ').');
    }
    return out;
  } catch { return []; }
}
function plans(snapshots, release, root, state, node) {
  const agy = snapshots.find(s => s.kind === 'agy');
  const foreignGrok = !!agy?.config.mcpServers?.grok && !require('./ownership').own(agy.config.mcpServers.grok, 'grok', root);
  const agySameRelease = !!agy && AGY.every(n => agy.config.mcpServers?.[n]?.args?.[0] && samePath(agy.config.mcpServers?.[n]?.args?.[0], path.join(release, 'servers', n, 'index.js')));
  return snapshots.flatMap(s => {
    let next, same, sameRelease = false;
    if (s.kind === 'dsh') {
      next = require('./dsh-config').render(s.text, release, root, node, s.client, s.file);
      return next === s.text ? [] : [{ ...s, next, backup: true, backupBefore: true }];
    }
    if (s.kind === 'codex') {
      next = toml(s.text, release, root, state, node, s.file, s.client);
      const old = block(s.text).parsed.root.mcp_servers || {}, wanted = block(next).parsed.root.mcp_servers;
      same = equal(Object.fromEntries([...CODEX, 'grok'].map(n => [n, old[n]])), Object.fromEntries([...CODEX, 'grok'].map(n => [n, wanted[n]])));
      sameRelease = CODEX.every(n => old[n]?.args?.[0] && samePath(old[n]?.args?.[0], path.join(release, 'servers', n, 'index.js')));
    } else if (s.kind === 'kimi') {
      // Чат Kimi (user-mcp.json): все серверы связки; посторонние ключи/серверы сохранены. Файла могло не быть (s.exists===false
      // из snapshot optional) — тогда он создаётся, резерв не нужен (нечего хранить), а откат при сбое установки его удаляет
      // (switchConfigs по exists===false). Для существовавшего файла — резерв .prev, если сменился выпуск.
      const wanted = kimiConfig(s.config, release, root, state, node, s.file, s.client);
      same = equal(entries(s.config, KIMI), entries(wanted, KIMI));
      sameRelease = s.exists !== false && KIMI.every(n => s.config.mcpServers?.[n]?.args?.[0] && samePath(s.config.mcpServers?.[n]?.args?.[0], path.join(release, 'servers', n, 'index.js')));
      return same ? [] : [{ ...s, next: JSON.stringify(wanted, null, 2) + '\n', backup: s.exists !== false && !sameRelease }];
    } else {
      const wanted = jsonConfig(s.config, s.kind, release, root, state, node, s.file, foreignGrok, s.client);
      same = s.kind === 'permissions'
        ? equal(grantsFor(s.client).filter(g => s.config.userSettings?.globalPermissionGrants?.allow?.includes(g)), grantsFor(s.client)) &&
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
  return paths().filter(p => p.kind !== 'permissions').map(({file, kind, client}) => {
    const title = require('./members').get(client)?.title || client;
    if (!fs.existsSync(file)) return file + ': не подключён';
    try {
      const s = require('./deploy').snapshot(file);
      if (kind === 'dsh') return title + ': ' + Object.entries(require('./dsh-config').connections(s.text).mcpServers).map(([n,c]) => n + ' → ' + c.args[0]).join('; ');
      if (kind === 'codex') {
        const managed = block(s.text).parsed.root.mcp_servers || {};
        const args = CODEX.map(n => managed[n]?.args?.[0]).filter(Boolean);
        return title + ': ' + (args.join('; ') || 'не подключён');
      }
      if (kind === 'kimi') return title + ': ' + KIMI.map(n => n + ' → ' + (s.config.mcpServers?.[n]?.args?.[0] || 'не подключён')).join('; ');
      return title + ': ' + AGY.map(n => n + ' → ' + (s.config.mcpServers?.[n]?.args?.[0] || 'не подключён')).join('; ');
    } catch { return file + ': ошибка чтения подключений'; }
  }).join('\n');
}
function restore(s, prev, kind) {
  if (kind === 'dsh') return require('./dsh-config').restore(s.text, prev.text);
  if (kind === 'codex') {
    const b = block(s.text), old = block(prev.text);
    return s.text.slice(0, b.from) + prev.text.slice(old.from, old.to) + s.text.slice(b.to);
  }
  const out = structuredClone(s.config);
  if (kind === 'kimi') {
    out.mcpServers ||= {};
    for (const n of KIMI) { if (prev.config.mcpServers?.[n]) out.mcpServers[n] = prev.config.mcpServers[n]; else delete out.mcpServers[n]; }
    return JSON.stringify(out, null, 2) + '\n';
  }
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
    for (const c of require('./members').installedClients) if (names.some(n => ({ 'codex-cli': /codex|chatgpt/, 'agy-cli': /antigravity|language_server/, 'dsh-headless': /deepseek.harness|dsh/, 'kimi-cli': /kimi/ })[require('./members').adapterOf(c.id)]?.test(n))) apps.add(c.title);
  }
  const list = require('./members').installedClients.map(c => c.title).filter(a => apps.has(a));
  if (!list.length) return '';
  return list.join(' и ') + (list.length > 1 ? ' работают' : ' работает') + ' со старыми серверами связки; слово о Claude заработает в ' +
    (list.length > 1 ? 'них' : 'нём') + ' после перезапуска приложения.';
}
module.exports = { paths, plans, toml, block, status, grants, grantsFor, restore, equal, entries, jsonConfig, kimiConfig, present, connected, warnings, relinkAgents, staleGuests, CODEX, AGY, KIMI };
