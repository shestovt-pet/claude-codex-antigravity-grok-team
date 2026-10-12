'use strict';
const { validateManifest, readLocal } = require('../common/artifact-manifest');
try {
  const [root, manifestPath] = process.argv.slice(2);
  if (!root || !manifestPath || process.argv.length !== 4) throw Error('Использование: node tools/verify-artifacts.js <абсолютная папка заказа> <относительный manifest.json>');
  const manifest = JSON.parse(readLocal(root, manifestPath, 4 * 1024 * 1024).bytes.toString('utf8'));
  const result = validateManifest(manifest, root);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.ready ? 0 : 1;
} catch (e) {
  process.stdout.write(JSON.stringify({ ready: false, errors: [e.message], artifacts: [] }) + '\n');
  process.exitCode = 1;
}
