'use strict';
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { Grok } = require('../../common/grok');
const { format } = require('../../common/format');
const access = require('../../common/access');
const grok = new Grok(), server = new McpServer({ name: 'grok', version: '0.5.9' }, require('../../common/server-instructions').options('grok'));
function register(name, title, schema, fn) {
  if (!access.allowed('grok', name)) return;
  server.registerTool(name, { title, description: title,
    inputSchema: require('../../common/schema').compatible(schema) }, async args => {
    try {
      access.guard('grok', name, args);
      const { job, text } = await fn(args);
      return { content: [{ type: 'text', text: format('Grok', job || { status: 'done' }, text) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: format('Grok', { status: 'failed' },
        require('../../common/grok').redact(e.message)) }] };
    }
  });
}
register('grok_send', 'Поручить Grok', {
  ...require('../../common/stage-schema').send, folder: z.string().optional(),
  task: z.string().min(1), text: z.string().optional(), work: z.string().optional(),
  stage: z.string().optional(), owner: z.string().optional(), retry_of: z.string().optional(),
}, async args => { const job = await grok.send(args); return { job, text: job.reason }; });
register('grok_status', 'Состояние Grok', {}, async () => ({ text: await grok.status() }));
register('grok_result', 'Результат Grok', {
  id: z.string(), wait_sec: z.number().int().min(0).max(40).default(0),
  from_char: z.number().int().nonnegative().default(0),
}, async args => {
  const end = Date.now() + args.wait_sec * 1000;
  let job;
  do {
    job = await grok.refresh(args.id);
    if (!['queued', 'running', 'delivery_unclear'].includes(job.status) || Date.now() >= end) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < end);
  return { job, text: grok.resultText(job, args.from_char) };
});
register('grok_cancel', 'Отменить поручение Grok', { id: z.string() }, async args => {
  const job = await grok.cancel(args.id); return { job, text: job.reason };
});
async function start() {
  await require('../../common/state-migration').start(require('../../common/paths'));
  await server.connect(require('../../common/public-transport').publicTransport(new StdioServerTransport()));
  access.ready('grok');
  if (!access.guest() && process.env.MOST_PROBE_ONLY !== '1') {
    setInterval(() => grok.status().catch(() => console.error('Grok: не удалось проверить поручения.')),
      30000).unref();
  }
}
if (require.main === module) start().catch(() => { console.error('Grok: запуск не удался.'); process.exitCode = 1; });
module.exports = { server, grok };
