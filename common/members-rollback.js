'use strict';
const fs = require('fs'), path = require('path');
function changes(state) {
  const store = require('./members-store').create(state);
  if (![store.file, store.good, store.log].some(file => fs.existsSync(file))) return [];
  // Даже начальная инициализация создаёт формат, которого база не понимает.
  // Повреждение читается через last-good; утрата обоих снимков запрещает откат.
  const snapshot = store.read({ initialize: false });
  return [{ rev: snapshot.rev, phase: snapshot.phase }];
}
function blockers(state, releases) {
  const entries = changes(state);
  if (!entries.length) return [];
  if (releases.length && releases.every(r => fs.existsSync(path.join(r, 'common', 'members-store.js')))) return [];
  return entries.map(e => 'members.json: phase ' + e.phase + ', rev ' + e.rev);
}
function assert(state, releases) {
  const reasons = blockers(state, releases);
  if (reasons.length) throw Error('Откат ниже кандидата А запрещён: существует реестр с phase. Мешающие записи: ' + reasons.join('; '));
}
module.exports = { blockers, assert, changes };
