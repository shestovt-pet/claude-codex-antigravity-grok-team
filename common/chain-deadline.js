'use strict';
// team-v46 п.5а: сроки в цепочке поручений. Срок ребёнка = min(обычный срок получателя,
// остаток срока родителя − 3 мин). Deadline — абсолютное время в карточке; ожидание в очереди его не сдвигает.
const PARENT_MARGIN_MS = 3 * 60 * 1000;

function normalTimeoutMs() {
  // team-v48e «нет срока» (§2.6): срок поручения отсутствует безусловно — сроковые тумблеры MOST_*_TIMEOUT_MS/MOST_PRINT_TIMEOUT/
  // MOST_WATCHDOG_MS удалены, функция всегда возвращает null (таймер-убийца не создаётся). deadline, уже записанный в карточке,
  // по-прежнему соблюдается через deadlinePassed/runtimeBudget (это данные карточки, а не тумблер возврата).
  return null;
}

// Оставшийся срок родителя: его deadline (если сам был ребёнком) либо обычный срок − прошедшее с запуска.
function parentRemainingMs(parent, parentServer, now = Date.now()) {
  if (!parent) return null;
  const deadline = Date.parse(parent.deadline);
  if (Number.isFinite(deadline)) return deadline - now;
  const normal = normalTimeoutMs(parentServer);
  const started = Date.parse(parent.startedAt);
  if (normal == null || !Number.isFinite(started)) return null;
  return normal - (now - started);
}

// Срок ребёнка в миллисекундах от now. Отказ, если остаток родителя ≤ 3 мин (ровно 3 мин — тоже отказ).
function childBudget(parent, parentServer, childServer, now = Date.now()) {
  const remaining = parentRemainingMs(parent, parentServer, now);
  const normal = normalTimeoutMs(childServer);
  let budget = normal;
  if (remaining != null) {
    const fromParent = remaining - PARENT_MARGIN_MS;
    budget = budget == null ? fromParent : Math.min(budget, fromParent);
  }
  if (budget == null) return null;
  if (budget <= 0) throw Error('у родителя не хватает времени (остаток ≤ 3 мин)');
  return budget;
}

function childDeadline(parent, parentServer, childServer, now = Date.now()) {
  try {
    const budget = childBudget(parent, parentServer, childServer, now);
    return { deadline: budget == null ? null : new Date(now + budget).toISOString(), error: null };
  } catch (e) { return { deadline: null, error: e.message }; }
}

// Родитель ребёнка: карточка из хранилища отправителя (клиента).
function parentCard(fields, client) {
  if (!fields?.parentJob) return null;
  try { return require('./team-store').list(require('./job-identity').memberId(client), false).jobs.find(j => j.id === fields.parentJob) || null; }
  catch { return null; }
}

// Для сервера-получателя: срок ребёнка из полей цепочки и карточки родителя.
function applyDeadline(fields, client, server, now = Date.now()) {
  if (!fields?.parentJob) return childDeadline(null, null, server, now);
  const parent = parentCard(fields, client);
  if (!parent) return { deadline: null, error: 'Не найден родитель для расчёта срока поручения.' };
  return childDeadline(parent, require('./job-identity').memberId(client), server, now);
}

// Срок ребёнка прошёл (например в очереди) — отмена без запуска.
function deadlinePassed(card, now = Date.now()) {
  const deadline = Date.parse(card?.deadline);
  return Number.isFinite(deadline) && deadline <= now;
}
function runtimeBudget(card, server, now = Date.now()) {
  const deadline = Date.parse(card?.deadline);
  return Number.isFinite(deadline) ? Math.max(0, deadline - now) : normalTimeoutMs(server);
}

// Родитель ребёнка в конечном состоянии (team-v46 п.8): идущие дети останавливаются межпроцессно.
const PARENT_TERMINAL = ['done', 'failed', 'cancelled', 'lost', 'needs_decision', 'applied'];
function parentTerminal(card, all) {
  const parentId = card?.parentJob;
  if (!parentId) return false;
  let list;
  try { list = all || require('./job-chain').cards(); } catch { return false; }
  const hits = list.filter(j => j.id === parentId);
  if (hits.length !== 1) return true;
  const parent = hits[0];
  if (PARENT_TERMINAL.includes(parent.status)) return true;
  if (['cancelling', 'stop_unconfirmed', 'cancel_requested'].includes(parent.status)) return true;
  const pid = parent.childPid || parent.agyPid;
  if (!Number.isInteger(pid)) return false; // карточка ещё не зафиксировала запуск
  try {
    const process = require('./fallback').processTable().find(p => p.pid === pid);
    if (!process) return true;
    const expected = Date.parse(parent.childStartedAt || parent.agyStartedAt), actual = Date.parse(process.startedAt);
    return Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) > 10000;
  } catch { return false; }
}

// Осталось до срока родителя (для <T>_result): «осталось до срока родителя».
function remainingText(card, now = Date.now()) {
  const deadline = Date.parse(card?.deadline);
  if (!Number.isFinite(deadline)) return '';
  const left = deadline - now;
  if (left <= 0) return 'осталось до срока родителя: истёк';
  const s = Math.max(0, Math.floor(left / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return 'осталось до срока родителя: ' + [h ? h + ' ч' : '', m ? m + ' мин' : '', sec + ' с'].filter(Boolean).join(' ');
}

module.exports = { PARENT_MARGIN_MS, normalTimeoutMs, parentRemainingMs, childBudget, childDeadline, parentCard, applyDeadline, deadlinePassed, runtimeBudget, remainingText, parentTerminal };
