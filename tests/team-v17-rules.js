'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const brief = read('rules/brief.md');
const helpers = read('skill/helpers/SKILL.md');
const common = read('rules/common.md');
const blockTitle = '## Сначала — результат и проверка';
const helpersTitle = '# Работа с помощниками (связка трёх ИИ)';
const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const lineCount = text => (text.match(/\n/g) || []).length;
let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ПРОЙДЕНО: ' + name);
  } catch (error) {
    failed++;
    console.error('ПРОВАЛ: ' + name + '\n' + error.message);
  }
}
function block(text, title) {
  const lines = text.split('\n');
  assert.equal(lines.filter(line => line === title).length, 1, 'Заголовок должен встречаться один раз');
  const at = lines.indexOf(title);
  assert.equal(lines[at + 1], '', 'Перед блоком нужна пустая строка');
  assert.equal(lines[at + 2], blockTitle, 'Блок должен идти сразу после заголовка и пустой строки');
  assert.equal(lines.filter(line => line === blockTitle).length, 1, 'Блок не должен дублироваться');
  const end = lines.indexOf('', at + 3);
  assert(end > at + 2, 'После блока нужна пустая строка');
  return lines.slice(at + 2, end).join('\n') + '\n';
}
function section(text, title) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const heading = '## ' + title;
  assert.equal(lines.filter(line => line === heading).length, 1, heading);
  const start = lines.indexOf(heading);
  let end = lines.findIndex((line, i) => i > start && /^#{2,} /u.test(line));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n');
}
function item(text, title, number) {
  const lines = section(text, title).split('\n');
  const starts = lines.map((line, i) => line.startsWith(number + '. ') ? i : -1).filter(i => i >= 0);
  assert.equal(starts.length, 1, title + ', пункт ' + number);
  const start = starts[0];
  let end = lines.findIndex((line, i) => i > start && /^\d+\. /u.test(line));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trimEnd();
}
function files(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(relative);
    assert(entry.isFile(), 'Неожиданный тип пути: ' + relative);
    return [relative];
  });
}
test('К5: блок сразу после первого заголовка памятки', () => {
  assert(brief.startsWith('# '));
  block(brief, brief.split('\n')[0]);
});
test('К5: блок сразу после заголовка скилла', () => {
  block(helpers, helpersTitle);
});
test('К5: обе копии совпадают с принятым блоком, не больше 15 строк и 1500 знаков', () => {
  const a = block(brief, brief.split('\n')[0]);
  const b = block(helpers, helpersTitle);
  assert.equal(a, b);
  // Принятый блок ред. 7, имя заменено в team-v29, чтобы закреплённый текст не менялся выгрузкой.
  assert.equal(sha256(a), 'c611ddc143fc5ec06e1c16c8a50d606f9519a7d626cce7657edf3d0fbb4cace8');
  assert(lineCount(a) <= 15, 'Блок длиннее 15 строк');
  assert(a.length <= 1500, 'Блок длиннее 1500 знаков');
});
test('К5: вся памятка не больше 64 строк и 7587 знаков', () => {
  // База main 39bc3b73: 49 переводов строки \n и 6087 знаков.
  assert(lineCount(brief) <= 49 + 15, 'Превышен рост памятки по строкам');
  assert(brief.length <= 6087 + 1500, 'Превышен рост памятки по знакам');
});
test('К6: запрещённые старые фразы отсутствуют во всех файлах rules/ и skill/', () => {
  const forbidden = [
    'Пользователь добавляет правило сам',
    'какое одно правило автоодобрения',
    'Всегда разрешать',
    'спроси, не было ли',
    'Задавай прямые вопросы и всегда предлагай',
  ];
  for (const file of [...files('rules'), ...files('skill')]) {
    const text = read(file);
    for (const phrase of forbidden) assert(!text.includes(phrase), file + ': ' + phrase);
  }
});
test('К6: прежние технические вопросы пользователю отсутствуют в rules/', () => {
  const forbidden = [
    'Кому поручить: Antigravity (Гемини), Codex, Grok или нескольким?',
    'Покажи пользователю, что именно вернёшь, и спроси',
    'выбери другое имя или спроси',
    'только с разрешения пользователя (ниже)',
  ];
  for (const file of files('rules')) {
    const text = read(file);
    for (const phrase of forbidden) assert(!text.includes(phrase), file + ': ' + phrase);
  }
});
test('К6: прежнее требование кворума каждого плана удалено', () => {
  assert(!common.includes('план и каждый последующий этап требуют кворума'));
});
test('К6: пункты 1 и 5 «Как собирать мнения» совпадают', () => {
  for (const n of [1, 5]) assert.equal(item(common, 'Как собирать мнения', n), item(helpers, 'Как собирать мнения', n));
  assert(item(common, 'Как собирать мнения', 1).includes('В обсуждении цели (КТ0) каждый сначала выводит критерии из дословного запроса; план Claude не видит.'));
});
test('К6: пункт 6 «Кто принимает итог» и новая шапка совпадают', () => {
  const a = item(common, 'Кто принимает итог', 6);
  assert.equal(a, item(helpers, 'Кто принимает итог', 6));
  assert(a.includes('Шапка файла помощника: строки „version: <хеш этапа>“, „семья: anthropic“, „модель: <модель агента>“ — каждая один раз.'));
});
test('К6: пункт 1 обеих копий содержит одинаковую новую строку об уровнях', () => {
  const expected = 'Уровни этапа — по памятке (блок «Сначала — результат и проверка»). Ответ в чате — только короткий, без файла, видный одним взглядом: проверок КТ4 нет, термины — по поиску всегда; всё остальное — этап, сомнение — этап.';
  for (const text of [common, helpers]) {
    const lines = item(text, 'Кто принимает итог', 1).split('\n').map(line => line.trim());
    assert.equal(lines.filter(line => line === expected).length, 1);
    assert(lines.some(line => line.includes('Уровни этапа — по памятке')));
  }
});
test('К6: скилл больше не исключает мелкую правку в одну строку', () => {
  assert(!helpers.includes('мелкая правка в одну строку'));
});
console.log('Памятка: ' + lineCount(brief) + ' строк, ' + brief.length + ' знаков.');
console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0');
process.exitCode = failed ? 1 : 0;
