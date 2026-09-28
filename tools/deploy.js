#!/usr/bin/env node
'use strict';
const { deploy, configure, configureClients, rollback } = require('../common/deploy');
function parseArgs(args) {
  const options = { root: process.env.MOST_REPO_ROOT || process.cwd() },
    configs = [];
  let undo = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--rollback') undo = true;
    else if (arg === '--release-only') options.releaseOnly = true;
    else if (arg === '--config-only') options.configOnly = true;
    else if (arg === '--clients-only') options.clientsOnly = true;
    else if (arg === '--restart-claude') options.restartClaude = true;
    else if (['--root', '--commit', '--config', '--release', '--state-dir', '--node-modules-from', '--result'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error('Нет значения ' + arg);
      if (arg === '--config') configs.push(value);
      else options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else throw Error('Неизвестный параметр: ' + arg);
  }
  if (configs.length) options.configs = configs;
  if ([options.releaseOnly, options.configOnly, options.clientsOnly].filter(Boolean).length > 1)
    throw Error('--release-only, --config-only и --clients-only нельзя совмещать.');
  if (options.clientsOnly && (options.commit || options.nodeModulesFrom || configs.length))
    throw Error('--clients-only несовместим с --commit, --node-modules-from и --config.');
  if (options.clientsOnly && !options.release && !undo) throw Error('--clients-only требует --release.');
  if (options.restartClaude && (undo || (!options.configOnly && !options.clientsOnly)))
    throw Error('--restart-claude допускается только с --config-only или --clients-only, без отката.');
  if (options.restartClaude && !options.release) throw Error('--restart-claude требует --release.');
  if (options.releaseOnly && (undo || options.configOnly))
    throw Error('--release-only несовместим с --rollback и --config-only.');
  if (options.release && !options.configOnly && !options.clientsOnly) throw Error('--release применяется только с --config-only или --clients-only.');
  if (options.configOnly && (options.commit || options.nodeModulesFrom))
    throw Error('--config-only не собирает релиз: --commit и --node-modules-from неприменимы.');
  if (options.releaseOnly && configs.length) throw Error('--release-only не обрабатывает --config.');
  if (undo && (options.release || options.commit || options.nodeModulesFrom || (options.stateDir && !options.configOnly)))
    throw Error('Параметры сборки неприменимы к откату; --state-dir допустим с --config-only.');
  if (undo && options.dryRun) throw Error('Для отката проверочный режим не предусмотрен.');
  if (options.result && (!options.configOnly || undo || options.dryRun)) throw Error('--result требует --config-only без отката и проверочного режима.');
  return { options, undo };
}
async function main(args, deps = {}) {
  const {options, undo} = parseArgs(args);
  if (undo && options.clientsOnly) {
    const clients = require('../common/client-configs').paths().filter(p => require('fs').existsSync(p.file));
    const text = await rollback({ configOnly: true, configs: clients.map(p => p.file), stateDir: options.stateDir });
    const result = text + '\n' + (await require('../common/client-rules').configure({ rollback: true })).join('\n');
    (deps.print || console.log)(result); return result;
  }
  const action = undo ? (deps.rollback || rollback) : options.clientsOnly ? (deps.configureClients || configureClients) : options.configOnly ? (deps.configure || configure) : (deps.deploy || deploy);
  const result = options.result ? await require('../common/deploy-ops').execute(options, action, deps) : await action(options);
  (deps.print || console.log)(result);
  return result;
}
if (require.main === module)
  main(process.argv.slice(2)).catch((e) => {
    console.error('Ошибка: ' + require('../common/errors').errorText(e));
    process.exitCode = 1;
  });
module.exports = { main, parseArgs };
