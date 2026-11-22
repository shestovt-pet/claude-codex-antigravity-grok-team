'use strict';
// team-v63 (п.1): вложение материала прямо в текст поручения. Параметр *_send `files` — список абсолютных путей (строка или
// { path, lines }); мост сам читает файлы (UTF-8 как есть) и вкладывает их в подсказку отдельными размеченными блоками с
// именем файла. Участнику в этом случае НЕ нужно открывать файлы инструментами — в подсказку добавляется строка NOTE.
// Предел общего объёма не вводится (слово владельца: никаких искусственных ограничений), но объём в знаках пишется в карточку.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NOTE = 'Материал вложен ниже, файлы открывать не нужно.';

// «10-40» или «12» (1-based, включительно) → срез строк. Пустые/битые диапазоны → весь файл.
function sliceLines(content, lines) {
  if (!lines) return content;
  const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(String(lines));
  if (!m) throw Error('files: диапазон строк должен быть «N» или «N-M»: ' + lines);
  const from = Number(m[1]), to = m[2] ? Number(m[2]) : from;
  if (from < 1 || to < from) throw Error('files: некорректный диапазон строк: ' + lines);
  const all = content.split(/\r?\n/);
  return all.slice(from - 1, to).join('\n');
}

function normalizeEntry(entry, i) {
  if (typeof entry === 'string') return { path: entry, lines: undefined };
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const p = entry.path ?? entry.file;
    if (typeof p !== 'string' || !p.trim()) throw Error('files[' + i + ']: нужен непустой path.');
    return { path: p, lines: entry.lines };
  }
  throw Error('files[' + i + ']: нужна строка пути или объект { path, lines }.');
}

// team-v63 (п.16): файл внутри папки (с учётом символьных ссылок — через realpath, когда файл существует).
function insideFolder(p, folder) {
  if (!folder) return false;
  const real = x => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  try { const rel = path.relative(real(folder), real(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); } catch { return false; }
}
// Авторизатор чтения вложений. Владельцу и ДОКАЗАННЫМ чатам (guest=false) — любые абсолютные пути без пределов объёма (так
// решил владелец). ГОСТЮ (поручение-исполнитель) при полном доступе — тоже без пределов; без полного доступа — только файлы
// внутри его папки поручения. Проверка выполняется ДО чтения файла. null — без ограничений.
function guestAuthorizer({ guest, folder, fullAccess }) {
  if (!guest || fullAccess) return null;
  return p => insideFolder(p, folder) ? true
    : (folder ? 'files: гостю доступны только файлы внутри папки поручения (' + folder + '): ' + p
             : 'files: гостю нужна папка поручения, внутри которой лежат вкладываемые файлы: ' + p);
}

// Читает список вложений и строит единый размеченный блок текста. Бросает понятный отказ на отсутствующем/нечитаемом файле
// (мост не должен молча проглатывать материал владельца). Возвращает { text, chars, items, hash, names }.
// authorize(path) → true | строка-причина отказа: проверка прав ДО чтения (team-v63 п.16).
function read(files, { readFile = p => fs.readFileSync(p, 'utf8'), authorize } = {}) {
  if (files === undefined || files === null) return null;
  if (!Array.isArray(files)) throw Error('files: ожидается список путей.');
  if (!files.length) return null;
  const blocks = [], items = [], names = [];
  for (let i = 0; i < files.length; i++) {
    const { path: p, lines } = normalizeEntry(files[i], i);
    if (!path.isAbsolute(p)) throw Error('files[' + i + ']: нужен абсолютный путь: ' + p);
    if (authorize) { const ok = authorize(p); if (ok !== true) throw Error(typeof ok === 'string' ? ok : 'files[' + i + ']: нет прав читать ' + p); }
    let content;
    try { content = readFile(p); } catch (e) { throw Error('files[' + i + ']: не прочитать ' + p + ': ' + (e.code || e.message)); }
    content = sliceLines(content, lines);
    const name = p + (lines ? ' (строки ' + lines + ')' : '');
    blocks.push('----- вложение: ' + name + ' -----\n' + content + '\n----- конец вложения: ' + name + ' -----');
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    items.push({ path: p, lines: lines || null, chars: content.length, sha256: sha });
    names.push(name);
  }
  const text = '\n\n' + blocks.join('\n\n');
  const hash = crypto.createHash('sha256').update(JSON.stringify(items.map(it => [it.path, it.lines, it.sha256]))).digest('hex');
  return { text, chars: text.length, items, hash, names };
}

// Готовит карточку по прочитанным вложениям и a.text: сохраняет вложения в отдельный файл (карточку не раздуваем), пишет
// размер/имена/хеш. Возвращает { chars } — объём вложений в знаках (для chars_in).
function attach(job, data, attachFile) {
  if (!data) return { chars: 0 };
  fs.writeFileSync(attachFile, data.text, 'utf8');
  job.attachFile = attachFile;
  job.attachmentsChars = data.chars;
  job.attachmentNames = data.names;
  job.attachmentsHash = data.hash;
  return { chars: data.chars };
}

// Хвост подсказки (stdin) для инлайна вложений: строка NOTE + содержимое файла вложений. Пусто, если вложений нет.
// team-v63 (п.21): если файл вложений ОБЪЯВЛЕН на карточке (attachFile), но к моменту запуска пропал — это ЯВНАЯ ошибка
// поручения (прежде promptTail молча отдавал поручение без материала владельца), а не тихий пропуск.
function promptTail(job, { readFile = p => fs.readFileSync(p, 'utf8') } = {}) {
  if (!job.attachFile) return [];
  let text;
  try { text = readFile(job.attachFile); }
  catch (e) { throw Error('Вложения поручения пропали к моменту запуска (' + job.attachFile + '): ' + (e.code || e.message)); }
  return [NOTE, text];
}

module.exports = { read, attach, promptTail, sliceLines, insideFolder, guestAuthorizer, NOTE };
