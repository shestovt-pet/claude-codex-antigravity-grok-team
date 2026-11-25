'use strict';
// team-v46 п.5: атомарный общий замок записи для всех писателей (codex-jobs, deepseek-jobs, claude-jobs,
// подпоручения). Файл замка создаётся флагом wx в state/locks/write под общим мьютексом; конфликт — по
// realpath для равных и вложенных папок в обе стороны (граница сегмента пути: E:\work\dir и E:\work\dir2
// не конфликтуют), по всем серверам сразу. Замок снимается при завершении поручения (любом).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { stateDir, canon, isSameOrInsideReal } = require('./paths');

// team-v56 А5 (ревью: расхождение №5): dir принимает state, чтобы установочный барьер читал замки из ТОГО ЖЕ каталога
// состояния, что и карточки (в бою state===MOST_STATE_DIR — различий нет; в тестовой изоляции источник един). Операции
// записи/снятия замка (acquire/release) вызывают dir() без аргумента и остаются на рабочем state.
const dir = (state = stateDir) => path.join(state, 'locks', 'write');
const mutexFile = (state) => path.join(dir(state), '.mutex');

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'ESRCH' ? false : null; }
}

function entryFile(real) {
  return path.join(dir(), crypto.createHash('sha256').update(real).digest('hex').slice(0, 40) + '.json');
}

function readEntries(state) {
  let names; try { names = fs.readdirSync(dir(state)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const f = path.join(dir(state), n);
    const entry = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    if (!entry || typeof entry.folder !== 'string' || !path.isAbsolute(entry.folder) || typeof entry.instance !== 'string' || !entry.instance)
      throw Error('Неверная карточка замка записи: ' + f);
    // team-v57: время записи замка — mtime файла замка (на диск не пишется, формат не меняется): установочный барьер
    // сверяет его с временем загрузки Windows, чтобы отличить замок, брошенный до перезагрузки, от записанного после неё.
    // При ошибке statSync — NaN (не 0): недоступное время НЕ должно давать ложное «записан до загрузки» (boot > 0).
    let mtimeMs; try { mtimeMs = fs.statSync(f).mtimeMs; } catch { mtimeMs = NaN; }
    out.push({ file: f, entry, mtimeMs });
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
function recoverMutex(state) {
  const recovery = mutexFile(state) + '-recovery';
  let fd;
  try { fd = fs.openSync(recovery, 'wx'); }
  catch (e) {
    if (['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) return false;
    throw e;
  }
  try {
    let pid = null;
    try { pid = JSON.parse(fs.readFileSync(mutexFile(state), 'utf8').replace(/^\uFEFF/, '')).pid; } catch {}
    if (alive(pid) !== false) return false;
    try { fs.unlinkSync(mutexFile(state)); return true; }
    catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  } finally { fs.closeSync(fd); fs.unlinkSync(recovery); }
}

// team-v56 Н4 (ревью Gemini-А): state по умолчанию — рабочий; изолированный state (тесты/установочный барьер) работает с
// собственным каталогом замков И собственным мьютексом, а не с глобальным paths.stateDir.
function withMutex(fn, state) {
  fs.mkdirSync(dir(state), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd;
    try { fd = fs.openSync(mutexFile(state), 'wx'); }
    catch (e) {
      const busy = e.code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
      if (busy) {
        let pid = null;
        try { pid = JSON.parse(fs.readFileSync(mutexFile(state), 'utf8').replace(/^\uFEFF/, '')).pid; } catch {}
        if (alive(pid) === false && recoverMutex(state)) continue;
        if (attempt >= 100) throw Error('Замок записи занят; повторите позже.');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      throw e;
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return fn(); }
    finally { fs.closeSync(fd); try { fs.unlinkSync(mutexFile(state)); } catch {} }
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

// team-v56 Б0 п.5: снятие именно осиротевшего замка по точному instance. Проверки отсутствия карточки и мёртвого
// владельца делает обработчик release_orphan; здесь — атомарная часть: под мьютексом перечитываем замки и снимаем
// только совпавший instance. Новый замок той же папки (другой instance) не трогаем; возраст и ENOENT прав не дают.
function orphanEntry({ instance, folder, jobId }, state) {
  if (typeof instance !== 'string' || !instance) throw Error('Нужен точный instance осиротевшего замка.');
  const want = folder ? canon(path.resolve(folder)) : null;
  for (const { file, entry } of readEntries(state)) {
    if (entry.instance !== instance) continue;
    if (want && canon(entry.folder) !== want) throw Error('Папка не совпадает с замком instance ' + instance + '.');
    if (jobId && entry.jobId && entry.jobId !== jobId) throw Error('Номер поручения не совпадает с замком instance ' + instance + '.');
    return { file, entry };
  }
  return null;
}
// Снимок замков только для чтения; ошибка хранилища — отказ у вызывающего (безопасно не снимаем). state по умолчанию —
// рабочий; установочный барьер передаёт свой каталог состояния, чтобы замки и карточки читались из одного источника.
function entries(state) { return readEntries(state); }
// team-v56 Н4: releaseOrphan принимает state (по умолчанию рабочий) — снятие точного замка в своём каталоге и под своим мьютексом.
// install-gate-simple (ревью Codex п.3): opts.verify(entry) — повторная проверка связи под мьютексом перед снятием (уборка
// мёртвых поручений: владелец по-прежнему мёртв, поручение замка не ожило). false — замок не снимается.
function releaseOrphan(match, state, opts = {}) {
  return withMutex(() => {
    const hit = orphanEntry(match, state);
    if (!hit) return { released: false, absent: true };
    if (opts.verify && !opts.verify(hit.entry)) return { released: false, changed: true };
    fs.unlinkSync(hit.file);
    return { released: true, entry: hit.entry };
  }, state);
}

// Вызывается после проверки процессов и сохранения подтверждения, под замком карточки.
// Повтор снимает только замки этого поручения, не нового владельца той же папки.
function releaseConfirmed(job) {
  if (!job.id || !(job.stopConfirmed || job.closedByWord)) throw Error('Нет подтверждения остановки поручения.');
  return withMutex(() => {
    for (const { file, entry } of readEntries()) if (entry.jobId === job.id) fs.unlinkSync(file);
  });
}

module.exports = { acquire, reconcile, releaseConfirmed, conflict, entryFile, dir, entries, releaseOrphan };
