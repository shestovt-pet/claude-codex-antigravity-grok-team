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

function participant(assistant) { try { return require('./members').all().find(m => m.title === assistant)?.id; } catch { return 'unknown'; } }

function format(assistant, job = {}, body = '', next = 'Проверьте результат.') {
  const elapsed =
    job.durationSec != null
      ? job.durationSec * 1000
      : (Date.parse(job.finishedAt) || Date.now()) - (Date.parse(job.startedAt) || Date.now());
  const normalized = ['lost', 'needs_decision'].includes(job.status);
  const state = job.closedByWord ? 'ОТМЕНЕНО · закрыто словом пользователя ' + job.closedByWord.word_id : job.stopUnconfirmed && !normalized ? states.stop_unconfirmed : states[job.status] || states.failed;
  const summary = assistant === 'Команда' || !job.id;
  const summaryHeader = 'Команда · ' + (job.status === 'failed' ? 'ошибка' : 'сводка') + ' · ' +
    new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const embedded = body.match(/^(?:⚠ Статус пользователю[^\n]*\n)+/)?.[0];
  // team-v44 П3: напоминание только в team_status/team_work; без имени инструмента — нет, встроенная строка тоже снимается.
  const allowed = ['team_status', 'team_work'].includes(require('./request-context').context.getStore()?.tool);
  const warning = embedded ? (allowed ? embedded.trimEnd() : '') : (require('./request-context').context.getStore()?.publicSnapshot?.warning ?? (allowed ? require('./work-owner').reminder() : ''));
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
      ? 'Этап: ' + (job.stageTitle || job.stage) + ' (работа ' + require('./summary').workTitle(job.workName || (typeof job.work === 'string' ? job.work : '—')) + ')'
      : '',
    job.id ? 'Номер поручения: ' + job.id : '',
    job.from ? 'Отправитель: ' + job.from + (job.fromChat ? ' (чат)' : '') : '',
    assistant === 'Codex' && job.id ? 'запрошено: модель ' + (job.model || 'unknown') + ', уровень ' + (job.effort || 'unknown') + '; подтверждено: модель unknown, уровень unknown' : '',
    assistant === 'Codex' && job.fullAccessApplied === true
      ? 'Доступ: полный (от имени пользователя, без песочницы); изменения вне папки поручения в список изменённых файлов не попадают' : '',
    !summary ? require('./provenance').format(job, (assistant === 'Grok' ? 'grok' : participant(assistant)) || 'unknown') : '',
    require('./progress').progress(job),
    require('./text-format').warning(job),
    body,
    job.stopUnconfirmed && normalized ? 'ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА: проверьте оставшийся процесс исполнителя.' : '',
    job.write && job.status === 'done' ? 'ИЗМЕНЕНИЯ УЖЕ ВНЕСЕНЫ в ' + (job.folder || job.cwd) : '',
    'Дальше: ' + next,
  ]
    .filter(Boolean)
    .join('\n');
}
module.exports = { format, duration };
