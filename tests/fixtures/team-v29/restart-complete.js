'use strict';
// Доказательства тестового перезапуска; настоящий Claude тесты не закрывают.
const fs = require('fs'), path = require('path');
module.exports = function complete(info) {
  const write = (f, value) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(value)); };
  const json = (f, value) => write(f, JSON.stringify(value));
  const startedAt = new Date(Date.now() - 1000).toISOString(), finishedAt = new Date().toISOString();
  const hold = require('../../../common/restart-hold');
  if (info.close) {
    hold.publish(hold.claimFile(info.state, info.runId), { decision: 'закрываю', id: info.id, runId: info.runId, pid: 2147483647, startedAt, publishedAt: startedAt, targets: [] });
    hold.publish(hold.claimFile(info.state, info.runId, true), { closedAt: startedAt });
  }
  write(info.log, 'запущен ' + info.runId + '\nитог ' + info.runId + ' True\n');
  json(info.result, { runId: info.runId, release: info.release, startedAt, finishedAt, success: true });
  for (const name of require('../../../common/members').servers) json(path.join(info.state, 'ready', name + '.json'), { pid: process.pid, release: info.release, startedAt: finishedAt });
};
