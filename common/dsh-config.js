'use strict';
// YAML служебного блока: стандартные типы, без вычисления тегов из чужого конфига.
const fs = require('fs'), path = require('path');
const begin = '# most:begin (правит team_change deploy)', end = '# most:end';
function bounds(text) {
  const starts = [...text.matchAll(/^# most:begin.*$/gm)], ends = [...text.matchAll(/^# most:end[ \t]*\r?$/gm)];
  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) throw Error('Повреждены метки DSH.');
  const from = starts[0].index, to = ends[0].index + ends[0][0].replace(/\r$/, '').length;
  return { from, to, bodyFrom: from + starts[0][0].length, bodyTo: ends[0].index };
}
function block(text) {
  const b = bounds(text);
  if (!b) return { from: text.length, to: text.length, entries: [], rows: [] };
  const { from, to } = b, body = text.slice(b.bodyFrom, b.bodyTo).trim();
  let rows;
  try {
    const doc = require('yaml').parseDocument(body, { schema: 'core', customTags: [], uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) throw (doc.errors[0] || doc.warnings[0]);
    rows = body ? doc.toJS({ maxAliasCount: 100 }) : [];
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) ||
        (Object.hasOwn(row, 'insert') ? !Array.isArray(row.insert) : !row.id))) throw Error('ожидается список элементов профиля');
    const entries = rows.flatMap(row => row.insert || [row]);
    if (entries.some(e => !e || typeof e.id !== 'string' || e.id.startsWith('mcp-most-') && !e.config?.serverName))
      throw Error('неверный элемент профиля');
    return { from, to, entries, rows };
  } catch (e) { throw Error('cordis.patch.yml не разобран, запись отменена: ' + e.message); }
}
function connections(text) {
  return { mcpServers: Object.fromEntries(block(text).entries.filter(e => e.id.startsWith('mcp-most-')).map(e => [e.config.serverName, e.config])) };
}
function render(text, release, root, node, client = 'deepseek', configFile) {
  const b = block(text), outside = text.slice(0, b.from) + text.slice(b.to);
  if (/\bid:\s*['"]?mcp-most-|\bserverName:\s*['"]?(?:team|codex|antigravity|deepseek|claude|kimi)\b/.test(outside)) throw Error('Подключения most в DSH вне служебного блока; требуется явное устранение дубликатов.');
  const entries = [...require('./members').installedServers].map(n => ({ id: 'mcp-most-' + n, name: '@deepseek-ai/dsh-mcp-client', config: {
    serverName: n, transport: 'stdio', command: node, args: [path.join(release, 'servers', n, 'index.js')],
    env: { MOST_CLIENT: client, MOST_REPO_ROOT: root, MOST_STATE_DIR: path.join(root, 'state') }, failOnStartupError: true,
  } }));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // Профиль накладывается после пакетов: унаследованные строки обновляем по id.
  const inherited = inheritedIds(configFile), foreign = e => !e.id.startsWith('mcp-most-');
  const rows = b.rows.flatMap(row => {
    if (!row.insert) return foreign(row) ? [row] : [];
    const insert = row.insert.filter(foreign);
    return insert.length ? [{ ...row, insert }] : [];
  });
  const added = entries.filter(e => !inherited.has(e.id));
  if (added.length) rows.push({ insert: added });
  rows.push(...entries.filter(e => inherited.has(e.id)));
  const managed = [begin, ...rows.map(row => '- ' + JSON.stringify(row)), end].join(eol);
  return text.slice(0, b.from) + (b.from && !text.slice(0, b.from).endsWith('\n') ? eol : '') + managed + (b.to === text.length ? eol : '') + text.slice(b.to);
}
function restore(text, previous) {
  let a, b;
  try { a = bounds(text); b = bounds(previous); }
  catch { return previous; }
  if (!a || !b) return previous;
  // Для отката нужны только метки: YAML внутри блока может быть повреждён.
  return text.slice(0, a.from) + previous.slice(b.from, b.to) + text.slice(a.to);
}
function inheritedIds(configFile) {
  const ids = new Set(); if (!configFile) return ids;
  const profile = path.dirname(configFile), manifest = path.join(profile, 'package.json');
  if (!fs.existsSync(manifest)) return ids;
  const bundles = JSON.parse(fs.readFileSync(manifest, 'utf8')).dsh?.profile?.bundles || [];
  for (const name of bundles) {
    if (typeof name !== 'string' || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) || name.split('/').some(s => s === '.' || s === '..'))
      throw Error('Неизвестное имя пакета профиля DSH.');
    const dir = path.join(profile, 'node_modules', name), file = path.join(dir, 'package.json');
    if (!fs.existsSync(file)) {
      if (name.startsWith('@deepseek-ai/')) continue; // встроенные пакеты не содержат подключений most
      throw Error('Не прочитан пакет DSH: ' + name);
    }
    const patch = JSON.parse(fs.readFileSync(file, 'utf8')).dsh?.bundle?.patch;
    for (const p of patch == null ? [] : Array.isArray(patch) ? patch : [patch]) {
      if (typeof p !== 'string' || !p) throw Error('Неизвестная запись patch DSH: ' + name);
      const patchFile = path.resolve(dir, p), rel = path.relative(dir, patchFile);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Файл patch вне пакета DSH: ' + name);
      const text = fs.readFileSync(patchFile, 'utf8');
      // Только литеральные идентификаторы. YAML/!!js не исполняются.
      for (const m of text.matchAll(/^\s*-\s*id:\s*['"]?(mcp-most-[a-z0-9_-]+)['"]?\s*(?:#.*)?$/gm)) ids.add(m[1]);
      if (/mcp-most-/.test(text) && !/^-?\s*(?:-\s*)?id:\s*['"]?mcp-most-/m.test(text))
        throw Error('Не распознаны строки most в пакете DSH: ' + name);
    }
  }
  return ids;
}
module.exports = { block, connections, render, restore, inheritedIds };
