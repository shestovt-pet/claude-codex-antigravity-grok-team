'use strict';
// node tools/acceptance-report.js E:\most\works — только чтение, без Team.work/уведомлений.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '../works'));
Object.assign(process.env, { MOST_REPO_ROOT: path.dirname(dir), MOST_STATE_DIR: path.join(path.dirname(dir), 'state'),
  MOST_CODEX_JOBS_DIR: path.join(path.dirname(dir), 'state/codex-jobs'), MOST_CODEX_ARCHIVE_DIR: '', MOST_CLIENT: 'claude' });
delete process.env.MOST_AUTHORITY;
// Запрет записи распространяется и на вызываемые модули. Ошибка чтения не даёт разрешения чинить состояние.
for (const method of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync',
  'truncateSync', 'copyFileSync', 'writeSync', 'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'truncate', 'copyFile', 'createWriteStream'])
  fs[method] = () => { throw Error('Отчёт только для чтения: ' + method); };
const open = fs.openSync;
fs.openSync = (file, flags, ...args) => {
  if (flags !== 'r' && flags !== fs.constants.O_RDONLY) throw Error('Отчёт только для чтения: open ' + flags);
  return open(file, flags, ...args);
};
for (const method of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'truncate', 'copyFile', 'open'])
  fs.promises[method] = async () => { throw Error('Отчёт только для чтения: promises.' + method); };
const gate = require('../common/stage-gate'), view = require('../common/acceptance');
const percent = w => Math.round(w.stages.filter(s => s.state === 'принят').reduce((n, s) => n + s.weight, 0) * 100) / 100;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function calculate(w, historical, jobs, snapshot) {
  const result = structuredClone(w);
  for (const s of result.stages.filter(s => s.level && (historical || ['принят', 'выдан без принятия'].includes(s.state)))) {
    const old = structuredClone(s); s.gate ||= { files: [], reasons: [] };
    // Новый способ — как Team.refreshWork: принятые/выданные — evaluate, остальные — только восстановление.
    try { s.gate.message = !historical ? await gate.evaluateCurrent(result, s, old, jobs, snapshot)
      : ['принят', 'выдан без принятия'].includes(s.state) ? await gate.evaluate(result, s, old, jobs, snapshot) : view.restoreOnly(result, s, old, jobs, snapshot); }
    catch (e) {
      const unreadable = e.code === 'STAGE_READ_FAILED' || ['EACCES', 'EPERM', 'ENOENT', 'EBUSY', 'EIO'].includes(e.code);
      s.state = unreadable ? old.state : old.state === 'выдан без принятия' ? old.state : 'идёт';
      s.gate.message = e.message;
    }
  }
  return result;
}
(async () => {
  const files = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort();
  const before = new Map(files.map(n => [n, fs.readFileSync(path.join(dir, n))]));
  const snapshot = require('../common/job-snapshot').create(), jobs = gate.allJobs(snapshot);
  console.log('Приёмка: было → стало (старый пересчёт → историческая приёмка)');
  console.log('Фаза ' + require('../common/members').phase() + '; доступные голосующие в среде отчёта: ' + Object.keys(require('../common/members').seats).join(', '));
  if (require('../common/members').phase() === 'B' && !require('../common/dsh-probe').ok())
    console.log('Ограничение: текущая версия dsh не подтверждена в этой среде; старый пересчёт не включает DeepSeek. Проценты могут отличаться от работающего сервера с подтверждённым dsh.');
  for (const file of files) {
    try {
      const w = JSON.parse(before.get(file));
      const old = await calculate(w, false, jobs, snapshot), next = await calculate(w, true, jobs, snapshot);
      const changes = next.stages.flatMap((s, i) => {
        const previous = old.stages[i];
        const detail = view.stageText(next, s);
        if (s.state !== previous.state) return [s.title + ': ' + (s.acceptance?.restored_from ? 'восстановлено из ' + s.acceptance.restored_from : 'сохранена приёмка прежнего состава') + '; старый пересчёт: ' + previous.gate?.message];
        return detail ? [s.title + ': ' + detail] : [];
      });
      console.log(file + ': ' + percent(old) + ' % → ' + percent(next) + ' %; ' + (changes.join(' | ') || 'разницы нет'));
      if (w.name === 'vampires-text') console.log('  vampires-text: прежние 85 % не восстанавливаются; сохранено решение пользователя от 14.10 «выдать без принятия».');
    } catch (e) { console.log(file + ': ошибка: ' + e.message); process.exitCode = 1; }
  }
  for (const [file, bytes] of before) if (hash(bytes) !== hash(fs.readFileSync(path.join(dir, file)))) throw Error('Карточка изменилась во время отчёта: ' + file);
  console.log('Проверено: ' + files.length + ' карточек; sha256 до/после совпадают. Запись запрещена.');
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
