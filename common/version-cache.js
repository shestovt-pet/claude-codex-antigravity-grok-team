'use strict';
// Проверка по обращению; неудачный результат тоже имеет срок годности.
module.exports = function versionCache(probe, now = Date.now, override = () => process.env.MOST_DSH_VERSION) {
  let value, lastAt = null;
  return function version() {
    const forced = override();
    if (forced) return forced;
    const age = lastAt === null ? null : now() - lastAt;
    if (age !== null && age >= 0 && age <= 60000) return value;
    try { value = probe(); } catch { value = null; }
    lastAt = now();
    return value;
  };
};
