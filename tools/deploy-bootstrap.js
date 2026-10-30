'use strict';
// Только встроенные модули: проверяется до загрузки common/paths и реестра.
const fs = require('fs'), path = require('path'), { createRequire } = require('module');
const real = p => fs.realpathSync.native(p);
const key = p => process.platform === 'win32' ? p.toLowerCase() : p;
const equal = (a, b) => key(a) === key(b);
function within(parent, child) {
  const rel = path.relative(key(parent), key(child));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function prospective(p) {
  p = path.resolve(p);
  try { return real(p); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const parent = path.dirname(p);
    if (parent === p) throw e;
    return path.join(prospective(parent), path.basename(p));
  }
}
function stateRoot(root, env = process.env) {
  if (env.MOST_STATE_DIR && !equal(prospective(env.MOST_STATE_DIR), prospective(path.join(root, 'state'))))
    throw Error('MOST_STATE_DIR должен совпадать с <root>\\state; --state-dir задаёт только каталог блокировок.');
}
function cliRelease(root, filename, release) {
  const file = real(filename), dir = path.dirname(path.dirname(file));
  if (!equal(file, path.join(dir, 'tools', 'deploy.js')) || !/^[a-f0-9]{40}$/.test(path.basename(dir)) ||
      !equal(path.dirname(dir), path.join(real(root), 'live')) || (release && !equal(real(release), dir)))
    throw Error('Настройки меняет только CLI готового релиза <root>\\live\\<коммит>\\tools\\deploy.js с явным --root или MOST_REPO_ROOT.');
  return dir;
}
function localYaml(release, filename) {
  let ok = false;
  try {
    const modules = real(path.join(release, 'node_modules'));
    const resolved = real(createRequire(real(filename)).resolve('yaml'));
    ok = within(release, modules) && within(modules, resolved);
  } catch (e) {
    if (!['ENOENT', 'MODULE_NOT_FOUND'].includes(e.code)) throw e;
  }
  if (!ok) throw Error('В релизе ' + release + ' отсутствует локальная зависимость yaml или она разрешилась вне ' + release + '\\node_modules. Установка отменена; требуется полный релиз. --root задаёт корень состояния, а не зависимости');
}
function resultContext(options, filename) {
  if (!options.release) throw Error('--result требует --release.');
  const file = real(options.result);
  if (!fs.statSync(file).isFile()) throw Error('Результат операции должен быть обычным файлом.');
  const dir = path.dirname(file), state = path.dirname(dir), root = path.dirname(state);
  const op = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (path.basename(dir) !== 'deploy-ops' || path.basename(state) !== 'state' ||
      typeof op.id !== 'string' || !op.id || /[\\/]/.test(op.id) || path.basename(file) !== op.id + '.json' ||
      op.status !== 'запущена' || !equal(real(op.root), root) ||
      (options.root && !equal(real(options.root), root))) throw Error('Не подтверждена принадлежность или статус результата операции.');
  const release = cliRelease(root, filename, options.release);
  if (!equal(real(op.release), release)) throw Error('Результат операции относится к другому релизу.');
  const marker = JSON.parse(fs.readFileSync(path.join(release, 'probe-ok.json'), 'utf8'));
  if (!equal(real(marker.root), root)) throw Error('Метка пробного запуска относится к другому корню.');
  return { root, file };
}
function bootstrap(options, undo, filename, env = process.env) {
  const settings = undo || options.configOnly || options.clientsOnly;
  let root = options.root || env.MOST_REPO_ROOT;
  if (options.result) {
    const context = resultContext({ ...options, root }, filename);
    root = context.root; options.result = context.file;
  }
  if (!root && settings) throw Error('Для настройки и отката требуется явный --root или MOST_REPO_ROOT; запускайте CLI готового релиза.');
  root = real(root || path.resolve(path.dirname(filename), '..'));
  if (!options.releaseOnly) stateRoot(root, env);
  if (settings) localYaml(cliRelease(root, filename, options.release), filename);
  options.root = root;
  env.MOST_REPO_ROOT = root;
  return options;
}
module.exports = { real, equal, within, prospective, stateRoot, cliRelease, localYaml, resultContext, bootstrap };
