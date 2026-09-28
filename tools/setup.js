#!/usr/bin/env node
'use strict';
// Установка связки на новом компьютере (team-v11 Р1): node tools/setup.js [--dry-run]
// Проверяет окружение, собирает релиз из текущего main этого клона и подключает серверы к тем приложениям,
// которые найдены. Отсутствующие приложения пропускаются с объяснением. Повторный запуск безопасен.
const fs = require('fs'),
  path = require('path'),
  { execFileSync } = require('child_process');

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
// Проверки окружения: [{ ok, name, text }]. deps позволяют подменять проверки в тестах.
function checks(root, deps = {}) {
  const platform = deps.platform || process.platform, node = deps.nodeVersion || process.versions.node;
  const has = deps.has || ((cmd) => {
    if (cmd === 'npm') {
      // Установка ставит зависимости через npm-cli.js рядом с node (common/deploy.js install) — проверяется то же самое,
      // без оболочки (team-v12 Р1: прежний вызов через оболочку печатал предупреждение Node.js DEP0190).
      const cli = path.join(path.dirname(deps.execPath || process.execPath), 'node_modules/npm/bin/npm-cli.js');
      try { if (fs.statSync(cli).isFile()) return true; } catch {}
      if (platform === 'win32') return false;
    }
    try { run(cmd, ['--version'], root); return true; } catch { return false; }
  });
  const git = deps.git || ((args) => run('git', args, root));
  const exists = deps.exists || fs.existsSync;
  const out = [];
  out.push({ ok: platform === 'win32', name: 'Windows', text: platform === 'win32' ? 'Windows' : 'нужен Windows 10 или 11: перезапуск Claude и подключения рассчитаны только на него' });
  const major = Number(node.split('.')[0]);
  out.push({ ok: major >= 18, name: 'Node.js', text: 'Node.js ' + node + (major >= 18 ? '' : ' — нужна версия 18 или новее: https://nodejs.org') });
  const hint = { git: ' — поставьте Git for Windows: https://git-scm.com', tar: ' — в Windows 10/11 tar встроен, проверьте PATH', npm: ' — рядом с Node.js нет npm: переустановите Node.js вместе с npm (https://nodejs.org)' };
  for (const cmd of ['git', 'tar', 'npm']) { const ok = has(cmd); out.push({ ok, name: cmd, text: ok ? cmd + ' найден' : cmd + (cmd === 'npm' ? ' не найден' : ' не найден в PATH') + hint[cmd] }); }
  if (!exists(path.join(root, '.git'))) {
    out.push({ ok: true, name: 'клон', zip: true, text: 'папка без .git (скачана архивом ZIP): будет создан локальный репозиторий с одним коммитом' });
    return out;
  }
  let repo = false;
  try { repo = /^[0-9a-f]{40}$/.test(git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'])); } catch {}
  if (!repo) { out.push({ ok: false, name: 'клон', text: 'в папке ' + root + ' есть .git, но нет ветки main: скачайте заново (git clone …) или архивом ZIP' }); return out; }
  // Репозиторий, созданный установщиком из ZIP: новый ZIP распакован поверх — изменения фиксируются новым коммитом.
  let fromZip = false, dirty = false;
  try { fromZip = git(['log', '-1', '--format=%ae', 'refs/heads/main']) === 'setup@localhost'; } catch {}
  if (fromZip) try { dirty = git(['status', '--porcelain', '--untracked-files=all']).length > 0; } catch {}
  out.push({ ok: true, name: 'клон', zipUpdate: fromZip && dirty,
    text: fromZip ? (dirty ? 'папка из ZIP, распакована новая версия: изменения будут зафиксированы новым коммитом' : 'папка из ZIP, изменений нет') : 'папка — git-клон с веткой main' });
  return out;
}
// ZIP без .git: локальный репозиторий из одного коммита; глобальные настройки git не читаются для автора.
function initZip(root, deps = {}, update = false) {
  const git = deps.git || ((args) => run('git', args, root));
  const id = ['-c', 'user.name=setup', '-c', 'user.email=setup@localhost', '-c', 'commit.gpgsign=false'];
  if (!update) git(['init', '-q', '-b', 'main']);
  else if (git(['symbolic-ref', '--short', 'HEAD']) !== 'main') throw Error('Папка из ZIP должна быть на ветке main.');
  git(['add', '-A']);
  git([...id, 'commit', '-q', '--no-verify', '-m', update ? 'Обновление из архива ZIP' : 'Установка из архива ZIP']);
}
// Чужие записи в конфигах — до любых записей, одинаково в проверочном и обычном режиме.
function conflicts(root, f, deps = {}) {
  const release = path.join(root, 'live', '0'.repeat(40)), state = path.join(root, 'state'), out = [];
  const d = require('../common/deploy'), cc = require('../common/client-configs');
  const attempt = (fn) => { try { fn(); } catch (e) { out.push(e.message); } };
  for (const file of f.claude) attempt(() => d.configFor(d.snapshot(file).config, release, root, state, file));
  for (const file of f.codex) attempt(() => cc.toml(d.snapshot(file).text, release, root, state, 'node', file));
  for (const file of f.agy) attempt(() => cc.jsonConfig(d.snapshot(file).config, 'agy', release, root, state, 'node', file));
  return out;
}

// Какие приложения найдены: Claude Desktop (конфиги), Codex, Antigravity.
function found(deps = {}) {
  const exists = deps.exists || fs.existsSync;
  const claude = require('../common/deploy').configPaths().filter(exists);
  const clients = require('../common/client-configs').paths().filter((p) => p.kind !== 'permissions');
  return {
    claude,
    codex: clients.filter((p) => p.kind === 'codex' && exists(p.file)).map((p) => p.file),
    agy: clients.filter((p) => p.kind === 'agy' && exists(p.file)).map((p) => p.file),
  };
}

async function setup(argv = process.argv.slice(2), deps = {}) {
  const dryRun = argv.includes('--dry-run');
  const root = path.resolve(deps.root || path.join(__dirname, '..'));
  const print = deps.print || console.log, lines = [];
  const say = (s) => { lines.push(s); print(s); };
  say('Установка связки Claude · Codex · Antigravity · Grok' + (dryRun ? ' — проверочный режим, ничего не меняется' : ''));
  say('Папка: ' + root);
  const c = checks(root, deps);
  for (const x of c) say((x.ok ? '✓ ' : '✗ ') + x.text);
  if (c.some((x) => !x.ok)) { say('Установка остановлена: исправьте отмеченное ✗ и запустите снова.'); return { ok: false, lines }; }
  const f = found(deps);
  say(f.claude.length ? '✓ Claude Desktop: ' + f.claude.join('; ') : '— Claude Desktop не найден: установите его и запустите один раз, затем повторите установку (без него серверы некому подключать).');
  say(f.codex.length ? '✓ Codex: ' + f.codex.join('; ') : '— Codex не найден (~\\.codex\\config.toml): его подключение пропущено; связка работает без Codex, но его голоса в ревью будут недоступны.');
  say(f.agy.length ? '✓ Antigravity: ' + f.agy.join('; ') : '— Antigravity не найден (~\\.gemini\\config\\mcp_config.json): подключение пропущено.');
  const bad = (deps.conflicts || conflicts)(root, f, deps);
  // Правила помощникам проверяются до любой записи: повреждённые метки или кодировка — отказ до сборки.
  const rules = require('../common/client-rules'), rp = rules.paths();
  const helperRules = [[rp[0], f.codex.length], [rp[1], f.agy.length]].filter(([, on]) => on && f.claude.length).map(([file]) => file);
  for (const file of helperRules) try { await (deps.ensureRules || rules.ensure)(file, { dryRun: true }); } catch (e) { bad.push(e.message); }
  if (bad.length) { for (const b of bad) say('✗ ' + b); say('Установка остановлена: ничего не изменено.'); return { ok: false, lines }; }
  const zip = c.some((x) => x.zip), zipUpdate = c.some((x) => x.zipUpdate);
  if (zip && dryRun) say('Проверочный режим: локальный репозиторий не создаётся, сборка релиза проверится при установке.');
  else if (zipUpdate && dryRun) say('Проверочный режим: новая версия из ZIP не фиксируется, сборка релиза проверится при установке.');
  else {
    if (zip) { (deps.initZip || initZip)(root, deps); say('✓ Создан локальный репозиторий из архива.'); }
    if (zipUpdate) { (deps.initZip || initZip)(root, deps, true); say('✓ Новая версия из архива зафиксирована.'); }
    // Полный хеш main берётся один раз: всё дальше собирается из него, даже если main сдвинется.
    const commit = (deps.git || ((args) => run('git', args, root)))(['rev-parse', '--verify', 'refs/heads/main^{commit}']);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw Error('Не удалось определить коммит main.');
    say('Коммит: ' + commit);
    if (!dryRun && !fs.existsSync(path.join(root, 'state'))) fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    const deploy = deps.deploy || require('../common/deploy').deploy;
    say(await deploy({ root, commit, dryRun, releaseOnly: !f.claude.length, configs: f.claude }));
  }
  // Правила помощникам: создаются, дописываются или обновляются только у найденных помощников.
  for (const file of helperRules) say('Правила: ' + await (deps.ensureRules || rules.ensure)(file, { dryRun }));
  say(dryRun ? 'Проверочный режим завершён. Для установки: setup.cmd (или node tools/setup.js).' : [
    'Готово. Дальше:',
    '1. Перезапустите Claude Desktop — в нём появятся серверы team, codex, antigravity, grok.',
    '2. В новом чате вызовите team_status: он покажет квоты, помощников и версию.',
    '3. Grok — по желанию: раздел «Grok» в README (нужна своя рутина с вебхуком и файл state\\grok-webhook.json).',
  ].join('\n'));
  return { ok: true, lines };
}

if (require.main === module)
  setup().then((r) => { process.exitCode = r.ok ? 0 : 1; }).catch((e) => {
    console.error('Ошибка установки: ' + require('../common/errors').errorText(e));
    process.exitCode = 1;
  });
module.exports = { setup, checks, found, conflicts, initZip };
