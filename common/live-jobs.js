'use strict';
// Прямое чтение именно состояния установки, без окружения сервера и без восстановления карточек.
// К6б (ред. 3): старые записи перестают мешать перезапуску только по доказанной остановке, без обхода дерева
// процессов: перезагрузка Windows после записи карточки, слово пользователя в карточке или доказанно историческая
// карточка (участник вне реестра, адаптер выключен — Grok, создана до выключения). Остальное блокирует.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const GROK_DISABLED_AT = Date.parse('2026-10-13T00:00:00Z');
let _boot;
function bootAt() {
  if (process.env.MOST_TEST_BOOT_AT) return Date.parse(process.env.MOST_TEST_BOOT_AT);
  if (_boot !== undefined) return _boot;
  try {
    const out = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    _boot = Date.parse(out.trim());
  } catch { _boot = NaN; }
  return _boot;
}
function cards({ stateDir, who: only, strictStores = false }) {
  if (!stateDir) throw Error('Не задан каталог состояния для проверки поручений.');
  const result = [];
  let stores;
  try { stores = fs.readdirSync(stateDir).filter(n => n === 'jobs' || n.endsWith('-jobs')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  for (const sub of stores) {
    const who = sub === 'jobs' ? 'antigravity' : sub.slice(0, -5);
    if (only && who !== only) continue;
    const dir = path.join(stateDir, sub);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT' && !strictStores) continue; throw Error('Не удалось проверить поручения: ' + dir + ': ' + e.message); }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.includes('.conflict-') || entry.name.endsWith('.tmp')) continue;
      if (!entry.isDirectory() && !entry.name.endsWith('.json')) continue;
      const file = path.join(dir, entry.name, ...(entry.isDirectory() ? ['card.json'] : []));
      let j;
      try { j = JSON.parse(fs.readFileSync(file).toString('utf8').replace(/^\uFEFF/, '')); if (!j || typeof j !== 'object') throw Error('неверная карточка'); }
      catch (e) {
        if (entry.isDirectory() && e.code === 'ENOENT') continue; // Рабочая папка, не карточка; плоская читается отдельно.
        throw Error('Не удалось проверить поручения: ' + file + ': ' + e.message);
      }
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch {}
      result.push({ who, j, entry: entry.name, file, store: sub, mtimeMs });
    }
  }
  return result;
}
function unfinished(options) {
  return cards(options).filter(({ j, who, mtimeMs }) => !confirmation(j, who, mtimeMs) &&
    (j.stopUnconfirmed || !['done', 'failed', 'cancelled', 'stop_confirmed', 'applied'].includes(j.status)));
}
function cardPids(j) {
  const out = [];
  const push = v => { if (Number.isInteger(v) && v > 0) out.push(v); };
  push(j.pid); push(j.childPid); push(j.owner?.pid); push(j.apply?.owner?.pid); push(j.stopUnconfirmed?.pid);
  if (Array.isArray(j.observedPids)) j.observedPids.forEach(push);
  return [...new Set(out)];
}
// Дочерние процессы поручения (без pid сервера-владельца): для исторических карточек выключенного адаптера.
function liveChildPids(j) {
  const out = [];
  const push = v => { if (Number.isInteger(v) && v > 0) out.push(v); };
  push(j.pid); push(j.childPid); push(j.stopUnconfirmed?.pid);
  if (Array.isArray(j.observedPids)) j.observedPids.forEach(push);
  return [...new Set(out)];
}
function memberAdapter(who) {
  try { const m = require('./members').all().find(m => m.id === who); return m ? require('./members').adapters[m.adapter] || null : null; } catch { return null; }
}
// Основание подтверждённой остановки: stop_confirmed, слово пользователя, перезагрузка, историческая карточка.
function confirmation(j, who, mtimeMs) {
  if (j.status === 'stop_confirmed') return 'stop_confirmed';
  if (j.stopConfirmed && typeof j.stopConfirmed.basis === 'string') return j.stopConfirmed.basis;
  const boot = bootAt();
  if (Number.isFinite(boot) && boot > mtimeMs) return 'reboot';
  const created = Date.parse(j.startedAt || j.createdAt);
  if (!liveChildPids(j).length && !memberAdapter(who) && Number.isFinite(created) && created < GROK_DISABLED_AT) return 'historical';
  return null;
}
function confirmed(j, who, mtimeMs) {
  if (mtimeMs === undefined && j.cardFile) { try { mtimeMs = fs.statSync(j.cardFile).mtimeMs; } catch {} }
  return !!confirmation(j, who, mtimeMs);
}
// team-v59: карточка, снятая словом владельца на ходу (close → closedByWord; stop_confirm форсом → stopConfirmed с основанием
// «слово пользователя» и уже терминальным статусом). Поздний результат исполнителя такую карточку НЕ воскрешает: статус остаётся
// снятым, голосом результат не считается, замок записи не возвращается. Используют finish адаптеров и их опрос (kill процесса).
function closedByOwnerWord(j) {
  return !!(j && (j.closedByWord ||
    (j.stopConfirmed && j.stopConfirmed.basis === 'слово пользователя' && (j.status === 'cancelled' || j.status === 'needs_decision'))));
}
// Одно правило перехода для claim, сводок и защиты папок.
function effectiveStatus(j, ownerState) {
  return ownerState === 'dead' && ['running', 'cancelling', 'stop_unconfirmed'].includes(j.status)
    ? (j.write ? 'needs_decision' : 'lost') : j.status;
}
function holdsFolder(j, who) {
  const stopped = confirmed(j, who), pids = cardPids(j);
  // Уборка синхронна: снимаем защиту только при доказанно завершённых PID.
  // Живой или недоступный PID (включая повторно использованный) сохраняет защиту.
  const dead = stopped && j.owner?.instance && j.owner.instance !== require('./locks').INSTANCE &&
    require('./deploy-ops').alive(j.owner.pid) === false && pids.length && pids.every(pid => require('./deploy-ops').alive(pid) === false);
  if (stopped && ['running', 'cancelling', 'stop_unconfirmed'].includes(j.status) && !dead) return true;
  const status = effectiveStatus(j, dead ? 'dead' : 'unknown');
  return ['running', 'queued', 'waiting_quota', 'delivery_unclear', 'cancelling', 'cancel_requested',
    'applying', 'needs_decision', 'migration_conflict'].includes(status) ||
    j.write && status === 'stop_unconfirmed' || !stopped && (j.stopUnconfirmed || status === 'stop_unconfirmed') ? true : false;
}
async function scan({ stateDir }) {
  const result = [], stale = [];
  for (const { who, j, entry, mtimeMs } of cards({ stateDir })) {
    if (!['running', 'applying', 'cancelling', 'cancel_requested', 'stop_unconfirmed'].includes(j.status) && !j.stopUnconfirmed) continue;
    const row = { who, id: String(j.id || entry).slice(0, 8), folder: j.folder || j.cwd || j.papka || 'не указана',
      duration: require('./format').duration(Date.now() - Date.parse(j.startedAt || j.createdAt || new Date())),
      from: j.from || j.sender || 'не указан', work: j.workName || (typeof j.work === 'string' && j.work) || (j.workUnbound && j.workLabel ? j.workLabel + ' (без привязки)' : null) || 'не указана' };
    const basis = confirmation(j, who, mtimeMs);
    if (basis) { stale.push({ ...row, note: 'старая запись: остановка подтверждена (' + basis + ')' }); continue; }
    // Смерть сервера не подтверждает остановку дочернего процесса (ред. 3: дерево не обходится).
    result.push(row);
  }
  return { result, stale };
}
async function running({ stateDir }) {
  return (await scan({ stateDir })).result;
}
async function staleRecords({ stateDir }) {
  return (await scan({ stateDir })).stale;
}
function describe(jobs) {
  return jobs.map(j => `${j.who} ${j.id}, папка ${j.folder}, идёт ${j.duration}, отправитель ${j.from}, работа ${j.work}`).join('; ');
}
module.exports = { running, staleRecords, describe, unfinished, confirmation, confirmed, effectiveStatus, holdsFolder, cards, cardPids, bootAt, closedByOwnerWord, GROK_DISABLED_AT };
