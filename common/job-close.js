'use strict';
// Закрытие карточек «нужно решение» словом пользователя (team-v44 П1): status=cancelled + closedByWord.
// Изменения в папке поручения не откатываются: закрытие — только «решение принято, продолжать не нужно».
const path = require('path');
const live = require('./live-jobs'), locks = require('./locks'), words = require('./user-word');
const stop = require('./stop-confirm');
const { stateDir, isInsideReal } = require('./paths');
const kinds = { 'kimi-jobs': 'kimi_job', 'codex-jobs': 'codex_job', 'deepseek-jobs': 'deepseek_job', 'claude-jobs': 'claude_job', jobs: 'job', 'grok-jobs': 'grok_job' };
const queueKinds = { 'kimi-jobs': 'kimi_queue', 'codex-jobs': 'codex_queue', 'deepseek-jobs': 'deepseek_queue', 'claude-jobs': 'claude_queue' };
const MAY = 'можно', ALREADY = 'уже закрыто словом', NOTHING = 'нечего закрывать', FORCED = 'закрывается словом владельца';
const CONFIRMED = 'уже подтверждено; результат сохранён';
function authority() {
  // team-v58 (task10 а): закрытие словом записывает ТОЛЬКО доказанный чат участника (chatSession). Признак поручения — первым;
  // сеанс без доказанного происхождения (подмена MOST_CLIENT, сброс MOST_JOB_ID) прав чата не имеет и слово не пишет.
  const acc = require('./access');
  if (acc.jobSession())
    throw Error('Закрытие словом записывает чат участника; из поручения запрещено.');
  if (!acc.chatSession())
    throw Error('Закрытие словом записывает доказанный чат участника; происхождение чата не доказано: ' + acc.chatOriginReason() + '.');
}
function outcome(j) {
  if (stop.completed.includes(j.status)) return j.stopUnconfirmed ? MAY : j.stopConfirmed ? CONFIRMED : NOTHING;
  if (j.closedByWord) return j.stopUnconfirmed ? MAY : ALREADY;
  if (stop.settling.includes(j.status) || j.status === 'needs_decision' || (j.status === 'stop_unconfirmed' && j.write === true)) return MAY;
  return NOTHING;
}
const report = rows => rows.map(r => r.input + ': ' + r.outcome).join('\n');
async function run(a) {
  authority();
  if (typeof a.quote !== 'string' || !a.quote.trim()) throw Error('Нужно слово пользователя дословно (quote).');
  if (!Array.isArray(a.job_ids) || !a.job_ids.length || a.job_ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)))
    throw Error('job_ids: нужны полные номера или префиксы от 8 знаков.');
  // Ошибка любого хранилища останавливает вызов, в том числе если нужная карточка уже найдена.
  const cards = live.cards({ stateDir, strictStores: true }), rows = a.job_ids.map(input => {
    const found = cards.filter(c => typeof c.j.id === 'string' && c.j.id.startsWith(input));
    return { input, card: found.length === 1 ? found[0] : null, outcome: found.length ? 'неоднозначно' : 'не найдено' };
  });
  const selected = [...new Map(rows.filter(r => r.card).map(r => [r.card.file, r.card])).values()]
    .sort((a, b) => a.store.localeCompare(b.store) || a.j.id.localeCompare(b.j.id));
  if (!selected.length) return report(rows) + '\nНичего не записано: набор не прошёл проверку.';
  const held = [];
  try {
    for (const c of selected) {
      const kind = kinds[c.store];
      if (!kind) throw Error('Неизвестный замок хранилища: ' + c.store);
      const queueKind = queueKinds[c.store];
      if (queueKind) {
        const queueLock = await locks.tryLock(queueKind, c.j.id, { jobId: c.j.id });
        if (!queueLock.ok) throw Error('поручение продолжается — повторите позже');
        held.push(queueLock);
      }
      const lock = await locks.waitLock(kind, c.j.id, { jobId: c.j.id }, 8000);
      if (!lock.ok) throw Error('Карточка поручения занята: ' + c.j.id);
      held.push(lock);
    }
    // Список процессов и карточки перечитываются только после захвата всего набора.
    for (const c of selected) {
      if (!isInsideReal(c.file, path.join(stateDir, c.store))) throw Error('Карточка вне хранилища.');
      const j = require('./cards').readCard(c.file);
      if (j.id !== c.j.id) throw Error('Номер карточки изменился во время проверки.');
      c.j = j;
    }
    // team-v61 (Codex №2): ОТКАЗ команды снимка (CIM/powershell бросил) не блокирует закрытие словом владельца — snapshot=null
    // даёт решаемый отказ, слово перекрывает его, риск называется (forcedNote). НЕполный/противоречивый ВОЗВРАЩЁННЫЙ снимок
    // (snapshotInvalid) по-прежнему останавливает набор.
    let snapshot = null;
    try { snapshot = await stop.processSnapshot(); } catch (e) { if (e.snapshotInvalid) throw e; snapshot = null; }
    for (const c of selected) {
      c.check = await stop.checkStopped(c.j, snapshot);
      // team-v59: слово владельца перекрывает отказ по аливости процесса/владельца и по статусу running/queued/cancelling —
      // карточка закрывается словом. Данные-состояния (конфликт миграции, незавершённый перенос) словом не снимаются.
      c.forced = stop.overridable(c.check.reason);
      c.outcome = c.forced ? FORCED : (c.check.reason || outcome(c.j));
    }
    for (const r of rows) if (r.card) r.outcome = selected.find(c => c.file === r.card.file).outcome;
    if (rows.some(r => !r.card || r.outcome === NOTHING) || selected.some(c => c.check.reason && !c.forced)) return report(rows) + '\nНичего не записано: набор не прошёл проверку.';
    const writable = selected.filter(c => c.outcome === MAY || c.forced);
    for (const c of selected.filter(c => [ALREADY, CONFIRMED].includes(c.outcome))) require('./write-lock').releaseConfirmed(c.j);
    if (!writable.length) return report(rows);
    authority();
    const ids = selected.map(c => c.j.id);
    const notes = [];
    return await words.recordJobClose(ids, a.quote, async word => {
      for (const c of writable) {
        const prev = c.j;
        const closed = { basis: 'слово пользователя', quote: a.quote, word_id: word.id, at: word.at,
          prev_status: prev.status, prev_stopUnconfirmed: prev.stopUnconfirmed ?? null,
          prev_stopConfirmed: prev.stopConfirmed ?? null, pids: live.cardPids(prev) };
        const next = { ...prev, stopConfirmed: stop.confirmation(prev, word, a.quote, c.check.evidence) };
        if (!stop.completed.includes(prev.status)) {
          next.status = 'cancelled'; next.closedByWord = closed;
          if (stop.settling.includes(prev.status) || c.forced && stop.STOPPABLE.includes(prev.status)) next.prev_status = prev.status;
        }
        delete next.stopUnconfirmed;
        try { require('./team-git').atomic(c.file, JSON.stringify(next, null, 2) + '\n'); }
        catch (e) {
          // П1 п. 6: ответ называет закрытые и оставшиеся номера набора и слово.
          for (const r of rows) if (r.outcome === MAY || r.outcome === FORCED) r.outcome = r.card.file === c.file ? 'сбой записи' : 'не закрыто';
          throw Error('Сбой записи карточки ' + c.j.id + ': ' + e.message + '.\n' + report(rows) + '\nСлово: ' + word.id + ' сохранено. Повторите тот же вызов: закрытые останутся, оставшиеся дозакроются тем же словом.');
        }
        require('./write-lock').releaseConfirmed(next);
        for (const r of rows) if (r.card.file === c.file) r.outcome = stop.completed.includes(prev.status) ? 'остановка подтверждена; результат сохранён' : c.forced ? 'закрыто словом владельца' : 'закрыто';
        if (c.forced) notes.push(stop.forcedNote(prev));
      }
      return report(rows) + '\nСлово: ' + word.id + (notes.length ? '\n' + notes.join('\n') : '') + '\nИзменения в папке поручения не откатываются: закрытие означает «решение принято, продолжать не нужно».';
    });
  } finally {
    for (const lock of held.reverse()) await lock.release();
  }
}
module.exports = { run };
