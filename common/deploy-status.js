'use strict';
const fs = require('fs'), path = require('path');
const { real, equal } = require('../tools/deploy-bootstrap');
// Чистое решение: никаких обращений к диску и подстановки createdAt.
function superseded(v) {
  return !!(v.valid && v.status === 'отказ' && v.sameRoot && v.sameRelease && v.direct &&
    /^[a-f0-9]{40}$/.test(v.commit) && Array.isArray(v.names) && v.names.length === 3 && v.names.every(n => n === v.commit) &&
    Number.isFinite(v.at) && Number.isFinite(v.updatedAt) && v.at > v.updatedAt);
}
function hidden(op, marker, root) {
  if (!op || !marker) return false;
  try {
    const r = real(root), release = real(op.release), installed = real(marker.release);
    return superseded({ valid: fs.statSync(release).isDirectory(), status: op.status, sameRoot: equal(real(op.root), r),
      sameRelease: equal(release, installed), direct: equal(path.dirname(release), path.join(r, 'live')),
      commit: marker.commit, names: [path.basename(op.release), path.basename(marker.release), path.basename(release)],
      at: Date.parse(marker.at), updatedAt: Date.parse(op.updatedAt) });
  } catch { return false; }
}
function visible(op, root) {
  try { return hidden(op, JSON.parse(fs.readFileSync(path.join(root, 'live/deployed.json'), 'utf8')), root) ? null : op; }
  catch { return op; }
}
module.exports = { superseded, hidden, visible };
