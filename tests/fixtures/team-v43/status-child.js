'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const f = require('./fixture'), data = require('./status.json'), root = process.argv[2];
process.env = { ...f.env(root), CODEX_PATH: path.join(f.source, 'tests/fake-codex.js'), MOST_TEST_BOOT_AT: data.now };
if (!fs.existsSync(path.join(root, 'state/members.json'))) f.phaseB(root);
const RealDate = Date;
global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [data.now])); } static now() { return RealDate.parse(data.now); } };
const stores = require('../../../common/team-store'), locks = require('../../../common/locks');
const quota = require('../../../common/quota-line'), drift = require('../../../common/release-drift');
const saved = { list: stores.list, owner: locks.ownerState, quota: quota.quotaLine, drift: drift.lines };
stores.list = who => ({ jobs: structuredClone(data.jobs[who] || []), errors: [] });
locks.ownerState = async () => 'unknown';
quota.quotaLine = async () => 'Квоты: Claude — 10%; Codex — 10%; Antigravity — 10%; DeepSeek — данных нет · снимок ' + data.now;
drift.lines = () => [];
const { Team } = require('../../../common/team'), team = new Team(root);
f.json(team.changeFile(data.change.name), data.change);
f.json(team.workFile(data.work.name), { revision: 1, goal: 'Цель', done_criteria: 'Результат проверен', reminders: [], ...data.work });
(async () => {
  try {
    const text = require('../../../common/format').format('Команда', { status: 'done' }, await team.status(), 'Проверьте результат и выберите следующий шаг.');
    assert(text.length <= 3000, text);
    for (const word of ['deepseek fixture-', 'codex fixture-', 'antigravity fixture-', 'Проверка результата', 'Проверка установки', 'Последнее развёртывание']) assert(text.includes(word), word + '\n' + text);
    console.log(text);
  } finally { stores.list = saved.list; locks.ownerState = saved.owner; quota.quotaLine = saved.quota; drift.lines = saved.drift; global.Date = RealDate; }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
