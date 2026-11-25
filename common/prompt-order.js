'use strict';
// cache-622 (М1): порядок частей текста поручения ради кэша префикса у поставщиков моделей. Неизменное — в начало,
// меняющееся от поручения к поручению — в конец:
//   1) шапка (постоянна для данного доступа: только чтение / запись / полный доступ);
//   2) материал (`text`) — ТЕКСТОМ, а не путём (как у Kimi); если материал длиннее порога — по-прежнему путь к файлу;
//   3) вложения `files` — строка NOTE и содержимое файлов;
//   4) текст задачи;
//   5) всё меняющееся (у адаптеров, где оно есть: карта путей копий Kimi, метки ответа и номер редакции реестра у
//      Antigravity, пути временных папок). Отдельной строки-напоминания «что ответить» в конце нет: задача и так стоит
//      после материала.
// Используется адаптерами codex, claude и deepseek (одна и та же трёхстрочная шапка). Kimi и Antigravity собирают свой
// текст сами (common/kimi-material.js, servers/antigravity), но в том же порядке.
const fs = require('fs');

// Порог вклейки материала текстом, знаков. Настройка MOST_INLINE_MATERIAL_CHARS; по умолчанию 300 000.
const DEFAULT_INLINE_MATERIAL_CHARS = 300000;
function inlineLimit(env = process.env) {
  const n = Number(env.MOST_INLINE_MATERIAL_CHARS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_INLINE_MATERIAL_CHARS;
}

// Шапка: постоянна для данного доступа (не содержит номера поручения, времени, путей).
function head(job) {
  return [
    'Это отдельное поручение пользователя через Claude. Не считай, что знаешь другие чаты.',
    job.fullAccessApplied
      ? 'Полный доступ: команды выполняются от имени пользователя без песочницы. Запускай только то, что названо в поручении; каждое действие вне папки поручения перечисли в отчёте.'
      : job.write
      ? 'Изменения разрешены только в рамках поручения. Перечисли файлы и проверки.'
      : 'Только чтение. Не изменяй файлы.',
    'Не обходи ограничения. Отвечай по-русски.',
  ];
}

// Материал поручения: текстом до порога, иначе путь к файлу. Пустой список, если материала нет.
// Возвращает { lines, inline } — inline=true, когда материал вклеен текстом.
function material(job, { readFile = p => fs.readFileSync(p, 'utf8'), limit = inlineLimit() } = {}) {
  if (!job.textFile) return { lines: [], inline: false };
  let text = null;
  try { text = readFile(job.textFile); } catch { text = null; }
  if (text !== null && text.length <= limit) return { lines: ['Материал:', text, '----- конец материала -----'], inline: true };
  return { lines: ['Материал в файле: ' + job.textFile], inline: false };
}

// Полный текст поручения для stdin codex/claude/deepseek. tail — меняющиеся строки (их у этих адаптеров нет; параметр
// оставлен для единообразия и тестов).
function build(job, { readFile, limit, tail = [] } = {}) {
  const m = material(job, { readFile, limit });
  const attachments = require('./attachments').promptTail(job, readFile ? { readFile } : undefined);
  return [...head(job), ...m.lines, ...attachments, 'Поручение:', job.task, ...tail].join('\n');
}

module.exports = { head, material, build, inlineLimit, DEFAULT_INLINE_MATERIAL_CHARS };
