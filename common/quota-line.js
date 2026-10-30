'use strict';
const fs = require('fs'), path = require('path');
function claudeText(q) {
  if (!q) return 'данные не предоставлены; процент пятичасового лимита не виден';
  if (q.calls !== undefined) return `замер сеанса (не процент лимита): ${q.calls} обращений, перечитано ${(q.reread / 1e6).toLocaleString('ru-RU', {maximumFractionDigits: 1})} млн, написано ${(q.written / 1e6).toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 2})} млн за ${q.window_h} ч · ${q.source}, ${q.taken_at}`;
  return `использовано ${q.percent} %, сброс ${q.resets_at || 'данные не предоставлены'} · ${q.source}, ${q.taken_at}`;
}
// team-v46 п.6: Claude-исполнитель — отдельный сеанс; счётчик поручений за 5 ч и сутки (счётчик расхода, не квота провайдера).
function claudeExecutorText(state = path.join(require('./paths').stateDir, 'team')) {
  const count = ms => { try { return require('./team-store').list('claude', false).jobs.filter(j => Date.parse(j.startedAt) > Date.now() - ms).length; } catch { return null; } };
  const h5 = count(5 * 3600000), d24 = count(24 * 3600000);
  return 'поручений за 5 ч: ' + (h5 == null ? 'не видно' : h5) + ', за сутки: ' + (d24 == null ? 'не видно' : d24) + ' (счётчик расхода, не квота провайдера)';
}
function claudeExecutorRow(state = path.join(require('./paths').stateDir, 'team')) {
  const m = require('./members').active().find(x => x.adapter === 'claude-print');
  if (!m) return '';
  return require('./members').executorTitle(m) + ' — ' + claudeExecutorText(state);
}
async function quotaLine({ state = path.join(require('./paths').stateDir, 'team'), binary, codex, advice = false, agyModel, executor = true } = {}) {
  let claude;
  try { claude = claudeText(JSON.parse(fs.readFileSync(path.join(state, 'claude-quota.json'), 'utf8'))); }
  catch (e) { claude = e.code === 'ENOENT' ? 'данные не предоставлены; процент пятичасового лимита не виден' : 'данные не предоставлены: ошибка чтения снимка'; }
  const q = require('./quota');
  const [c, a] = await Promise.all([Promise.resolve().then(() => codex || (binary ? q.codexQuota(binary) : q.rollout() || { source: 'данные не предоставлены' })).catch(e => ({source:'ошибка источника квоты', error:e.message})), require('./agy-quota').agySnapshot()]);
  const registry = require('./members');
  const texts = {
    'claude-print': (claude.includes('данные не предоставлены') ? '' : 'семья anthropic · ') + claude,
    'codex-cli': (c.all?.length || c.five_hour || c.weekly ? 'семья openai · ' : '') + (c.error ? 'данные не предоставлены: ' + c.error : q.quotaText(c).replace(/\n/g, ', ')),
    'agy-cli': a.data ? a.text : 'данные не предоставлены: ' + a.text,
  };
  const rows = registry.active().flatMap(m => {
    if (m.adapter !== 'claude-print') return [m.title + ' — ' + (texts[m.adapter] || 'источник квоты не подключён (А)')];
    const base = [m.title + ' Desktop (отдельно от Claude через Antigravity) — ' + texts['claude-print']];
    // team-v46: исполнитель — отдельный сеанс; в плотной строке квот подпись сокращена (полная — в заголовке «Участники»).
    if (executor) base.push('Claude-исполнитель — ' + claudeExecutorText(state));
    return base;
  });
  const line = 'Квоты: ' + rows.join('; ') + ' · Квота не удостоверяет модель ответа · снимок ' + new Date().toLocaleString('ru-RU');
  return line + (advice ? '\n' + require('./quota-advice').codexAdvice(c) + '\n' + require('./quota-advice').agyAdvice(a, agyModel) : '');
}
module.exports = { quotaLine, claudeText, claudeExecutorText, claudeExecutorRow };
