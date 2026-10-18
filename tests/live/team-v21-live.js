'use strict';
// Только чтение. Запуск отдельно от общего прогона, с явными MOST_REPO_ROOT/MOST_STATE_DIR.
// Этот файл не устанавливает релиз, не перезапускает приложения и не применяет уборку.
const fs = require('fs'), path = require('path');
if (!process.env.MOST_REPO_ROOT || !process.env.MOST_STATE_DIR) throw Error('Нужны явные MOST_REPO_ROOT и MOST_STATE_DIR.');
const attempts = [];
for (const key of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'copyFileSync', 'cpSync', 'truncateSync',
  'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'cp', 'truncate', 'createWriteStream', 'write', 'writeSync', 'link', 'linkSync', 'symlink', 'symlinkSync', 'mkdtemp', 'mkdtempSync', 'utimes', 'utimesSync', 'chmod', 'chmodSync']) {
  fs[key] = (...args) => { attempts.push(key + ': ' + args[0]); throw Error('Живая проверка попыталась записать файл: ' + key); };
}
for (const key of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'cp', 'truncate', 'link', 'symlink', 'mkdtemp', 'utimes', 'chmod']) {
  fs.promises[key] = async (...args) => { attempts.push(key + ': ' + args[0]); throw Error('Живая проверка попыталась записать файл: ' + key); };
}
for (const [obj, key] of [[fs, 'openSync'], [fs.promises, 'open']]) {
  const original = obj[key];
  obj[key] = (file, flags, ...args) => {
    if (!['r', 'rs', 0].includes(flags)) { attempts.push(key + ': ' + file); throw Error('Живая проверка попыталась открыть файл для записи'); }
    return original.call(obj, file, flags, ...args);
  };
}
const root = fs.realpathSync(process.env.MOST_REPO_ROOT), state = process.env.MOST_STATE_DIR;
const paths = require('../../common/paths'), compat = require('../../common/path-compat'), deploy = require('../../common/deploy'), clients = require('../../common/client-configs');
const print = (name, value) => console.log(name + '\n' + (typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
let failed = false;
function check(name, fn) { try { print(name, fn()); } catch (e) { failed = true; print(name, 'незакрытое требование: ' + e.message); } }
const base = '97e948f0e667855a1b8b0787555d7d25208fdd2a';
check('Пути C:/E:', () => ['C:\\most', 'E:\\most', 'C:\\most\\live\\' + base, 'E:\\most\\live\\' + base].map(p => ({ path: p, canon: paths.canonMaybe(p), sameRoot: paths.samePath(p, root) })));
check('Равенство корней и релизов', () => ({ root: paths.samePath('C:\\most', 'E:\\most'), release: paths.samePath('C:\\most\\live\\' + base, 'E:\\most\\live\\' + base) }));
check('Сводка нового кода', () => require('../../common/release-drift').lines(root, state));
check('Сухая уборка нового кода', () => {
  const cleanup = require('../../common/cleanup');
  return cleanup.cleanupText(cleanup.cleanup({ root, apply: false, owner: 'team-v21-live-readonly' }));
});
const installed = JSON.parse(fs.readFileSync(path.join(root, 'live/deployed.json'), 'utf8'));
const release = fs.realpathSync(installed.release || path.join(root, 'live', installed.commit));
const servers = config => Object.fromEntries(['team', 'codex', 'antigravity', 'grok'].filter(n => config?.[n]).map(n => [n, {
  command: config[n].command, args: config[n].args,
  env: Object.fromEntries(['MOST_REPO_ROOT', 'MOST_STATE_DIR', 'MOST_CLIENT'].map(k => [k, config[n].env?.[k]])),
}]));
for (const file of deploy.configPaths()) check('План Claude: ' + file, () => {
  const snapshot = deploy.snapshot(file), next = deploy.configFor(snapshot.config, release, root, state, file);
  return servers(next.mcpServers);
});
const snapshots = [];
for (const item of clients.paths()) check('Чтение подключения: ' + item.file, () => { snapshots.push({ ...deploy.snapshot(item.file), kind: item.kind }); return 'прочитано'; });
check('Планы Codex/Antigravity без записи', () => {
  const plans = clients.plans(snapshots, release, root, state, process.execPath);
  return snapshots.map(s => {
    const plan = plans.find(p => p.file === s.file);
    const config = s.kind === 'codex'
      ? clients.block(plan?.next || s.text).parsed.root.mcp_servers
      : (plan ? JSON.parse(plan.next) : s.config).mcpServers;
    return { file: s.file, changed: !!plan, backup: plan?.backup, servers: servers(config),
      ...(s.kind === 'permissions' ? { note: 'план разрешений построен; личные разрешения в отчёт не выводятся' } : {}) };
  });
});
const releases = new Set([release]);
for (const file of [...deploy.configPaths(), ...clients.paths().filter(p => p.kind !== 'permissions').map(p => p.file)]) {
  check('Релиз отката из ' + file + '.prev', () => {
    const text = fs.readFileSync(file + '.prev', 'utf8'), refs = require('../../common/cleanup').configPaths(text).abs;
    const found = refs.map(p => p.match(/^(.*[\\/]live[\\/][a-f0-9]{40})[\\/]servers[\\/]/i)?.[1]).filter(Boolean);
    found.forEach(p => releases.add(p)); return found;
  });
}
for (const rel of releases) check('К2б: ' + rel, () => {
  const marker = JSON.parse(fs.readFileSync(path.join(rel, 'probe-ok.json'), 'utf8'));
  let decision;
  try { decision = compat.releasePolicy(root, rel); } catch (e) { decision = { refusal: e.message }; }
  return { markerRoot: marker.root, samePath: paths.samePath(marker.root, root), strict: compat.strictSamePath(marker.root, root), decision };
});
for (const [kind, key] of [['team_words', path.join(state, 'team/user-words.json')], ['migration', state], ['instance', 'team-v21-live-example'], ['team_repo', paths.canon(root)]])
  check('Имена каналов: ' + kind, () => compat.lockNames(kind, key, state));
print('Попытки записи', attempts);
if (attempts.length) failed = true;
process.exitCode = failed ? 1 : 0;
