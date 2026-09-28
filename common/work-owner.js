'use strict';
const fs = require('fs'), path = require('path');
const { repoRoot } = require('./paths');
const { inside, name, atomic } = require('./team-git');

function check(work, owner) {
  if (work.owner && work.owner !== owner) {
    throw Error('владение передано ' + work.owner + ' ' +
      (work.claimed_at || work.created_at || '') + ' — остановитесь');
  }
}

function touch(workName, owner, root = repoRoot) {
  const file = inside(root, 'works', name(workName) + '.json');
  const work = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(work, owner);
  // Карточки прежних выпусков получают владельца при первом вызове с меткой сеанса.
  work.owner ||= owner || null;
  work.heartbeat_at = new Date().toISOString();
  atomic(file, JSON.stringify(work, null, 2) + '\n');
  return work;
}

// Проверка и действие держат один замок с claim: передача между ними невозможна.
async function withWork(args, action, root = repoRoot) {
  if (!args.work) return action();
  return require('./deploy').locked(root, async () => {
    touch(args.work, args.owner, root);
    return action();
  });
}

function reminder(root = repoRoot, now = Date.now(), scope = require('./request-context').context.getStore() || {}) {
  const dir = path.join(root, 'works');
  const overdue = [];
  if (!fs.existsSync(dir)) return '';
  for (const entry of fs.readdirSync(dir)) {
    if (!/^[a-z0-9-]{1,40}\.json$/.test(entry)) continue;
    try {
      const w = JSON.parse(fs.readFileSync(inside(root, 'works', entry), 'utf8'));
      if (scope.owner && w.owner !== scope.owner) continue;
      if (scope.work && (w.name || entry.slice(0, -5)) !== scope.work) continue;
      if (!w.stages?.some(s => s.state !== 'принят')) continue;
      const at = Date.parse(w.status_sent_at || w.created_at || w.updated_at);
      const minutes = Math.floor((now - at) / 60000);
      if (Number.isFinite(at) && minutes >= 15) overdue.push({ w, minutes, name: entry.slice(0, -5) });
    } catch { /* Повреждённую карточку отдельно показывает team_status. */ }
  }
  return overdue.map(({ w, minutes, name }) => '⚠ Статус пользователю не отправлялся ' + minutes +
    ' мин — отправьте строку прогресса · работа ' + (w.title || w.name || name) +
    ' · владелец ' + (w.owner || 'не указан')).join('\n');
}

async function reconcileJobs(workName) {
  const stores = require('./team-store'), locks = require('./locks');
  for (const who of ['codex', 'antigravity']) {
    const { jobs, errors } = stores.list(who, false);
    if (errors.length) throw Error('Нельзя проверить поручения работы: ' + errors.join('; '));
    for (const job of jobs) {
      if ((job.workName || job.work) !== workName ||
          !['running', 'cancelling', 'stop_unconfirmed'].includes(job.status)) continue;
      const lock = await locks.waitLock(who === 'codex' ? 'codex_job' : 'job', job.id, { jobId: job.id }, 8000);
      if (!lock.ok) throw Error('Карточка поручения занята.');
      try {
        const card = JSON.parse(fs.readFileSync(job.cardFile, 'utf8'));
        if (!['running', 'cancelling', 'stop_unconfirmed'].includes(card.status) ||
            await locks.ownerState(card.owner) !== 'dead') continue;
        card.status = 'lost';
        card.error = 'Владелец завершился. Поручение потеряно; проверьте частичный результат.';
        card.finishedAt = new Date().toISOString();
        atomic(job.cardFile, JSON.stringify(card, null, 2));
      } finally { await lock.release(); }
    }
  }
}

function hasLiveJobs(workName) {
  const stores = require('./team-store');
  for (const who of ['codex', 'antigravity', 'grok']) {
    const { jobs, errors } = stores.list(who, false);
    if (errors.length) throw Error('Нельзя проверить поручения работы: ' + errors.join('; '));
    if (jobs.some(j => (j.workName || j.work) === workName &&
      ['running', 'queued', 'waiting_quota', 'delivery_unclear', 'cancelling',
        'stop_unconfirmed', 'migration_conflict'].includes(j.status))) return true;
  }
  return false;
}
module.exports = { check, touch, withWork, reminder, reconcileJobs, hasLiveJobs };
