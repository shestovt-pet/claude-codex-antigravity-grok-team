'use strict';
// Снимок содержит материал и автора; журнал решений привязан к снимку, но не входит в его хеш.
const cw = () => require('./consilium-workflow');
const seats = require('./members').seats;
function need(ok, why) { if (!ok) throw Object.assign(Error(why), { workflowCode: 2 }); }
function author(s) {
  const a = s.author;
  const authors = Array.isArray(a) ? a.flatMap(p => p.authors || [p]) : a?.authors || [a];
  need(authors.length && authors.every(a => a && ['anthropic', 'openai', 'google', 'xai'].includes(a.family) && a.model?.trim()), 'Нужна семья и модель автора этапа.');
  need(!s.level || ['обычный', 'высокий'].includes(s.level), 'Неизвестный уровень этапа консилиума.');
  return [...new Set(authors.map(a => a.family))];
}
const sent = j => Date.parse(j.startedAt || j.createdAt || j.created_at);
function ordered(rows, ready = false) {
  return rows.slice().sort((a, b) => {
    const delta = (ready ? Date.parse(a.finishedAt) : sent(a)) - (ready ? Date.parse(b.finishedAt) : sent(b));
    need(Number.isFinite(delta), 'Неизвестен порядок поручений.');
    if (delta) return delta;
    need(a.id === b.id || (Number.isInteger(a.gateOrder) && Number.isInteger(b.gateOrder) && a.gateOrder !== b.gateOrder), 'Неоднозначный порядок поручений.');
    return (a.gateOrder || 0) - (b.gateOrder || 0);
  });
}
async function check({ ctx, w, s, snapshot, adapter, usedJobs, files }) {
  const api = cw(), families = author(s), family = families.includes('anthropic') ? 'anthropic' : families[0], candidates = Object.values(seats).filter(f => !families.includes(f));
  const observed = [], votes = [], opinions = [];
  for (const who of api.QUORUM) for (const card of await adapter.list(who)) {
    const text = api.taskText(card);
    if ((card.workName || card.work) !== w.work_id || (card.stageId || card.stage) !== s.id) continue;
    if (api.marker(text, 'workflow_work') !== w.work_id || api.marker(text, 'workflow_stage') !== s.id) continue;
    const j = { ...card, who }; observed.push(j);
    if (j.status !== 'done' || j.cancelled || j.cancel_requested || j.lateHash) continue;
    api.validateJob(j, who);
    const r = await adapter.read(who, j);
    need(!r.provenance.mismatch && r.provenance.family, 'Не подтверждён маршрут/семья: ' + j.id);
    const hash = api.marker(text, 'snapshot_sha256');
    need(hash && api.marker(r.text, 'snapshot_sha256') === hash, 'В ответе нет хеша проверенного снимка: ' + j.id);
    votes.push({ ...j, participant: who, accepted: api.verdict(r.text), provenance: r.provenance,
      snapshot: hash, task_sha256: api.sha(text), response_sha256: api.sha(r.raw) });
  }
  const current = ordered(votes.filter(v => v.snapshot === snapshot), true);
  const receiptVotes = () => current.map(v => ({ participant: v.who, job_id: v.id, accepted: v.accepted, provenance: v.provenance,
    task_sha256: v.task_sha256, response_sha256: v.response_sha256, finishedAt: v.finishedAt }));
  const availability = Object.keys(seats).flatMap(who => {
    const last = ordered(observed.filter(j => j.who === who && api.matches(api.taskText(j), w.work_id, s.id, snapshot))).at(-1);
    return last ? [{ participant: who, job_id: last.id, status: last.status }] : [];
  });
  for (const ref of s.reviews.filter(r => r.participant !== 'grok')) {
    need(ref.source === 'bridge', 'Версия 2 принимает голоса только из хранилища моста.');
    need(ref.job_id && !usedJobs.has(ref.job_id), 'Повтор/отсутствие job_id.'); usedJobs.add(ref.job_id);
    const v = current.find(v => v.id === ref.job_id && v.who === ref.participant);
    need(v && v.task_sha256 === ref.task_sha256 && v.response_sha256 === ref.response_sha256, 'Нет действующего голоса или не совпадает хеш: ' + ref.job_id);
  }
  const historical = new Set(s.reviews.filter(r => r.participant === 'grok').map(r => r.job_id));
  const journal = (s.decisions || []).filter(d => d.replacement !== 'grok' && !historical.has(d.job_id));
  need(Array.isArray(journal), 'Журнал решений должен быть массивом.');
  const dismissals = journal.filter(d => d.kind === 'dismiss' && d.version === snapshot);
  for (const d of journal) {
    need(['dismiss', 'reconsider', 'replace'].includes(d.kind) && d.version && d.reason?.trim(), 'Некорректный журнал решений.');
    if (d.kind === 'dismiss' && d.version === snapshot)
      need(current.some(v => v.id === d.job_id && !v.accepted) && Number.isFinite(Date.parse(d.at)), 'Отклонение без отказа или времени.');
    if (d.kind === 'reconsider' && d.version === snapshot) {
      const original = current.find(v => v.id === d.job_id && !v.accepted), next = current.find(v => v.id === d.review_job_id);
      const dismissal = dismissals.find(x => x.job_id === d.job_id);
      need(original && next && dismissal && next.who === original.who && sent(next) > Date.parse(dismissal.at) &&
        api.taskText(next).includes(original.id) && api.taskText(next).includes(dismissal.reason), 'Не подтверждён пересмотр тем же проверяющим с причиной.');
    }
  }
  const eligible = current.filter(v => seats[v.who] === v.provenance.family && candidates.includes(v.provenance.family) &&
    (v.who !== 'grok' || files.every(f => new RegExp('(^|[^a-fA-F0-9])' + f.sha256 + '([^a-fA-F0-9]|$)', 'i').test(api.taskText(v)))));
  for (const v of current.filter(v => v.who === 'grok' && !eligible.includes(v))) opinions.push('Grok совещательный: семья автора или нет sha256 каждого файла');
  if (s.kind === 'discussion') {
    need(new Set(current.map(v => v.provenance.family)).size >= 2, 'Обсуждение требует позиции минимум двух семей.');
    return { stage: s.id, snapshot_sha256: snapshot, votes: receiptVotes(), availability, opinions };
  }
  const helperRows = [];
  const replacementDecisions = new Map();
  for (const d of journal.filter(d => d.kind === 'replace' && d.version === snapshot)) replacementDecisions.set(d.replacement, d);
  for (const d of replacementDecisions.values()) {
    need(family !== 'anthropic' && candidates.length === 1 && seats[d.replacement] && candidates.includes(seats[d.replacement]), 'Помощник не занимает место при этом авторе.');
    need(d.family === 'anthropic' && /sonnet/i.test(d.model || ''), 'Журнал замены требует семью anthropic и модель помощника.');
    const last = ordered(observed.filter(j => j.who === d.replacement && api.matches(api.taskText(j), w.work_id, s.id, snapshot))).at(-1);
    if (last?.status === 'done' && eligible.some(v => v.id === last.id)) {
      opinions.push('заменённый проверяющий вернулся: ' + d.replacement);
      continue;
    }
    const word = /^word-/.test(d.evidence || '');
    if (word) {
      // team-v18 К5: действующее на момент решения слово пользователя — доказательство недоступности наравне с поручением;
      // поручение на пересмотр после отклонения оно не заменяет.
      const words = require('./user-word'), record = words.byId(d.evidence);
      need(!dismissals.some(x => current.some(v => v.id === x.job_id && v.who === d.replacement)), 'Нужно недоступное поручение на пересмотр с причиной.');
      need(record && record.who_down === d.replacement && words.holds(record, Date.parse(d.at)), 'Нет действующего слова пользователя о недоступности ' + d.replacement + '.');
      // team-v19 К4 (в): слово, записанное дирижёром его семьи-автора, недоступность не доказывает.
      need(!record.source || record.source === 'chat-claude' || require('./fallback').FAMILY[record.recorded_by] !== family, 'Слово записал дирижёр семьи автора: нужно доказательство поручением.');
    } else {
      need(last && last.id === d.evidence && !last.cancelled && !last.cancel_requested && !last.lateHash &&
        ['lost', 'failed', 'waiting_quota'].includes(last.status), 'Нет недоступности последнего поручения.');
      if (last.status === 'waiting_quota') need(last.retryKind === 'quota' && Number.isFinite(Date.parse(last.lastQuotaAt)) && Date.parse(last.nextAttemptAt) > Date.now(), 'Нет подтверждённой нехватки квоты.');
      for (const rejection of dismissals.filter(d => current.some(v => v.id === d.job_id && v.who === last.who)))
        need(sent(last) > Date.parse(rejection.at) && api.taskText(last).includes(rejection.job_id) && api.taskText(last).includes(rejection.reason), 'Нужно недоступное поручение на пересмотр с причиной.');
    }
    const ref = typeof d.file === 'string' ? { path: d.file } : d.file;
    const file = await api.readFile(ctx, ref, api.LIMITS.text, true);
    need(api.marker(file.text, 'snapshot_sha256') === snapshot && api.marker(file.text, 'family') === 'anthropic' &&
      api.marker(file.text, 'model') === d.model && api.marker(file.text, 'replacement') === d.replacement && api.marker(file.text, 'evidence') === d.evidence,
    'Файл помощника: нужны хеш, семья anthropic, модель, замена и доказательство.');
    helperRows.push({ who: d.replacement, family: d.family, model: d.model, hash: file.sha256, accepted: api.verdict(file.text), ...(word ? { word_id: d.evidence } : {}) });
    opinions.push('замена ' + d.replacement + ' помощником anthropic' + (word ? ' по слову пользователя ' + d.evidence : '') + '; сервер происхождение файла не проверял');
  }
  need(helperRows.length <= 1, 'Помощник занимает только одно обязательное место.');
  const blockers = [];
  for (const v of eligible.filter(v => !v.accepted)) {
    const d = dismissals.find(d => d.job_id === v.id);
    const accepted = eligible.some(n => n.who === v.who && n.accepted && Date.parse(n.finishedAt) > Date.parse(v.finishedAt) &&
      (!d || (sent(n) > Date.parse(d.at) && api.taskText(n).includes(v.id) && api.taskText(n).includes(d.reason))));
    if (accepted) continue;
    if (d && family === 'anthropic' && !require('./user-word').mode(Date.parse(d.at)).active) opinions.push('особое мнение: отклонено с причиной ' + v.who + ': ' + d.reason);
    else if (!(d && helperRows.some(h => h.who === v.who && h.accepted))) blockers.push(v.who + (d ? ': отклонено, ждёт пересмотра' : ': открыто'));
  }
  const active = new Map(); for (const v of eligible) active.set(v.provenance.family, v);
  const approvals = new Set([...active.values()].filter(v => v.accepted).map(v => v.provenance.family));
  if (helperRows[0]?.accepted) approvals.add('anthropic');
  else if (helperRows.length) blockers.push('помощник на месте замены');
  if (s.level === 'высокий') {
    need(Array.isArray(s.fresh_reviews) && s.fresh_reviews.length, 'Высокий риск требует дополнительного помощника.');
    const extra = await api.readFile(ctx, s.fresh_reviews.at(-1), api.LIMITS.text, true);
    need(!helperRows.some(h => h.hash === extra.sha256), 'Один файл помощника нельзя засчитать дважды.');
    need(api.marker(extra.text, 'snapshot_sha256') === snapshot && api.marker(extra.text, 'family') === 'anthropic' && /sonnet/i.test(api.marker(extra.text, 'model') || ''), 'Нет семьи, модели или снимка дополнительного помощника.');
    if (!api.verdict(extra.text)) blockers.push('дополнительный помощник');
  }
  for (const old of votes.filter(v => v.snapshot !== snapshot && !v.accepted && candidates.includes(v.provenance.family)))
    if (!eligible.some(v => v.who === old.who && v.accepted) && (family === 'anthropic' || helperRows.some(h => h.who === old.who && h.accepted)))
      opinions.push('особое мнение: исправлено без подтверждения ' + old.who + ', ' + old.id);
  need(!blockers.length, 'Есть НЕ ПРИНЯТО: ' + blockers.join('; '));
  need(candidates.length > 0 && approvals.size >= candidates.length, 'Нужны ПРИНЯТО всех внешних семей, отличных от автора.');
  return { stage: s.id, snapshot_sha256: snapshot, votes: receiptVotes(), replacements: helperRows, availability, opinions };
}
module.exports = { author, check };
