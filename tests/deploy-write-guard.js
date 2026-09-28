'use strict';
// Загружается также дочерними Node-процессами: bootstrap пишет только в выданную папку.
const fs = require('fs'), path = require('path');
const root = path.resolve(process.env.MOST_TEST_WRITE_ROOT);
function check(file) {
  if (typeof file === 'number') return;
  const rel = path.relative(root, path.resolve(String(file)));
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
    throw Error('Запись вне разрешённой папки: ' + file);
}
for (const method of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'rmSync', 'rmdirSync']) {
  const original = fs[method];
  fs[method] = function(file, ...args) { check(file); return original.call(this, file, ...args); };
}
for (const method of ['renameSync', 'copyFileSync', 'cpSync']) {
  const original = fs[method];
  fs[method] = function(from, to, ...args) {
    if (method === 'renameSync') check(from);
    check(to);
    return original.call(this, from, to, ...args);
  };
}
const open = fs.openSync;
fs.openSync = function(file, flags, ...args) {
  if (typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) : /[wa+]/.test(flags)) check(file);
  return open.call(this, file, flags, ...args);
};
