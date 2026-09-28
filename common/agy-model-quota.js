'use strict';
const { createHash } = require('crypto');
const { modelQuota } = require('./agy-quota');
const { retryPlan } = require('./quota');
const configs = snapshot => snapshot?.data?.userStatus?.cascadeModelConfigData;
const models = snapshot => Array.isArray(configs(snapshot)?.clientModelConfigs) ? configs(snapshot).clientModelConfigs : [];
const unique = rows => rows.length === 1 ? rows[0] : null;
function account(snapshot) {
  const email = snapshot?.accountEmail, source = snapshot?.data?.userStatus?.email;
  if (typeof email !== 'string' || !email || typeof source !== 'string' || email.toLowerCase() !== source.toLowerCase()) return null;
  return createHash('sha256').update(email.toLowerCase()).digest('hex');
}
function matchingConfig(snapshot, cli) {
  if (!cli) return null;
  return unique(models(snapshot).filter(m => m && (m.label === cli.name || m.modelOrAlias?.model === cli.id || m.modelOrAlias?.alias === cli.id)));
}
function selectModel(requested, snapshot, list) {
  const want = String(requested || '').trim();
  let cli;
  if (want) {
    cli = unique(list.filter(m => m.id === want || m.name === want));
    if (list.length && !cli) return { error: 'Модели «' + want + '» нет в списке или соответствие неоднозначно. Доступны: ' + list.map(m => m.id).join(', ') };
    cli ||= { id: want };
  } else if (account(snapshot)) {
    // Настройка по умолчанию принадлежит аккаунту приложения: без сверки её не используем.
    const ref = configs(snapshot)?.defaultOverrideModelConfig?.modelOrAlias;
    const config = ref && unique(models(snapshot).filter(m => m && (
      (ref.model != null && m.modelOrAlias?.model === ref.model) || (ref.alias != null && m.modelOrAlias?.alias === ref.alias))));
    if (config) cli = unique(list.filter(m => matchingConfig(snapshot, m) === config));
  }
  return { id: cli?.id || null, name: cli?.name, account: account(snapshot),
    warning: !cli ? 'модель неизвестна: точное время сброса определить нельзя' : !list.length ? 'список моделей получить не удалось; модель передана как есть и не проверена' : null };
}
function modelFields(selection) {
  return { modelId: selection.id, modelAccount: selection.account || null,
    model: selection.id ? selection.id + (selection.name ? ' (' + selection.name + ')' : '') : 'неизвестна',
    modelWarning: selection.warning || null };
}
function quotaRetry(job, failure, snapshot, list, now = Date.now()) {
  const trusted = job.modelId && job.modelAccount && job.modelAccount === account(snapshot);
  const cli = trusted && unique(list.filter(m => m.id === job.modelId));
  const model = cli && matchingConfig(snapshot, cli), q = modelQuota(model?.quotaInfo);
  let resetsAt = null, pastResetProbe = job.pastResetProbe || false, early = false;
  if (q) {
    const reset = Date.parse(q.resetTime);
    if (reset > now) resetsAt = new Date(reset + 60000).toISOString();
    else if (!pastResetProbe) { early = true; pastResetProbe = true; }
  }
  const plan = retryPlan(job, { ...failure, resetsAt });
  if (early && plan.status === 'waiting_quota') plan.nextAttemptAt = new Date(now + 90000).toISOString();
  const free = trusted ? models(snapshot).filter(m => m !== model && typeof m?.label === 'string' && modelQuota(m.quotaInfo)?.remainingFraction > 0).map(m => m.label) : [];
  const current = q ? model.label + ': сброс ' + new Date(q.resetTime).toLocaleString('ru-RU') : 'Время сброса своей модели неизвестно';
  return { ...plan, pastResetProbe, quotaResetTime: q?.resetTime || null,
    quotaAdvice: current + '. ' + (free.length ? 'Свободные модели Antigravity: ' + free.join(', ') + '.' : 'Свободные модели Antigravity не подтверждены.') + ' Автоматической смены модели нет; решение принимает Claude.' };
}
module.exports = { selectModel, modelFields, quotaRetry };
