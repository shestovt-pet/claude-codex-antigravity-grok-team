'use strict';
// team-v48 Г2b-2: фальшивый dsh для адаптерных тестов «нет срока» DeepSeek (настоящий процесс).
// Запускается через fake-dsh.cmd (dsh на Windows — .cmd, сервер зовёт его из оболочки).
// `--version` отвечает сразу и не читает stdin (иначе dshVersion ждал бы до таймаута).
// Иначе читает задачу из stdin: HANG — зависает как настоящий бегущий процесс до taskkill/отмены;
// в прочих случаях печатает NDJSON сессии и финала.
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('dsh 0.2.1-test\n'); process.exit(0); }
let buf = '';
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  // cache-622: FAKE_PROMPT_LOG — записать вход (порядок частей); USAGE — события status/step_end с usage, как у dsh 0.2.2.
  if (process.env.FAKE_PROMPT_LOG) require('fs').appendFileSync(process.env.FAKE_PROMPT_LOG, JSON.stringify({ args, prompt: buf }) + '\n');
  if (buf.includes('HANG')) { setInterval(() => {}, 1000); return; }
  // quota-622: NO_MONEY (или FAKE_DSH_NO_MONEY=1) — отказ, как живой dsh при пустом счёте DeepSeek (прогон zhivoj-brod-4).
  if (buf.includes('NO_MONEY') || process.env.FAKE_DSH_NO_MONEY === '1') {
    process.stderr.write('[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)\ndsh: ACCOUNT_QUOTA: Insufficient Balance (request_id: 1eea0066-5881-4a09-bc48-c416581fdc2e)\n');
    process.exitCode = 1; return;
  }
  // cache-622 (У2): USAGE_API — шаг с полями DeepSeek API (prompt_cache_hit/miss_tokens), их разбирает genericTokens.
  const usage = buf.includes('USAGE_API') ? '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"prompt_cache_hit_tokens":900,"prompt_cache_miss_tokens":100,"completion_tokens":7}}\n'
    : buf.includes('USAGE') ? '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":1295,"outputTokens":2,"cacheReadTokens":13056,"cacheWriteTokens":0,"totalTokens":14353}}\n' +
    '{"type":"status","phase":"step_end","turn":1,"step":2,"usage":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":14336,"cacheWriteTokens":7,"totalTokens":14493}}\n' : '';
  process.stdout.write('{"type":"session","sessionId":"s-g2b"}\n' + usage + '{"type":"final","text":"ОК"}\n');
});
