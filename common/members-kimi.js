'use strict';
const fs = require('fs'), path = require('path');
function member() {
  return { id: 'kimi', family: 'moonshot', title: 'Kimi', specialization: 'чтение входящих материалов и независимая проверка', external: true, adapter: 'kimi-cli', adapter_params: {},
    roles: { receives: true, sends: false, voter: true, writer: false, conductor: false, fallback_conductor: false, literary: false },
    state: 'paused', pause: { kind: 'manual', scope: 'participant', since: new Date().toISOString(), until: null, next_probe: null } };
}
const MASKS = ['kimi/kimi_send', 'kimi/kimi_result', 'kimi/kimi_status'];
// team-v56 А5 (ревью Kimi №3): «живая приёмка А3» — ОТДЕЛЬНЫЙ от технической пробы совместимости артефакт
// kimi-acceptance.json. Он подтверждает сквозную работу send→result, team_ask и отмены собственного тестового потомка и
// привязан к хешам кандидата: версия политики доказательства, CLI (sha256), профили всех запусков и целевой набор ролей.
// Технический probe-ok его не подменяет (probe:true отвергается). Без действительного артефакта sends не публикуется и
// исходная пауза не снимается (замысел А5: «ручная пауза до живой приёмки А3»).
function acceptanceFile(state) { return path.join(state, 'kimi-acceptance.json'); }
// team-v56 И1б (ревью Codex 4/Gemini-А): хеш реализации исходящих Kimi. Любая правка кода запуска/материала/ревью/MCP/
// миграции инвалидирует старый артефакт приёмки. Вынесен в kimi-launch.js (общий для привязки приёмки и для записи
// implHash в карточку поручения самим сервером при запуске — team-v56 Л1).
function acceptanceBinding() {
  const launch = require('./kimi-launch'), kimiMcp = require('./kimi-mcp');
  // team-v56 И1б: профили совет/текст привязываются с ТОЧНЫМ перечнем инструментов MCP (RECIPIENTS): смена получателей
  // или их инструментов меняет profileShas и инвалидирует старую приёмку А3. Профиль «проверка» — без MCP (независимость).
  const tools = kimiMcp.profileTools();
  const profileShas = {
    review: launch.profile({ role: 'проверка', write: false, fullAccess: false }).sha256,
    reader: launch.profile({ role: 'совет', write: false, fullAccess: false }, tools).sha256,
    writer: launch.profile({ role: 'совет', write: true, fullAccess: false }, tools).sha256,
    writerFull: launch.profile({ role: 'совет', write: true, fullAccess: true }, tools).sha256 };
  let cliSha256 = null; try { cliSha256 = launch.identity().sha256; } catch {}
  return { policy: launch.POLICY, roles: { writer: true, sends: true }, profileShas, mcpTools: tools, implHash: launch.implementationHash(), cliSha256 };
}
// team-v56 К3 (ревью Kimi 1 круг 3): каждая ссылка приёмки привязана к ФАКТИЧЕСКОЙ операции по следам, которые мост реально
// пишет на диск, а не к «любой завершённой карточке». Прежняя проверка (существование card.json + статус done/applied)
// позволяла подставить одну постороннюю завершённую карточку во все четыре поля. Теперь:
//  send/result/cancel_child — дочерняя карточка исходящего поручения Kimi в хранилище получателя: from='kimi'
//    (servers/*/index.js: from = memberId(access.client()) = исполнитель-родитель) и parentJob = поручение Kimi, которое
//    мост перечислил в своих delegations/outgoingCount (common() в servers/kimi/index.js). Это доказывает, что исходящее
//    отправил именно Kimi, а не просто чья-то карточка с from.
//  result — та же дочерняя карточка, завершённая успехом с читаемым результатом, И след получения результата родителем (Л2).
//  cancel_child — дочерняя карточка-потомок Kimi, отменённая с подтверждением остановки (cancelled/stop_confirmed + stopConfirmed).
//  team_ask — запись входящих дирижёру state/inbox/<id>.json (common/inbox.js): автор-поручение Kimi, status='answered' с ответом.
// Различимость: team_ask — не карточка (иной namespace); result (done) и cancel_child (cancelled) взаимно исключают статусы,
// поэтому одну карточку нельзя подставить во все поля.
// team-v56 Л1 (ревью Kimi круг 4): каждое родительское поручение Kimi доказуемо относится к ТЕКУЩЕЙ привязке приёмки —
// запущено тем же CLI (cli.sha256) и той же реализацией (implHash пишет сервер при запуске) и начато не раньше момента
// начала приёмки (rec.startedAt). Старые операции (например, при другой версии CLI или до начала приёмки) приёмку не дают.
// team-v56 Л2 (ревью Kimi круг 4 → круг 5, М1): result действителен ТОЛЬКО при доказуемом следе ВЫДАЧИ готового результата
// этому родителю. Прежний след (resultsReceived из stream.ndjson родителя) засчитывал любой ответ на вызов *_result, в том
// числе «ещё работает»/ошибку: родитель мог получить «ещё идёт», потомок завершался позже, и приёмка проходила без
// фактического получения готового результата. Теперь факт выдачи пишет сам сервер-получатель (codex/deepseek/kimi_result,
// common/result-receipt) в карточку ПОТОМКА: отметка resultDeliveries { to: номер родителя, at, sha256 }. Приёмка проверяет,
// что выдано именно этому родителю (to), после finishedAt потомка (at) и с sha256 ТЕКУЩЕГО результата карточки (не замена).
function kimiJobCard(state, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return null;
  try { const c = JSON.parse(fs.readFileSync(path.join(state, 'kimi-jobs', id, 'card.json'), 'utf8').replace(/^﻿/, '')); return c && c.id === id ? c : null; }
  catch { return null; }
}
function acceptanceJobs(state, rec, want) {
  if (!rec.jobs || typeof rec.jobs !== 'object') return false;
  // Л1: артефакт обязан нести момент начала приёмки; все операции — не раньше него.
  const start = Date.parse(rec.startedAt);
  if (!Number.isFinite(start)) return false;
  const live = require('./live-jobs');
  let all; try { all = live.cards({ stateDir: state, strictStores: true }); } catch { return false; }
  // Л1: родительское поручение Kimi, привязанное к текущей приёмке — тот же CLI и реализация, начато не раньше начала приёмки.
  const boundParent = id => {
    const parent = kimiJobCard(state, id);
    if (!parent || !parent.cli || parent.cli.sha256 !== want.cliSha256 || parent.implHash !== want.implHash) return null;
    const t = Date.parse(parent.startedAt);
    if (!Number.isFinite(t) || t < start) return null;
    return parent;
  };
  // Дочерняя карточка исходящего Kimi: ровно одна карточка с этим id, from='kimi', parentJob — ПРИВЯЗАННОЕ поручение Kimi,
  // перечислившее этот id в своих delegations (успешный обход: outgoingVerified=true). Возвращает карточку и её родителя.
  const outgoing = id => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return null;
    const hits = all.filter(c => c.j && c.j.id === id);
    if (hits.length !== 1) return null;
    const c = hits[0];
    if (c.who === 'kimi' || c.j.from !== 'kimi') return null;
    const parent = boundParent(c.j.parentJob);
    if (!parent || parent.outgoingVerified !== true || !Array.isArray(parent.delegations) || !parent.delegations.includes(id)) return null;
    return { c, parent };
  };
  const resultPath = c => {
    const rf = c.j.resultFile;
    if (typeof rf !== 'string' || !rf.trim()) return null;
    return path.isAbsolute(rf) ? rf : path.join(path.dirname(c.file), rf);
  };
  const readable = c => { const p = resultPath(c); if (!p) return false; try { return fs.statSync(p).isFile() && (fs.readFileSync(p), true); } catch { return false; } };
  // Л2 (круг 5, М1): результат ВЫДАН именно этому родителю — в карточке потомка есть отметка resultDeliveries, где to == номер
  // родителя, at (момент выдачи) не раньше finishedAt потомка, а sha256 совпадает с sha ТЕКУЩЕГО результата карточки (выдан
  // завершённый, не заменённый позже результат). «Ещё работает»/ошибка/выдача другому родителю такой отметки не создают.
  const received = (parent, c) => {
    const p = resultPath(c); if (!p) return false;
    const fin = Date.parse(c.j.finishedAt); if (!Number.isFinite(fin)) return false;
    let sha; try { sha = require('./result-receipt').sha256(fs.readFileSync(p, 'utf8')); } catch { return false; }
    const dels = Array.isArray(c.j.resultDeliveries) ? c.j.resultDeliveries : [];
    return dels.some(d => d && d.to === parent.id && d.sha256 === sha && Number.isFinite(Date.parse(d.at)) && Date.parse(d.at) >= fin);
  };
  const inboxAnswered = id => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return false;
    let e; try { e = JSON.parse(fs.readFileSync(path.join(state, 'inbox', id + '.json'), 'utf8').replace(/^﻿/, '')); } catch { return false; }
    return !!e && e.author && e.author.kind === 'job' && (e.author.member === 'kimi' || e.author.from === 'kimi') &&
      !!boundParent(e.author.id) && e.status === 'answered' && typeof e.answer === 'string' && !!e.answer.trim();
  };
  const checks = {
    send: id => !!outgoing(id),
    result: id => { const o = outgoing(id); return !!o && ['done', 'applied'].includes(o.c.j.status) && readable(o.c) && received(o.parent, o.c); },
    team_ask: inboxAnswered,
    cancel_child: id => { const o = outgoing(id); return !!o && ['cancelled', 'stop_confirmed'].includes(o.c.j.status) && !!o.c.j.stopConfirmed; },
  };
  for (const step of ['send', 'result', 'team_ask', 'cancel_child']) if (!checks[step](rec.jobs[step])) return false;
  return true;
}
function acceptance(state) {
  let rec; try { rec = JSON.parse(fs.readFileSync(acceptanceFile(state), 'utf8').replace(/^﻿/, '')); } catch { return null; }
  if (!rec || rec.status !== 'passed' || rec.probe === true) return null;
  if (!(rec.send === true && rec.result === true && rec.team_ask === true && rec.cancel_child === true)) return null;
  const want = acceptanceBinding();
  // team-v56 И1а (ревью Codex 4/Kimi 1/Gemini-А 1): если CLI не найден/identity бросил (cliSha256==null) — приёмка
  // НЕДЕЙСТВИТЕЛЬНА ни при каком содержимом файла; артефакт с cliSha256:null тоже отвергается (не null===null).
  if (want.cliSha256 == null) return null;
  if (rec.cliSha256 == null || rec.cliSha256 !== want.cliSha256) return null;
  if (rec.policy !== want.policy) return null;
  if (rec.implHash !== want.implHash) return null;
  if (JSON.stringify(rec.mcpTools) !== JSON.stringify(want.mcpTools)) return null;
  if (JSON.stringify(rec.profileShas) !== JSON.stringify(want.profileShas)) return null;
  if (JSON.stringify(rec.roles) !== JSON.stringify(want.roles)) return null;
  if (!acceptanceJobs(state, rec, want)) return null;
  return rec;
}
// team-v56 А5 (ревью Kimi №2): доказуемое снятие ИСХОДНОЙ (автоматической) паузы Kimi по журналу. Снять можно только когда
// журнал содержит событие-основание добавления Kimi и после него никто не менял его паузу/состояние (ручная перепауза,
// активация, удаление). Одного kind:'manual' и сравнения настенных часов недостаточно — проверяется фактическая история.
// Уже active сохраняется (сюда не попадает); removed не оживляется; поздняя ручная пауза сохраняется (ok:false).
// team-v56 И3 (ревью Codex 6): «исходной автоматической» считается только пауза с доказанным происхождением —
// добавление Kimi действием автоматической миграции (team-v54-kimi/team-v56-kimi). Вручную добавленный/поставленный на
// паузу Kimi (любое иное действие журнала) миграцией не снимается никогда.
const AUTO_ADD = ['team-v54-kimi', 'team-v56-kimi'];
function originalPauseRemovable(store) {
  const hist = store.history();
  let addIdx = -1;
  for (let i = 0; i < hist.length; i++)
    if (!hist[i].before?.members?.some(m => m.adapter === 'kimi-cli') && hist[i].after?.members?.some(m => m.adapter === 'kimi-cli')) addIdx = i;
  if (addIdx < 0) return { ok: false, reason: 'нет события-основания добавления Kimi' };
  if (!AUTO_ADD.includes(hist[addIdx].action)) return { ok: false, reason: 'Kimi добавлен не автоматической миграцией (действие ' + hist[addIdx].action + '): ручная пауза не снимается' };
  const basePause = JSON.stringify(hist[addIdx].after.members.find(m => m.adapter === 'kimi-cli').pause);
  for (let i = addIdx + 1; i < hist.length; i++) {
    const k = hist[i].after?.members?.find(m => m.adapter === 'kimi-cli');
    if (!k) return { ok: false, reason: 'Kimi удалён после добавления' };
    // Событие смены ролей самого deploy паузу/состояние не трогает; любое изменение state/pause — поздняя ручная пауза/активация.
    if (k.state !== 'paused' || JSON.stringify(k.pause) !== basePause) return { ok: false, reason: 'пауза/состояние Kimi менялись после добавления' };
  }
  return { ok: true, basis: { rev: hist[addIdx].rev, at: hist[addIdx].at, action: hist[addIdx].action } };
}
function forward(roster, { accepted = false, store = null } = {}) {
  const next = structuredClone(roster);
  if (!next.members.some(m => m.id === 'kimi' || m.adapter === 'kimi-cli')) next.members.push(member());
  const kimi = next.members.find(m => m.adapter === 'kimi-cli');
  if (kimi) {
    // team-v56 И2 (ревью Kimi 2): БЕЗ действующей приёмки А3 не включаем ни writer, ни sends; ранее включённые права,
    // привязанные к приёмке, отзываются, когда приёмка отсутствует/недействительна/сменился CLI (accepted=false → оба false).
    // Идемпотентно: при уже выставленных ролях/состоянии снимок не меняется и редакция не растёт.
    kimi.roles = { ...kimi.roles, writer: accepted === true, sends: accepted === true };
    // А5: исходная пауза снимается только при живой приёмке И доказуемой исходной паузе (без поздней ручной/удаления).
    if (accepted && kimi.state === 'paused' && store && originalPauseRemovable(store).ok) { kimi.state = 'active'; kimi.pause = null; }
  }
  const agy = next.members.find(m => m.adapter === 'agy-cli');
  if (agy) agy.mcp_allow = [...new Set([...(agy.mcp_allow || []), ...MASKS])];
  return next;
}
const digest = roster => require('./kimi-launch').sha(JSON.stringify({ rev: roster.rev, phase: roster.phase, members: roster.members }));
function target(state, current) {
  const store = require('./members-store').create(state);
  const next = forward(current, { accepted: !!acceptance(state), store });
  if (!current.members.some(m => m.adapter === 'kimi-cli') && store.history().some(e => e.after?.members?.some(m => m.adapter === 'kimi-cli')))
    next.members = next.members.filter(m => m.adapter !== 'kimi-cli');
  return next;
}
// Миграции Kimi/v46 входят в проверенный снимок без смены исторической фазы.
// Штатная активация фазы выполняется после конфигов и журналируется отдельно.
function installTarget(state, current, release) {
  let next = target(state, current);
  const v46 = path.join(release, 'common/members-v46.js');
  if (fs.existsSync(v46)) next = require(v46).forward(next);
  next.rev = current.rev + (JSON.stringify(next.members) !== JSON.stringify(current.members) ? 1 : 0);
  return next;
}
function activationTarget(current, release) {
  const next = structuredClone(current); delete next.warning;
  const phaseFile = path.join(release, 'common/install-phase.js');
  const phase = fs.existsSync(phaseFile) ? require(phaseFile).phase : 'A';
  if (phase !== next.phase) {
    const d = next.members.find(m => m.id === 'deepseek'), agy = next.members.find(m => m.id === 'antigravity');
    if (d) d.roles = { ...d.roles, receives: phase === 'B', sends: phase === 'B', writer: phase === 'B', voter: phase === 'B' };
    if (agy) agy.mcp_allow = phase === 'B' ? [...new Set([...(agy.mcp_allow || []), 'deepseek/deepseek_send', 'deepseek/deepseek_result', 'deepseek/deepseek_status'])] : (agy.mcp_allow || []).filter(x => !/^deepseek\//.test(x));
    next.phase = phase;
  }
  next.rev = current.rev + (next.phase !== current.phase || JSON.stringify(next.members) !== JSON.stringify(current.members) ? 1 : 0);
  return next;
}
const accepts = (op, roster) => [op.targetRoster, op.activationRoster, op.recoveryRoster].some(r => r && digest(r) === digest(roster));
const latestRoster = op => [op.targetRoster, op.activationRoster, op.recoveryRoster].filter(Boolean).reduce((a, b) => b.rev >= a.rev ? b : a);
function refresh(state, op) {
  const saved = JSON.parse(fs.readFileSync(recoveryFile(state), 'utf8'));
  if (saved.id !== op.id) throw Error('Операция миграции Kimi изменилась.');
  Object.assign(op, saved); return op;
}
function activation(state, current, release) {
  const next = activationTarget(current, release);
  if (next.rev !== current.rev && pending(state)) {
    const op = JSON.parse(fs.readFileSync(recoveryFile(state), 'utf8'));
    if (path.resolve(op.release) !== path.resolve(release) || !accepts(op, current)) throw Error('Фазовая запись не соответствует операции миграции Kimi.');
    op.activationRoster = next;
    require('./team-git').atomic(recoveryFile(state), JSON.stringify(op));
  }
  return next;
}
function apply(state, expectedRev, proposed) {
  const store = require('./members-store').create(state), current = store.read({ initialize: false });
  if (expectedRev !== undefined && current.rev !== expectedRev) throw Error('Редакция реестра изменилась до миграции Kimi.');
  const next = proposed ? structuredClone(proposed) : target(state, current);
  // Удалённого (в том числе из текущего снимка) не восстанавливать автоматически.
  if (!current.members.some(m => m.adapter === 'kimi-cli') && store.history().some(e => e.after?.members?.some(m => m.adapter === 'kimi-cli')))
    next.members = next.members.filter(m => m.adapter !== 'kimi-cli');
  if (next.phase === current.phase && JSON.stringify(next.members) === JSON.stringify(current.members)) return false;
  // team-v56 А5 (ревью: расхождение №2): отдельное событие журнала активации v56, явно отличное от исторического
  // team-v54-kimi (историческая миграция v54 остаётся воспроизводимой). Событие привязано к хешу целевого состава
  // (rosterHash = digest(next) — включает роли writer/sends и state). Если Kimi перешёл из paused в active по живой
  // приёмке — в журнал кладётся основание снятия исходной паузы (id/rev/действие события-основания), как требует замысел.
  const curK = current.members.find(m => m.adapter === 'kimi-cli'), nextK = next.members.find(m => m.adapter === 'kimi-cli');
  const unpaused = curK?.state === 'paused' && nextK?.state === 'active', sendsOn = nextK?.roles?.sends === true, writerOn = nextK?.roles?.writer === true;
  const meta = { action: 'team-v56-kimi', who: 'deploy', rosterHash: digest(next),
    reason: 'Kimi v56: запись (writer) ' + (writerOn ? 'включена после живой приёмки А3' : 'выключена до живой приёмки А3') + '; исходящие (sends) ' + (sendsOn ? 'включены после живой приёмки А3' : 'выключены до живой приёмки А3') +
      (unpaused ? '; исходная пауза снята по журналу' : '; пауза сохранена до живой приёмки А3') };
  if (unpaused) meta.pauseRemovalBasis = originalPauseRemovable(store).basis;
  store.update(current.rev, n => { n.members = next.members; }, meta, { phase: next.phase }); return true;
}
function recorded(state) {
  const store = require('./members-store').create(state);
  if (![store.file, store.good, store.log].some(f => fs.existsSync(f))) return false;
  const current = store.read({ initialize: false });
  return current.members.some(m => m.adapter === 'kimi-cli') || store.history().some(e => [e.before, e.after].some(s => s?.members?.some(m => m.adapter === 'kimi-cli')));
}
function supported(release) {
  return compatible(release) && fs.existsSync(path.join(release, 'common/members-kimi.js'));
}
function compatible(release) { try { return /['"]kimi-cli['"]/.test(fs.readFileSync(path.join(release, 'common/members-store.js'), 'utf8')); } catch { return false; } }
const absent = state => !['members.json', 'members.json.last-good', 'members-log.jsonl'].some(n => fs.existsSync(path.join(state, n)));
function emergencyPause(state, op) {
  const store = require('./members-store').create(state), current = store.read({ initialize: false });
  if (op && !accepts(op, current)) return current;
  const m = current.members.find(m => m.adapter === 'kimi-cli'); if (!m || m.state === 'removed' || m.state === 'paused' && m.pause?.kind === 'manual') return current;
  const paused = structuredClone(current); delete paused.warning;
  const k = paused.members.find(m => m.adapter === 'kimi-cli'); k.state = 'paused'; k.pause = member().pause; paused.rev++;
  // Ожидаемый after фиксируется раньше write-ahead журнала: обрыв любого из файлов восстанавливаем.
  if (op) { op.recoveryRoster = paused; op.recovering = true; require('./team-git').atomic(recoveryFile(state), JSON.stringify(op)); }
  store.update(current.rev, n => { n.members = paused.members; }, { action: 'kimi-recovery', who: 'deploy', operation: op?.id || null, reason: 'Аварийная пауза; история сохранена, восстановление только совместимым кодом.' }, { phase: current.phase });
  return store.read({ initialize: false });
}
const recoveryFile = state => path.join(state, 'kimi-migration.json');
function pending(state) {
  try { return JSON.parse(fs.readFileSync(recoveryFile(state), 'utf8')).status !== 'complete'; }
  catch (e) { return e.code !== 'ENOENT'; }
}
async function processTable() {
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Start';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}} | ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64e6 }, (e, out) => {
    if (e) return reject(e);
    try { resolve([].concat(JSON.parse(out)).map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: p.CommandLine, startedAt: p.Start }))); } catch (error) { reject(error); }
  }));
}
async function serverProcesses(state, deps = {}) {
  const hold = require('./restart-hold'), rows = await (deps.processTable || processTable)();
  if (!Array.isArray(rows) || !rows.some(p => p.pid === process.pid) || rows.some(p => !Number.isInteger(p.pid) || p.pid < 0 || !Number.isInteger(p.ppid) || typeof p.name !== 'string') || new Set(rows.map(p => p.pid)).size !== rows.length) throw Error('Неполный снимок процессов: остановка старых серверов не доказана.');
  const root = path.dirname(state), targets = new Map();
  for (const p of rows) {
    if (!/^node(?:\.exe)?$/i.test(p.name)) continue;
    if (!p.cmd || !Number.isFinite(Date.parse(p.startedAt))) throw Error('Не прочитана команда/отпечаток процесса Node: ' + p.pid);
    const refs = require('./cleanup').cmdPaths(p.cmd);
    if (refs.relative.some(x => /(^|[\\/])servers[\\/]/i.test(x))) throw Error('Относительная команда сервера: нельзя определить принадлежность процесса ' + p.pid);
    if (refs.abs.some(x => /[\\/]servers[\\/](?:[^\\/]+[\\/]index|[^\\/]+)\.js$/i.test(x) && require('./cleanup').refersTo(x, root))) targets.set(p.pid, p);
  }
  // Маркеры дополняют командные строки; team и гостевые серверы маркеров не создают.
  const markers = path.join(state, 'restart-servers');
  if (fs.existsSync(markers)) for (const name of fs.readdirSync(markers).filter(n => n.endsWith('.json'))) {
    const entry = JSON.parse(fs.readFileSync(path.join(markers, name), 'utf8'));
    const live = rows.find(p => p.pid === entry.process?.pid);
    if (!live) continue;
    if (!Number.isFinite(Date.parse(live.startedAt)) || !Number.isFinite(Date.parse(entry.process?.startedAt))) throw Error('Не подтверждён процесс старого сервера: ' + name);
    if (hold.same(live, entry.process)) targets.set(live.pid, live);
  }
  if (targets.has(process.pid)) throw Error('Миграцию Kimi выполняет только внешний установщик нового релиза.');
  return { rows, targets: [...targets.values()] };
}
async function assertServersStopped(state, seen, deps = {}) {
  const snapshot = await serverProcesses(state, deps);
  if (snapshot.targets.length || snapshot.rows.some(p => seen.has(p.pid))) throw Error('Остановка старых деревьев серверов не подтверждена.');
  return snapshot;
}
async function stopServers(state, deps = {}) {
  const { rows, targets } = await serverProcesses(state, deps);
  // team-v57 (ред.7): слово пользователя перекрывает ВСЕ проверки на пути установки, включая эту проверку идущих поручений
  // перед остановкой старых серверов (иначе общее слово перекрыло бы барьер assertNoJobs, но установка всё равно упала бы
  // здесь на тех же идущих поручениях). С непустым словом идущие поручения уже показаны пользователю и перекрыты его словом.
  const overridden = typeof deps.word === 'string' && deps.word.trim() !== '';
  const jobs = overridden ? [] : await require('./live-jobs').running({ stateDir: state, table: deps.table });
  if (jobs.length) throw Error('Перед миграцией нужно завершить поручения: ' + require('./live-jobs').describe(jobs));
  const seen = new Set(targets.map(p => p.pid)); let changed;
  do { changed = false; for (const p of rows) if (seen.has(p.ppid) && !seen.has(p.pid)) { seen.add(p.pid); changed = true; } } while (changed);
  for (const p of targets) {
    const fresh = await serverProcesses(state, deps), live = fresh.rows.find(r => r.pid === p.pid);
    if (!live) continue;
    if (!require('./restart-hold').same(live, p)) throw Error('PID сервера переиспользован перед остановкой: ' + p.pid);
    await (deps.stop || (pid => new Promise((resolve, reject) => require('child_process').execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 30000 }, e => e ? reject(e) : resolve()))))(p.pid);
  }
  await assertServersStopped(state, seen, deps);
  return [...seen];
}
// team-v57 (ред.5): слово пользователя на карточке перекрывает проверку перед установкой БЕЗ условий на PID (требование
// владельца, не предмет ревью). Слово на карточке — статус stop_confirmed либо stopConfirmed.basis как непустая строка
// (пустой/пробельный basis словом не считается). Перезагрузка Windows (без слова) снимает карточку по времени записи.
// Неизвестный статус, неполный done и незавершённая admission/reservation словом НА КАРТОЧКЕ и перезагрузкой НЕ снимаются —
// только общим словом установки (п.3, в assertNoJobs/install).
const cardWord = j => j.status === 'stop_confirmed' || (j.stopConfirmed && typeof j.stopConfirmed.basis === 'string' && j.stopConfirmed.basis.trim() !== '');
const wordBasis = j => j.status === 'stop_confirmed' ? 'статус stop_confirmed' : String(j.stopConfirmed.basis).trim();
// team-v57 (ред.6): время загрузки Windows в проверке установки берётся ТОЛЬКО настоящее, собственным запросом (тот же
// PowerShell, что в live.bootAt, но БЕЗ чтения MOST_TEST_BOOT_AT) — иначе процесс, запустивший установку с этой переменной,
// выдал бы живую карточку за пережившую перезагрузку. Тесты подставляют время через внутреннюю зависимость deps.bootAt
// функции проверки (недоступную из командной строки и окружения), а не через переменную окружения.
let _installBoot;
function installBootAt() {
  if (_installBoot !== undefined) return _installBoot;
  try {
    const out = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    _installBoot = Date.parse(out.trim());
  } catch { _installBoot = NaN; }
  return _installBoot;
}
// team-v57 (task9 п.3, ревью Codex 3): устойчивое перечисление карточек — ошибка чтения отдельного файла/хранилища не
// прекращает сбор. Повторяет разбор common/live-jobs.cards (его менять нельзя), но ошибки чтения собирает отдельным
// перечнем (с путём файла), а читаемые карточки возвращает. Используется, когда строгий live.cards падает целиком.
function resilientCards(state) {
  const cards = [], errors = [];
  let stores;
  try { stores = fs.readdirSync(state).filter(n => n === 'jobs' || n.endsWith('-jobs')); }
  catch (e) { if (e.code !== 'ENOENT') errors.push('ошибка чтения состояния ' + state + ': ' + e.message); return { cards, errors }; }
  for (const sub of stores) {
    const who = sub === 'jobs' ? 'antigravity' : sub.slice(0, -5);
    const dir = path.join(state, sub);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { errors.push('ошибка чтения состояния ' + dir + ': ' + e.message); continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.includes('.conflict-') || entry.name.endsWith('.tmp')) continue;
      if (!entry.isDirectory() && !entry.name.endsWith('.json')) continue;
      const file = path.join(dir, entry.name, ...(entry.isDirectory() ? ['card.json'] : []));
      let j;
      try { j = JSON.parse(fs.readFileSync(file).toString('utf8').replace(/^\uFEFF/, '')); if (!j || typeof j !== 'object') throw Error('неверная карточка'); }
      catch (e) {
        if (entry.isDirectory() && e.code === 'ENOENT') continue; // рабочая папка, не карточка
        errors.push('ошибка чтения состояния ' + file + ': ' + e.message);
        continue;
      }
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch {}
      cards.push({ who, j, entry: entry.name, file, store: sub, mtimeMs });
    }
  }
  return { cards, errors };
}
// install-gate-simple (слово пользователя 24.11.2026): ворота установки видят ТОЛЬКО живое — поручения с живым процессом и замки
// записи с живым владельцем (общее определение — common/dead-jobs). Мёртвое (lost, stop_unconfirmed, needs_decision, карточки
// удалённых участников, замки мёртвых владельцев, «пропущенное по слову/перезагрузке») не выводится вообще и слова не требует;
// его закрывает уборка dead-jobs.finalize (при запуске моста, перед установкой и раз в сутки). Поля passedByCardWord/
// passedByReboot оставлены пустыми для совместимости записи операции. deps.table/now/stores — тестовые подстановки.
// Ревью Codex п.4: снимок неполон (не прочитана карточка/замок, таблица процессов) — технический отказ одной строкой
// «не удалось проверить, повторите» (исключение с code GATE_INCOMPLETE), а не молчаливый пропуск. Только чтение.
function installationBlockers(state, deps = {}) {
  const dj = require('./dead-jobs');
  const g = dj.liveForGate(state, { table: deps.table, now: deps.now, stores: deps.stores, data: deps.data });
  if (g.incomplete.length) throw Object.assign(Error(dj.incompleteLine(g.incomplete)), { code: 'GATE_INCOMPLETE', incomplete: g.incomplete });
  return { running: g.running, blockers: g.locks, passedByCardWord: [], passedByReboot: [] };
}
// team-v57 (task9 п.2/5, ревью Kimi 4): единый форматтер пропущенной записи — с причинами, папкой, статусом, отправителем;
// им печатается И показанный список (listText), И итоговое сообщение установки (deploy-ops.wordSummary).
function fmtPassed(p) {
  const head = p.kind === 'lock'
    ? 'замок ' + p.instance + (p.jobId ? ' (' + p.jobId + ')' : '')
    : p.who + ' ' + p.id + (p.status ? ' (' + p.status + ')' : '');
  const tail = [];
  if (p.folder && p.folder !== 'не указана') tail.push('папка ' + p.folder);
  if (p.from && p.from !== 'не указан') tail.push('отправитель ' + p.from);
  return head + ' [' + p.basis + ']: ' + p.reasons.join(', ') + (tail.length ? ' — ' + tail.join(', ') : '');
}
// Показ пользователю: одна строка на живое поручение (участник, папка, сколько идёт, кто отправил) и на живой замок.
function listText(b) {
  const dj = require('./dead-jobs');
  const rows = [...b.running.map(dj.line), ...b.blockers, ...b.passedByCardWord.map(fmtPassed), ...b.passedByReboot.map(fmtPassed)];
  return rows.join('\n') || 'ничего не идёт';
}
// Отпечаток списка — sha256 канонической записи БЕЗ летучих полей (duration в running меняется во времени).
// team-v57 (task9 п.2): в отпечаток входят статус running-карточки и состав пропущенных записей (участник, номер, статус,
// папка, отправитель для карточек; instance, папка, номер поручения для замков). Компаратор возвращает 0 при равенстве.
function listHash(b) {
  const byJson = (x, y) => { const a = JSON.stringify(x), c = JSON.stringify(y); return a < c ? -1 : a > c ? 1 : 0; };
  const canonPassed = a => a.map(p => ({ kind: p.kind, who: p.who || null, id: p.id || null, status: p.status || null, instance: p.instance || null, jobId: p.jobId || null, folder: p.folder || null, from: p.from || null, basis: p.basis, reasons: [...p.reasons].sort() })).sort(byJson);
  const norm = {
    running: b.running.map(r => ({ who: r.who, id: r.id, status: r.status, folder: r.folder, from: r.from, work: r.work })).sort(byJson),
    blockers: [...b.blockers].sort(),
    passedByCardWord: canonPassed(b.passedByCardWord),
    passedByReboot: canonPassed(b.passedByReboot),
  };
  return require('crypto').createHash('sha256').update(JSON.stringify(norm), 'utf8').digest('hex');
}
// §5.1 (team-v58): «новые записи» свежего списка — те, которых не было в утверждённом (показанном пользователю) списке.
// Сравнение по тем же каноническим полям, что и отпечаток (listHash), без летучих (duration): завершившаяся к перезапуску
// запись исчезает и новой не считается, а появившаяся после показа — считается. Возвращает человекочитаемые строки новых.
function recordKey(kind, parts) { return kind + ':' + JSON.stringify(parts); }
function recordKeys(b) {
  const keys = new Set();
  // install-gate-simple: идущее поручение узнаётся по участнику и номеру — смена статуса (отметка словом установки,
  // cancelling→needs_decision) не делает его новой записью.
  for (const r of b.running || []) keys.add(recordKey('running', [r.who, r.id]));
  for (const x of b.blockers || []) keys.add(recordKey('blocker', [x]));
  const passed = (arr, tag) => (arr || []).forEach(p => keys.add(recordKey(tag, [p.kind, p.who || null, p.id || null, p.status || null, p.instance || null, p.jobId || null, p.folder || null, p.from || null, p.basis, [...p.reasons].sort()])));
  passed(b.passedByCardWord, 'word'); passed(b.passedByReboot, 'reboot');
  return keys;
}
function newRecords(fresh, approved) {
  const old = recordKeys(approved || { running: [], blockers: [], passedByCardWord: [], passedByReboot: [] }), out = [];
  for (const r of fresh.running || []) if (!old.has(recordKey('running', [r.who, r.id]))) out.push(r.who + ' ' + r.id + ' (' + r.status + ')');
  for (const x of fresh.blockers || []) if (!old.has(recordKey('blocker', [x]))) out.push(x);
  // §5.1/§5.4 (team-v58, task10 д): карточку, остановленную словом ТЕКУЩЕЙ установки (deploy-ops.markOverriddenStopped ставит
  // stopConfirmed.basis='слово установки'), НЕ считаем новой записью: она была в утверждённом списке (running/blocker), и слово
  // установки её перекрыло — её переход running→passedByCardWord выполнила сама установка, а не появление невиданного поручения.
  const passedNew = (arr, tag) => (arr || []).forEach(p => { if (p.basis === 'слово установки') return; if (!old.has(recordKey(tag, [p.kind, p.who || null, p.id || null, p.status || null, p.instance || null, p.jobId || null, p.folder || null, p.from || null, p.basis, [...p.reasons].sort()]))) out.push(fmtPassed(p)); });
  passedNew(fresh.passedByCardWord, 'word'); passedNew(fresh.passedByReboot, 'reboot');
  return out;
}
function refusalText(b, hash, channel) {
  const how = channel === 'console'
    ? 'Подождать или прервать? Подождать — Enter (установка отменится, запустите её позже); прервать — наберите слово пользователя.'
    : 'Подождать или прервать? Подождать — повторить установку позже; прервать — слово пользователя (quote) с этим отпечатком (list_hash).';
  return 'Установка не начата.\nСейчас работает (установка это оборвёт):\n' + listText(b) + '\n' + how + '\nОтпечаток списка (list_hash): ' + hash + '.';
}
// §5.4 (team-v58): после установки по слову карточки ПЕРЕКРЫТЫХ поручений (overriddenByWord.running и блокеры-карточки)
// получают отметку остановки с основанием — словом установки (тот же вид отметки stopConfirmed, что ставит stop_confirm;
// источник — канал установки), чтобы они не числились «идёт»/«отменяется» в сводке. Поручения-карточки опознаются по id из
// running и по вхождению id в строку блокера. Карточка, уже закрытая словом/stop_confirmed (cardWord), не трогается.
const SETTLING = ['cancelling', 'cancel_requested', 'delivery_unclear', 'stop_unconfirmed'];
function markOverriddenStopped(state, w) {
  if (!w || !w.quote) return { marked: [] };
  const live = require('./live-jobs');
  const ids = new Set((w.running || []).map(r => String(r.id)));
  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inBlocker = id => (w.blockers || []).some(x => new RegExp('(^|[\\s(])' + esc(id) + '([\\s:)]|$)').test(x));
  let cards;
  try { cards = live.cards({ stateDir: state }); } catch { return { marked: [] }; }
  const at = w.at || new Date().toISOString(), marked = [];
  for (const c of cards) {
    const j = c.j, id = String(j.id || '');
    if (!id || cardWord(j)) continue; // уже со словом/stop_confirmed — не трогаем
    if (!(ids.has(id) || inBlocker(id))) continue;
    const next = { ...j, stopConfirmed: { basis: 'слово установки', quote: w.quote, source: 'install-' + (w.channel || 'console'),
      at, pids: live.cardPids(j), prev_status: j.status, prev_stopUnconfirmed: j.stopUnconfirmed ?? null } };
    // Для «отменяющихся» статусов статус переводится так же, как это делает stop_confirm, — чтобы не числиться «отменяется».
    if (SETTLING.includes(j.status)) next.status = j.write ? 'needs_decision' : 'cancelled';
    delete next.stopUnconfirmed;
    try { require('./team-git').atomic(c.file, JSON.stringify(next, null, 2) + '\n'); marked.push(id); } catch { continue; }
    try { require('./write-lock').releaseConfirmed(next); } catch {}
  }
  return { marked };
}
// Двухшаговый канал чата: без слова — отказ с полным списком и отпечатком; со словом и верным отпечатком — разрешение.
// Доступ (чат участника связки, не поручение) проверяет вызывающий (team.js); здесь — только сверка списка/отпечатка/
// непустоты слова. channel — имя клиента-участника, из чьего чата пришло слово (по умолчанию claude для совместимости).
// install-gate-simple (ревью Codex п.8): предварительная проверка в Team.changeInner — ТОЛЬКО чтение. Ворота и так видят лишь
// живое; закрытие мёртвого идёт позже, на пути установки (deploy.resolveInstallWord) — после проверок полномочий и под замком
// операции. Неполный снимок — технический отказ одной строкой.
function deployGate(state, { quote, listHash: provided, bootAt, channel = 'claude', table } = {}) {
  let b;
  try { b = installationBlockers(state, { bootAt, table }); }
  catch (e) { if (e.code === 'GATE_INCOMPLETE') return { refusal: e.message, technical: true }; throw e; }
  const h = listHash(b);
  if (!b.running.length && !b.blockers.length) return { ok: true, list: b, listHash: h };
  const word = typeof quote === 'string' ? quote.trim() : '';
  if (!word) return { refusal: refusalText(b, h, channel), list: b, listHash: h };
  if (typeof provided !== 'string' || !provided) throw Error('Нужен отпечаток показанного списка (list_hash) вместе со словом пользователя.');
  if (provided !== h) return { refusal: 'Список изменился с момента показа — слово не применено, дайте слово заново по новому списку.\n' + refusalText(b, h, channel), list: b, listHash: h, stale: true };
  return { ok: true, word, channel, list: b, listHash: h };
}
// Барьер установки. opts.word — непустое слово пользователя перекрывает проверку (любые находки). opts.record(patch) пишет в
// запись операции ДО первого изменяющего шага ДВА раздельных поля:
//  gatePassed { at, listHash, passedByCardWord, passedByReboot } — ВСЕГДА, когда непуст хотя бы один из passedBy*, даже если
//    running и blockers пусты (мешающего не осталось и общее слово не понадобилось);
//  overriddenByWord { quote, channel, at, listHash, running, blockers } — ТОЛЬКО когда установка разрешена общим словом.
async function assertNoJobs(state, opts = {}) {
  const b = installationBlockers(state, { bootAt: opts.bootAt, table: opts.table, stores: opts.stores });
  const hash = listHash(b), findings = b.running.length || b.blockers.length;
  const word = typeof opts.word === 'string' ? opts.word.trim() : '';
  const at = new Date().toISOString();
  const gatePassed = (b.passedByCardWord.length || b.passedByReboot.length)
    ? { at, listHash: hash, passedByCardWord: b.passedByCardWord, passedByReboot: b.passedByReboot } : null;
  const write = async patch => { if (opts.record && patch) await opts.record(patch); };
  if (!findings) {
    await write(gatePassed && { gatePassed });
    return { ok: true, listHash: hash, gatePassed, ...b };
  }
  if (!word) {
    await write(gatePassed && { gatePassed });
    throw Object.assign(Error(refusalText(b, hash, opts.channel)), { listHash: hash, list: b });
  }
  // team-v57 (task9 п.1, ревью Gemini 1-2/Codex 1/Kimi 2): утверждённый отпечаток идёт вместе со словом до изменяющего шага.
  // Если передан ожидаемый отпечаток и он НЕ совпал с текущим — список изменился после показа: ОТКАЗ с новым списком и
  // новым отпечатком, ничего не перекрывается (слово относилось к другому списку). Эта сверка повторяется в beforeHold
  // под замком запуска поручений (job_start), поэтому слово перекрывает только то, что видел пользователь.
  if (typeof opts.expectedHash === 'string' && opts.expectedHash && opts.expectedHash !== hash) {
    await write(gatePassed && { gatePassed });
    throw Object.assign(Error('Слово не применено: список изменился с момента показа — дайте слово заново по новому списку.\n' + refusalText(b, hash, opts.channel)), { listHash: hash, list: b, stale: true });
  }
  const overriddenByWord = { quote: word, channel: opts.channel || null, at, listHash: hash, running: b.running, blockers: b.blockers };
  await write({ ...(gatePassed ? { gatePassed } : {}), overriddenByWord });
  return { ok: true, overridden: overriddenByWord, gatePassed, listHash: hash, ...b };
}
async function install(state, release, deps = {}) {
  // team-v57 (ред.5/6): слово пользователя (deps.word) перекрывает барьер; gatePassed/overriddenByWord пишутся в запись операции
  // (deps.opFile — state\deploy-ops\<id>.json) ДО первого изменяющего шага. Без opFile запись пропускается (путь тестов).
  // deps.bootAt — внутренняя тестовая подстановка времени загрузки (в бою не задаётся: берётся настоящее из Windows).
  const record = deps.opFile ? (patch => require('./deploy-ops').update(deps.opFile, patch)) : undefined;
  // team-v57 (task9 п.1): утверждённый отпечаток (deps.listHash) сверяется и здесь, и под замком запуска поручений в beforeHold.
  await assertNoJobs(state, { word: deps.word, channel: deps.channel, bootAt: deps.bootAt, expectedHash: deps.listHash, record, table: deps.table });
  if (!supported(release)) return null;
  const store = require('./members-store').create(state), current = store.read({ initialize: false });
  const wanted = installTarget(state, current, release), changed = wanted.rev !== current.rev;
  if (!changed && !pending(state) && !absent(state)) return null;
  const hold = require('./restart-hold'), atomic = require('./team-git').atomic;
  let op;
  if (pending(state)) {
    op = JSON.parse(fs.readFileSync(recoveryFile(state), 'utf8'));
    if (path.resolve(op.release) !== path.resolve(release)) throw Error('Восстановление миграции требует тот же новый релиз: ' + op.release);
  } else {
    const proof = deps.proof || JSON.parse(fs.readFileSync(path.join(release, 'probe-ok.json'), 'utf8'));
    if ((proof.sourceRegistryAbsent ? !absent(state) : proof.sourceRegistryRev !== current.rev || proof.sourceRegistryHash !== digest(current)) || !proof.targetRoster || proof.targetRegistryHash !== digest(proof.targetRoster)) throw Error('Реестр изменился после пробы Kimi: нужна новая целевая проба.');
    const id = 'kimi-' + require('crypto').randomUUID();
    // team-v57 (task9 п.1, ревью Codex 2/Kimi 2): повторная сверка идёт под замком запуска поручений (job_start) ВНУТРИ
    // hold.begin и с теми же record и ожидаемым отпечатком — это проверенный снимок до изменений. После записи holdFile и
    // recoveryFile новые поручения уже не стартуют (restart-hold.admit отказывает по pending-миграции), поэтому stopServers
    // ниже видит лишь поручения из утверждённого списка и отдельной сверки отпечатка не требует.
    const h = await hold.begin(state, { runId: id, beforeHold: () => assertNoJobs(state, { word: deps.word, channel: deps.channel, bootAt: deps.bootAt, expectedHash: deps.listHash, record, table: deps.table }) }, deps.hold || {});
    const before = proof.sourceRegistryAbsent && proof.targetRoster.rev === 0 ? proof.targetRoster : current;
    op = { id, release, before, expectedRev: current.rev, sourceRegistryAbsent: proof.sourceRegistryAbsent, sourceRegistryHash: proof.sourceRegistryHash, targetRoster: proof.targetRoster, hold: h, status: 'holding', steps: [] };
    atomic(recoveryFile(state), JSON.stringify(op));
  }
  async function step(name, fn) {
    op.steps.push({ name, status: 'started', at: new Date().toISOString() }); atomic(recoveryFile(state), JSON.stringify(op));
    await deps.hook?.('kimi-' + name); const value = await fn();
    op.steps.at(-1).status = 'done'; atomic(recoveryFile(state), JSON.stringify(op)); return value;
  }
  try {
    const stoppedPids = await step('stop', () => stopServers(state, deps));
    await step('migrate', async () => {
      // Повторный снимок включает и серверы, заново открытые другим клиентом после остановки.
      await assertServersStopped(state, new Set(stoppedPids), deps);
      const now = store.read({ initialize: false });
      // Повтор после частично опубликованного журнала проходит восстановление members-store.
      const initializedSource = op.sourceRegistryAbsent && now.rev === 0 && digest(now) === digest(op.before) && store.history().length === 1;
      const emptySource = op.sourceRegistryAbsent && !fs.existsSync(store.file) && !fs.existsSync(store.good) && store.history().length === 0;
      const sameSource = op.sourceRegistryAbsent ? emptySource || initializedSource : now.rev === op.expectedRev && digest(now) === op.sourceRegistryHash;
      if (!sameSource && !accepts(op, now)) throw Error('Редакция реестра изменилась после пробы; это не результат данной миграции.');
      const candidate = require(path.join(release, 'common/members-kimi.js'));
      if (sameSource) {
        if (op.sourceRegistryAbsent) store.read({ initialRoster: op.before });
        candidate.apply(state, now.rev, op.targetRoster);
      }
      if (op.recovering) candidate.emergencyPause(state, op);
    });
    op.status = 'migrated'; atomic(recoveryFile(state), JSON.stringify(op)); return op;
  } catch (e) {
    op.status = 'recovery_required'; op.recovering = true; op.error = e.message; atomic(recoveryFile(state), JSON.stringify(op));
    try { emergencyPause(state, op); } catch {}
    throw Error('Миграция Kimi остановлена; restart-hold сохранён до восстановления тем же новым кодом: ' + e.message);
  }
}
async function complete(state, op, probe, deps = {}) {
  if (!op) return;
  try {
    refresh(state, op);
    const store = require('./members-store').create(state);
    const consistent = () => {
      const current = store.read({ initialize: false }); store.history();
      if (digest(current) !== digest(latestRoster(op))) throw Error('Реестр после миграции не соответствует операции: восстановление не завершено.');
    };
    consistent(); await probe(); consistent();
    // Только после согласованной истории и готовности серверов нового кода.
    op.status = 'complete'; op.completedAt = new Date().toISOString();
    require('./team-git').atomic(recoveryFile(state), JSON.stringify(op));
    if (!await require('./restart-hold').abort(state, op.hold, deps.hold || {})) throw Error('Не подтверждено снятие паузы миграции.');
  } catch (e) { failed(state, op, e); throw e; }
}
function failed(state, op, error) {
  if (!op) return;
  refresh(state, op);
  op.status = 'recovery_required'; op.recovering = true; op.error = error.message;
  require('./team-git').atomic(recoveryFile(state), JSON.stringify(op));
  emergencyPause(state, op);
}
module.exports = { member, MASKS, forward, target, installTarget, activationTarget, activation, digest, absent, apply, recorded, supported, compatible, emergencyPause, pending, install, complete, failed, stopServers, serverProcesses, installationBlockers, installBootAt, assertNoJobs, listText, listHash, newRecords, markOverriddenStopped, refusalText, deployGate, acceptance, acceptanceBinding, acceptanceFile, originalPauseRemovable, resilientCards };
