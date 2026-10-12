'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { root, json, run } = require('./team-v16-fixture');
const access = require('../common/access'), detect = require('../common/fallback-detect');
run([['Р6а: сохранённые orchestrator=grok/offline=claude без fallback не меняют полномочия', () => {
  const fallbackDir = process.env.MOST_FALLBACK_DIR;
  fs.mkdirSync(fallbackDir);
  assert(!fs.existsSync(path.join(fallbackDir, 'session.json')));
  const before = access.describe();
  json(path.join(root, 'works', 'roles-case', 'roles.json'), {
    version: 1, work: 'roles-case', status: 'confirmed', confirmedBy: 'user',
    slots: { orchestrator: 'grok', offline: ['claude'], coder: 'codex', reviewer: ['antigravity'], judge: 'user' }
  });
  // Доступный Desktop и живой MCP, как в существующем fallback-smoke-detect.
  const detection = detect.evaluate({ mode: null, desktopReady: [{ name: 'team', pid: process.pid, alive: true }],
    claudeProcs: [{ name: 'claude.exe', pid: process.pid }], claudeQuota: null, pendingJobs: 0 });
  assert.equal(detection.advice, 'hold');
  assert.deepEqual(access.describe(), before);
  assert.equal(access.client(), 'claude'); assert.equal(access.guest(), false);
  assert.doesNotThrow(() => access.guard('team', 'team_work', { action: 'update' }));
  assert.doesNotThrow(() => access.guard('team', 'team_change', { action: 'merge' }));
  process.env.MOST_CLIENT = 'grok';
  try {
    assert.equal(access.guest(), true);
    assert.throws(() => access.guard('team', 'team_work', { action: 'update' }), /запрещено/);
    assert.throws(() => access.guard('team', 'team_change', { action: 'merge' }), /запрещено/);
  } finally { process.env.MOST_CLIENT = 'claude'; }
  assert(!fs.existsSync(path.join(fallbackDir, 'session.json')));
}]]);
