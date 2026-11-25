'use strict';
// install-gate-simple: проверка на КОПИИ настоящего состояния (урок 17.11: ворота проверялись только на чистом состоянии и не
// прошли на живом). Отдельный скрипт, не входит в полный прогон (нужна копия живого состояния машины пользователя).
//   node tests/install-gate-copy.js [источник=E:\most\state] [копия=<клон>\.state-copy] [список=E:\tmp\install-gate-list.md]
// Источник только читается: копируются карточки (card.json и плоские .json; у Antigravity ещё meta.json и result.txt — для
// штатного восстановления), замки записи (если каталог есть), реестр и состояния сценариев; время изменения сохраняется.
// На копии: холостой прогон → финализация под замками карточек → повтор (пусто) → ворота с настоящей таблицей процессов →
// ворота при «ничего не идёт» → живое поручение-фикстура (одна строка) → нечитаемый замок (технический отказ) → удаление
// «старше недели» через 8 суток.
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const [src = 'E:\\most\\state', dst = path.join(__dirname, '..', '.state-copy'), listFile = 'E:\\tmp\\install-gate-list.md'] = process.argv.slice(2);
process.env.MOST_STATE_DIR = dst; process.env.MOST_REPO_ROOT = path.join(__dirname, '..'); process.env.MOST_NOTIFY = 'off';
delete process.env.MOST_JOB_ID; process.env.MOST_CLIENT = 'claude';
const dj = require('../common/dead-jobs'), kimi = require('../common/members-kimi');
const out = [], log = s => { out.push(s); console.log(s); };

function copyState() {
  fs.rmSync(dst, { recursive: true, force: true });
  let n = 0;
  const copy = (a, b) => { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b); const st = fs.statSync(a); fs.utimesSync(b, st.atime, st.mtime); n++; };
  for (const store of fs.readdirSync(src).filter(x => x === 'jobs' || x.endsWith('-jobs'))) {
    const dir = path.join(src, store);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const names = store === 'jobs' ? ['card.json', 'meta.json', 'result.txt'] : ['card.json'];
        if (!fs.existsSync(path.join(dir, e.name, 'card.json'))) continue;
        for (const f of names) { const p = path.join(dir, e.name, f); if (fs.existsSync(p)) copy(p, path.join(dst, store, e.name, f)); }
      } else if (e.name.endsWith('.json')) copy(path.join(dir, e.name), path.join(dst, store, e.name));
    }
  }
  for (const f of fs.readdirSync(src).filter(x => /^members/.test(x))) { const p = path.join(src, f); if (fs.statSync(p).isFile()) copy(p, path.join(dst, f)); }
  // Gemini д: каталога замков может не быть.
  const lw = path.join(src, 'locks', 'write');
  if (fs.existsSync(lw)) for (const f of fs.readdirSync(lw).filter(x => x.endsWith('.json'))) copy(path.join(lw, f), path.join(dst, 'locks', 'write', f));
  const sc = path.join(src, 'scenarios');
  if (fs.existsSync(sc)) for (const id of fs.readdirSync(sc)) { const p = path.join(sc, id, 'state.json'); if (fs.existsSync(p)) copy(p, path.join(dst, 'scenarios', id, 'state.json')); }
  return n;
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

(async () => {
  log('Копия: ' + copyState() + ' файлов из ' + src + ' (источник только читался)');
  const t0 = Date.now();
  const data = dj.load(dst), table = await dj.tableAsync(dj.pidsOf(data));
  log('Таблица процессов: существующих номеров из карточек и замков — ' + table.size + ', полнота: ' + (table.incomplete || 'да') + ' (' + (Date.now() - t0) + ' мс)');
  const before = dj.survey(dst, { data, table });
  assert.deepEqual(before.incomplete, [], 'снимок полон: ' + before.incomplete.join('; '));
  const liveHashes = before.live.map(({ c }) => [c.file, sha(c.file)]);
  const keptHashes = before.kept.map(({ c }) => [c.file, sha(c.file)]);
  const dry = await dj.finalize(dst, { apply: false, table, data });
  log('Холостой прогон: закрыть ' + dry.closed.length + ', восстановить (Antigravity, готовый результат) ' + dry.recovered.length + ', снять замков ' + dry.locks.length + '; живых карточек ' + dry.live + ', живых замков ' + dry.liveLocks + ', оставить ' + dry.kept.length);
  const keptBy = {}; for (const k of dry.kept) (keptBy[k.reason] = keptBy[k.reason] || []).push(k.who + ' ' + k.id.slice(0, 8) + ' (' + k.status + ')');
  for (const [k, v] of Object.entries(keptBy)) log('  оставлено — ' + k + ': ' + v.length + ' — ' + v.join(', '));
  if (fs.existsSync(listFile)) {
    const text = fs.readFileSync(listFile, 'utf8');
    const ids = [...text.matchAll(/^\| \d+ \| [a-z]+ \| `([^`]+)`/gm)].map(m => m[1]);
    const lockIds = [...text.matchAll(/^\| \d+ \| `([0-9a-f-]{36})` \| `/gm)].map(m => m[1]);
    const closed = new Set([...dry.closed, ...dry.recovered].map(x => x.id)), kept = new Map(dry.kept.map(x => [x.id, x])), live = new Set(before.live.map(({ c }) => String(c.j.id || c.entry)));
    const cards = new Map(data.cards.map(c => [String(c.j.id || c.entry), c]));
    const tally = {};
    for (const id of ids) {
      const c = cards.get(id), k = !c ? 'карточки уже нет' : closed.has(id) ? 'закрывается' : kept.has(id) ? 'оставлена (' + kept.get(id).reason + ')' : live.has(id) ? 'ЖИВАЯ' : 'уже завершена (' + c.j.status + '), в воротах не видна';
      (tally[k] = tally[k] || []).push(id.slice(0, 8));
    }
    log('Список ворот 24.11: карточек ' + ids.length + ', замков ' + lockIds.length);
    for (const [k, v] of Object.entries(tally)) log('  ' + k + ': ' + v.length + ' — ' + v.join(' '));
    const lockClosed = new Set(dry.locks.map(x => x.instance)), liveLocks = new Set(before.liveLocks.map(l => l.entry.instance));
    for (const id of lockIds) log('  замок ' + id.slice(0, 8) + ': ' + (lockClosed.has(id) ? 'снимается' : liveLocks.has(id) ? 'ЖИВОЙ владелец' : 'уже нет'));
  }
  const res = await dj.finalize(dst, { table });
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  assert.deepEqual(res.closed.map(x => x.id).sort(), dry.closed.map(x => x.id).sort(), 'закрыто ровно показанное холостым прогоном');
  assert.deepEqual(res.recovered.map(x => x.id).sort(), dry.recovered.map(x => x.id).sort());
  assert.deepEqual(res.locks.map(x => x.instance).sort(), dry.locks.map(x => x.instance).sort());
  log('Финализация (под замками карточек адаптеров): закрыто ' + res.closed.length + ', восстановлено ' + res.recovered.length + ', снято замков ' + res.locks.length + ', сбоев 0');
  for (const [f, h] of liveHashes) assert.equal(sha(f), h, 'живая карточка не тронута: ' + f);
  for (const [f, h] of keptHashes) assert.equal(sha(f), h, 'оставленная карточка не тронута: ' + f);
  log('Живые (' + liveHashes.length + ') и оставленные (' + keptHashes.length + ') карточки побайтно не изменены');
  const again = dj.survey(dst, { table });
  assert.equal(again.dead.length + again.deadLocks.length, 0, 'после финализации мёртвого не осталось');
  log('Повторная оценка: мёртвых карточек 0, замков мёртвых владельцев 0');
  const g = kimi.installationBlockers(dst, { table });
  log('Ворота сейчас (настоящая таблица процессов): ' + (g.running.length + g.blockers.length ? '\n' + kimi.listText(g).split('\n').map(l => '  ' + l).join('\n') : 'ничего не идёт'));
  // «Живых поручений нет»: таблица без процессов живых карточек и замков.
  const quiet = new Map([...table].filter(([pid]) => !before.live.some(({ a }) => (a.pids || []).includes(pid)) && !before.liveLocks.some(l => l.entry.pid === pid)));
  quiet.checked = table.checked;
  const g0 = kimi.installationBlockers(dst, { table: quiet });
  assert.deepEqual(g0.running, [], JSON.stringify(g0.running)); assert.deepEqual(g0.blockers, []);
  assert.equal(kimi.deployGate(dst, { table: quiet }).ok, true, 'без живого — установка без слова');
  log('Ворота при отсутствии живых поручений: пусто, установка идёт без слова');
  const fx = path.join(dst, 'claude-jobs', 'gate-fixture-live.json');
  fs.writeFileSync(fx, JSON.stringify({ id: 'gate-fixture-live', status: 'running', pid: process.pid, folder: 'E:\\проба\\живая', from: 'claude', startedAt: new Date(Date.now() - 300000).toISOString() }));
  const t1 = new Map([...quiet, [process.pid, Date.now() - 3600000]]); t1.checked = new Set([...(table.checked || []), process.pid]);
  const g1 = kimi.installationBlockers(dst, { table: t1 });
  const text = kimi.refusalText(g1, kimi.listHash(g1), 'console');
  assert.equal(g1.running.length, 1); assert.equal(g1.blockers.length, 0);
  assert.equal(kimi.listText(g1).split('\n').length, 1);
  assert(/Подождать или прервать\?/.test(text));
  log('Живое поручение-фикстура — ворота:\n' + text.split('\n').map(l => '  ' + l).join('\n'));
  fs.unlinkSync(fx);
  // Нечитаемый замок на копии — технический отказ одной строкой.
  const badLock = path.join(dst, 'locks', 'write', 'zz-broken.json');
  fs.mkdirSync(path.dirname(badLock), { recursive: true }); fs.writeFileSync(badLock, '{');
  const tg = kimi.deployGate(dst, { table: quiet });
  assert(tg.technical && !tg.refusal.includes('\n') && /не удалось проверить/.test(tg.refusal), JSON.stringify(tg));
  log('Нечитаемый замок: ' + tg.refusal);
  fs.unlinkSync(badLock);
  const plan = require('../common/cards-autocleanup').plan(dst, path.dirname(src), Date.now() + 8 * 86400000);
  const del = new Set(plan.del.map(x => x.id)), closedIds = [...res.closed, ...res.recovered].map(x => x.id);
  const deletable = closedIds.filter(id => del.has(id));
  log('Через 8 суток уборка «старше недели» удалит из закрытых: ' + deletable.length + ' из ' + closedIds.length + (deletable.length < closedIds.length ? ' (остальные — ссылки открытых работ/изменений/сценариев): ' + closedIds.filter(id => !del.has(id)).map(id => id.slice(0, 8)).join(' ') : ''));
  log('Закрыто (участник · номер · было · причина):');
  for (const x of res.closed) log('  ' + x.who + ' · ' + x.id + ' · ' + x.status + ' · ' + x.reason);
  for (const x of res.recovered) log('  восстановлено: ' + x.who + ' · ' + x.id + ' · ' + x.status);
  log('Снятые замки: ' + (res.locks.map(l => l.instance + ' (' + (l.jobId || 'без поручения') + ', ' + l.folder + ', PID ' + l.pid + ')').join('; ') || 'нет'));
  log('Итого: пройдено 1, провалено 0');
  setTimeout(() => process.exit(0), 200).unref();
})().catch(e => { console.error('FAIL ' + e.stack); console.log('Итого: пройдено 0, провалено 1'); process.exitCode = 1; setTimeout(() => process.exit(1), 200).unref(); });
