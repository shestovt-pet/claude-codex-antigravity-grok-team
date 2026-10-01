'use strict';
const fs = require('fs'), path = require('path');
function read(root = path.join(__dirname, '..')) {
  try {
    const text = fs.readFileSync(path.join(root, 'rules', 'instructions.md'), 'utf8').trim();
    if ([...text].length > 1200) return { text: '', warning: 'Подсказка rules/instructions.md превышает 1200 символов.' };
    return { text, warning: '' };
  } catch { return { text: '', warning: 'Нет rules/instructions.md: подсказки серверов не предоставлены.' }; }
}
function options(who) {
  const data = read();
  return { instructions: require('./access').guest() || !data.text ? '' : who === 'team' ? data.text : 'Зови помощников по типу задачи без напоминания; правила и приёмка — у сервера team (team_rules).' };
}
module.exports = { read, options };
