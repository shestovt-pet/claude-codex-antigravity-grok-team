'use strict';
// Только чтение: этот раздел сводки не обновляет карточки, готовность или установку.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
function git(root, args) {
  const r = spawnSync('git', ['--no-optional-locks', '-c', 'safe.directory=' + root, ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) throw Error('Не удалось проверить git: ' + args[0]);
  return r.stdout.trim();
}
function lines(root, state) {
  const rows = [], deployedPath = path.join(root, 'live', 'deployed.json');
  let deployed;
  if (fs.existsSync(deployedPath)) {
    deployed = JSON.parse(fs.readFileSync(deployedPath, 'utf8'));
    const commit = deployed.commit;
    let head, ancestor = false;
    try {
      if (!/^[a-f0-9]{7,40}$/i.test(commit || '')) throw Error('Неизвестный коммит');
      const full = git(root, ['rev-parse', '--verify', commit + '^{commit}']);
      head = git(root, ['rev-parse', '--verify', 'main^{commit}']);
      if (full === head) ancestor = true;
      else { git(root, ['merge-base', '--is-ancestor', full, head]); ancestor = true;
        rows.push('Работающая версия отстаёт от main, ждёт установки'); }
    } catch { /* Неизвестный объект и отдельная ветка — один вид расхождения. */ }
    if (!ancestor) rows.push('⚠ Работающая версия ' + String(commit || 'неизвестна') + ' не из main: установлена ' +
      (deployed.method || 'способ не записан') + ', ' + (deployed.at || 'время неизвестно'));
  } else rows.push('Последнее развёртывание: не записано (нет deployed.json)');
  const ready = path.join(state, 'ready');
  if (fs.existsSync(ready)) {
    const releases = fs.readdirSync(ready).filter(n => n.endsWith('.json')).map(n => {
      const rec = JSON.parse(fs.readFileSync(path.join(ready, n), 'utf8'));
      return rec.release && path.resolve(rec.release);
    });
    const expected = deployed?.release ? path.resolve(deployed.release) : deployed?.commit && path.resolve(root, 'live', deployed.commit);
    if (releases.length && (!expected || releases.some(r => !r || r.toLowerCase() !== expected.toLowerCase())))
      rows.push('⚠ Серверы запущены не из записанной установки');
  }
  // -z сохраняет имена с переводами строк и нелатинскими символами; rename содержит второй путь.
  const r = spawnSync('git', ['--no-optional-locks', '-c', 'safe.directory=' + root, 'status', '--porcelain=v1', '-z', '-uall'],
    { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) throw Error('Не удалось проверить несохранённые изменения кода.');
  const records = r.stdout.split('\0'); let count = 0;
  const ignored = p => /^(works|_handoff)\//.test(p.replaceAll('\\', '/'));
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]; if (!rec) continue;
    // Как в cleanup: исключаем только неотслеживаемые результаты прогона.
    // Одноимённые отслеживаемые исходники остаются изменениями кода.
    if (/^\?\? tests\/(\.tmp-|windows-test-output-[^/]*\.txt$)/.test(rec)) continue;
    const renamed = /[RC]/.test(rec.slice(0, 2));
    const paths = [rec.slice(3), ...(renamed ? [records[++i]] : [])];
    if (paths.some(p => p && !ignored(p))) count++;
  }
  if (count) rows.push('⚠ В C:\\most несохранённые изменения кода: ' + count + ' файлов');
  return rows;
}
module.exports = { lines };
