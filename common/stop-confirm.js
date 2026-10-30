'use strict';
// Подтверждение человеком не заменяет отмену работающего поручения.
const fs = require('fs'), path = require('path');
const live = require('./live-jobs'), locks = require('./locks'), words = require('./user-word');
const { stateDir, isInsideReal } = require('./paths');
const kinds = { 'codex-jobs': 'codex_job', 'deepseek-jobs': 'deepseek_job', 'claude-jobs': 'claude_job', jobs: 'job', 'grok-jobs': 'grok_job' };
const MAY = 'можно', ALREADY = 'уже подтверждено', NOTHING = 'нечего подтверждать';
const BUSY = 'ещё может работать — сначала отмена';
function authority() {
  const access = require('./access');
  if (process.env.MOST_JOB_ID || access.client() !== 'claude' || access.guest() || words.mode().active)
    throw Error('Подтверждение остановки разрешено только чату Claude в основном режиме; из гостя и поручения запрещено.');
}
async function outcome(j, pids) {
  if (['running', 'queued', 'waiting_quota', 'delivery_unclear', 'migration_conflict', 'cancelling', 'cancel_requested', 'applying'].includes(j.status) ||
      await locks.ownerState(j.owner) !== 'dead' ||
      j.apply?.owner && await locks.ownerState(j.apply.owner) !== 'dead' ||
      live.cardPids(j).some(pid => pids.has(pid))) return BUSY;
  if (j.stopConfirmed) return ALREADY;
  if (j.status === 'stop_unconfirmed' || j.stopUnconfirmed && ['failed', 'cancelled', 'lost', 'needs_decision'].includes(j.status)) return MAY;
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
    const pids = new Set(require('./cleanup').windowsProcesses().map(p => p.pid));
    for (const c of selected) c.outcome = await outcome(c.j, pids);
    for (const r of rows) if (r.card) r.outcome = selected.find(c => c.file === r.card.file).outcome;
    if (rows.some(r => !r.card || r.outcome === BUSY)) return report(rows) + '\nНичего не записано: набор не прошёл проверку.';
    const writable = selected.filter(c => c.outcome === MAY);
    for (const c of selected.filter(c => c.outcome === ALREADY)) require('./write-lock').releaseConfirmed(c.j);
    if (!writable.length) return report(rows);
    authority();
    return await words.recordStopConfirmation(selected.map(c => c.j.id), a.quote, async word => {
      for (const c of writable) {
        const confirmed = { basis: 'слово пользователя', quote: a.quote, word_id: word.id, at: word.at, pids: live.cardPids(c.j) };
        try { require('./team-git').atomic(c.file, JSON.stringify({ ...c.j, stopConfirmed: confirmed }, null, 2) + '\n'); }
        catch (e) { throw Error('Сбой записи карточки ' + c.j.id + ': ' + e.message + '. Повторите тот же вызов; слово ' + word.id + ' сохранено.'); }
        require('./write-lock').releaseConfirmed({ ...c.j, stopConfirmed: confirmed });
        for (const r of rows) if (r.card.file === c.file) r.outcome = 'снято';
      }
      return report(rows) + '\nСлово: ' + word.id;
    });
  } finally {
    for (const lock of held.reverse()) await lock.release();
  }
}
module.exports = { run };

