'use strict';
// Загружается только тестовым процессом через --require.
const fs = require('fs');
const original = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  const name = String(file);
  if (process.env.FAULT_CONTROL && /codex-jobs[\\/].+\.json$/.test(name)) {
    const control = JSON.parse(original(process.env.FAULT_CONTROL, 'utf8'));
    const stack = new Error().stack;
    const matchesScope = !control.scope || stack.includes('at ' + control.scope + ' (');
    if (control.count > 0 && name.includes(control.target) && matchesScope) {
      control.count--;
      fs.writeFileSync(process.env.FAULT_CONTROL, JSON.stringify(control));
      if (control.code === 'PARTIAL') return '{"incomplete":';
      throw Object.assign(new Error('SECRET: текст поручения'), { code: control.code });
    }
  }
  return original.call(this, file, ...args);
};
