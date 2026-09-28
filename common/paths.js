'use strict';
const fs = require('fs'),
  path = require('path');
const isWindows = process.platform === 'win32';
const repoRoot = path.resolve(process.env.MOST_REPO_ROOT || path.join(__dirname, '..'));
const stateDir = path.resolve(process.env.MOST_STATE_DIR || path.join(repoRoot, 'state'));
function canon(p) {
  const r = fs.realpathSync.native(p);
  return isWindows ? r.toLowerCase() : r;
}

function canonMaybe(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const c = canon(cur);
      return rest.length ? path.join(c, ...rest.reverse()) : c;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      rest.push(isWindows ? path.basename(cur).toLowerCase() : path.basename(cur));
      cur = parent;
    }
  }
}

function isInsideReal(child, root) {
  const c = canonMaybe(child),
    r = canon(root);
  const rel = path.relative(r, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function samePath(a, b) {
  try {
    return canonMaybe(a) === canonMaybe(b);
  } catch (e) {
    const x = path.resolve(a),
      y = path.resolve(b);
    return isWindows ? x.toLowerCase() === y.toLowerCase() : x === y;
  }
}

// Правила написаны для корня по умолчанию C:\most; при другой папке установки подставляется фактический корень (team-v11 Р1).
function withRoot(text, root = repoRoot) {
  const actual = /^[a-z]:[\\/]/i.test(String(root)) ? path.win32.normalize(String(root)).replace(/[\\]+$/, '') : path.resolve(root);
  if (actual.toLowerCase() === 'c:\\most') return text;
  return text.replace(/C:\\most(?![\w-])/gi, () => actual).replace(/C:\/most(?![\w-])/gi, () => actual.replace(/\\/g, '/'));
}
module.exports = {
  withRoot, canon, canonMaybe, isInsideReal, samePath, stateDir, repoRoot };
