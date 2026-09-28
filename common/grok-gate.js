'use strict';
const stores = require('./team-store');
const bound = (v, c, phase) => phase === 'design' ? v.designHash === c.designHash : v.base === c.base && v.candidate === c.candidate;
function binding(c, phase) { return phase === 'design' ? { designHash: c.designHash } : { base: c.base, candidate: c.candidate }; }
function taskCheck(j, c, phase) {
  const task = (j.task || '') + '\n' + (j.text || '');
  if (!task.includes(c.requestMark)) throw Error('В поручении Grok нет метки запроса.');
  for (const hash of phase === 'design' ? [c.designHash] : [c.base, c.candidate])
    if (!new RegExp('(^|[^a-fA-F0-9])' + hash + '([^a-fA-F0-9]|$)').test(task)) throw Error('В поручении Grok нет точного хеша замысла или пары коммитов.');
}
async function record(c, phase, a) {
  let value;
  if (a.unavailable) {
    try { require('./grok').config(); } catch (e) { value = { status: 'недоступен', reason: e.message }; }
    if (!value) throw Error('Мост настроен: укажите поручение Grok.');
  } else {
    const j = stores.list('grok', false).jobs.find(j => j.id === a.job_id);
    if (!j) throw Error('Поручение Grok не найдено.');
    taskCheck(j, c, phase);
    if (j.status === 'cancelled' || j.cancelled) throw Error('Отменённое поручение не считается запросом Grok; запросите заново.');
    const current = await new (require('./grok').Grok)().refresh(j.id);
    if (current.status === 'cancelled' || current.cancelled) throw Error('Отменённое поручение не считается запросом Grok; запросите заново.');
    if (!['queued', 'running', 'delivery_unclear', 'done', 'lost', 'failed'].includes(current.status)) throw Error('Неподтверждённое состояние поручения Grok.');
    value = { job_id: j.id, status: current.status, reason: current.reason };
    if (current.status === 'done') {
      let reviewed;
      for (const decision of ['ПРИНЯТО', 'НЕ ПРИНЯТО']) {
        try { reviewed = stores.review('grok', j.id, phase === 'design' ? null : c.base, phase === 'design' ? null : c.candidate, decision, c.requestMark, phase === 'design' ? c.designHash : null); value.decision = decision; break; } catch (e) { if (decision === 'НЕ ПРИНЯТО') throw e; }
      }
      if (reviewed.reviewText.includes('[системное]')) {
        c.systemic ||= [];
        if (!c.systemic.some(v => v.who === 'grok' && v.job_id === j.id)) c.systemic.push({ who: 'grok', job_id: j.id });
      }
    }
  }
  const field = phase === 'design' ? 'grokDesign' : 'grokVerdict';
  c[field] = { ...value, ...binding(c, phase), at: new Date().toISOString() };
  return 'Grok: ' + (value.decision || ({ running: 'ждём ответ', delivery_unclear: 'ждём ответ', queued: 'ждём ответ', failed: 'отказ', lost: 'потеряно' }[value.status]) || value.status);
}
function paragraph(text, id, markers) {
  return text.split(/\r?\n\s*\r?\n/).some(p => p.includes(id) && markers.some(marker => marker === 'closed'
    ? p.includes('Где закрыто:') && p.includes('Проверка')
    : new RegExp(marker + '[ \\t]*[^\\s:][^\\r\\n]*').test(p)));
}
async function check(c, lessons) {
  for (const phase of ['design', 'verdict']) {
    const field = phase === 'design' ? 'grokDesign' : 'grokVerdict';
    let v = c[field];
    if (!v || !bound(v, c, phase)) throw Error('Grok не запрошен: ' + phase);
    if (v.status !== 'недоступен') {
      await record(c, phase, { job_id: v.job_id }); v = c[field];
    }
    if (v.status === 'недоступен') {
      if (!paragraph(lessons, 'Grok недоступен ' + c.name + ':', ['Grok недоступен ' + c.name + ':'])) throw Error('Grok недоступен: нужно решение в lessons.md для ' + c.name);
    } else if (['running', 'queued', 'delivery_unclear'].includes(v.status)) throw Error('Ждём Grok, не более 60 мин.');
    else if (v.decision === 'ПРИНЯТО') continue;
    else if (!paragraph(lessons, v.job_id.slice(0, 8), v.status === 'failed' ? ['Отклонено:', 'Grok недоступен:'] : ['closed', 'Отклонено:']))
      throw Error('Нет решения по Grok ' + v.job_id + ': ' + (v.decision || v.status));
  }
}
module.exports = { record, check, paragraph, bound };
