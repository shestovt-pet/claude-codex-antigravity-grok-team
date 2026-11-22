'use strict';
// Подтверждение человеком не заменяет отмену работающего поручения.
const path = require('path');
const live = require('./live-jobs'), locks = require('./locks'), words = require('./user-word');
const { stateDir, isInsideReal } = require('./paths');
const kinds = { 'kimi-jobs': 'kimi_job', 'codex-jobs': 'codex_job', 'deepseek-jobs': 'deepseek_job', 'claude-jobs': 'claude_job', jobs: 'job', 'grok-jobs': 'grok_job' };
const MAY = 'можно', ALREADY = 'уже подтверждено', NOTHING = 'нечего подтверждать', FORCED = 'снимается словом владельца';
const BUSY = 'ещё может работать — сначала отмена';
const settling = ['cancelling', 'cancel_requested', 'delivery_unclear'];
const completed = ['done', 'applied'];
// team-v59: статусы, которые слово владельца переводит в остановленное (к settling добавлены идущие/в очереди).
const STOPPABLE = [...settling, 'running', 'queued', 'waiting_quota'];
// Отказы, которые слово НЕ снимает (целостность переноса, а не аливость процесса) — остаются блокирующими набор.
const DATA_BLOCK = ['конфликт миграции требует разбора', 'перенос ещё не завершён'];
const overridable = reason => !!reason && !DATA_BLOCK.includes(reason);
// Что осталось не подтверждено после снятия словом: процессы поручения могли остаться работать.
function forcedNote(j) {
  const pids = cardPids(j);
  return 'процесс(ы) PID ' + (pids.length ? pids.join(', ') : 'неизвестны') + ' на момент снятия был жив/неизвестен — мог остаться работать (снято словом владельца).';
}
const toleranceMs = 5000;
const nextStep = 'Штатный *_cancel, дождаться результата и повторить; для осиротевшего процесса — ручная проверка либо подтверждённый перезапуск Windows и повтор.';
const cardPids = j => [...new Set([...live.cardPids(j), ...(Number.isInteger(j.agyPid) && j.agyPid > 0 ? [j.agyPid] : [])])];
async function processSnapshot() {
  const rows = await require('./restart-hold').processTableAsync();
  // team-v61 (Codex №2): «сбой снимка (CIM/powershell)» — это ОТКАЗ самой команды (processTableAsync бросил выше); его слово
  // владельца перекрывает (run ловит и продолжает). ВОЗВРАЩЁННЫЙ, но неполный/противоречивый снимок (нет самого процесса,
  // дубликат/отрицательный pid) — это сигнал целостности/подмены, а не недоступность CIM: он по-прежнему блокирует набор
  // (снято словом не фабрикуется), поэтому помечаем ошибку snapshotInvalid, и run её НЕ глушит.
  if (!Array.isArray(rows) || !rows.some(p => p?.pid === process.pid) ||
      rows.some(p => !p || !Number.isInteger(p.pid) || p.pid < 0 || !Number.isInteger(p.ppid) || p.ppid < 0) ||
      new Set(rows.map(p => p.pid)).size !== rows.length)
    throw Object.assign(Error('Неполный или некорректный снимок процессов: остановка не доказана. ' + nextStep), { snapshotInvalid: true });
  return new Map(rows.map(p => [p.pid, p]));
}
// Старые времена — границы, а не отпечатки ОС. observedPids не наследуют время рождения корня.
async function checkStopped(j, snapshot) {
  const evidence = { checkedAt: new Date().toISOString(), toleranceMs, fields: {
    createdAt: j.createdAt ?? null, startedAt: j.startedAt ?? null, childStartedAt: j.childStartedAt ?? null,
    finishedAt: j.finishedAt ?? null, owner: j.owner ?? null, applyOwner: j.apply?.owner ?? null,
  }, owners: [], processes: [] };
  if (['running', 'queued', 'waiting_quota'].includes(j.status)) return { reason: BUSY, evidence };
  if (j.status === 'migration_conflict') return { reason: 'конфликт миграции требует разбора', evidence };
  if (j.status === 'applying') return { reason: 'перенос ещё не завершён', evidence };
  for (const owner of [j.owner, ...(j.apply?.owner ? [j.apply.owner] : [])]) {
    const state = await locks.ownerState(owner);
    evidence.owners.push({ owner: owner ?? null, state });
    if (state !== 'dead') return { reason: BUSY + ' (владелец PID ' + (owner?.pid ?? 'не указан') + ': ' + state + '). ' + nextStep, evidence };
  }
  // team-v61 (Codex №2): сбой снимка процессов (CIM/powershell) передаётся сюда как snapshot=null. Без него принадлежность
  // карточных PID не доказать — но это РЕШАЕМЫЙ (overridable) отказ: слово владельца перекрывает его, действие выполняется,
  // а риск «процесс проверить не удалось» называется в ответе (forcedNote). Если у карточки нет PID — проверять нечего.
  if (!snapshot) {
    const pids = cardPids(j);
    return pids.length
      ? { reason: 'снимок процессов недоступен (CIM/powershell) — принадлежность PID ' + pids.join(', ') + ' не установлена. ' + nextStep, evidence }
      : { evidence };
  }
  for (const pid of cardPids(j)) {
    const p = snapshot.get(pid), item = { pid, startedAt: p?.startedAt ?? null, bounds: [] };
    evidence.processes.push(item);
    if (!p) { item.state = 'absent'; continue; }
    const owner = [j.owner, j.apply?.owner].find(o => o?.pid === pid);
    const add = (field, value, kind) => { if (value != null) item.bounds.push({ field, value, kind }); };
    if (owner) add(owner === j.owner ? 'owner.startedAt' : 'apply.owner.startedAt', owner.startedAt, 'upper');
    else {
      add(j.startedAt ? 'startedAt' : 'createdAt', j.startedAt || j.createdAt, 'lower');
      if (pid === j.childPid) add('childStartedAt', j.childStartedAt, 'upper');
      add('finishedAt', j.finishedAt, 'upper');
    }
    const birth = Date.parse(p.startedAt), now = Date.parse(evidence.checkedAt);
    const dates = [j.createdAt, j.startedAt, j.childStartedAt, j.finishedAt, owner?.startedAt].filter(v => v != null).map(v => Date.parse(v));
    const created = Date.parse(j.createdAt), started = Date.parse(j.startedAt), child = Date.parse(j.childStartedAt), finished = Date.parse(j.finishedAt);
    const lower = Number.isFinite(started) ? started : created;
    const inconsistent = dates.some(t => !Number.isFinite(t) || t > now + toleranceMs) ||
      created > started || lower > child || lower > finished || child > finished;
    if (!Number.isFinite(birth) || birth > now + toleranceMs || inconsistent || !item.bounds.length) {
      item.state = 'unknown';
      return { reason: 'принадлежность PID ' + pid + ' не установлена. ' + nextStep, evidence };
    }
    item.excludedBy = item.bounds.filter(b => b.kind === 'upper' ? birth > Date.parse(b.value) + toleranceMs : birth < Date.parse(b.value) - toleranceMs);
    if (item.excludedBy.length) { item.state = 'foreign'; continue; }
    item.state = 'possibly_alive';
    return { reason: 'живой PID ' + pid + ' может принадлежать поручению — сначала отмена. ' + nextStep, evidence };
  }
  return { evidence };
}
function confirmation(j, word, quote, evidence) {
  return { basis: 'слово пользователя', quote, word_id: word.id, at: word.at, pids: cardPids(j),
    prev_status: j.status, prev_stopUnconfirmed: j.stopUnconfirmed ?? null, prev_stopConfirmed: j.stopConfirmed ?? null, evidence };
}
function authority() {
  // team-v58 (task10 а): подтверждение остановки записывает ТОЛЬКО доказанный чат участника (chatSession). Признак поручения —
  // первым; сеанс без доказанного происхождения (подмена MOST_CLIENT, сброс MOST_JOB_ID) прав чата не имеет и слово не пишет.
  const acc = require('./access');
  if (acc.jobSession())
    throw Error('Подтверждение остановки записывает чат участника; из поручения запрещено.');
  if (!acc.chatSession())
    throw Error('Подтверждение остановки записывает доказанный чат участника; происхождение чата не доказано: ' + acc.chatOriginReason() + '.');
}
function outcome(j) {
  if (j.stopConfirmed && !j.stopUnconfirmed && !settling.includes(j.status)) return ALREADY;
  if (settling.includes(j.status) || j.status === 'stop_unconfirmed' ||
      j.stopUnconfirmed && ['failed', 'cancelled', 'lost', 'needs_decision', ...completed].includes(j.status)) return MAY;
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
    // team-v61 (Codex №2): ОТКАЗ команды снимка (CIM/powershell бросил) не блокирует слово владельца — checkStopped получает
    // null и выдаёт решаемый отказ, который слово перекрывает (риск назван). НЕполный/противоречивый ВОЗВРАЩЁННЫЙ снимок
    // (snapshotInvalid — целостность/подмена) по-прежнему останавливает набор, даже словом.
    let snapshot = null;
    try { snapshot = await processSnapshot(); } catch (e) { if (e.snapshotInvalid) throw e; snapshot = null; }
    for (const c of selected) {
      c.check = await checkStopped(c.j, snapshot);
      // team-v59: слово владельца перекрывает отказ по аливости процесса/владельца и по статусу running/queued/cancelling —
      // действие выполняется и помечает карточку остановленной словом. Данные-состояния (конфликт миграции, незавершённый
      // перенос) словом не снимаются: это не процесс, а целостность переноса. Такой отказ по-прежнему блокирует набор.
      c.forced = overridable(c.check.reason);
      c.outcome = c.forced ? FORCED : (c.check.reason || outcome(c.j));
    }
    for (const r of rows) if (r.card) r.outcome = selected.find(c => c.file === r.card.file).outcome;
    if (rows.some(r => !r.card) || selected.some(c => c.check.reason && !c.forced)) return report(rows) + '\nНичего не записано: набор не прошёл проверку.';
    const writable = selected.filter(c => c.outcome === MAY || c.forced);
    for (const c of selected.filter(c => c.outcome === ALREADY)) require('./write-lock').releaseConfirmed(c.j);
    if (!writable.length) return report(rows);
    authority();
    // team-v59: штатная остановка поручения из этого процесса — перевод карточки в остановленный статус (ниже) и снятие
    // замка записи (releaseConfirmed): ждущая очередь/квота так же отменяется, идущее больше не подхватывается. Реального
    // kill карточных PID мост здесь не делает (PID мог быть переиспользован ОС; дерево процессов ведёт адаптер по *_cancel),
    // поэтому в ответе названо, что осталось не подтверждено (процесс мог остаться работать). Слово владельца пометку даёт
    // в любом случае — замок свободен, новая отправка в ту же папку проходит.
    const notes = [];
    return await words.recordStopConfirmation(selected.map(c => c.j.id), a.quote, async word => {
      for (const c of writable) {
        const confirmed = confirmation(c.j, word, a.quote, c.check.evidence);
        const next = { ...c.j, stopConfirmed: confirmed };
        if (settling.includes(c.j.status) || c.forced && STOPPABLE.includes(c.j.status)) { next.prev_status = c.j.status; next.status = c.j.write ? 'needs_decision' : 'cancelled'; }
        delete next.stopUnconfirmed;
        try { require('./team-git').atomic(c.file, JSON.stringify(next, null, 2) + '\n'); }
        catch (e) { throw Error('Сбой записи карточки ' + c.j.id + ': ' + e.message + '. Повторите тот же вызов; слово ' + word.id + ' сохранено.'); }
        require('./write-lock').releaseConfirmed(next);
        for (const r of rows) if (r.card.file === c.file) r.outcome = c.forced ? 'снято словом владельца' : 'снято';
        if (c.forced) notes.push(forcedNote(c.j));
      }
      return report(rows) + '\nСлово: ' + word.id + (notes.length ? '\n' + notes.join('\n') : '');
    });
  } finally {
    for (const lock of held.reverse()) await lock.release();
  }
}
module.exports = { run, processSnapshot, checkStopped, confirmation, settling, completed, overridable, forcedNote, STOPPABLE, FORCED };

