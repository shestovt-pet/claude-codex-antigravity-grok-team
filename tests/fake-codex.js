'use strict';
const fs = require('fs'),
  path = require('path');
const args = process.argv.slice(2),
  out = (e) => process.stdout.write(JSON.stringify(e) + '\n');
if (args[0] === 'app-server') {
  let b = '';
  process.stdin.on('data', (d) => {
    b += d;
    let i;
    while ((i = b.indexOf('\n')) >= 0) {
      const m = JSON.parse(b.slice(0, i));
      b = b.slice(i + 1);
      if (m.method === 'initialize') out({ id: m.id, result: {} });
      if (m.method === 'account/rateLimits/read')
        out({
          id: m.id,
          result: {
            rateLimits: {
              primary: { windowDurationMins: 10080, usedPercent: 23, resetsAt: Date.now() / 1000 + 3600 },
              secondary: { windowDurationMins: 300, usedPercent: 12, resetsAt: Date.now() / 1000 + 3600 },
            },
          },
        });
    }
  });
} else {
  let prompt = '';
  process.stdin.on('data', (d) => (prompt += d));
  process.stdin.on('end', async () => {
    const result = args[args.indexOf('--output-last-message') + 1],
      resume = args.includes('resume');
    const thread = resume ? args[args.length - 2] : '12345678-' + require('crypto').randomUUID().slice(9);
    if (process.env.FAKE_CODEX_LOG)
      fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, cwd: process.cwd(), prompt }) + '\n');
    out({ type: 'thread.started', thread_id: thread });
    if (prompt.includes('HANG')) {
      setInterval(() => {}, 1000);
      return;
    }
    if (prompt.includes('SLOW')) await new Promise((r) => setTimeout(r, 1200));
    if (prompt.includes('MISSING')) {
      out({ type: 'turn.failed', error: { message: 'Session not found' } });
      process.exitCode = 1;
      return;
    }
    if (prompt.includes('QUOTA') && (!resume || prompt.includes('ALWAYS'))) {
      fs.writeFileSync(result, 'Частичный ответ');
      out({
        type: 'turn.failed',
        error: { message: 'You’ve hit your usage limit. Try again later.', codexErrorInfo: 'UsageLimitExceeded' },
      });
      process.exitCode = 1;
      return;
    }
    const text = prompt.includes('QUOTE')
      ? "Цитата: You've hit your usage limit"
      : prompt.includes('LARGE')
        ? 'А'.repeat(25000) + 'КОНЕЦ'
        : resume
          ? 'ПРОДОЛЖЕНО ' + thread
          : 'ПРИНЯТО';
    fs.writeFileSync(result, text);
    out({ type: 'item.completed', item: { type: 'agent_message', text } });
    out({ type: 'turn.completed' });
  });
}
