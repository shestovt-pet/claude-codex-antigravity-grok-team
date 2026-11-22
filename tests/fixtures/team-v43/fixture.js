'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const source = path.resolve(__dirname, '../../..');
const base = 'cc88996c48220a947383633c87af23c61dd6bac9';
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const json = (file, value) => write(file, JSON.stringify(value, null, 2));
function env(root, parent = process.env) {
  fs.mkdirSync(root, { recursive: true });
  const e = require('../../runner-support').environment(parent, root);
  Object.assign(e, { MOST_REPO_ROOT: root, MOST_STATE_DIR: path.join(root, 'state'), MOST_CLIENT: 'claude',
    MOST_CLAUDE_CONFIGS: '[]', HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root });
  return e;
}
// Состав установки, как его увидит deploy ПОСЛЕ forward-миграции team-v46 (claude получает поручения):
// mirrors common/deploy.js serversForRoot, но поверх forward — релиз фикстуры совпадает с тем, что требует проба.
function installServers(root) {
  const members = require('../../../common/members');
  const roster = require('../../../common/members-store').create(path.join(root, 'state')).read({ initialize: false });
  return members.serversForInstall(require('../../../common/members-v46').forward(roster));
}
function release(root, id = 'a'.repeat(40), { old = false, servers = installServers(root), installPhase, installed = true } = {}) {
  const dir = path.join(root, 'live', id);
  fs.mkdirSync(dir, { recursive: true });
  if (old) {
    const archive = path.join(root, 'base.zip');
    cp.execFileSync('git', ['-C', source, 'archive', '--format=zip', '--output=' + archive, base], { windowsHide: true });
    cp.execFileSync(require('../../../common/paths').systemTar(), ['-xf', archive, '-C', dir], { windowsHide: true });
  } else {
    for (const name of ['common', 'tools', 'rules']) fs.cpSync(path.join(source, name), path.join(dir, name), { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(source, file), path.join(dir, file));
    // Исторические наборы проверяют фазу A; состав метки и фаза фикстуры согласованы.
    // installPhase позволяет собрать релиз с фильтром A даже при полном составе серверов,
    // чтобы доказывать чтение реестра корня, а не install-phase релиза.
    if (installPhase !== undefined) write(path.join(dir, 'common/install-phase.js'), "'use strict'; module.exports = { phase: '" + installPhase + "' };\n");
    else if (!servers.includes('deepseek')) write(path.join(dir, 'common/install-phase.js'), "'use strict'; module.exports = { phase: 'A' };\n");
    for (const n of servers) write(path.join(dir, 'servers', n, 'index.js'), '// фикстура готового сервера');
  }
  const modules = path.join(source, 'node_modules');
  if (!fs.existsSync(path.join(modules, 'yaml/package.json'))) throw Error('Подготовка фикстуры: выполните npm ci в тестовом клоне, локальный yaml отсутствует.');
  fs.cpSync(modules, path.join(dir, 'node_modules'), { recursive: true });
  let proof = {};
  if (!old) {
    // Это макет уже установленного релиза: миграцию и MCP-пробу проверяет kimi-deploy,
    // а псевдосерверы этой фикстуры служат только проверкам конфигов/доставки правил.
    const state = path.join(root, 'state'), store = require('../../../common/members-store').create(state);
    const kimi = require(path.join(dir, 'common/members-kimi.js')), before = store.read();
    if (installed) kimi.apply(state, before.rev, kimi.installTarget(state, before, dir));
    const roster = store.read({ initialize: false }), target = kimi.installTarget(state, roster, dir);
    proof = { sourceRegistryAbsent: false, sourceRegistryRev: roster.rev, sourceRegistryHash: kimi.digest(roster), targetRoster: target, targetRegistryHash: kimi.digest(target) };
  }
  json(path.join(dir, 'probe-ok.json'), { root, commit: id, at: new Date().toISOString(), servers, ...proof });
  return dir;
}
function operation(root, release, id = 'install') {
  const file = path.join(root, 'state/deploy-ops', id + '.json');
  json(file, { id, root, release, status: 'запущена', noCleanup: true,
    createdAt: '2026-10-25T19:00:00Z', updatedAt: '2026-10-25T19:00:00Z' });
  return file;
}
function phaseB(root) {
  const registry = require('../../../common/members-store').create(path.join(root, 'state'));
  registry.update(registry.read().rev, n => {
    Object.assign(n.members.find(m => m.id === 'deepseek').roles, { receives: true, sends: true, writer: true, voter: true });
  }, { action: 'activate', who: 'claude', reason: 'Обезличенная фикстура', quote: 'Проверка' }, { phase: 'B' });
  return registry.read();
}
function cli(dir, args, environment, cwd = path.dirname(dir)) {
  return cp.spawnSync(process.execPath, [path.join(dir, 'tools/deploy.js'), ...args], {
    env: environment, cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
}
module.exports = { source, base, write, json, env, release, operation, phaseB, cli };
