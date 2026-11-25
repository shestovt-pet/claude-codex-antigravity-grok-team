'use strict';
// install-gate-simple (ревью Codex п.6): штатная процедура восстановления карточки Antigravity — одна на адаптер
// (servers/antigravity normalizeJob и сбой фиксации итога) и уборку мёртвых поручений (common/dead-jobs). Результат
// считается зафиксированным, только если в папке задания есть meta.json и result.txt и sha256(result.txt) === meta.hash.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function committedMeta(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const text = fs.readFileSync(path.join(dir, 'result.txt'), 'utf8');
    return meta && typeof meta.hash === 'string' && sha(text) === meta.hash ? meta : null;
  } catch { return null; }
}
// Поля карточки «готово» по зафиксированному результату — те же, что ставит адаптер.
function recoveredFields(meta, cur, note) {
  return { status: 'done', resultHash: meta.hash, words: meta.words, warnings: meta.warnings || [], problems: [],
    finishedAt: meta.finishedAt, durationSec: meta.durationSec, usage: meta.usage || null,
    provenance: meta.provenance || require('./provenance').forJob(cur, 'antigravity'), draftStatus: 'not_attempted', recovered: note };
}
module.exports = { committedMeta, recoveredFields, sha };
