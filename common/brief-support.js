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
  let total = 0;
  return rows.map((r, i) => {
    if (!r || typeof r.origin !== 'string' || !r.origin.trim()) throw Error('Опора ' + (i + 1) + ': нужен origin.');
    if (!['канон', 'свобода'].includes(r.section) || typeof r.path !== 'string') throw Error('Некорректная запись опоры.');
    const p = fs.realpathSync(path.resolve(folder, r.path));
    if (!isInsideReal(p, folder)) throw Error('Опора вне папки проекта: ' + r.path);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 100 * 1024) throw Error('Файл опоры больше 100 КБ или не файл: ' + r.path);
    const bytes = fs.readFileSync(p);
    total += bytes.length;
    if (bytes.length > 100 * 1024 || total > 200 * 1024) throw Error('Опора больше 100 КБ на файл или 200 КБ в сумме.');
    return { label: (r.section === 'канон' ? 'Твёрдый канон' : 'Зона авторской свободы') + ' · ' + r.path,
      text: 'Источник: ' + r.origin + '\n' + bytes.toString('utf8'), copyName: 'opora_auto_' + i + '.txt' };
  });
}
const text = rows => rows.map(r => '\n' + r.label + '\n' + r.text).join('\n');
module.exports = { support, text };
