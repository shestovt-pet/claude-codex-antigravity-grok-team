'use strict';
// Отмена поручения, которое ждёт очереди или квоты (team-v18, К4). Переход карточки один на всех: его вызывают
// обработчики codex_cancel и antigravity_cancel и сервер team (grok_slot) — под тем же замком карточки, что у адаптера.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const locks = require('./locks');
const WAITING = ['waiting_quota', 'queued'];

// Переход «в очереди» / «ждёт квоту» → «отменено». Отменённое поручение не возобновляется: очередь берёт только queued и waiting_quota.
function cancelWaiting(c) {
  if (!WAITING.includes(c.status)) return false;
  c.status = 'cancelled';
  c.finishedAt = new Date().toISOString();
  return true;
}

function write(file, text) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 8) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

// Отмена ждущего поручения codex или antigravity из другого процесса: замок и формат карточки — как у адаптера.
async function cancel(who, id) {
  if (!['codex', 'antigravity'].includes(who) || !/^[a-zA-Z0-9_-]{1,80}$/.test(id || '')) throw Error('Некорректное поручение для отмены.');
  const dir = require('./team-store').roots()[who];
  const l = await locks.waitLock(who === 'codex' ? 'codex_job' : 'job', id, { jobId: id }, 8000);
  if (!l.ok) throw Error('Карточка ' + id + ' занята.');
  try {
    const bundle = path.join(dir, id, 'card.json');
    const file = who === 'antigravity' || fs.existsSync(bundle) ? bundle : path.join(dir, id + '.json');
    const j = require('./cards').readCard(file), before = { ...j };
    if (!cancelWaiting(j)) return j;
    if (who === 'antigravity') {
      j.provenance = require('./provenance').forJob(j, 'antigravity');
      j.cancellation = { parent_stop: j.stopUnconfirmed ? 'stop_unconfirmed' : 'unknown', parent_local_status: j.status, delegated_stop: 'unknown' };
      write(file, JSON.stringify(j, null, 1));
    } else write(file, JSON.stringify(j, null, 2));
    require('./notify').transition(who === 'codex' ? 'Codex' : 'Antigravity', before, j);
    return j;
  } finally { await l.release(); }
}

module.exports = { WAITING, cancelWaiting, cancel };
