'use strict';
const fs = require('fs'), path = require('path');
const [root, release, route, late] = process.argv.slice(2), state = path.join(root, 'state');
const json = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const deploy = require(path.join(release, 'common/deploy.js'));
const deps = { probe: async () => {}, rules: { files: [] }, hook: async phase => {
  if (late === 'true' && /^config\d+$/.test(phase)) json(path.join(state, 'codex-jobs/a.json'),
    { id: 'foreign', status: 'running', owner: require(path.join(release, 'common/locks.js')).owner(), folder: root });
}, restart: { launch: async () => { throw Error('закрытие недопустимо'); } } };
require(path.join(release, 'tools/deploy.js')).main([
  '--root', root, route === 'cli-config' ? '--config-only' : '--clients-only', '--release', release,
  ...(route === 'cli-config' ? ['--config', path.join(root, 'claude.json')] : []), '--restart-claude',
], { configure: o => deploy.configure(o, deps), configureClients: o => deploy.configureClients(o, deps), print() {} })
  .catch(e => { console.error(e.message); process.exitCode = 1; });
