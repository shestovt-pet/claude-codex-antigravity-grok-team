'use strict';
// Прямое чтение именно состояния установки, без окружения сервера и без восстановления карточек.
const fs = require('fs'), path = require('path');
async function running({ stateDir }) {
  if (!stateDir) throw Error('Не задан каталог состояния для проверки поручений.');
  const result = [];
  for (const [who, sub] of [['codex', 'codex-jobs'], ['antigravity', 'jobs']]) {
    const dir = path.join(stateDir, sub);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') continue; throw Error('Не удалось проверить поручения: ' + dir + ': ' + e.message); }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.includes('.conflict-') || entry.name.endsWith('.tmp')) continue;
      if (!entry.isDirectory() && !entry.name.endsWith('.json')) continue;
      const file = path.join(dir, entry.name, ...(entry.isDirectory() ? ['card.json'] : []));
      let j;
      try { j = JSON.parse(fs.readFileSync(file).toString('utf8').replace(/^\uFEFF/, '')); if (!j || typeof j !== 'object') throw Error('неверная карточка'); }
      catch (e) { throw Error('Не удалось проверить поручения: ' + file + ': ' + e.message); }
      const active = who === 'codex' ? ['running', 'cancelling', 'cancel_requested'] : ['running', 'applying'];
      if (!active.includes(j.status) && j.status !== 'stop_unconfirmed' && !j.stopUnconfirmed) continue;
      const owner = who === 'antigravity' && j.status === 'applying' ? j.apply?.owner : j.owner;
      if (await require('./locks').ownerState(owner, stateDir) === 'dead') continue;
      result.push({ who, id: String(j.id || entry.name).slice(0, 8), folder: j.folder || j.cwd || j.papka || 'не указана',
        duration: require('./format').duration(Date.now() - Date.parse(j.startedAt || j.createdAt || new Date())),
        from: j.from || j.sender || 'не указан', work: j.workName || (typeof j.work === 'string' && j.work) || 'не указана' });
    }
  }
  return result;
}
function describe(jobs) {
  return jobs.map(j => `${j.who} ${j.id}, папка ${j.folder}, идёт ${j.duration}, отправитель ${j.from}, работа ${j.work}`).join('; ');
}
module.exports = { running, describe };
