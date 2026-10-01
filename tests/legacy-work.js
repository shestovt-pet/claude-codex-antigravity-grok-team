'use strict';
// Старые наборы проверяют уведомления/редакции, а не новую приёмку.
// Их карточка моделирует этапы, существовавшие до v14; новые правила отдельно проверяет team-v14.js.
module.exports = function legacyWork(team, name) {
  const fs = require('fs'), file = team.workFile(name), w = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of w.stages) s.rules_version = 13;
  fs.writeFileSync(file, JSON.stringify(w));
};
