'use strict';
// team-v63 (п.5/п.4): общая отметка «лимит участника исчерпан». Карточки квоты несут retryKind==='quota' и lastQuotaAt
// (см. common/quota.retryPlan и адаптеры Kimi/DeepSeek). Отметка «действует», если после неё не было успешного поручения
// и с момента отметки прошло меньше окна (по умолчанию 10 минут): раньше — не запускаем CLI впустую и в сценарии обходим
// участника; позже — окно могло закончиться, пробуем по-настоящему.
const WINDOW_MS = 600000;
// quota-622 (слово пользователя 23.11.2026): «на счёте нет денег» (DeepSeek ACCOUNT_QUOTA / Insufficient Balance). Баланс сам не
// пополняется, поэтому окно отметки долгое — сутки (MOST_BALANCE_WINDOW_MS): всё это время новые поручения получают быстрый
// отказ, а сценарий обходит участника. Снятие — первый успешный ответ (после пополнения: поручение с force: true или resume
// сценария, остановленного по балансу) — или конец окна: раз в сутки одна настоящая попытка, чтобы забытая отметка не
// держала участника вечно после пополнения. Повтора поручений по таймеру нет (пользы нет: деньги не появятся сами).
const BALANCE_WINDOW_MS = 24 * 3600000;
function balanceWindowMs() { const v = Number(process.env.MOST_BALANCE_WINDOW_MS); return Number.isFinite(v) && v > 0 ? v : BALANCE_WINDOW_MS; }

// «Действующая отметка» — карточка, которая ПРЯМО СЕЙЧАС ждёт квоту (status waiting_quota): участник упёрся в лимит и ещё не
// разблокирован. Разрешённые/конечные состояния отметкой не считаются: done — успех, cancelled — снято пользователем,
// failed — попытки исчерпаны/окно кончилось (тогда и пробуем по-настоящему), needs_decision — писатель на решении. Так
// отметка не «залипает» и не блокирует новые поручения после того, как окно кончилось или карточка разрешилась.
function activeMark(j) {
  return !j.archived && j.status === 'waiting_quota';
}
// quota-622: отметка «на счёте нет денег» — карточка с quotaReason 'balance' (новый адаптер DeepSeek) или прежняя упавшая
// карточка, в ошибке которой — диагностика баланса (ACCOUNT_QUOTA / Insufficient Balance; карточки до этой правки).
// Время — lastQuotaAt, иначе finishedAt. Снятое пользователем (cancelled) отметкой не считается.
function balanceMark(j) {
  if (j.archived || j.status === 'cancelled' || j.status === 'done') return null;
  const legacy = j.status === 'failed' && !j.quotaReason && require('./quota').balanceExhausted(j.error);
  if (j.quotaReason !== 'balance' && !legacy) return null;
  const t = Date.parse(j.lastQuotaAt || j.finishedAt || '');
  return Number.isFinite(t) ? t : null;
}
// Последняя действующая отметка исчерпания и был ли после неё успех. jobs — карточки участника (team-store.list(...).jobs).
// kind: 'quota' (окно лимита) или 'balance' (на счёте нет денег) — по самой поздней отметке.
function latest(jobs = []) {
  let at = null, kind = null, successAt = null;
  for (const j of jobs) {
    const q = Date.parse(j.lastQuotaAt || '');
    if (activeMark(j) && Number.isFinite(q) && q > (at || 0)) { at = q; kind = 'quota'; }
    const b = balanceMark(j);
    if (b && b >= (at || 0)) { at = b; kind = 'balance'; }
    const ok = j.status === 'done' && Number.isFinite(Date.parse(j.finishedAt || ''));
    if (ok) successAt = Math.max(successAt || 0, Date.parse(j.finishedAt));
  }
  return { at: at ? new Date(at).toISOString() : null, kind, laterSuccess: !!(at && successAt && successAt >= at) };
}

// Действует ли отметка сейчас. Возвращает { blocked, at, kind, sinceMin }.
function blocked(jobs = [], { windowMs, now = Date.now() } = {}) {
  const l = latest(jobs);
  if (!l.at || l.laterSuccess) return { blocked: false, at: l.at, kind: l.kind };
  const win = windowMs ?? (l.kind === 'balance' ? balanceWindowMs() : WINDOW_MS);
  const since = now - Date.parse(l.at);
  return { blocked: since >= 0 && since < win, at: l.at, kind: l.kind, sinceMin: Math.floor(since / 60000) };
}

// Текст отказа по действующей отметке (для *_send без force). kind 'balance' — «на счёте нет денег».
function refusalText(member, at, kind) {
  const t = new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (kind === 'balance')
    return 'На счёте ' + member + ' нет денег (отметка ' + new Date(at).toLocaleString('ru-RU') + '); пополните счёт и повторите с force: true или отдайте другому.';
  return 'Лимит ' + member + ' исчерпан с ' + t + '; повторите после сброса или отдайте другому (force: true — пробовать всё равно).';
}

// quota-622: строка для сводки team_status о состоянии участника по отметкам (null — отметки нет).
function statusText(jobs = []) {
  const b = blocked(jobs);
  if (!b.blocked) return null;
  const when = new Date(b.at).toLocaleString('ru-RU');
  return b.kind === 'balance' ? 'на счёте нет денег (отметка ' + when + ', снимется первым успешным ответом после пополнения)' : 'лимит исчерпан (отметка ' + when + ')';
}

module.exports = { latest, blocked, refusalText, statusText, balanceMark, WINDOW_MS, BALANCE_WINDOW_MS };
