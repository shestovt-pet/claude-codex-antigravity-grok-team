'use strict';
const members = require('./members');
function run(a) {
  if (a.action === 'list') {
    const snap = members.snapshot();
    // team-v46: участник claude в списке подписан как исполнитель (отдельный сеанс, не чат).
    const labelled = { ...snap, members: snap.members.map(m => m.id === 'claude' ? { ...m, title: members.executorTitle(m) } : m) };
    return JSON.stringify(labelled, null, 2);
  }
  const access = require('./access');
  // Метка user сама по себе не расширяет полномочия; используются прежние ворота доступа.
  if (access.guest() || process.env.MOST_JOB_ID) throw Error('Изменять состав может только дирижёр из чата пользователя.');
  if (!['add', 'remove', 'pause', 'resume'].includes(a.action)) throw Error('Неизвестное действие team_members.');
  if (['add', 'remove'].includes(a.action) && !(typeof a.quote === 'string' && a.quote.trim())) throw Error('Нужна дословная цитата пользователя.');
  if (typeof a.reason !== 'string' || !a.reason.trim()) throw Error('Укажите причину изменения состава.');
  return JSON.stringify(members.store().update(a.expected_rev, next => {
    const id = a.member?.id || a.id, old = next.members.find(m => m.id === id);
    if (a.action === 'add') {
      if (!a.member || old && old.state !== 'removed') throw Error('Участник уже существует или запись не задана.');
      if (a.id && a.member.id && a.id !== a.member.id) throw Error('id участника не совпадает с id в записи.');
      // Возвращённый в состав участник снова действует: пауза и removed не переносятся.
      const member = { ...a.member, state: 'active', pause: null };
      if (old) next.members[next.members.indexOf(old)] = member; else next.members.push(member);
    } else {
      if (!old || old.state === 'removed') throw Error('Действующий участник не найден.');
      if (a.action === 'remove') {
        const jobs = require('./live-jobs').unfinished({ stateDir: require('./paths').stateDir, who: id });
        if (jobs.length) throw Error('Участник ' + id + ' имеет незавершённые поручения без подтверждённой остановки: ' + jobs.map(({ j, entry }) => j.id || entry).join(', '));
        old.state = 'removed'; old.pause = null;
      }
      if (a.action === 'pause') { old.state = 'paused'; old.pause = { kind: 'manual', scope: 'participant', since: new Date().toISOString(), until: a.until || null, next_probe: null }; }
      if (a.action === 'resume') { old.state = 'active'; old.pause = null; }
    }
  }, { action: a.action, who: access.client(), reason: a.reason, quote: a.quote || null }), null, 2);
}
module.exports = { run };
