'use strict';
// Родитель передаёт корень до первого common/*; каждый сценарий — новый процесс.
const options = JSON.parse(process.argv[2]);
const failFile = process.argv[3];
require('../../../common/deploy').rollback(options, { hook: async (_, p) => {
  if (failFile && p.file === failFile) throw Error('занят');
} }).then(text => console.log(text)).catch(e => { console.error(e.message); process.exitCode = 1; });
