'use strict';
// Завершённые проверенные ответы для прежних испытаний независимых ворот.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
function accepted(team, name) {
  const file = team.changeFile(name), c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dir = require('../common/team-store').roots().grok;
  fs.mkdirSync(dir, { recursive: true });
  for (const phase of ['design', 'verdict']) {
    const id = crypto.randomUUID(), text = 'ПРИНЯТО\nКОНТРОЛЬ ' + 'a'.repeat(64) + '\nКОНЕЦ ОТВЕТА\n';
    fs.writeFileSync(path.join(dir, id + '.result.txt'), text);
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, status: 'done',
      task: String(c.requestMark) + ' ' + (phase === 'design' ? c.designHash : c.base + ' ' + c.candidate),
      resultHash: crypto.createHash('sha256').update(text).digest('hex') }));
    c[phase === 'design' ? 'grokDesign' : 'grokVerdict'] = { job_id: id, status: 'done', decision: 'ПРИНЯТО', designHash: c.designHash, base: c.base, candidate: c.candidate };
  }
  fs.writeFileSync(file, JSON.stringify(c));
}
module.exports = { accepted };
