'use strict';
const fs = require('fs'), path = require('path');
function claudeText(q) {
  if (!q) return 'процент пятичасового лимита не виден; замер не предоставлен';
  if (q.calls !== undefined) return `замер сеанса (не процент лимита): ${q.calls} обращений, перечитано ${(q.reread / 1e6).toLocaleString('ru-RU', {maximumFractionDigits: 1})} млн, написано ${(q.written / 1e6).toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 2})} млн за ${q.window_h} ч · ${q.source}, ${q.taken_at}`;
  return `использовано ${q.percent} %, сброс ${q.resets_at || 'данные не предоставлены'} · ${q.source}, ${q.taken_at}`;
}
async function quotaLine({ state = path.join(require('./paths').stateDir, 'team'), binary, codex, advice = false, agyModel } = {}) {
  let claude;
  try { claude = claudeText(JSON.parse(fs.readFileSync(path.join(state, 'claude-quota.json'), 'utf8'))); }
  catch (e) { claude = e.code === 'ENOENT' ? 'процент пятичасового лимита не виден; замер не предоставлен' : 'ошибка чтения снимка'; }
  const q = require('./quota');
  const [c, a] = await Promise.all([Promise.resolve().then(() => codex || (binary ? q.codexQuota(binary) : q.rollout() || { source: 'данные не предоставлены' })).catch(e => ({source:'ошибка источника квоты', error:e.message})), require('./agy-quota').agySnapshot()]);
  const line = 'Квоты: Claude — ' + claude + '; Codex — ' + (c.error || q.quotaText(c).replace(/\n/g, ', ')) + '; Antigravity — ' + a.text + ' · снимок ' + new Date().toLocaleString('ru-RU');
  return line + (advice ? '\n' + require('./quota-advice').codexAdvice(c) + '\n' + require('./quota-advice').agyAdvice(a, agyModel) + '\nGrok: квота не видна' : '');
}
module.exports = { quotaLine, claudeText };
