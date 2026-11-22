'use strict';
// Отмена поручения, которое ждёт очереди или квоты (team-v18, К4). Переход карточки один на всех: его вызывают
// обработчики codex_cancel и antigravity_cancel и сервер team (grok_slot) — под тем же замком карточки, что у адаптера.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const locks = require('./locks');
const WAITING = ['waiting_quota', 'queued'];
// team-v56 Б0: внешняя отмена берёт тот же замок карточки, что держит сервер адаптера. Иначе отмена идёт под 'job',
// а сервер пишет под codex_job/kimi_job/deepseek_job/claude_job — разные замки теряют обновления. agy-cli — общий 'job'.
const JOB_LOCKS = { 'codex-cli': 'codex_job', 'kimi-cli': 'kimi_job', 'dsh-headless': 'deepseek_job', 'claude-print': 'claude_job' };
const jobLock = adapter => JOB_LOCKS[adapter] || 'job';

// Переход «в очереди» / «ждёт квоту» → «отменено». Отменённое поручение не возобновляется: очередь берёт только queued и waiting_quota.
function cancelWaiting(c) {
  if (!WAITING.includes(c.status)) return false;
  c.status = 'cancelled';
  c.finishedAt = new Date().toISOString();
  return true;
}

function write(file, text) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 8) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

// Отмена ждущего поручения из другого процесса: замок и формат карточки — как у адаптера. Запись отмены и проверка
// непосредственно перед spawn сериализуются одним замком карточки (jobLock). Общие замки (job_start/очередь) берём ДО
// замка карточки и не берём их, уже держа замок карточки.
async function cancelCard(who, adapter, dir, id) {
  const l = await locks.waitLock(jobLock(adapter), id, { jobId: id }, 8000);
  if (!l.ok) throw Error('Карточка ' + id + ' занята.');
  try {
    const bundle = path.join(dir, id, 'card.json');
    const file = adapter === 'agy-cli' || fs.existsSync(bundle) ? bundle : path.join(dir, id + '.json');
    // Перечитываем карточку под замком: если claim уже перевёл её в running, cancelWaiting вернёт false — отдаём актуальный
    // статус без ложного cancelled и без перезаписи свежей карточки.
    const j = require('./cards').readCard(file), before = { ...j };
    if (!cancelWaiting(j)) return j;
    if (adapter === 'kimi-cli') {
      // team-v56 Б0: выигравшая отмена queued/waiting_quota запрещает запуск (launch=forbidden проверяется перед spawn);
      // session-reservation продолжения, если была, освобождается — запуск уже не состоится.
      j.launch = 'forbidden';
      if (j.sessionKey) try { require('./job-admission').releaseSession(require('./paths').stateDir, j.sessionKey, j.id); } catch {}
      write(file, JSON.stringify(j, null, 2));
    } else if (adapter === 'agy-cli') {
      j.provenance = require('./provenance').forJob(j, who);
      j.cancellation = { parent_stop: j.stopUnconfirmed ? 'stop_unconfirmed' : 'unknown', parent_local_status: j.status, delegated_stop: 'unknown' };
      write(file, JSON.stringify(j, null, 1));
    } else write(file, JSON.stringify(j, null, 2));
    require('./notify').transition(require('./members').names[who] || who, before, j);
    return j;
  } finally { await l.release(); }
}

async function cancel(who, id) {
  if (!require('./members').helpers.includes(who) || !/^[a-zA-Z0-9_-]{1,80}$/.test(id || '')) throw Error('Некорректное поручение для отмены.');
  const adapter = require('./members').adapterFor(who)?.adapter;
  const dir = require('./team-store').roots()[who];
  // team-v56 Б0/А2: внешняя отмена Kimi входит в общий порядок постановки — job_start → kimi_queue/all → kimi_job. Так она
  // сериализуется с claim/spawn того же state и не теряет обновлений. Остальные адаптеры сохраняют свой порядок (замок карточки).
  if (adapter === 'kimi-cli') {
    const { stateDir } = require('./paths'), restartHold = require('./restart-hold');
    return restartHold.locked(stateDir, async () => {
      const ql = await locks.waitLock('kimi_queue', 'all', {}, 30000, stateDir);
      if (!ql.ok) throw Error('Очередь Kimi занята; повторите отмену.');
      try { return await cancelCard(who, adapter, dir, id); } finally { await ql.release(); }
    });
  }
  return cancelCard(who, adapter, dir, id);
}

module.exports = { WAITING, cancelWaiting, cancel, jobLock };
