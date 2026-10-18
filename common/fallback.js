'use strict';
// Запасной режим «Claude отвалился» (team-v19, Р-в — Р-ж, К1–К6, К4а): отличие чата от поручения, сеанс дирижёра,
// права при вызове, баннер, снимок открытых работ и запуск Claude Desktop. Журнал — common/user-word.js.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const words = () => require('./user-word');
const access = () => require('./access');
const paths = () => require('./paths');
const NAMES = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', grok: 'Grok' };
const FAMILY = { codex: 'openai', antigravity: 'google', grok: 'xai', claude: 'anthropic' };
const SEATS = ['codex', 'antigravity'];
const release = () => path.resolve(__dirname, '..');
const stateDir = () => paths().stateDir;
const two = n => String(n).padStart(2, '0');
const hhmm = at => { const d = new Date(at); return two(d.getHours()) + ':' + two(d.getMinutes()); };
// Способ отличить чат Antigravity от его поручения не подтверждён живой пробой (К2 п. 2): до пробы Antigravity слово о
// Claude не записывает и дирижёром не бывает. Тесты включают его подменой (NODE_ENV=test, MOST_TEST_AGY_PROBE=1).
// Отказ гостю начинается прежней фразой access.guard (tests/team-v14.js КР1 Н7), дальше — пояснение.
const DENY = 'Гостю это действие запрещено: ';
const deny = text => DENY + text[0].toLowerCase() + text.slice(1);
const probe = { agy: process.env.NODE_ENV === 'test' && process.env.MOST_TEST_AGY_PROBE === '1' };

// Таблица процессов: Windows — CIM, Linux — /proc. Подмена в тестах — MOST_TEST_PROCESS_TREE (только NODE_ENV=test).
let tableCache = null;
// commandLine — для К12 (командные строки процессов-гостей), без кэша.
function processTable(fresh = false, opts = {}) {
  // Подмена в тестах; pid «self» — процесс, который читает таблицу (гость, запущенный тестом).
  if (process.env.NODE_ENV === 'test' && process.env.MOST_TEST_PROCESS_TREE)
    return JSON.parse(process.env.MOST_TEST_PROCESS_TREE).map(r => ({ ...r, pid: r.pid === 'self' ? process.pid : r.pid, ppid: r.ppid === 'self' ? process.pid : r.ppid }));
  const cmd = !!opts.commandLine;
  if (!fresh && !cmd && tableCache && Date.now() - tableCache.at < 30000) return tableCache.rows;
  let rows = [];
  if (process.platform === 'win32') {
    const out = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name," + (cmd ? 'CommandLine,' : '') + "@{n='Start';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}} | ConvertTo-Json -Compress"],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 64e6 });
    rows = [].concat(JSON.parse(out || '[]')).map(r => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, startedAt: r.Start || null, ...(cmd ? { commandLine: r.CommandLine || '' } : {}) }));
  } else if (fs.existsSync('/proc/self/stat')) {
    const boot = Number((fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m) || [])[1]) * 1000, tick = 100;
    for (const n of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
      try {
        const stat = fs.readFileSync('/proc/' + n + '/stat', 'utf8'), close = stat.lastIndexOf(')');
        const rest = stat.slice(close + 2).split(' ');
        rows.push({ pid: Number(n), ppid: Number(rest[1]), name: stat.slice(stat.indexOf('(') + 1, close), startedAt: new Date(boot + Number(rest[19]) / tick * 1000).toISOString(),
          ...(cmd ? { commandLine: fs.readFileSync('/proc/' + n + '/cmdline', 'utf8').split('\0').join(' ').trim() } : {}) });
      } catch {}
    }
  }
  if (!cmd) tableCache = { at: Date.now(), rows };
  return rows;
}
// Предки процесса гостя считаются один раз (Н7).
let chainCache = null;
function ancestors() {
  if (chainCache) return chainCache;
  const table = processTable(), byPid = new Map(table.map(r => [r.pid, r])), chain = [];
  let cur = byPid.get(process.pid);
  for (let n = 0; cur && n < 64; n++) {
    const parent = byPid.get(cur.ppid);
    if (!parent || chain.some(p => p.pid === parent.pid)) break;
    chain.push({ pid: parent.pid, startedAt: parent.startedAt, name: parent.name });
    cur = parent;
  }
  return (chainCache = chain);
}
function reset() { tableCache = null; chainCache = null; }
// JSON с BOM: итог запуска пишет Windows PowerShell (Out-File -Encoding utf8) — BOM снимается до разбора (Codex 1c35bf39 п. 6).
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const ready = name => readJson(path.join(stateDir(), 'ready', name + '.json'));
// Тот же процесс: PID совпал, процесс стартовал не позже записи ready и не раньше чем за 10 минут до неё (Windows отдаёт PID заново).
function sameStart(processStart, readyAt) {
  const a = Date.parse(processStart), b = Date.parse(readyAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return a <= b + 5000 && b - a < 600000;
}
// Не поручение (Р-ж, К2 п. 1; Codex 1c35bf39 п. 2, Codex 7a3bd85b п. 1) — для поручений, переноса, отмены и слова гостя:
// (а) нет MOST_JOB_ID; (б) запись state\ready\team.json прочитана — нет файла, он не читается или JSON повреждён — отказ;
// (в) отпечаток снят и PID основного сервера из записей ready (со сверкой времени старта) не среди предков. Отказ по умолчанию.
// Релиз здесь не сверяется: поручение прежнего основного сервера отсекают предки, а гости открытых приложений после
// следующей установки не теряют обычные поручения (помощник Н1). Релиз — только в chatProof.
function readyRecord(name) {
  try { const r = JSON.parse(fs.readFileSync(path.join(stateDir(), 'ready', name + '.json'), 'utf8').replace(/^\uFEFF/, '')); return r && typeof r === 'object' ? r : null; }
  catch { return null; }
}
function jobProof() {
  if (process.env.MOST_JOB_ID) return { ok: false, job: true, reason: 'это поручение-сеанс, а не чат' };
  const main = readyRecord('team');
  if (!main || !Number.isInteger(main.pid)) return { ok: false, reason: 'запись основного сервера (state\\ready\\team.json) не прочитана' };
  let chain;
  try { chain = ancestors(); } catch { return { ok: false, reason: 'не удалось снять отпечаток процесса' }; }
  if (!chain.length) return { ok: false, reason: 'не удалось снять отпечаток процесса' };
  for (const name of ['team', 'codex', 'antigravity', 'grok']) {
    const r = ready(name), hit = r?.pid && chain.find(p => p.pid === r.pid);
    if (hit && sameStart(hit.startedAt, r.startedAt)) return { ok: false, job: true, reason: 'среди предков — основной сервер ' + name + ': это поручение' };
  }
  return { ok: true, fingerprint: { pid: chain[0].pid, startedAt: chain[0].startedAt || null }, parent_name: chain[0].name || null };
}
// Чат, а не поручение, — для слова о Claude и прав дирижёра: те же три условия, запись ready обязательна; Antigravity — после пробы.
function chatProof(client = access().client()) {
  if (!SEATS.includes(client)) return { ok: false, reason: 'слово о Claude записывает чат Codex или Antigravity' };
  if (process.env.MOST_JOB_ID) return { ok: false, job: true, reason: 'это поручение-сеанс, а не чат' };
  if (client === 'antigravity' && !probe.agy) return { ok: false, reason: 'способ отличить чат Antigravity от поручения не подтверждён пробой' };
  const main = readyRecord('team');
  if (!main?.release) return { ok: false, reason: 'нет записи основного сервера (state\\ready\\team.json)' };
  if (!paths().samePath(main.release, release())) return { ok: false, release: true, reason: 'основной сервер другого релиза' };
  return jobProof();
}
// Строка отказа при недоказанном чате: другой релиз — сервер чата от прошлой установки (помощник Н2), иначе — «скажи в чате Codex».
function proofRefusal(proof, lead = '') {
  if (proof.release) return deny(lead + 'Сервер этого чата от прошлой установки — перезапусти приложение (' + proof.reason + ').');
  return deny(lead + (lead ? 'не' : 'Не') + ' могу подтвердить, что это чат (' + proof.reason + '), — скажи это в чате Codex.');
}
const sameFingerprint = (a, b) => !!a && !!b && a.pid === b.pid && (a.startedAt || null) === (b.startedAt || null);
function fingerprintAlive(fp, fresh = true) {
  if (!fp) return false;
  try {
    const p = processTable(fresh).find(r => r.pid === fp.pid);
    return !!p && (!fp.startedAt || !p.startedAt || Math.abs(Date.parse(p.startedAt) - Date.parse(fp.startedAt)) < 2000);
  } catch { return true; }
}
const LABEL = /^fallback-(codex|antigravity)-[a-zа-яё0-9]{4}$/i;
// Сеанс дирижёра у этого вызова: гость-чат той же семьи, тот же отпечаток процесса и та же метка owner.
function session(a = {}) {
  const acc = access(), client = acc.client();
  if (!acc.guest() || !SEATS.includes(client)) return null;
  const m = words().mode();
  if (!(m.active || m.returned) || m.conductor !== client || !a.owner || a.owner !== m.owner) return null;
  const proof = chatProof(client);
  if (!proof.ok || !sameFingerprint(proof.fingerprint, m.fingerprint)) return null;
  return { ...m, client };
}
// Права дирижёра, которые снимают прежние запреты гостю (access.guard).
function conductorAllows(server, tool, a = {}) {
  const s = session(a);
  if (!s) return false;
  if (s.active) return tool === 'team_work' || tool === 'codex_send' || tool === 'antigravity_apply' || /_(send|cancel|status|result)$/.test(tool);
  // После return, до claim Claude: только итог в next_step и handover (Н4).
  return tool === 'team_work' && a.action === 'update' && Object.keys(a).every(k => ['action', 'name', 'owner', 'expected_revision', 'next_step', 'status_sent'].includes(k) || a[k] === undefined);
}
function refusalText(m) {
  return 'Запасной режим: пользователь сказал в чате ' + NAMES[m.word.recorded_by] + ' „' + m.word.quote + '“ (' + hhmm(m.since) + '); дирижёр — ' + NAMES[m.conductor] +
    '. Ничего не меняй. Режим снимается только по новой реплике пользователя тебе: team_word return quote=<дословно>';
}
// Права при вызове (К2, Р-д). Регистрация — access.allowed, здесь — условие «режим активен и ты дирижёр».
function guard(server, tool, a = {}) {
  const acc = access(), client = acc.client(), send = /_send$/.test(tool);
  if (!acc.guest()) {
    const m = words().mode();
    if (!m.active) return;
    const read = tool === 'team_status' || tool === 'team_rules' || /_(status|result)$/.test(tool) ||
      (tool === 'team_work' && ['get', 'list'].includes(a.action)) || (tool === 'team_change' && ['diff', 'precheck', 'list'].includes(a.action)) ||
      (tool === 'team_word' && ['list', 'return'].includes(a.action));
    // Перенос и отмена — тоже изменения (Codex 1c35bf39 п. 1); очередь дирижёра основной сервер исполняет без guard.
    if ((['team_work', 'team_change', 'team_word'].includes(tool) && !read) || (send && a.work) || (tool === 'codex_send' && a.write) ||
        tool === 'antigravity_apply' || /_cancel$/.test(tool)) throw Error(refusalText(m));
    return;
  }
  if ((tool === 'team_word' && a.action !== 'list') || send || tool === 'antigravity_apply' || /_cancel$/.test(tool)) {
    const proof = jobProof();
    if (!proof.ok) throw Error(proofRefusal(proof, 'Поручение-сеанс этого не делает: слово, поручения и перенос — только из чата; '));
  }
  // team-v25: jobProof выше обязателен для каждой отправки и отмены.
  // В активном запасном режиме сохраняются прежние права дирижёра.
  if (client === 'codex' && server === 'codex' &&
      ['codex_send', 'codex_status', 'codex_result', 'codex_cancel'].includes(tool) &&
      (!words().mode().active || ['codex_status', 'codex_result'].includes(tool))) return;
  const own = SEATS.includes(client) && client === server;
  if (own || tool === 'antigravity_apply' || /_cancel$/.test(tool)) {
    const s = session(a);
    if (!s?.active) throw Error(deny('Сервер своей семьи, перенос и отмена — только у дирижёра запасного режима (rules/fallback.md).'));
  }
}
// Гость своего релиза: показывает коммит и расхождение с live\deployed.json (К12).
function releaseLine(mine = path.basename(release())) {
  if (!access().guest()) return '';
  const deployed = readJson(path.join(paths().repoRoot, 'live', 'deployed.json'));
  if (!deployed?.commit || !/^[a-f0-9]{40}$/.test(mine) || deployed.commit === mine) return '';
  return 'Гость связки работает со старым релизом ' + mine.slice(0, 8) + ' (установлен ' + deployed.commit.slice(0, 8) + '): перезапустите приложение.';
}
function launchLine() {
  const dir = path.join(stateDir(), 'fallback');
  if (!fs.existsSync(dir)) return '';
  const last = fs.readdirSync(dir).filter(n => /^launch-.*\.json$/.test(n)).sort().at(-1);
  const l = last && readJson(path.join(dir, last));
  if (!l) return '';
  const r = l.result && readJson(l.result);
  if (r?.success === true) return 'Claude Desktop: серверы готовы.';
  if (r?.success === false || Date.now() - Date.parse(l.at) > 360000) return 'Claude Desktop: серверы не поднялись за 5 минут — поручения ждут.';
  return 'Claude Desktop: запускается (' + hhmm(l.at) + ').';
}
// Баннер — первой строкой каждого ответа основного сервера и гостя (К6).
function banner(scope = {}) {
  let m;
  try { m = words().mode(); } catch { return ''; }
  const out = [], guest = access().guest(), client = access().client();
  if (m.active) {
    out.push('Запасной режим: дирижёр ' + NAMES[m.conductor] + ' с ' + hhmm(m.since) + ' (слово „' + m.word.quote + '“, ' + m.word.id + ')' + (m.owner ? '; чат с меткой ' + m.owner : ''));
    const launch = launchLine();
    if (launch) out.push(launch);
    const snap = readSnapshot(m.word.id), lost = snapshotLine(snap);
    if (lost) out.push(lost);
    let changed = '';
    try { changed = snap && !snap.error ? drift(m.word.id) : ''; } catch {}
    if (changed) out.push(changed);
    if (guest && SEATS.includes(client)) {
      if (session(scope)) out.push('Ты дирижёр: правила — team_rules part=fallback');
      else if (client === m.conductor) {
        out.push('Дирижёр — чат ' + NAMES[m.conductor] + ' с меткой ' + m.owner + '; если метка не твоя — ты участник.');
        if (!fingerprintAlive(m.fingerprint, false)) out.push('Прежний сеанс дирижёра завершён: если пользователь пишет тебе — team_word rebind quote=<его реплика> owner=<новая метка>.');
      }
    }
  } else if (m.returned && !m.handover && guest && session(scope))
    out.push('Claude вернулся в ' + hhmm(m.returned.at) + ' — остановись: итог в team_work next_step, затем team_word handover');
  const rel = releaseLine();
  if (rel) out.push(rel);
  return out.join('\n');
}

// Снимок открытых работ при первом слове о Claude (К4а): этапы и их material с sha256 — и только они; копии файлов material
// по хешу — в state\fallback\snapshot-<word>\ (к-кандидату п. 6: правка файла после слова не ломает продолжение).
const copyDir = wordId => path.join(stateDir(), 'fallback', 'snapshot-' + wordId);
function snapshot(word) {
  const root = paths().repoRoot, dir = path.join(root, 'works'), works = [], store = copyDir(word.id);
  if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir).filter(n => /^[a-z0-9-]{1,40}\.json$/.test(n))) {
    const w = readJson(path.join(dir, n));
    if (!w || w.closed || !Array.isArray(w.stages)) continue;
    works.push({ name: w.name || n.slice(0, -5), folder: w.folder || null, stages: w.stages.filter(s => s.state !== 'принят').map(s => ({ id: s.id, title: s.title, author: s.author, state: s.state,
      weight: s.weight, material: (s.material || []).map(f => {
        const file = path.resolve(w.folder || root, f);
        let sha256 = null;
        try {
          const bytes = fs.readFileSync(file);
          sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
          fs.mkdirSync(store, { recursive: true });
          if (!fs.existsSync(path.join(store, sha256))) fs.writeFileSync(path.join(store, sha256), bytes);
        } catch {}
        return { path: f, sha256 };
      }) })) });
  }
  const file = path.join(stateDir(), 'fallback', 'snapshot-' + word.id + '.json');
  require('./team-git').atomic(file, JSON.stringify({ word: word.id, at: new Date().toISOString(), works }, null, 2) + '\n');
  return file;
}
function readSnapshot(wordId) { return readJson(path.join(stateDir(), 'fallback', 'snapshot-' + wordId + '.json')); }
// Файлы material из снимка, изменённые после слова (строка баннера). Хеш пересчитывается только при смене размера или времени.
const driftCache = new Map();
function drift(wordId) {
  const snap = readSnapshot(wordId), changed = new Set();
  for (const w of snap?.works || []) for (const s of w.stages || []) for (const f of s.material || []) {
    if (!f.sha256) continue;
    const file = path.resolve(w.folder || paths().repoRoot, f.path);
    let now = null;
    try {
      const st = fs.statSync(file), key = st.size + ':' + st.mtimeMs, hit = driftCache.get(file);
      now = hit?.key === key ? hit.sha : crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      driftCache.set(file, { key, sha: now });
    } catch {}
    if (now !== f.sha256) changed.add(f.path);
  }
  const list = [...changed];
  return list.length ? 'После слова изменены файлы этапов: ' + list.slice(0, 5).join(', ') + (list.length > 5 ? ' и ещё ' + (list.length - 5) : '') +
    ' — этап-продолжение возьмёт их копии из снимка.' : '';
}

// Claude Desktop закрыт или без серверов (К5): запуск или перезапуск, не чаще раза в 10 минут, окружение гостя не передаётся.
async function launchDesktop(deps = {}) {
  // Тесты запускают Claude Desktop только подменой: настоящий перезапуск закрыл бы приложение на компьютере.
  if (process.env.NODE_ENV === 'test' && !deps.restart && !deps.restartDeps?.launch) return 'Claude Desktop: запуск в тестах — только подменой.';
  const dir = path.join(stateDir(), 'fallback');
  fs.mkdirSync(dir, { recursive: true });
  const last = fs.readdirSync(dir).filter(n => /^launch-.*\.json$/.test(n)).sort().at(-1), prev = last && readJson(path.join(dir, last));
  if (prev && Date.now() - Date.parse(prev.at) < 600000) return '';
  const ev = (deps.evaluate || require('./fallback-detect').evaluate)({ sharedStateDir: stateDir() });
  const team = ready('team');
  let teamAlive = false;
  try { teamAlive = !!team?.pid && processTable(true).some(p => p.pid === team.pid && sameStart(p.startedAt, team.startedAt)); } catch {}
  if (ev.desktopAlive && teamAlive) return '';
  const kind = ev.desktopAlive ? 'restart' : 'start';
  const record = { at: new Date().toISOString(), kind };
  try {
    const out = await (deps.restart || require('./restart').restart)({ root: paths().repoRoot, release: release(), state: stateDir(), close: kind === 'restart' }, deps.restartDeps || {});
    record.result = typeof out === 'object' ? out.result : (String(out).match(/итог — уведомлением Windows и в (.+)$/)?.[1] || '').trim() + '.json';
  } catch (e) { record.error = e.message; }
  require('./team-git').atomic(path.join(dir, 'launch-' + record.at.replace(/[:.]/g, '-') + '.json'), JSON.stringify(record, null, 2) + '\n');
  if (record.error) return 'Claude Desktop не запускается — поручения ждут (' + record.error + ').';
  return kind === 'start' ? 'Открываю Claude Desktop — серверы связки живут в нём.' : 'Claude Desktop открыт без серверов связки — перезапускаю его.';
}

// team_word о Claude: первое слово, второй чат, возврат, остановка, перепривязка. Проверка режима и запись — под одним
// замком журнала (Codex 1c35bf39 п. 3); снимок — у каждой записи, которая включает режим.
async function word(a, deps = {}) {
  const acc = access(), W = words(), client = acc.client();
  if (typeof a.quote !== 'string' || !a.quote.trim()) { if (a.action !== 'handover') throw Error('Нужна реплика пользователя дословно (quote).'); }
  const off = () => Error(acc.guest() ? deny('Запасной режим не действует.') : 'Запасной режим не действует.');
  if (a.action === 'record') {
    if (!acc.guest() || client === 'claude') throw Error('О себе Claude слово не записывает.');
    const proof = chatProof(client);
    if (!proof.ok) throw Error(proofRefusal(proof));
    const out = await W.transact(({ mode, write }) => {
      const m = mode();
      if (m.active) {
        write({ kind: 'record', who_down: 'claude', quote: a.quote, source: 'chat-' + client, recorded_by: client, owner: a.owner || null, fingerprint: proof.fingerprint, participant: true });
        return { m };
      }
      if (!LABEL.test(a.owner || '') || !a.owner.toLowerCase().startsWith('fallback-' + client + '-')) throw Error('Нужна метка сеанса owner=fallback-' + client + '-<4 буквы>.');
      return { r: write({ kind: 'record', who_down: 'claude', quote: a.quote, source: 'chat-' + client, recorded_by: client, owner: a.owner,
        fingerprint: proof.fingerprint, parent_name: proof.parent_name, release: path.basename(release()) }) };
    });
    if (out.m) return 'Дирижёр уже ' + NAMES[out.m.conductor] + ' (слово в ' + hhmm(out.m.since) + '); я — участник.';
    const lines = [takeSnapshot(out.r, deps)];
    try { lines.push(await launchDesktop(deps)); } catch (e) { lines.push('Claude Desktop: проверка не удалась (' + e.message + ').'); }
    return 'Записал: „' + a.quote + '“ — Claude недоступен; дирижёр — ' + NAMES[client] + ', пока Claude не вернётся.' + lines.filter(Boolean).map(l => '\n' + l).join('');
  }
  if (a.action === 'return') {
    return W.transact(({ mode, write }) => {
      if (!mode().active) throw off();
      const by = !acc.guest() ? 'claude' : session(a)?.active ? client : null;
      if (!by) throw Error(deny('Возврат Claude записывает Claude или дирижёр.'));
      write({ kind: 'return', who_down: 'claude', quote: a.quote, by });
      return 'Записал возврат Claude: „' + a.quote + '“. Дирижёр получит «Claude вернулся — остановись»; работы — claim после его handover или 15 минут тишины.';
    });
  }
  if (a.action === 'handover') {
    return W.transact(({ write }) => {
      if (!session(a)) throw Error(acc.guest() ? deny('Остановку записывает дирижёр.') : 'Остановку записывает дирижёр.');
      write({ kind: 'handover', who_down: 'claude', by: client, owner: a.owner });
      return 'Записал: дирижёр ' + NAMES[client] + ' остановился.';
    });
  }
  if (a.action === 'rebind') {
    if (!acc.guest()) throw Error(words().mode().active ? 'Перепривязку записывает новый чат ' + NAMES[words().mode().conductor] + '.' : 'Запасной режим не действует.');
    const proof = chatProof(client);
    return W.transact(({ mode, write }) => {
      const m = mode();
      if (!m.active) throw off();
      if (client !== m.conductor) throw Error(deny('Перепривязку записывает новый чат ' + NAMES[m.conductor] + '.'));
      if (!proof.ok) throw Error(proofRefusal(proof));
      if (sameFingerprint(proof.fingerprint, m.fingerprint) || fingerprintAlive(m.fingerprint)) throw Error('Прежний сеанс дирижёра жив: перепривязка не нужна.');
      if (!LABEL.test(a.owner || '') || !a.owner.toLowerCase().startsWith('fallback-' + client + '-')) throw Error('Нужна новая метка owner=fallback-' + client + '-<4 буквы>.');
      write({ kind: 'conductor', who_down: 'claude', conductor: client, owner: a.owner, fingerprint: proof.fingerprint, quote: a.quote, reason: 'rebind' });
      return 'Записал: „' + a.quote + '“ — дирижёр ' + NAMES[client] + ', новый сеанс ' + a.owner + '.';
    });
  }
  throw Error('Неизвестное действие.');
}
// Снимок при включающей записи; сбой не глотается: запись о сбое читает баннер и continue_stage (Grok cfb0705b).
function takeSnapshot(r, deps = {}) {
  try { (deps.snapshot || snapshot)(r); return ''; }
  catch (e) {
    try { require('./team-git').atomic(path.join(stateDir(), 'fallback', 'snapshot-' + r.id + '.json'), JSON.stringify({ word: r.id, at: new Date().toISOString(), error: e.message, works: [] }, null, 2) + '\n'); } catch {}
    return snapshotLine({ error: e.message });
  }
}
function snapshotLine(snap) {
  if (snap && !snap.error) return '';
  return 'Снимок открытых работ не записан' + (snap?.error ? ' (' + snap.error + ')' : '') + ': этап, начатый Claude, продолжить нельзя — continue_stage откажет; новые этапы — своей семьи.';
}
// Кто из гостей пишет слово о помощнике: дирижёр — о других; другой гость-чат — только о текущем дирижёре.
function helperAllowed(a) {
  const client = access().client(), m = words().mode();
  if (!m.active || !SEATS.includes(client)) return false;
  if (m.conductor === a.who_down && client !== m.conductor) return chatProof(client).ok;
  return !!session(a)?.active && a.who_down !== client;
}
// Слово о помощнике в запасном режиме: дирижёр — о других; другой гость-чат — о текущем дирижёре (запись conductor).
// Проверка режима и записи — под одним замком журнала.
async function helperWord(a) {
  const acc = access(), W = words(), client = acc.client();
  if (!acc.guest()) {
    const m = W.mode();
    if (m.active) throw Error(refusalText(m));
    return null; // чат Claude вне режима — правила team-v18
  }
  const proof = SEATS.includes(client) ? chatProof(client) : { ok: false, reason: 'не чат Codex или Antigravity' };
  return W.transact(({ mode, write }) => {
    const m = mode();
    if (!m.active) throw Error(deny('Слово о помощнике записывает чат Claude; в запасном режиме — дирижёр.'));
    if (m.conductor === a.who_down && SEATS.includes(client) && client !== m.conductor) {
      if (!proof.ok) throw Error(proofRefusal(proof));
      if (!LABEL.test(a.owner || '') || !a.owner.toLowerCase().startsWith('fallback-' + client + '-')) throw Error('Нужна метка сеанса owner=fallback-' + client + '-<4 буквы>.');
      const record = write(W.entry(a));
      write({ kind: 'conductor', who_down: 'claude', conductor: client, owner: a.owner, fingerprint: proof.fingerprint, quote: a.quote, reason: 'word', word_id: record.id });
      return 'Записал: „' + a.quote + '“ — дирижёр теперь ' + NAMES[client] + '.';
    }
    if (!session(a)?.active) throw Error(deny('Слово о помощнике в запасном режиме записывает дирижёр.'));
    if (a.who_down === client) throw Error('О себе дирижёр слово не записывает.');
    return W.line(write(W.entry(a)));
  });
}

// Есть ли anthropic среди авторов этапа (К4 г).
function hasAnthropic(author) {
  const rows = Array.isArray(author) ? author : author ? [author] : [];
  return rows.some(p => (Array.isArray(p?.authors) ? p.authors : [p]).some(x => x?.family === 'anthropic'));
}
// Поручение помощника этой работы, которое записало или перенесло файл, и хеш записанного (к-кандидату пп. 2, 5):
// Antigravity — appliedTo или apply.target перенесённого поручения, хеш — newHash переноса; Codex — список writes поручения
// с записью (путь и sha256 после поручения, Grok cfb0705b Б2). resultFile Codex — файл ответа, в папке работы его нет.
// Все писатели пути по времени, а не первое совпадение (Codex 7a3bd85b п. 2).
function writers(w, file, jobs) {
  const P = paths(), same = f => typeof f === 'string' && f && P.samePath(path.normalize(f), path.normalize(file)), out = [];
  const time = (...v) => v.map(x => Date.parse(x || '')).find(Number.isFinite) || 0;
  for (const j of jobs) {
    if ((j.workName || j.work) !== w.name) continue;
    if (j.who === 'antigravity' && ['done', 'applied'].includes(j.status) && !j.cancelled && (same(j.appliedTo) || same(j.apply?.target)))
      out.push({ job: j, hash: j.apply?.newHash || null, at: time(j.appliedAt, j.finishedAt, j.startedAt) });
    if (j.who === 'codex' && Array.isArray(j.writes) && j.folder) {
      const e = j.writes.filter(e => same(path.resolve(j.folder, e.path))).at(-1);
      if (e) out.push({ job: j, hash: e.sha256 || null, at: time(j.finishedAt, j.startedAt) });
    }
  }
  return out.sort((x, y) => x.at - y.at);
}
// Автор файла: последний писатель, чей записанный хеш совпадает с файлом. Не совпал ни с одним — авторы: anthropic и все
// семьи, которые писали этот путь (отказ по умолчанию: несовпадение не доказывает правку именно Claude).
function writtenBy(w, file, jobs, hash) {
  const list = writers(w, file, jobs);
  if (!list.length) return null;
  const match = list.filter(x => x.hash && x.hash === hash).at(-1);
  return { job: match?.job || null, match: !!match, writers: list };
}
// Поручение Codex этой работы с записью или ролью «текст», у которого нет списка записанных файлов (старые карточки):
// какие файлы оно трогало, неизвестно — файлы папки считаются частью обеих семей, anthropic и openai (отказ по умолчанию).
// Папка поручения — папка работы, вложенная в неё или объемлющая её (помощник Н4): в любом случае могло писать в файлы работы.
function unknownCodex(w, jobs) {
  const P = paths(), inside = (a, b) => { try { return P.isInsideReal(a, b); } catch { return false; } };
  const near = f => !w.folder || !f || P.samePath(f, w.folder) || inside(f, w.folder) || inside(w.folder, f);
  return jobs.filter(j => j.who === 'codex' && (j.workName || j.work) === w.name && (j.write || j.role === 'текст') && !Array.isArray(j.writes) &&
    j.status !== 'queued' && near(j.folder));
}
// Этап-продолжение (К4а): собирает сервер из снимка запасного режима; дирижёр называет только этап и автора поручения «текст».
// Части строятся в порядке ключей схемы zod (part, material, source_job, авторы): ответ через MCP сравнивается с хранимым.
function continuation(w, old, a, jobs) {
  const s0 = session(a);
  if (!s0?.active) throw Error('continue_stage — только у дирижёра запасного режима.');
  const c = a.continue_stage || {};
  const id = typeof c === 'string' ? c : c.id, au = c.author || {};
  if (typeof id !== 'string' || !id) throw Error('continue_stage: укажите id этапа.');
  if (!['openai', 'google', 'xai'].includes(au.family) || typeof au.model !== 'string' || !au.model.trim())
    throw Error('continue_stage: укажите author — семью и модель поручения «текст» (openai, google или xai).');
  const snap = readSnapshot(s0.word.id);
  if (!snap || snap.error) throw Error('continue_stage: ' + snapshotLine(snap));
  const from = snap.works?.find(x => x.name === w.name)?.stages?.find(s => s.id === id);
  if (!from || from.state !== 'идёт' || !hasAnthropic(from.author))
    throw Error('continue_stage: этапа ' + id + ' нет в снимке запасного режима (' + s0.word.id + ') с автором anthropic и состоянием «идёт».');
  const index = w.stages.findIndex(s => s.id === id), prev = old.stages.find(s => s.id === id);
  if (index < 0 || !prev) throw Error('continue_stage: этап ' + id + ' уже снят из плана.');
  if (prev.level === 'высокий') throw Error('continue_stage: этап «высокий» ждёт Claude (rules/fallback.md).');
  jobs ||= require('./stage-gate').allJobs();
  const root = w.folder || paths().repoRoot, sha = b => crypto.createHash('sha256').update(b).digest('hex');
  const fromAuthor = Array.isArray(from.author) ? from.author : [from.author];
  const anth = fromAuthor.flatMap(p => Array.isArray(p?.authors) ? p.authors : [p]).find(x => x?.family === 'anthropic');
  const anthropic = { family: 'anthropic', model: anth.model }, modelOf = j => require('./provenance').reviewerInfo(j, j.who).requested_text_model || j.model || j.who;
  const unknown = unknownCodex(w, jobs), textCodex = unknown.filter(j => j.role === 'текст' && ['done', 'applied'].includes(j.status) && !j.cancelled).at(-1);
  const claudeFiles = [], suspect = [], helperParts = new Map(), reference = [], restore = [], restored = [];
  // Файл помощника — отдельной частью: автор — семья последнего писателя с совпавшим хешем; не совпал ни с одним —
  // anthropic и все семьи писателей. Семья автора части её не проверяет; не осталось двух проверяющих — часть ждёт.
  const family = j => require('./stage-gate').reviewerFamily(j);
  // Писатель не с ролью «текст» (совет, без роли): замок навсегда ответил бы «Автор без поручения «текст»» — файл идёт
  // справкой в прежнем этапе (помощник Т1), и при совпавшем хеше, и при несовпавшем.
  const place = (use, hit, own = null, orig = use) => {
    // Роль проверяется первой во всех ветках (Codex 38eabe71): «совет» той же семьи, что продолжает этап, — тоже справкой.
    if (hit.match) {
      if (hit.job.role !== 'текст') { reference.push(orig); return true; }
      if (own && family(hit.job) === own) return false; // файл семьи продолжения — в общей части
      const key = hit.job.id, part = helperParts.get(key) || { part: 'поручение ' + hit.job.id, material: [], source_job: hit.job.id, family: family(hit.job), model: modelOf(hit.job) };
      part.material.push(use); helperParts.set(key, part); return true;
    }
    if (hit.writers.some(x => x.job.role !== 'текст')) { reference.push(orig); return true; }
    const ids = [...new Set(hit.writers.map(x => x.job.id))], key = 'изменён:' + ids.join(','), byFamily = new Map();
    for (const x of hit.writers) byFamily.set(family(x.job), { family: family(x.job), model: modelOf(x.job) });
    const texts = [...new Set(hit.writers.filter(x => x.job.role === 'текст' && ['done', 'applied'].includes(x.job.status) && !x.job.cancelled).map(x => x.job.id))];
    const part = helperParts.get(key) || { part: (ids.length > 1 ? 'поручения ' : 'поручение ') + ids.join(', ') + ', файл изменён после ' + (ids.length > 1 ? 'них' : 'него'), material: [],
      ...(texts.length ? { source_job: texts.length > 1 ? texts : texts[0] } : {}), authors: [anthropic, ...[...byFamily.values()].filter(a => a.family !== 'anthropic')] };
    part.material.push(use); helperParts.set(key, part); return true;
  };
  for (const m of from.material || []) {
    const file = path.resolve(root, m.path), hit = writtenBy(w, file, jobs, m.sha256);
    if (hit && (hit.match ? hit.job.role !== 'текст' : hit.writers.some(x => x.job.role !== 'текст'))) { reference.push(m.path); continue; } // справкой
    // Файл берётся по хешу снимка: живой, если не менялся после слова, иначе копия из снимка в папке работы (к-кандидату п. 6).
    if (!m.sha256) throw Error('continue_stage: файла ' + m.path + ' не было при снимке — частичный результат Claude только из снимка.');
    let live = null;
    try { live = sha(fs.readFileSync(file)); } catch {}
    let use = m.path;
    if (live !== m.sha256) {
      let bytes = null;
      try { bytes = fs.readFileSync(path.join(copyDir(s0.word.id), m.sha256)); } catch {}
      if (!bytes || sha(bytes) !== m.sha256) throw Error('continue_stage: копии файла ' + m.path + ' в снимке нет или она не совпадает с хешем снимка — частичный результат Claude только из снимка.');
      if (!w.folder) throw Error('continue_stage: копию из снимка можно положить только в папку работы (folder).');
      use = ['.most', 'snapshot-' + s0.word.id.replace(/^word-/, '').slice(0, 8), m.path.replace(/\\/g, '/')].join('/');
      const target = path.resolve(root, use);
      if (!paths().isInsideReal(target, root)) throw Error('continue_stage: файл ' + m.path + ' вне папки работы.');
      restore.push({ target, bytes }); restored.push(m.path);
    }
    if (!hit) { (unknown.length ? suspect : claudeFiles).push(use); continue; }
    place(use, hit, null, m.path);
  }
  for (const r of restore) {
    fs.mkdirSync(path.dirname(r.target), { recursive: true });
    if (!fs.existsSync(r.target) || sha(fs.readFileSync(r.target)) !== sha(r.bytes)) fs.writeFileSync(r.target, r.bytes);
  }
  // Добавленные файлы сверяются тем же writtenBy (помощник Н3): файл поручения другой семьи — в её часть.
  const added = [];
  for (const f of Array.isArray(c.material) ? c.material.filter(f => typeof f === 'string' && f.trim()) : []) {
    const file = path.resolve(root, f);
    let live = null;
    try { live = sha(fs.readFileSync(file)); } catch {}
    const hit = writtenBy(w, file, jobs, live);
    // Без известного писателя при поручении Codex без списка writes — та же ветка, что у файлов снимка: openai среди авторов
    // части (Codex 9a66ede6).
    if (!hit) { (unknown.length ? suspect : added).push(f); continue; }
    if (!place(f, hit, au.family)) added.push(f);
  }
  const authors = [anthropic, { family: au.family, model: au.model.trim() }];
  // Файлы при поручениях Codex без списка записанного: при продолжении семьёй openai — в общей части, иначе — частью anthropic и openai.
  const mainMaterial = [...new Set([...claudeFiles, ...(au.family === 'openai' ? suspect : []), ...added])];
  const parts = [...helperParts.values()];
  if (suspect.length && au.family !== 'openai') parts.push({ part: 'файлы при поручениях Codex', material: suspect, ...(textCodex ? { source_job: textCodex.id } : {}),
    authors: [anthropic, { family: 'openai', model: textCodex ? modelOf(textCodex) : modelOf(unknown.at(-1)) }] });
  const material = [...new Set([...mainMaterial, ...parts.flatMap(p => p.material)])];
  const author = parts.length ? [{ part: 'продолжение', material: mainMaterial, authors }, ...parts] : { authors };
  const next = { title: prev.title + ' (продолжение)', accept_criteria: prev.accept_criteria, weight: prev.weight, state: 'идёт', level: prev.level,
    author, ...(material.length ? { material } : {}), ...(prev.closes !== undefined ? { closes: prev.closes } : {}),
    continuation: { word: s0.word.id, from: id, at: new Date().toISOString(), claude_files: claudeFiles, ...(suspect.length ? { codex_unknown: suspect } : {}),
      ...(reference.length ? { reference } : {}), ...(restored.length ? { restored } : {}) } };
  const stages = w.stages.slice();
  stages.splice(index, 1, next);
  return { stages, plan_change: 'продолжение этапа Claude в запасном режиме, снимок ' + s0.word.id + '; снят этап ' + id };
}
// Состояние папки для списка записанных файлов поручения Codex с записью: путь → размер и время; .git и node_modules — мимо.
// Больше 50 000 файлов — список не ведётся (null): такие файлы считаются тронутыми (отказ по умолчанию).
function folderState(folder, limit = 50000) {
  const out = new Map(), stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(folder, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink() || ['.git', 'node_modules'].includes(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { stack.push(r); continue; }
      if (!e.isFile()) continue;
      try { const st = fs.statSync(path.join(folder, r)); out.set(r, st.size + ':' + st.mtimeMs); } catch {}
      if (out.size > limit) return null;
    }
  }
  return out;
}
// Изменённые за поручение файлы: путь и sha256 после поручения (null — файл удалён).
function folderChanges(folder, before) {
  const after = folderState(folder);
  if (!before || !after) return null;
  const changed = [];
  for (const p of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(p) === after.get(p)) continue;
    let sha256 = null;
    if (after.has(p)) { try { sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, p))).digest('hex'); } catch {} }
    changed.push({ path: p, sha256 });
  }
  return changed.sort((x, y) => x.path.localeCompare(y.path));
}
// Окружение поручения-сеанса (К2): MOST_JOB_ID и MOST_CLIENT=job, без MOST_AUTHORITY — и для нового, и для resume.
function jobEnv(id, base = process.env) {
  const env = { ...base, MOST_JOB_ID: String(id), MOST_CLIENT: 'job' };
  delete env.MOST_AUTHORITY;
  return env;
}
// Запись по поручению дирижёра из очереди (К2): режим действует и сеанс дирижёра тот же, что при постановке.
function queueHold(card) {
  const m = words().mode();
  // Слово имеет приоритет: fromChat никогда не снимает удержание запасного режима.
  if (!card.fallbackWord) {
    if (card.fromChat === 'codex' && card.from === 'codex' && card.fullAccess !== true) return '';
    return 'запись из очереди — только по поручению дирижёра запасного режима или чата Codex';
  }
  if (!m.active) return 'запасной режим снят — запись по поручению дирижёра ждёт Claude';
  if (m.entry.id !== card.fallbackWord) return 'дирижёр запасного режима сменился — запись ждёт нового поручения';
  return '';
}
// Вызов дирижёра в текущем запросе (team.js кладёт его в контекст перед замком этапа).
function caller() {
  return require('./request-context').context.getStore()?.fallbackConductor || null;
}

module.exports = { NAMES, FAMILY, SEATS, LABEL, probe, processTable, ancestors, reset, chatProof, sameFingerprint, fingerprintAlive, session,
  conductorAllows, refusalText, guard, banner, releaseLine, launchLine, snapshot, readSnapshot, launchDesktop, word, helperAllowed, helperWord,
  hasAnthropic, writtenBy, unknownCodex, drift, continuation, caller, jobEnv, queueHold, jobProof, folderState, folderChanges, snapshotLine };
