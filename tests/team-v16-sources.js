'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { gate, stores, fixture, job, fresh, accept, json, run } = require('./team-v16-fixture');
const tests = [];
for (const version of [14, 15]) for (const explicit of [false, true]) {
  for (const status of ['done', 'applied', 'cancelled', 'failed', 'running', 'unexpected']) tests.push([
    'Р13: v' + version + ' ' + (explicit ? 'source_jobs' : 'автопоиск') + ' ' + status,
    async () => {
      const f = fixture({ author: { family: 'google', model: 'gemini' } }); f.s.rules_version = version;
      const id = job(f, 'antigravity', 0, { role: 'текст', status, ...(explicit ? { stage: 'other', stageId: 'other' } : {}) });
      if (explicit) f.s.source_jobs = [id];
      job(f); if (version === 14) fresh(f); else job(f, 'grok');
      if (['done', 'applied'].includes(status)) { assert(stores.source('antigravity', id)); await accept(f); }
      else { assert.throws(() => stores.source('antigravity', id)); await assert.rejects(accept(f)); }
    }
  ]);
}
for (const field of ['cancelled', 'lateHash', 'corrupt']) tests.push(['Р13: applied сохраняет защиту ' + field, async () => {
  const f = fixture({ author: { family: 'google', model: 'gemini' } });
  const id = job(f, 'antigravity', 0, { role: 'текст', status: 'applied', ...(field === 'corrupt' ? {} : { [field]: true }) });
  f.s.source_jobs = [id]; job(f); job(f, 'grok');
  if (field === 'corrupt') json(path.join(stores.roots().antigravity, id, 'meta.json'), { hash: 'wrong' });
  assert.throws(() => stores.source('antigravity', id)); await assert.rejects(accept(f));
}]);
run(tests);
