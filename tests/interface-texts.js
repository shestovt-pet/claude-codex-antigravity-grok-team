'use strict';
const fs = require('fs'), path = require('path');
// Только четыре принятых исторических документа: не переписываем прежние замыслы и ТЗ.
// Остальные файлы docs (включая новые) проверяются без исключений.
const history = new Set(['docs/design/design-v1.md', 'docs/design/design-v2.md',
  'docs/design/design-v3.md', 'docs/design/impl-brief.md']);
const forbidden = /трёх\s+ИИ|Связка\s+трёх|Квоты\s+(?:трёх|четырёх)|проверка\s+трёх\s+голосов|трое\s+проверяющих|(?:^|[^а-яё])трио(?=$|[^а-яё])/i;
function ownText(text) {
  // Дословные материалы должны быть явно отделены от собственного описания интерфейса.
  return text.replace(/^```(?:user-request|assistant-response)\r?\n[\s\S]*?^```[ \t]*$/gm, '');
}
function violations(text) {
  return ownText(text).split(/\r?\n/).flatMap((line, i) => forbidden.test(line) ? [i + 1] : []);
}
function inventory(root) {
  const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e => {
    const file = dir + '/' + e.name;
    return e.isDirectory() ? walk(file) : /\.(?:md|js)$/.test(e.name) ? [file] : [];
  });
  const files = ['AGENTS.md', 'README.md', ...['docs', 'rules', 'common', 'servers'].flatMap(walk)];
  return { files: files.filter(f => !history.has(f)), history: files.filter(f => history.has(f)) };
}
function inspect(root) {
  // В common/servers проверяется весь статический исходный текст, включая все строки
  // описаний, сводок и уведомлений. Динамические запросы/ответы из хранилища не читаются.
  return inventory(root).files.flatMap(file => violations(fs.readFileSync(path.join(root, file), 'utf8')).map(line => file + ':' + line));
}
module.exports = { inspect, inventory, violations };
