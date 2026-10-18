'use strict';
// team-v19 Р-а, К8: запасной режим с токеном хоста выведен из работы — команда отвечает указателем на rules/fallback.md, код 1.
const assert = require('assert'), path = require('path'), { spawnSync } = require('child_process');
const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'host-fallback.js'), 'confirm-request', 'enter'], { encoding: 'utf8' });
assert.strictEqual(r.status, 1);
assert.match(r.stdout + r.stderr, /Запасной режим теперь по слову пользователя „Claude отвалился“ в чате Codex или Antigravity — rules\/fallback\.md/);
console.log('ok — confirm-request enter: указатель на rules/fallback.md, код 1');
