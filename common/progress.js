'use strict';
function progress(job) {
  const work = job.workName || (typeof job.work === 'string' ? job.work : null);
  if (!work || !/^[a-z0-9-]{1,40}$/.test(work)) return '';
  try {
    const { Team, workText } = require('./team'), t = new Team();
    return workText(t.readWork(t.workFile(work))).split('\n').find(l => l.startsWith('Принято ')) || '';
  } catch { return ''; }
}
async function longRunning(who, jobs, mutate) {
  for (const j of jobs) if (j.status === 'running' && !j.longNotified && Date.now() - Date.parse(j.startedAt) >= 600000) {
    let claimed = false;
    await mutate(j.id, c => { if (c.status !== 'running' || c.longNotified) return false; c.longNotified = true; claimed = true; });
    if (claimed) await require('./notify').notify(`${who} работает над поручением ${j.id} уже 10 мин (работа ${require('./summary').workTitle(j.workName || (typeof j.work === 'string' ? j.work : 'не указана'))})`, progress(j));
  }
}
module.exports = { progress, longRunning };
