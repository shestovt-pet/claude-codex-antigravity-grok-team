'use strict';
// team-v63 (п.5/п.4): общая отметка «лимит участника исчерпан». Карточки квоты несут retryKind==='quota' и lastQuotaAt
// (см. common/quota.retryPlan и адаптеры Kimi/DeepSeek). Отметка «действует», если после неё не было успешного поручения
// и с момента отметки прошло меньше окна (по умолчанию 10 минут): раньше — не запускаем CLI впустую и в сценарии обходим
// участника; позже — окно могло закончиться, пробуем по-настоящему.
const WINDOW_MS = 600000;

// «Действующая отметка» — карточка, которая ПРЯМО СЕЙЧАС ждёт квоту (status waiting_quota): участник упёрся в лимит и ещё не
// разблокирован. Разрешённые/конечные состояния отметкой не считаются: done — успех, cancelled — снято пользователем,
// failed — попытки исчерпаны/окно кончилось (тогда и пробуем по-настоящему), needs_decision — писатель на решении. Так
// отметка не «залипает» и не блокирует новые поручения после того, как окно кончилось или карточка разрешилась.
function activeMark(j) {
  return !j.archived && j.status === 'waiting_quota';
}
// Последняя действующая отметка исчерпания и был ли после неё успех. jobs — карточки участника (team-store.list(...).jobs).
function latest(jobs = []) {
  let at = null, successAt = null;
  for (const j of jobs) {
    const q = Date.parse(j.lastQuotaAt || '');
    if (activeMark(j) && Number.isFinite(q)) at = Math.max(at || 0, q);
    const ok = j.status === 'done' && Number.isFinite(Date.parse(j.finishedAt || ''));
    if (ok) successAt = Math.max(successAt || 0, Date.parse(j.finishedAt));
  }
  return { at: at ? new Date(at).toISOString() : null, laterSuccess: !!(at && successAt && successAt >= at) };
}

// Действует ли отметка сейчас. Возвращает { blocked, at, sinceMin }.
function blocked(jobs = [], { windowMs = WINDOW_MS, now = Date.now() } = {}) {
  const l = latest(jobs);
  if (!l.at || l.laterSuccess) return { blocked: false, at: l.at };
  const since = now - Date.parse(l.at);
  return { blocked: since >= 0 && since < windowMs, at: l.at, sinceMin: Math.floor(since / 60000) };
}

// Текст отказа по действующей отметке (для *_send без force).
function refusalText(member, at) {
  const t = new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return 'Лимит ' + member + ' исчерпан с ' + t + '; повторите после сброса или отдайте другому (force: true — пробовать всё равно).';
}

module.exports = { latest, blocked, refusalText, WINDOW_MS };
