'use strict';
// Журнал живой пробы. В обычных сеансах выключен; задания и материалы целиком не сохраняет.
function record(current, message) {
  if (process.env.MOST_MATRIX_PROBE !== '1' || !current?.tool) return;
  const server = current.tool.split('_')[0];
  if (!['team', 'codex', 'deepseek', 'antigravity', 'claude'].includes(server)) return;
  const fs = require('fs'), path = require('path'), state = require('./paths').stateDir;
  const args = current.probeArgs || {};
  const response = (message.result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const entry = { at: new Date().toISOString(), tool: current.tool, parentJob: process.env.MOST_JOB_ID || null,
    client: require('./access').client(), id: args.id || null, folder: args.folder || null,
    write: args.write === true, full_access: args.full_access === true,
    isError: !!(message.error || message.result?.isError), response: response.slice(0, 1200) };
  fs.mkdirSync(state, { recursive: true });
  fs.appendFileSync(path.join(state, 'server-log-' + server + '.jsonl'), JSON.stringify(entry) + '\n');
}
module.exports = { record };
