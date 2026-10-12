#!/usr/bin/env node
'use strict';
const workflow = require('../../common/consilium-workflow');
async function main() {
  const [command, ...args] = process.argv.slice(2), options = {};
  if (!['snapshot', 'check'].includes(command)) throw Object.assign(Error('Команда: snapshot или check; --file FILE [--stage ID] [--intent start|accept|deliver].'), { workflowCode: 3 });
  for (let i = 0; i < args.length; i += 2) {
    if (!['--file', '--stage', '--intent'].includes(args[i]) || !args[i + 1] || options[args[i].slice(2)])
      throw Object.assign(Error('Неизвестный/повторный параметр.'), { workflowCode: 3 });
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.file || (command === 'snapshot' && options.intent)) throw Object.assign(Error('Нужен --file; snapshot не принимает --intent.'), { workflowCode: 3 });
  const result = await workflow.run(options.file, { stage: options.stage, intent: command === 'snapshot' ? 'snapshot' : options.intent });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch(e => { process.stdout.write(JSON.stringify({ ready: false, error: e.message }) + '\n'); process.exitCode = e.workflowCode || 3; });
