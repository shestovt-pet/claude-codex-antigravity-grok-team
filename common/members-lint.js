'use strict';
const fs = require('fs'), path = require('path');
// Только объявления действующего состава. Не ищет имена моделей, форматы старых
// карточек, протоколы конкретного адаптера и исторические документы.
const exempt = new Set(['common/members-default.js', 'common/model-family.js']);
function checkText(file, text) {
  if (!/^(common|servers|tools)\/.+\.js$/.test(file) || exempt.has(file)) return [];
  return text.split(/\r?\n/).flatMap((line, i) =>
    /\b(?:const|let|var)\s+(?:participants|members|voters|helpers|SEATS|QUORUM|WHO|SERVERS|AGENTS)\s*=.*\[\s*['"](?:codex|antigravity|claude)['"]/i.test(line)
      ? [file + ':' + (i + 1) + ': действующий состав должен читаться из members.js'] : []);
}
function scan(root) {
  const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(dir + '/' + e.name) : checkText(dir + '/' + e.name, fs.readFileSync(path.join(root, dir, e.name), 'utf8')));
  return ['common', 'servers', 'tools'].flatMap(walk);
}
module.exports = { checkText, scan };
