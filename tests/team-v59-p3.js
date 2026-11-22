'use strict';
// team-v59 часть 3: простой вопрос консилиуму за секунды + авто-уборка карточек.
//  - краткая сводка на объёме ≈12000 карточек: холодный ≤5 с, повторный ≤1 с, при зависшем источнике квоты ≤3 с;
//  - send роли «совет»: папка необязательна (служебная), имя работы любое (кириллица), незарегистрированная работа принимается;
//  - авто-уборка: старое конечное без ссылок удаляется; моложе недели / неконечное / со ссылкой из открытой работы / с замком — остаются.
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const REPO = path.resolve(__dirname, '..');

function tmp(pfx) { return fs.mkdtempSync(path.join(os.tmpdir(), 'v59p3-' + pfx + '-')); }
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
function card(dir, id, obj, mtimeAgoMs) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, id + '.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  if (mtimeAgoMs != null) { const t = (Date.now() - mtimeAgoMs) / 1000; fs.utimesSync(f, t, t); }
  return f;
}
// Дочерний процесс с заданным MOST_STATE_DIR — честный «холодный» процесс (пустой кэш в памяти).
function child(stateDir, code, extraEnv = {}) {
  return execFileSync(process.execPath, ['-e', code], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, MOST_STATE_DIR: stateDir, MOST_REPO_ROOT: REPO, MOST_CLIENT: 'claude', MOST_JOB_ID: '', NODE_OPTIONS: '', ...extraEnv },
  });
}

const tests = [];
const T = (n, f) => tests.push([n, f]);

// ---- Авто-уборка карточек (дополнение 2) ----
T('авто-уборка: старое конечное без ссылок удаляется; защищённые остаются', () => {
  const uuid = require('crypto').randomUUID;
  const state = tmp('clean'), repo = tmp('clean-repo');
  const cj = path.join(state, 'codex-jobs');
  const WEEK = 8 * 86400000, DAY = 2 * 86400000;
  const id = {}; for (const k of ['oldDone', 'oldFailed', 'young', 'running', 'weird', 'ref', 'lock']) id[k] = uuid();
  card(cj, id.oldDone, { id: id.oldDone, status: 'done' }, WEEK);
  card(cj, id.oldFailed, { id: id.oldFailed, status: 'failed' }, WEEK);
  card(cj, id.young, { id: id.young, status: 'done' }, DAY);              // моложе недели
  card(cj, id.running, { id: id.running, status: 'running' }, WEEK);      // неконечный
  card(cj, id.weird, { id: id.weird, status: 'непонятный' }, WEEK);       // незнакомый статус
  card(cj, id.ref, { id: id.ref, status: 'done' }, WEEK);                 // ссылка из открытой работы
  card(cj, id.lock, { id: id.lock, status: 'done' }, WEEK);               // замок
  fs.writeFileSync(path.join(cj, 'bad.json'), '{ не json'); // нечитаемая — не трогаем
  const bad = path.join(cj, 'bad.json'); const t = (Date.now() - WEEK) / 1000; fs.utimesSync(bad, t, t);
  // открытая работа ссылается на id.ref; замок — на id.lock (номера в формате UUID — так ищет build-plan.js)
  fs.mkdirSync(path.join(repo, 'works'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'works', 'w.json'), JSON.stringify({ name: 'w', closed: false, note: 'см ' + id.ref }));
  fs.mkdirSync(path.join(state, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(state, 'locks', 'l.json'), JSON.stringify({ jobId: id.lock }));

  const clean = require('../common/cards-autocleanup');
  const r = clean.run({ stateDir: state, repoRoot: repo });
  assert.equal(r.removed, 2, 'удалены ровно два старых конечных без ссылок (факт ' + r.removed + ')');
  assert(!fs.existsSync(path.join(cj, id.oldDone + '.json')), 'old-done удалён');
  assert(!fs.existsSync(path.join(cj, id.oldFailed + '.json')), 'old-failed удалён');
  for (const keep of ['young', 'running', 'weird', 'ref', 'lock'])
    assert(fs.existsSync(path.join(cj, id[keep] + '.json')), keep + ' остался');
  assert(fs.existsSync(path.join(cj, 'bad.json')), 'нечитаемая осталась');
  rmrf(state); rmrf(repo);
});

T('авто-уборка: троттлинг раз в сутки (maybeRun)', () => {
  const state = tmp('thr'), repo = tmp('thr-repo');
  const clean = require('../common/cards-autocleanup');
  assert.equal(clean.due(state), true, 'без метки — пора');
  clean.maybeRun({ stateDir: state, repoRoot: repo });
  assert.equal(clean.due(state), false, 'сразу после — не пора');
  assert.equal(clean.due(state, Date.now() + 25 * 3600000), true, 'через сутки — снова пора');
  rmrf(state); rmrf(repo);
});

// ---- Папка необязательна для роли «совет» (п.3в) ----
T('scratch-folder: роль «совет» без папки — служебная; запись требует папку', () => {
  const state = tmp('scr');
  // модуль читает stateDir один раз при require — грузим в дочернем процессе с нужным MOST_STATE_DIR
  const out = child(state, `
    const sf = require(${JSON.stringify(path.join(REPO, 'common/scratch-folder.js'))});
    const a = { role: 'совет', task: 'x' };
    const f = sf.ensure(a);
    const fs = require('fs');
    console.log(JSON.stringify({ scratch: a.scratchFolder === true, exists: fs.existsSync(f), inState: f.includes('scratch') }));
    const b = { role: 'совет', write: true, task: 'x' };
    sf.ensure(b);
    console.log(JSON.stringify({ writeNoFolder: b.folder === undefined }));
    const c = { role: 'совет', folder: ${JSON.stringify(state)}, task: 'x' };
    sf.ensure(c);
    console.log(JSON.stringify({ keepsExplicit: c.folder === ${JSON.stringify(state)}, notScratch: !c.scratchFolder }));
  `);
  const [r1, r2, r3] = out.trim().split('\n').map(JSON.parse);
  assert(r1.scratch && r1.exists && r1.inState, 'совет без папки → служебная папка создана: ' + JSON.stringify(r1));
  assert(r2.writeNoFolder, 'write=true без папки — служебную НЕ подставляем (останется прежний отказ)');
  assert(r3.keepsExplicit && r3.notScratch, 'явная папка сохраняется');
  rmrf(state);
});

// ---- Диск-индекс + объём ≈12000: холодный ≤5с, повторный ≤1с ----
T('индекс карточек: 12000 — холодный ≤5с, повторный ≤1с', () => {
  const state = tmp('idx12k');
  const cj = path.join(state, 'codex-jobs');
  fs.mkdirSync(cj, { recursive: true });
  const old = new Date(Date.now() - 3 * 86400000).toISOString(); // >24ч → стабильная
  const t = (Date.now() - 3 * 86400000) / 1000;
  for (let i = 0; i < 12000; i++) {
    const f = path.join(cj, 'j' + i + '.json');
    fs.writeFileSync(f, JSON.stringify({ id: 'j' + i, status: 'done', startedAt: old }));
    fs.utimesSync(f, t, t);
  }
  const scanCode = `
    const s = require(${JSON.stringify(path.join(REPO, 'common/team-store.js'))});
    const a = Date.now(); const r = s.list('codex', false); console.log('T ' + (Date.now()-a) + ' N ' + r.jobs.length);
  `;
  // pass1 — строит индекс (не замеряем как холодный). pass2 — честный холодный процесс с индексом на диске.
  child(state, scanCode);
  assert(fs.existsSync(path.join(state, 'scan-index')), 'индекс на диске создан');
  const cold = child(state, scanCode);
  const coldMs = Number(/T (\d+)/.exec(cold)[1]), coldN = Number(/N (\d+)/.exec(cold)[1]);
  assert.equal(coldN, 12000, 'все карточки видны');
  assert(coldMs <= 5000, 'холодный проход с индексом ≤5с, факт ' + coldMs + 'мс');
  // повторный в ТОМ ЖЕ процессе (кэш в памяти прогрет)
  const warm = child(state, scanCode.replace('const a = Date.now();', 's.list("codex", false); const a = Date.now();'));
  const warmMs = Number(/T (\d+)/.exec(warm)[1]);
  assert(warmMs <= 1000, 'повторный проход ≤1с, факт ' + warmMs + 'мс');
  console.log('      (12000: холодный ' + coldMs + 'мс, повторный ' + warmMs + 'мс)');
  rmrf(state);
});

// ---- Квота с зависшим источником: ответ ≤3с ----
T('квота: зависший источник — краткая сводка не ждёт (≤3с), локальное свежее + внешнее из кэша', () => {
  const state = tmp('quota');
  // Реестр участников нужен для сборки строки квот (локальные части считаются на месте).
  const copy = 'E:\\Codex\\work\\v59-owner-word\\state-copy';
  for (const f of ['members.json', 'members-log.jsonl', 'members.json.last-good'])
    try { fs.copyFileSync(path.join(copy, f), path.join(state, f)); } catch {}
  const teamDir = path.join(state, 'team'); fs.mkdirSync(teamDir, { recursive: true });
  // Прошлый снимок ВНЕШНИХ частей (codex/agy) в кэше — их отдаём мгновенно, пометив «обновляются».
  fs.writeFileSync(path.join(teamDir, 'quota-ext-cache.json'), JSON.stringify({ codexText: 'ПРОШЛЫЙ-CODEX-СНИМОК', agyText: 'ПРОШЛЫЙ-AGY', at: new Date(Date.now() - 10 * 60000).toISOString() }));
  const out = child(state, `
    const ql = require(${JSON.stringify(path.join(REPO, 'common/quota-line.js'))});
    const a = Date.now();
    ql.quotaLine({ state: ${JSON.stringify(teamDir)}, budgetMs: 2000 }).then(line => {
      console.log(JSON.stringify({ ms: Date.now()-a, line }));
    }).catch(e => console.log(JSON.stringify({ err: String(e.message) })));
  `, { MOST_QUOTA_REFRESH_THROTTLE_MS: '999999' }); // не плодить досчёт
  const r = JSON.parse(out.trim());
  assert(!r.err, 'строка собрана без ошибки: ' + r.err);
  assert(r.ms <= 3000, 'ответ ≤3с при зависшем источнике, факт ' + r.ms + 'мс');
  assert(r.line.includes('ПРОШЛЫЙ-CODEX-СНИМОК'), 'внешняя часть взята из прошлого снимка: ' + r.line);
  assert(/обновляются в фоне/.test(r.line), 'помечено, что внешние обновляются: ' + r.line);
  rmrf(state);
});

// ---- Имя работы любое + незарегистрированная работа у роли «совет» (п.3а,3б) ----
T('совет: имя работы любое (кириллица) и незарегистрированная — принимается ярлыком, без привязки', () => {
  const repo = tmp('work-repo'); fs.mkdirSync(path.join(repo, 'works'), { recursive: true });
  const out = child(tmp('wstate'), `
    const sg = require(${JSON.stringify(path.join(REPO, 'common/stage-gate.js'))});
    const root = ${JSON.stringify(repo)};
    (async () => {
      const res = {};
      for (const [k, work] of [['cyr', 'Вопрос про 2+2'], ['unreg', 'nonexistent-work-xyz']]) {
        const a = { role: 'совет', task: '2+2?', work };
        try { await sg.prepareJob(a, 'codex', root); res[k] = { ok: true, workLabel: a.workLabel, work: a.work, unbound: a.workUnbound === true }; }
        catch (e) { res[k] = { ok: false, err: String(e.message).slice(0, 80) }; }
      }
      console.log(JSON.stringify(res));
    })();
  `);
  const r = JSON.parse(out.trim());
  assert(r.cyr.ok, 'кириллическое имя работы не отклонено: ' + JSON.stringify(r.cyr));
  assert(r.cyr.unbound && r.cyr.work === undefined && r.cyr.workLabel === 'Вопрос про 2+2', 'кириллица → ярлык без привязки: ' + JSON.stringify(r.cyr));
  assert(r.unreg.ok && r.unreg.unbound && r.unreg.workLabel === 'nonexistent-work-xyz', 'незарегистрированная → ярлык: ' + JSON.stringify(r.unreg));
  rmrf(repo);
});

run();
async function run() {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('OK ' + n); }
    catch (e) { failed++; console.error('FAIL ' + n + '\n' + (e.stack || e.message)); }
  }
  console.log('Итого: пройдено ' + (tests.length - failed) + ', провалено ' + failed);
  process.exitCode = failed ? 1 : 0;
}
