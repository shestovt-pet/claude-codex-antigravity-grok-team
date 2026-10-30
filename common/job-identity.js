'use strict';
// Участник поручения определяется хранилищем карточки, а не MOST_CLIENT или аргументами вызова.
function currentJob() {
  const id = process.env.MOST_JOB_ID;
  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  try {
    const hits = require('./job-chain').cards().filter(j => j.id === id);
    return hits.length === 1 ? hits[0] : null;
  } catch { return null; }
}
function memberId(client) {
  if (client === 'job' || client === 'claude-print' && process.env.MOST_JOB_ID)
    return currentJob()?.member || null;
  return client === 'claude-print' ? 'claude' : client;
}
module.exports = { currentJob, memberId };
