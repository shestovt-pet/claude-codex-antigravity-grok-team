'use strict';
// Контракт совместимости team-v21: common/path-compat.js нельзя удалять или
// переименовывать без смены признака нового кода в deploy-ops.
// Для нового релиза на E: удаление файла даёт не отказ, а отключённую уборку
// и строку «релиз старого кода». После возврата на любой релиз старого кода
// (без common/path-compat.js) не запускать team_change cleanup.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const paths = require('./paths');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const fold = s => process.platform === 'win32' ? s.toLowerCase() : s;
function realOrGiven(p) { try { return fs.realpathSync(p); } catch { return p; } }
function strictSamePath(a, b) {
  try { return fold(fs.realpathSync.native(a)) === fold(fs.realpathSync.native(b)) ? 'same' : 'different'; }
  catch { return 'unknown'; }
}
function modernRelease(release) {
  try { fs.readFileSync(path.join(release, 'common/path-compat.js')); return true; } catch { return false; }
}
function releasePolicy(root, release) {
  if (modernRelease(release)) return { root, oldCode: false };
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(release, 'probe-ok.json'), 'utf8')); } catch {}
  if (!marker || !path.isAbsolute(marker.root || '') || strictSamePath(marker.root, root) !== 'same')
    throw Error('Релиз собран для ' + (marker?.root || 'неизвестного корня') + ', а этот путь сейчас не подтверждён как та же папка, что ' + root + ' — нужен релиз, собранный на E:');
  return { root: marker.root, oldCode: true };
}
// Раскрываем существующего родителя, сохраняя регистр несуществующего хвоста.
function spelling(p, real) {
  let cur = path.resolve(p); const tail = [];
  for (;;) {
    try { return path.join(real(cur), ...tail.reverse()); }
    catch (e) {
      if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e;
      const parent = path.dirname(cur); if (parent === cur) throw e;
      tail.push(path.basename(cur)); cur = parent;
    }
  }
}
function spellings(p) {
  const out = [path.resolve(p)];
  for (const real of [fs.realpathSync, fs.realpathSync.native]) {
    try { out.push(spelling(p, real)); } catch { /* Текстовое имя остаётся. */ }
  }
  return [...new Set(out)];
}
function within(child, parent) {
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function connectionSources() {
  const roots = [], states = [];
  const files = [];
  try { files.push(...require('./client-configs').paths().filter(p => p.kind !== 'permissions').map(p => p.file)); } catch {}
  try { files.push(...require('./deploy').configPaths()); } catch {}
  for (const file of [...new Set(files.flatMap(f => [f, f + '.prev']))]) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const obj = /\.toml(?:\.prev)?$/i.test(file) ? require('./toml-records').document(text).root : JSON.parse(text);
      const walk = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, v] of Object.entries(value)) {
          if (typeof v === 'string' && path.isAbsolute(v)) {
            if (key === 'MOST_REPO_ROOT') roots.push(v);
            if (key === 'MOST_STATE_DIR') states.push(v);
          } else walk(v);
        }
      };
      walk(obj);
    } catch { /* Недоступное подключение не отменяет остальные источники. */ }
  }
  return { roots, states };
}
function channel(kind, key, state) {
  const h = hash((kind === 'team_repo' ? 'team_repo' : state) + '|' + kind + '|' + key).slice(0, 32);
  return process.platform === 'win32' ? '\\\\.\\pipe\\most-' + h : process.platform === 'linux' ? '\0most-' + h : path.join(os.tmpdir(), 'most-' + h + '.sock');
}
// Снимок источников и прежнего корня неизменен в течение жизни процесса.
function createLockNames({ root = paths.repoRoot, previousRoot = 'C:\\most', sources = connectionSources() } = {}) {
  const roots = spellings(root);
  let previousActive = false;
  try { previousActive = fold(fs.realpathSync.native(previousRoot)) === fold(fs.realpathSync.native(root)); }
  catch (e) { previousActive = e.code !== 'ENOENT'; }
  const aliases = [];
  for (const source of sources.roots) if (paths.samePath(source, root)) aliases.push(source);
  if (previousActive) aliases.push(previousRoot);
  const expand = (p, statePath, keyState) => {
    const out = new Set(spellings(p));
    for (const base of roots) for (const value of [...out]) if (within(value, base)) {
      const suffix = path.relative(base, value);
      for (const alias of aliases) for (const s of spellings(path.join(alias, suffix))) out.add(s);
    }
    for (const source of sources.states) {
      if (statePath && paths.samePath(source, p)) for (const s of spellings(source)) out.add(s);
      if (!statePath) for (const base of spellings(keyState || paths.stateDir)) for (const value of [...out]) {
        if (paths.samePath(source, base) && within(value, base))
          for (const s of spellings(path.join(source, path.relative(base, value)))) out.add(s);
      }
    }
    return [...out];
  };
  return (kind, key, state = paths.stateDir) => {
    const states = kind === 'team_repo' ? [state] : expand(state, true);
    const keys = kind !== 'team_repo' && path.isAbsolute(key) ? expand(key, false, state) : [key];
    const result = new Map();
    for (const s of states) for (const k of keys) {
      const name = channel(kind, k, s);
      if (!result.has(name)) result.set(name, { name, state: s, key: k,
        infoPath: path.join(realOrGiven(s), 'locks', kind + '-' + hash(s + '|' + kind + '|' + k).slice(0, 20) + '.json') });
    }
    return [...result.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  };
}
module.exports = { realOrGiven, strictSamePath, modernRelease, releasePolicy, spellings, createLockNames, channel };
// require не читает подключения: deploy может ещё загружаться. Снимок — при первом обращении.
let defaultLockNames;
module.exports.lockNames = (...args) => (defaultLockNames ||= createLockNames())(...args);
