'use strict';
// Наличие этого модуля в целевом релизе — поддержка замысла 3.8.
const fs = require('fs'), path = require('path'), os = require('os');
const settingsPath = () => process.env.MOST_AGY_CLI_SETTINGS || path.join(process.env.USERPROFILE || os.homedir(), '.gemini/antigravity-cli/settings.json');
const supports = release => !!release && fs.existsSync(path.join(release, 'common/agy-mcp-permissions.js'));
const encode = value => JSON.stringify(value, null, 2) + '\n';
const parse = text => JSON.parse(text.replace(/^\uFEFF/, ''));
function read(file) { return require('./deploy').snapshot(file, true); }
function check(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.permissions !== undefined && (!config.permissions || typeof config.permissions !== 'object' || Array.isArray(config.permissions))) ||
      (config.permissions?.allow !== undefined && (!Array.isArray(config.permissions.allow) || config.permissions.allow.some(x => typeof x !== 'string'))))
    throw Error('Некорректные permissions.allow Antigravity CLI.');
}
function plans(release, root, { rollback = false, file = settingsPath() } = {}) {
  const supported = supports(release);
  if (!supported && !rollback) return [];
  const backup = read(file + '.most-mcp-backup.json');
  if (rollback && !backup.exists) return []; // Этот установщик ничего не менял.
  const current = read(file); check(current.config);
  let record = backup.config;
  if (backup.exists) {
    if (record.version !== 1 || record.file !== path.resolve(file) || typeof record.existed !== 'boolean' || typeof record.active !== 'boolean' ||
        typeof record.text !== 'string' || !Array.isArray(record.managed) || record.managed.some(x => !/^mcp\([a-zA-Z0-9_-]+\/(?:[a-zA-Z0-9_.-]+|\*)\)$/.test(x)))
      throw Error('Повреждена резервная копия разрешений MCP: ' + backup.file);
    check(parse(record.text));
    if (rollback && !record.active) return [];
  }
  if (!backup.exists || !record.active) record = { version: 1, file: path.resolve(file), existed: current.exists, text: current.text || '{}', managed: [], active: true };
  const original = parse(record.text), oldAllow = original.permissions?.allow || [];
  const roster = supported ? require('./members-store').create(path.join(root, 'state')).read({ initialize: false }).members : [];
  const allow = require('./members').receiver('antigravity', roster)?.mcp_allow || [];
  const wanted = allow.map(x => 'mcp(' + x + ')');
  const managed = [...new Set([...record.managed, ...wanted])];
  // Восстанавливаем только наши правила, не permissions.deny/ask и не чужие allow.
  const next = structuredClone(current.config);
  let grants = [...(next.permissions?.allow || [])];
  for (const grant of managed) {
    const count = Math.max(oldAllow.filter(x => x === grant).length, wanted.includes(grant) ? 1 : 0);
    if (grants.filter(x => x === grant).length !== count) { grants = grants.filter(x => x !== grant); for (let i = 0; i < count; i++) grants.push(grant); }
  }
  if (grants.length || original.permissions?.allow !== undefined) { next.permissions ||= {}; next.permissions.allow = grants; }
  else if (next.permissions) delete next.permissions.allow;
  if (next.permissions && !Object.keys(next.permissions).length && original.permissions === undefined) delete next.permissions;
  const equal = require('./client-configs').equal;
  const nextText = !record.existed && !Object.keys(next).length ? null : equal(next, original) && record.existed ? record.text : encode(next);
  const out = [];
  const recordText = encode({ ...record, managed, active: supported });
  // Исходный файл (или факт его отсутствия) сохраняется ДО изменения настроек.
  if (!backup.exists || backup.text !== recordText) out.push({ ...backup, next: recordText, backup: false });
  if ((current.exists ? current.text : null) !== nextText && !(current.exists && nextText !== null && equal(current.config, next)))
    out.push({ ...current, next: nextText, backup: false });
  // Отметка завершённого отката публикуется после настроек. Если процесс погибнет
  // между записями, повтор увидит active=true и закончит восстановление.
  if (rollback && !supported) out.reverse();
  return out;
}
module.exports = { plans, settingsPath, supports };
