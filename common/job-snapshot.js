'use strict';
// Один экземпляр на запрос. Материалы и результаты поручений не кэшируются.
const stores = require('./team-store');
function create() {
  const helpers = new Map(), owners = new Map();
  for (const who of require('./members').helpers) {
    const entries = stores.scan(who), index = new Map();
    for (const entry of entries) for (const job of entry.jobs) {
      if (!index.has(job.id)) index.set(job.id, new Map());
      const byArchive = index.get(job.id);
      // Как прежний find: при повторе номера берётся первая карточка.
      if (!byArchive.has(entry.archived)) byArchive.set(entry.archived, job);
    }
    helpers.set(who, { entries, index });
  }
  function helper(who) {
    const value = helpers.get(who);
    if (!value) throw Error('Помощник отсутствует в снимке: ' + who);
    return value;
  }
  return {
    list(who, includeArchive = true) { return stores.listing(helper(who).entries, includeArchive); },
    get(who, id, archived = false) { return helper(who).index.get(id)?.get(archived); },
    ownerState(owner) {
      const key = JSON.stringify([owner?.instance, owner?.pid, owner?.startedAt]);
      if (!owners.has(key)) owners.set(key, Promise.resolve().then(() => require('./locks').ownerState(owner)));
      return owners.get(key);
    },
  };
}
module.exports = { create };
