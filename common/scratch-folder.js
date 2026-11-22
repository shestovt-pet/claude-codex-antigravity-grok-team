'use strict';
// team-v59 (часть 3 п.3в): простой вопрос участнику (роль «совет»/«текст» без записи, «проверка» переданного text) не должен
// требовать папку. Если папка не передана — мост сам берёт служебную пустую папку state\scratch\<id> и подставляет её.
// Запись (write=true) по-прежнему требует явную папку (там действуют замки записи и проверки write-folder). Пустая
// существующая папка отказом не была и не становится. Файл-заглушку от вызывающего не требуем.
const fs = require('fs'), path = require('path');
function scratchAllowed(a) {
  if (a.write === true) return false;
  // team-v63 (п.а): у Antigravity режим text файла не имеет — служебная папка берётся при ЛЮБОЙ роли (включая «проверка»
  // без text). Флаг ставит только вызов mode=text без folder; прочие адаптеры его не передают и работают как прежде.
  if (a.anyRole) return true;
  // team-v60: вызов без role (и без записи) считается «совет» — простой вопрос участнику берёт служебную папку.
  const role = a.role || 'совет';
  return ['совет', 'текст'].includes(role) || (role === 'проверка' && typeof a.text === 'string' && a.text.length > 0);
}
// Возвращает папку: исходную (если задана непустой строкой) либо служебную пустую (создаётся). Мутирует a.folder.
function ensure(a) {
  // team-v60: отсутствующая роль при write !== true закрепляется как «совет» и дальше по пути идёт советом.
  if (a.write !== true && !a.role) a.role = 'совет';
  if (typeof a.folder === 'string' && a.folder.trim()) return a.folder;
  if (!scratchAllowed(a)) return a.folder; // пусть прежняя проверка «нужна папка» отработает как есть
  const dir = path.join(require('./paths').stateDir, 'scratch', require('crypto').randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  a.folder = dir;
  a.scratchFolder = true;
  return dir;
}
// team-v59 (Codex №4): служебная папка — внутренняя деталь, вызывающий её не называл. В отпечаток запроса (request_id) она
// входить не должна, иначе повтор того же запроса без folder каждый раз даёт новый случайный путь и REQUEST_ID_CONFLICT.
// folderValue — что класть в values admission: стабильную метку для служебной папки, иначе канонический путь.
function folderValue(a, folder) { return a.scratchFolder ? '(scratch)' : folder; }
// На повторе (admission вернул duplicate) только что созданную пустую служебную папку убираем — не копить мусор.
function discard(a) { if (a.scratchFolder) { try { require('fs').rmdirSync(a.folder); } catch {} } }
module.exports = { ensure, scratchAllowed, folderValue, discard };
