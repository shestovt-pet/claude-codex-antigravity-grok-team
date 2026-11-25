'use strict';
const fs = require('fs'), assert = require('assert');
const args = process.argv.slice(2);
if (args[0] === 'models') { console.log(process.env.FAKE_AGY_MODELS || 'test-model  Test'); process.exit(0); }
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
  if (stream && args.includes('--add-dir') && !text.includes('Материал в файле: ')) throw Error('Unexpected arguments'); // cache-622 (Б1): кроме материала файлом
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
  // cache-622: ECHO_MARKERS — ответ между метками, взятыми из поручения (метки стоят в конце поручения).
  const marks = /(<<<РЕЗУЛЬТАТ-[0-9A-F]+>>>)[\s\S]*?(<<<КОНЕЦ-РЕЗУЛЬТАТА-[0-9A-F]+>>>)/.exec(text);
  const response = text.includes('ECHO_MARKERS') && marks ? 'Вот результат:\n' + marks[1] + '\nГОТОВЫЙ ТЕКСТ\n' + marks[2] + '\nГотово.'
    : text.includes('QUOTE_DENIAL') ? 'ПРИНЯТО\nПоле denied_actions обработано; цитата: read_file auto-denied; denied.' : 'Последний итог: ПРИНЯТО';
  // cache-622 (М2): FAKE_AGY_CONVERSATION — id разговора в событиях init/result, как у agy 1.5.15; --conversation сохраняет id.
  const conv = process.env.FAKE_AGY_CONVERSATION ? (args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : process.env.FAKE_AGY_CONVERSATION + '-' + count) : null;
  const withConv = o => conv ? { conversation_id: conv, ...o } : o;
  if (conv && stream) console.log(JSON.stringify({ event: 'init', conversation_id: conv, init: { model: 'test' } }));
  // cache-622 (Б3): QUOTA_ONCE — первый ход с этим текстом упирается в квоту (повтор по квоте).
  if (stream && text.includes('QUOTA_ONCE') && count === 1) {
    console.log(JSON.stringify({ event: 'result', result: withConv({ status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED: quota exhausted' }) }));
    process.exitCode = 1; return;
  }
  // cache-622 (У1): FAKE_AGY_USAGE_TOTAL — usage только накопленным итогом разговора в result (без usage шагов), как
  // result.usage продолженного разговора agy: n-й ход разговора — 1000·n вход, 10·n выход.
  const turnNo = conv ? fs.readFileSync(process.env.FAKE_STREAM_LOG, 'utf8').trim().split('\n').map(JSON.parse).filter(c => c.args.includes('--conversation') ? c.args[c.args.indexOf('--conversation') + 1] === conv : false).length + 1 : 1;
  const totalUsage = process.env.FAKE_AGY_USAGE_TOTAL ? { usage: { input_tokens: 1000 * turnNo, output_tokens: 10 * turnNo, total_tokens: 1010 * turnNo } } : {};
  if (!stream) { console.log(JSON.stringify({ status: 'SUCCESS', response })); return; }
  console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Цитата read_file auto-denied — это ещё не итог' } }));
  console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_info: { name: 'read_file', output: 'Документ содержит read_file auto-denied' } } }));
  if (text.includes('SERVICE_DENIAL')) console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_info: { name: 'read_file', error: { type: 'PERMISSION_DENIED', message: 'permission denied' } } } }));
  if (text.includes('NO_RESULT')) return;
  console.log(JSON.stringify({ event: 'result', result: withConv({ status: 'SUCCESS', response: 'Промежуточный итог' }) }));
  if (text.includes('ERROR_STATUS')) process.exitCode = 1;
  setTimeout(() => console.log(JSON.stringify({ event: 'result', result: withConv({ status: text.includes('ERROR_STATUS') ? 'ERROR' : 'SUCCESS', response, error: text.includes('ERROR_STATUS') ? 'Пробная ошибка' : undefined, ...totalUsage }) })), 30);
}
if (args.includes('--print')) respond({ event: 'user', message: { content: args[args.indexOf('--print') + 1] } });
else process.stdin.on('end', () => respond(JSON.parse(input)));
