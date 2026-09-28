'use strict';
function errorText(error) {
  const message = String(error?.message || error || '');
  if (/^(?:ENOENT|ENOTDIR)/.test(message)) return 'Файл или папка не найдены.';
  if (/^(?:EACCES|EPERM)/.test(message)) return 'Нет разрешения на действие с файлом или процессом.';
  if (/^EBUSY/.test(message)) return 'Файл занят другой программой.';
  if (/^(?:Unexpected|Expected|Invalid|Cannot|Command failed|spawn|connect|read |write |E[A-Z]+:)/.test(message))
    return 'Не удалось выполнить операцию' + (error?.code ? ' (код ' + error.code + ')' : '') + '.';
  return message;
}
module.exports = { errorText };
