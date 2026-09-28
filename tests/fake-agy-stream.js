'use strict';
const fs = require('fs'), assert = require('assert');
const args = process.argv.slice(2);
if (args[0] === 'models') { console.log('test-model  Test'); process.exit(0); }
if (args[0] === '--version') { console.log('test-agy-stream'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
function respond(event) {
  assert.equal(event.event, 'user');
  assert.deepEqual(Object.keys(event).sort(), ['event', 'message']);
  assert.deepEqual(Object.keys(event.message), ['content']);
  assert.equal(typeof event.message.content, 'string');
  const text = event.message.content;
  const stream = !args.includes('--print');
  if (stream && args.includes('--add-dir')) throw Error('Unexpected arguments');
  fs.appendFileSync(process.env.FAKE_STREAM_LOG, JSON.stringify({ args, event, eof: true, files: args.includes('--add-dir') ? fs.readdirSync(args[args.indexOf('--add-dir') + 1]).map(f => fs.readFileSync(require('path').join(args[args.indexOf('--add-dir') + 1], f), 'utf8')) : [] }) + '\n');
  const count = fs.readFileSync(process.env.FAKE_STREAM_LOG, 'utf8').trim().split('\n').map(JSON.parse).filter(c => c.event.message.content === text).length;
  if (text.includes('OUTPUT_LIMIT')) {
    const result = { status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED: exceeded the output token limit' };
    console.log(JSON.stringify(stream ? { event: 'result', result } : result));
    process.exitCode = 1; return;
  }
  if (text.includes('PROTOCOL_ERROR') && (stream || text.includes('FAIL_LEGACY'))) {
    process.exitCode = 1;
    const result = { status: 'ERROR', response: '', error: 'stream input message is missing the "event" field' };
    if (text.includes('STDERR_PROTOCOL')) process.stderr.write(result.error);
    else console.log(JSON.stringify(stream ? { event: 'result', result } : result));
    return;
  }
  const legacyCount = fs.readFileSync(process.env.FAKE_STREAM_LOG, 'utf8').trim().split('\n').map(JSON.parse).filter(c => c.args.includes('--print') && c.event.message.content === text).length;
  const denial = (!stream && text.includes('LEGACY_DENIAL') && !(text.includes('LEGACY_ONCE') && legacyCount > 1)) || (text.includes('DENY_READ') && !(text.includes('ONLY_ONCE') && count > 1)) || text.includes('DENY_OTHER');
  if (denial) process.stderr.write('a tool required the "' + (text.includes('DENY_OTHER') ? 'write_file' : 'read_file') + '" permission that headless mode cannot prompt for, so it was auto-denied\n');
  const response = text.includes('QUOTE_DENIAL') ? 'ПРИНЯТО\nПоле denied_actions обработано; цитата: read_file auto-denied; denied.' : 'Последний итог: ПРИНЯТО';
  if (!stream) { console.log(JSON.stringify({ status: 'SUCCESS', response })); return; }
  console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Цитата read_file auto-denied — это ещё не итог' } }));
  console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_info: { name: 'read_file', output: 'Документ содержит read_file auto-denied' } } }));
  if (text.includes('SERVICE_DENIAL')) console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_info: { name: 'read_file', error: { type: 'PERMISSION_DENIED', message: 'permission denied' } } } }));
  if (text.includes('NO_RESULT')) return;
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Промежуточный итог' } }));
  if (text.includes('ERROR_STATUS')) process.exitCode = 1;
  setTimeout(() => console.log(JSON.stringify({ event: 'result', result: { status: text.includes('ERROR_STATUS') ? 'ERROR' : 'SUCCESS', response, error: text.includes('ERROR_STATUS') ? 'Пробная ошибка' : undefined } })), 30);
}
if (args.includes('--print')) respond({ event: 'user', message: { content: args[args.indexOf('--print') + 1] } });
else process.stdin.on('end', () => respond(JSON.parse(input)));
