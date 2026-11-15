'use strict';
// team-v46 п.5: атомарный общий замок записи для всех писателей (codex-jobs, deepseek-jobs, claude-jobs,
// подпоручения). Файл замка создаётся флагом wx в state/locks/write под общим мьютексом; конфликт — по
// realpath для равных и вложенных папок в обе стороны (граница сегмента пути: E:\work\dir и E:\work\dir2
// не конфликтуют), по всем серверам сразу. Замок снимается при завершении поручения (любом).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { stateDir, canon, isSameOrInsideReal } = require('./paths');

const dir = () => path.join(stateDir, 'locks', 'write');
const mutexFile = () => path.join(dir(), '.mutex');

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'ESRCH' ? false : null; }
}

function entryFile(real) {
  return path.join(dir(), crypto.createHash('sha256').update(real).digest('hex').slice(0, 40) + '.json');
}

function readEntries() {
  let names; try { names = fs.readdirSync(dir()); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const f = path.join(dir(), n);
    const entry = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    if (!entry || typeof entry.folder !== 'string' || !path.isAbsolute(entry.folder) || typeof entry.instance !== 'string' || !entry.instance)
      throw Error('Неверная карточка замка записи: ' + f);
    out.push({ file: f, entry });
  }
  return out;
}

// Конфликт — по realpath, равные и вложенные папки в обе стороны. Границу сегмента держит path.relative.
function conflict(a, b) {
  try { return isSameOrInsideReal(a, b) || isSameOrInsideReal(b, a); }
  catch (e) { throw Error('Не удалось проверить папку замка записи: ' + e.message); }
}

// Только один восстановитель может менять устаревший мьютекс. После захвата
// перечитываем владельца: первый снимок мог устареть, пока другой процесс восстановил замок.
// Если восстановитель умер, .mutex-recovery остаётся: безопасный отказ до ручной проверки.
function recoverMutex() {
  const recovery = mutexFile() + '-recovery';
  let fd;
  try { fd = fs.openSync(recovery, 'wx'); }
  catch (e) {
    if (['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) return false;
    throw e;
  }
  try {
    let pid = null;
    try { pid = JSON.parse(fs.readFileSync(mutexFile(), 'utf8').replace(/^\uFEFF/, '')).pid; } catch {}
    if (alive(pid) !== false) return false;
    try { fs.unlinkSync(mutexFile()); return true; }
    catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  } finally { fs.closeSync(fd); fs.unlinkSync(recovery); }
}

function withMutex(fn) {
  fs.mkdirSync(dir(), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd;
    try { fd = fs.openSync(mutexFile(), 'wx'); }
    catch (e) {
      const busy = e.code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
      if (busy) {
        let pid = null;
        try { pid = JSON.parse(fs.readFileSync(mutexFile(), 'utf8').replace(/^\uFEFF/, '')).pid; } catch {}
        if (alive(pid) === false && recoverMutex()) continue;
        if (attempt >= 100) throw Error('Замок записи занят; повторите позже.');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      throw e;
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return fn(); }
    finally { fs.closeSync(fd); try { fs.unlinkSync(mutexFile()); } catch {} }
  }
}

// Захват замка записи папки. Занят конфликтующей папкой — { ok:false, busy:true, owner }.
function acquire(folder, info = {}) {
  const real = canon(path.resolve(folder));
  return withMutex(() => {
    // Смерть сервера не подтверждает остановку дерева исполнителя: замок остаётся до решения.
    let hit;
    try { hit = readEntries().map(e => e.entry).find(e => conflict(e.folder, real)); }
    catch (e) { return { ok: false, busy: true, needsDecision: true, error: e.message }; }
    if (hit) return { ok: false, busy: true, owner: hit, needsDecision: hit.needsDecision === true || alive(hit.pid) !== true };
    const file = entryFile(real);
    const entry = { folder: real, ...info, instance: crypto.randomUUID(), pid: process.pid, since: new Date().toISOString() };
    try { fs.writeFileSync(file, JSON.stringify(entry), { flag: 'wx' }); }
    catch (e) {
      if (e.code === 'EEXIST') return { ok: false, busy: true, owner: { folder: real } };
      throw e;
    }
    return { ok: true, owner: entry, release: () => withMutex(() => {
      // Все серверы проходят этот путь, включая finally после ошибки taskkill.
      if (entry.jobId) {
        let jobs;
        try { jobs = require('./job-chain').cards().filter(j => j.id === entry.jobId); }
        catch { return { released: false, needsDecision: true }; }
        if (jobs.some(j => j.treeWarning || j.stopUnconfirmed || j.status === 'stop_unconfirmed')) {
          try { const held = JSON.parse(fs.readFileSync(file, 'utf8')); if (held.instance === entry.instance) fs.writeFileSync(file, JSON.stringify({ ...held, needsDecision: true })); } catch {}
          return { released: false, needsDecision: true };
        }
      }
      try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (current.instance !== entry.instance) return { released: false, needsDecision: true };
        fs.unlinkSync(file); return { released: true };
      } catch (e) { return { released: e.code === 'ENOENT', needsDecision: e.code !== 'ENOENT' }; }
    }) };
  });
}

// team-v48e (ревью п.1): перед запуском исполнителя фактический realpath папки записи должен совпадать
// с папкой захваченного замка. Если путь сместился после захвата (подмена symlink/junction между
// постановкой и запуском), прежний замок защищает уже не ту папку — захватываем замок фактической папки
// (отказ, если она занята другим писателем). Так гарантия «папка записи — её замок» держится и при подмене.
function reconcile(folderLock, folder, info = {}) {
  let now;
  try { now = canon(path.resolve(folder)); }
  catch (e) { throw Error('Не удалось сверить папку записи перед запуском: ' + e.message); }
  const held = folderLock && folderLock.ok !== false && folderLock.owner && folderLock.owner.folder;
  if (held && held === now) return folderLock; // замок соответствует фактической папке
  const moved = acquire(folder, info);
  if (!moved.ok)
    throw Error('Папка записи сместилась после захвата замка и занята другим поручением с записью.');
  if (folderLock && folderLock.release) { try { folderLock.release(); } catch {} }
  return moved;
}

// Вызывается после проверки процессов и сохранения подтверждения, под замком карточки.
// Повтор снимает только замки этого поручения, не нового владельца той же папки.
function releaseConfirmed(job) {
  if (!job.id || !(job.stopConfirmed || job.closedByWord)) throw Error('Нет подтверждения остановки поручения.');
  return withMutex(() => {
    for (const { file, entry } of readEntries()) if (entry.jobId === job.id) fs.unlinkSync(file);
  });
}

module.exports = { acquire, reconcile, releaseConfirmed, conflict, entryFile, dir };
