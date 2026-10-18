'use strict';
// team-v27 (урок 78): правила проверки в месте запуска, рецептов и наблюдения за задачами на компьютере пользователя.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ПРОЙДЕНО: ' + name); }
  catch (error) { failed++; console.error('ПРОВАЛ: ' + name + '\n' + error.message); }
}
function section(text, heading) {
  const lines = text.split('\n'); const at = lines.indexOf(heading);
  assert(at >= 0, 'Нет раздела ' + heading);
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return lines.slice(at + 1, end).join('\n');
}
const common = read('rules/common.md'), claude = read('rules/claude.md'), lessons = read('lessons.md');
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (/\.md$/.test(e.name)) out.push(p);
  }
  return out;
}
test('К1: правила урока 78 в rules/common.md и rules/claude.md', () => {
  const pol = section(common, '## Политика уроков (lessons.md)');
  assert(pol.includes('урок закрывается только механической проверкой у исполнителя'), 'Р1');
  assert(pol.includes('ошибка самой проверки = не запускать'), 'Р1: ошибка проверки');
  assert(pol.includes('проверяет Codex на сквозном примере'), 'Р2');
  const run = section(claude, '## Запуск на компьютере пользователя (team-v27, урок 78)');
  for (const p of ['Единственный вход', 'Смена канала доставки', 'содержательному старту', 'старт проверю в ЧЧ:ММ',
                   'Задержка предыдущего задания переносит проверку', 'от вас ничего не нужно'])
    assert(run.includes(p), 'Р3: нет «' + p + '»');
});
test('К2: нет рецепта newline для сохранения окончаний строк', () => {
  const files = ['rules', 'skill'].flatMap(walk);
  for (const f of files) {
    const t = read(f);
    for (const q of ["newline=''", 'newline=""'])
      for (const line of t.split('\n').filter(l => l.includes(q)))
        assert(/неполн|не делает CRLF/.test(line), f + ': рецепт «' + q + '» без оговорки: ' + line.slice(0, 120));
  }
  assert(claude.includes('чтением и записью байтами (`rb`/`wb`)'), 'rules/claude.md: новый способ правки');
});
test('К3: урок 78 со всеми полями политики уроков', () => {
  const at = lessons.indexOf('## 78. ');
  assert(at >= 0, 'нет урока 78');
  const next = lessons.indexOf('\n## ', at + 1);
  const body = lessons.slice(at, next > at ? next : undefined);
  for (const f of ['Воспроизводимый случай:', 'Первопричина:', 'Что надо было сделать вместо:', 'Область действия:',
                   'Где закрыто:', 'Остаточное ограничение:', 'Проверка:', 'Статус:'])
    assert(body.includes(f), 'урок 78: нет поля ' + f);
  assert(/LF-задание положено в очередь напрямую → rejected/.test(body), 'урок 78: нет отрицательного теста');
});
test('К4: урок 69 ссылается на урок 78', () => {
  const at = lessons.indexOf('## 69. '), next = lessons.indexOf('\n## 70. ', at);
  assert(at >= 0 && next > at, 'нет урока 69');
  assert(lessons.slice(at, next).includes('см. урок 78'), 'урок 69 без ссылки');
});
test('К5: числовые сроки наблюдения согласованы', () => {
  const run = section(claude, '## Запуск на компьютере пользователя (team-v27, урок 78)');
  assert(run.includes('плюс не более 5 минут'), 'старт: T + 5');
  assert(run.includes('не реже раза в 15 минут до старта'), 'до старта: 15');
  assert(run.includes('не реже раза в 25 минут'), 'в работе: 25');
  assert(run.includes('устаревшим через 5 минут') && run.includes('предельная задержка обнаружения остановки — 30 минут'), '25 + 5 = 30');
  const mins = [...run.matchAll(/(\d+) минут/g)].map(m => Number(m[1]));
  for (const m of mins) assert([5, 15, 25, 30].includes(m), 'лишний срок: ' + m);
});
console.log(`Итого: пройдено ${passed}, провалено ${failed}, пропущено 0`);
process.exitCode = failed ? 1 : 0;
