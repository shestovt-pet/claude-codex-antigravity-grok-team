'use strict';
const states = require('./states');
function duration(ms) {
  let s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  s %= 60;
  return [h ? h + ' ч' : '', m ? m + ' мин' : '', s + ' с'].filter(Boolean).join(' ');
}

function format(assistant, job = {}, body = '', next = 'Проверьте результат.') {
  const elapsed =
    job.durationSec != null
      ? job.durationSec * 1000
      : (Date.parse(job.finishedAt) || Date.now()) - (Date.parse(job.startedAt) || Date.now());
  const normalized = ['lost', 'needs_decision'].includes(job.status);
  const state = job.stopUnconfirmed && !normalized ? states.stop_unconfirmed : states[job.status] || states.failed;
  const summary = assistant === 'Команда' || !job.id;
  const summaryHeader = 'Команда · ' + (job.status === 'failed' ? 'ошибка' : 'сводка') + ' · ' +
    new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const embedded = body.match(/^(?:⚠ Статус пользователю[^\n]*\n)+/)?.[0];
  const warning = embedded ? embedded.trimEnd() : require('./work-owner').reminder();
  if (embedded) body = body.slice(embedded.length);
  return [
    warning,
    summary ? summaryHeader : assistant +
      ' · поручение ' +
      (job.id ? String(job.id).slice(0, 8) : '—') +
      ' · ' +
      state +
      ' · ' +
      duration(elapsed),
    job.stage
      ? 'Этап: ' + job.stage + ' (работа ' + require('./summary').workTitle(job.workName || (typeof job.work === 'string' ? job.work : '—')) + ')'
      : '',
    job.id ? 'Номер поручения: ' + job.id : '',
    job.from ? 'Отправитель: ' + job.from : '',
    require('./progress').progress(job),
    body,
    job.stopUnconfirmed && normalized ? 'ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА: проверьте оставшийся процесс исполнителя.' : '',
    job.write && job.status === 'done' ? 'ИЗМЕНЕНИЯ УЖЕ ВНЕСЕНЫ в ' + (job.folder || job.cwd) : '',
    'Дальше: ' + next,
  ]
    .filter(Boolean)
    .join('\n');
}
module.exports = { format, duration };
