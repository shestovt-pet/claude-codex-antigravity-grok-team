'use strict';
function codexAdvice(snapshot) {
  const used = snapshot?.weekly?.used_percent;
  if (!Number.isFinite(used) || used < 0 || used > 100 || snapshot.error) return 'Codex: остаток недели не виден';
  const advice = used >= 80 ? 'только обязательные голоса и блокирующие правки'
    : used >= 50 ? 'только обсуждение, итоговое ревью и код' : 'обычное распределение';
  return 'Codex: использовано ' + used + ' % недели — ' + advice + ' · ' + (snapshot.source || 'источник не указан');
}
function agyAdvice(snapshot, selected) {
  const config = snapshot?.data?.userStatus?.cascadeModelConfigData;
  const models = Array.isArray(config?.clientModelConfigs) ? config.clientModelConfigs : [];
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
  const requested = selected && selected !== 'по умолчанию' ? selected : null;
  const model = requested
    ? models.find(m => [m.label, m.modelOrAlias?.model, m.modelOrAlias?.alias].some(v => v != null && normalize(v) === normalize(requested)))
    : models.find(m => m.modelOrAlias?.model != null && m.modelOrAlias.model === config?.defaultOverrideModelConfig?.modelOrAlias?.model);
  const q = require('./agy-quota').modelQuota(model?.quotaInfo), remaining = q?.remainingFraction;
  const label = model?.label || requested || 'модель по умолчанию';
  if (model && !q) return 'Antigravity (' + label + '): формат ответа изменился';
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > 1 || !Number.isFinite(Date.parse(q?.resetTime)) || /аккаунт agy не совпадает/.test(snapshot?.text || ''))
    return 'Antigravity (' + label + '): остаток 5 ч не виден';
  const reset = new Date(q.resetTime).toLocaleString('ru-RU');
  const advice = remaining < .1 ? 'только обязательные голоса'
    : remaining < .2 ? 'новые крупные тексты отложить до сброса ' + reset
    : remaining < .35 ? 'предупреждение: запас квоты меньше 35 %' : 'обычное распределение';
  return 'Antigravity (' + label + '): осталось ' + Math.round(remaining * 100) + ' % за 5 ч — ' + advice + ' · сброс ' + reset + ' · приложение Antigravity';
}
module.exports = { codexAdvice, agyAdvice };
