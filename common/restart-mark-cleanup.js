'use strict';
// team-v61 (п.12): фоновая уборка устаревших ОТМЕТОК процессов моста — файлов, которые копятся от перезапусков:
//   state/restart-servers/<pid>.json и <pid>.watch (цепочка предков сервера и ответ сторожа);
//   state/ready/<server>.<pid>.json (готовность на экземпляр, access.ready).
// Удаляются ТОЛЬКО отметки процессов, которых НЕТ в живом снимке процессов И чей файл старше суток (mtime). Снимок берётся
// один раз; при его сбое/пустоте не удаляем ничего (безопасный отказ — как в restart-hold п.2). Переиспользованный ОС pid
// (есть в снимке) не трогаем. Общий ready/<server>.json (без pid) не трогаем. Не на пути ответа сводки: запускается сервером
// team в фоне, не чаще раза в сутки (троттлинг меткой на диске), как cards-autocleanup.
// team-v61 (часть 3, Codex): снимок процессов берётся АСИНХРОННО — иначе синхронный fallback.processTable на Windows
// запускал execFileSync(powershell) с таймаутом до 120 с и на это время блокировал событийный цикл сервера team (сводка и
// прочие инструменты не обслуживались). На Windows снимок — уже имеющийся асинхронный chat-origin.liveTableAsync (execFile,
// не execFileSync); на прочих ОС processTable читает /proc синхронно и внешних процессов не запускает — дёшево, заворачиваем
// в Promise. run/maybeRun — асинхронные; tableFn внедряется в тестах. При сбое/пустоте снимка удаляем 0.
const fs = require('fs'), path = require('path');
const DAY = 86400000;

// Асинхронный снимок таблицы процессов: Windows — execFile через chat-origin.liveTableAsync; прочие ОС — синхронное /proc.
function liveTable() {
  if (process.platform === 'win32') return require('./chat-origin').liveTableAsync();
  try { return Promise.resolve(require('./fallback').processTable(false)); } catch (e) { return Promise.reject(e); }
}
async function livePids(tableFn = liveTable) {
  const rows = await tableFn();
  if (!Array.isArray(rows) || !rows.length) throw Error('Снимок процессов пуст.');
  return new Set(rows.map(p => p.pid).filter(Number.isInteger));
}
// restart-servers: «<pid>.json» / «<pid>.watch»; ready: «<server>.<pid>.json». Общий «<server>.json» pid не даёт → null.
function pidOf(name) {
  const m = name.match(/(?:^|\.)(\d+)\.(?:json|watch)$/);
  return m ? Number(m[1]) : null;
}

async function run({ stateDir, now = Date.now(), apply = true, tableFn = liveTable } = {}) {
  let live;
  try { live = await livePids(tableFn); } catch (e) { return { removed: 0, skipped: 'снимок процессов недоступен: ' + e.message }; }
  const cutoff = now - DAY;
  let removed = 0;
  for (const [sub, keep] of [['restart-servers', n => /\.(?:json|watch)$/.test(n)], ['ready', n => /\.\d+\.json$/.test(n)]]) {
    const dir = path.join(stateDir, sub);
    let ents; try { ents = fs.readdirSync(dir); } catch { continue; }
    for (const n of ents) {
      if (!keep(n)) continue;
      const pid = pidOf(n);
      if (pid == null || live.has(pid)) continue;    // нет pid в имени / процесс жив — не трогаем
      const f = path.join(dir, n);
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs >= cutoff) continue;            // моложе суток — не трогаем
      if (!apply) { removed++; continue; }
      try { fs.unlinkSync(f); removed++; } catch {}
    }
  }
  return { removed };
}

function marker(stateDir) { return path.join(stateDir, 'restart-mark-cleanup-last.json'); }
function due(stateDir, now = Date.now(), everyMs = DAY) {
  try { const m = JSON.parse(fs.readFileSync(marker(stateDir), 'utf8')); return now - Date.parse(m.at) >= everyMs; } catch { return true; }
}
async function maybeRun({ stateDir, now = Date.now(), everyMs = DAY, tableFn = liveTable } = {}) {
  if (!due(stateDir, now, everyMs)) return { skipped: true };
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(marker(stateDir), JSON.stringify({ at: new Date(now).toISOString() })); } catch {}
  const r = await run({ stateDir, now, tableFn });
  try { console.error('team: уборка отметок процессов — удалено ' + r.removed + (r.skipped ? ' (' + r.skipped + ')' : '')); } catch {}
  return r;
}
module.exports = { run, maybeRun, due, pidOf };
