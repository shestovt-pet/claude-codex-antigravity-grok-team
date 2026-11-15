'use strict';
const fs = require('fs'), path = require('path');
const { isInsideReal } = require('./paths');
function support(folder, enabled = true) {
  if (!folder || enabled === false) return [];
  const file = path.join(folder, '.most', 'opora.json');
  if (!fs.existsSync(file)) return [];
  if (!isInsideReal(file, folder)) throw Error('opora.json вне папки проекта.');
  let rows;
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error('Некорректный JSON опоры.'); }
  if (!Array.isArray(rows)) throw Error('opora.json должен содержать список.');
  // team-v48e Г7 (§2.5, 4a): жёсткие пределы опоры 100 КБ/файл и 200 КБ/сумма сняты безусловно (без тумблеров и слова).
  // Проверки «файл / внутри папки проекта / валидный JSON» сохранены (подлинность, не размер).
  return rows.map((r, i) => {
    if (!r || typeof r.origin !== 'string' || !r.origin.trim()) throw Error('Опора ' + (i + 1) + ': нужен origin.');
    if (!['канон', 'свобода'].includes(r.section) || typeof r.path !== 'string') throw Error('Некорректная запись опоры.');
    const p = fs.realpathSync(path.resolve(folder, r.path));
    if (!isInsideReal(p, folder)) throw Error('Опора вне папки проекта: ' + r.path);
    const st = fs.statSync(p);
    if (!st.isFile()) throw Error('Опора не файл: ' + r.path);
    const bytes = fs.readFileSync(p);
    return { label: (r.section === 'канон' ? 'Твёрдый канон' : 'Зона авторской свободы') + ' · ' + r.path,
      text: 'Источник: ' + r.origin + '\n' + bytes.toString('utf8'), copyName: 'opora_auto_' + i + '.txt' };
  });
}
const text = rows => rows.map(r => '\n' + r.label + '\n' + r.text).join('\n');
module.exports = { support, text };
