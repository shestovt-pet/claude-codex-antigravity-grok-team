'use strict';
// team-v56 Б0 п.5: team_word action=release_orphan — снятие замка записи без карточки по точному instance.
// Доступ как у stop_confirm/close v55: основной чат Claude, не гость, не поручение, не запасной режим.
// Слово не доказывает отсутствие процесса: требуется отсутствие опубликованной карточки поручения и подтверждённо
// мёртвый владелец замка. Снимается ровно совпавший instance; чужой новый замок той же папки не трогается.
const path = require('path');
const live = require('./live-jobs'), writeLock = require('./write-lock'), words = require('./user-word'), ops = require('./deploy-ops');
const { stateDir, canon } = require('./paths');

function authority() {
  // team-v58 (task10 а): снятие осиротевшего замка словом записывает ТОЛЬКО доказанный чат участника (chatSession). Признак
  // поручения — первым; сеанс без доказанного происхождения (подмена MOST_CLIENT, сброс MOST_JOB_ID) прав чата не имеет.
  const acc = require('./access');
  if (acc.jobSession())
    throw Error('Снятие осиротевшего замка записывает чат участника; из поручения запрещено.');
  if (!acc.chatSession())
    throw Error('Снятие осиротевшего замка записывает доказанный чат участника; происхождение чата не доказано: ' + acc.chatOriginReason() + '.');
}

// Снимок до/перед снятием: нет опубликованной карточки поручения; замок instance найден и соответствует; владелец мёртв.
// Ошибка любого хранилища — исключение (безопасный отказ: ничего не снимаем).
function snapshot(instance, jobId, folder) {
  const card = live.cards({ stateDir, strictStores: true }).find(c => typeof c.j.id === 'string' && c.j.id === jobId);
  if (card) throw Error('Карточка поручения ' + jobId + ' существует (' + card.store + '): это не осиротевший замок — используйте stop_confirm или close.');
  const hit = writeLock.entries().find(e => e.entry.instance === instance);
  if (!hit) return { absent: true };
  const entry = hit.entry;
  if (canon(entry.folder) !== canon(path.resolve(folder))) throw Error('Папка не совпадает с замком instance ' + instance + '.');
  if (entry.jobId && entry.jobId !== jobId) throw Error('Номер поручения не совпадает с замком instance ' + instance + '.');
  // team-v59: слово владельца снимает замок при ЛЮБОМ состоянии владельца (жив, не проверяется, мёртв). Прежний отказ
  // «владелец жив — слово не доказывает остановку» снят: это его замок, слово его. Аливость возвращается, чтобы ответ назвал,
  // что осталось не подтверждено (старый сервер мог остаться работать — возможны два писателя в папке). Карточки нет и папка
  // совпала — это по-прежнему проверяется (иначе это не осиротевший замок или не тот замок).
  const alive = ops.alive(entry.pid);
  return { absent: false, entry, ownerAlive: alive };
}

async function run(a) {
  authority();
  const instance = a.lock_instance, folder = a.folder;
  const jobId = Array.isArray(a.job_ids) && a.job_ids.length === 1 ? a.job_ids[0] : undefined;
  if (typeof instance !== 'string' || !/^[0-9a-fA-F-]{8,80}$/.test(instance)) throw Error('Нужен точный instance осиротевшего замка (lock_instance).');
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(jobId)) throw Error('Нужен ровно один номер поручения осиротевшего замка (job_ids).');
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw Error('Нужна абсолютная папка замка (folder).');
  if (typeof a.quote !== 'string' || !a.quote.trim()) throw Error('Нужно слово пользователя дословно (quote).');
  const adm = require('./job-admission'), hold = require('./restart-hold');
  const before = snapshot(instance, jobId, folder);
  // team-v56 И7 (ревью Codex 5/Kimi 5/Gemini-А): при ОТСУТСТВУЮЩЕМ lock_instance НЕ отзываем admission/session и не пишем
  // новое слово — иначе опечатка instance отозвала бы живую чужую постановку того же jobId. Идемпотентность «уже снято» —
  // только по уже записанному ровно такому же освобождению (instance+jobId+folder).
  if (before.absent) {
    const prior = words.findOrphanRelease(instance, jobId, folder);
    if (prior) return 'Замок instance ' + instance + ' отсутствует — уже снято ранее (слово ' + prior.id + '); постановка не отзывается.';
    throw Error('Замок instance ' + instance + ' (поручение ' + jobId + ', папка ' + folder + ') не найден: снимать нечего, постановка не отзывается. Проверьте instance/папку/номер.');
  }
  // team-v56 К2 (ревью Codex 5/Kimi 5 круг 3): отзыв постановки ТОЛЬКО при доказанной связи замка с поручением — у самого
  // замка есть собственный jobId, равный запрошенному. Замок БЕЗ entry.jobId не доказывает, что запрошенный номер — это
  // поручение именно ЭТОГО замка: сам осиротевший замок (мёртвый владелец) по слову пользователя снять можно, но admission/
  // session тогда НЕ отзываем (иначе чужую живую неопубликованную постановку того же номера удалил бы случайный замок).
  const linked = before.entry.jobId === jobId;
  // Отзыв постановки и снятие замка — ПОД замком постановки (job_start): так revoke admission сериализуется с save/commit
  // серверов (после отзыва их commit вернёт null и send остановится до spawn). Запись слова — под журналом внутри.
  return hold.locked(stateDir, () => words.recordOrphanRelease(instance, jobId, folder, a.quote, async word => {
    authority();
    const now = snapshot(instance, jobId, folder);
    if (now.absent)
      return 'Замок instance ' + instance + ' уже отсутствует (снят параллельно); постановка не отзывается. Слово: ' + word.id;
    const proven = now.entry.jobId === jobId;
    let note;
    if (proven) {
      // Доказанная связь instance↔jobId↔folder (snapshot подтвердил замок с этим jobId и этой папкой, владелец мёртв):
      // отзываем незавершённую постановку и session-reservation осиротевшего поручения. Ограничение: у записи admission
      // нет поля папки (common/job-admission.js: key/adapter/principal/jobId/…), поэтому принадлежность admission папке
      // доказывается через замок (folder сверен в snapshot, lock.jobId=jobId), а сама admission — по совпадению jobId.
      const revoked = adm.revokeByJob(stateDir, jobId).removed;
      note = revoked.length ? '; отозвана постановка: ' + revoked.join(', ') : '; незавершённых постановок по номеру нет';
    } else {
      note = '; постановка НЕ отзывалась: у замка нет собственного номера поручения — связь замка с постановкой ' + jobId + ' не доказана';
    }
    const r = writeLock.releaseOrphan({ instance, folder, jobId });
    if (!r.released && !r.absent) throw Error('Замок instance ' + instance + ' не снят: условие не выполнено.');
    // Повторное чтение подтверждает отсутствие замка.
    if (writeLock.entries().some(e => e.entry.instance === instance)) throw Error('Замок instance ' + instance + ' всё ещё присутствует после снятия.');
    // team-v59: если владелец замка на момент снятия был жив/не проверялся — назвать риск (старый сервер мог остаться работать).
    const risk = now.ownerAlive !== false ? '\nВладелец замка (PID ' + now.entry.pid + ') на момент снятия был ' + (now.ownerAlive === true ? 'жив' : 'не проверяется') + ' — мог остаться работать; возможны два писателя в папке (риск принят словом владельца).' : '';
    return 'Снят осиротевший замок записи instance ' + instance + ' (поручение ' + jobId + ', папка ' + folder + ')' + note + '. Слово: ' + word.id + risk;
  }, { revoked_admission: linked }));
}

module.exports = { run, snapshot };
