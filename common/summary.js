'use strict';
const fs = require('fs'), path = require('path');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const short = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
function title(value) { return value.title || (value.name === 'trio-v2' ? 'Связка четырёх: 8 пунктов запроса' : value.name); }
function label(value) { return value.title ? value.title + ' (' + value.name + ')' : title(value); }
const changeTitle = value => value.title || value.name;
function localTime(value) { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'время неизвестно'; }
function mergedLine(root, merged) {
  const timed = merged.map(card => {
    let at = card.mergedAt, source = 'слияние';
    if (!Number.isFinite(Date.parse(at))) {
      at = null; source = 'время коммита';
      if (/^[a-f0-9]{40}$/i.test(card.candidate || '')) try {
        at = require('./team-git').git(root, ['show', '-s', '--format=%cI', card.candidate, '--'], { recoverIndex: false, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch {}
    }
    return { card, at, source, time: Date.parse(at) };
  });
  const known = timed.filter(v => Number.isFinite(v.time)).sort((a, b) => b.time - a.time || a.card.name.localeCompare(b.card.name));
  const unknown = timed.length - known.length, last = known[0];
  return 'Изменения: слито: ' + merged.length + (last ? ', последнее' + (unknown ? ' с известным временем' : '') + ' ' + short(changeTitle(last.card), 65) + ' ' + (last.card.candidate || '').slice(0, 8) + ' · ' + last.source + ' ' + localTime(last.at) : '') +
    (unknown ? '; время неизвестно: ' + unknown : '');
}
function grokText(c) {
  return ['design', 'verdict'].map(phase => {
    const v = c[phase === 'design' ? 'grokDesign' : 'grokVerdict'];
    // team-v18: Grok на месте выпавшего обязательного выполняет и совещательный запрос этой редакции.
    const slot = c.request ? require('./team-seats').grokSlotVote(c, phase) : null;
    if (slot && (!v || !require('./grok-gate').bound(v, c, phase))) return 'на месте ' + slot.replaces + ': ' + slot.decision;
    if (!v || !require('./grok-gate').bound(v, c, phase)) return 'не запрошен';
    return v.decision || ({ running: 'ждём ответ', queued: 'ждём ответ', delivery_unclear: 'ждём ответ', failed: 'отказ', lost: 'потеряно', cancelled: 'отменено локально', stop_unconfirmed: 'остановка не подтверждена', cancel_requested: 'запрошена отмена' }[v.status]) || v.status;
  }).join(' / ');
}
function workTitle(name) {
  if (!/^[a-z0-9-]{1,40}$/.test(name || '')) return name || 'не указана';
  try { return title(read(path.join(require('./paths').repoRoot, 'works', name + '.json'))); }
  catch { return title({ name }); }
}
function loadLine(state, jobs) {
  let c; try { c = read(path.join(state, 'claude-quota.json')); } catch {}
  const fresh = c?.window_h === 5 && Date.now() - Date.parse(c.taken_at) < 18000000;
  const recent = who => (jobs[who] || []).filter(j => !j.archived && Date.parse(j.startedAt) > Date.now() - 18000000);
  const a = recent('antigravity');
  return 'Нагрузка за 5 ч: Claude Desktop — ' + (fresh ? c.calls + ' обращений, перечитано ' + (c.reread / 1e6).toFixed(1) + ' млн' : 'нет замера за 5 ч') +
    '; Codex — ' + recent('codex').length + ' поручений; Antigravity — ' + a.length + ' поручений, ' + (a.reduce((n, j) => n + (Number(j.usage?.total_tokens) || 0), 0) / 1e6).toFixed(2) + ' млн токенов.' +
    (fresh && c.reread > 50000000 ? '\nClaude перегружен: отдавайте чтение и ревью помощникам' : '');
}
function settings({ row = false } = {}) {
  const d = require('./deploy'), cc = require('./client-configs'), entries = [];
  for (const file of d.configPaths()) {
    try {
      const c = d.snapshot(file).config;
      for (const n of require('./members').servers) entries.push({ name: 'Claude ' + file + ' / ' + n, arg: c.mcpServers?.[n]?.args?.[0] });
    } catch (e) { entries.push({ name: 'Claude ' + file, error: e.code === 'ENOENT' ? 'отсутствует' : 'ошибка чтения' }); }
  }
  for (const { file, kind } of cc.paths().filter(p => p.kind !== 'permissions')) {
    try {
      const s = d.snapshot(file), servers = kind === 'codex' ? cc.block(s.text).parsed.root.mcp_servers : s.config.mcpServers;
      for (const n of require('./members').servers) entries.push({ name: kind + '/' + n, arg: servers?.[n]?.args?.[0] });
    } catch { entries.push({ name: kind, error: 'не подключён или ошибка чтения' }); }
  }
  const release = e => e.arg && /[\\/]live[\\/]([a-f0-9]{40})[\\/]servers[\\/]/.exec(e.arg)?.[1];
  const counts = new Map(); for (const e of entries) { const r = release(e); if (r) counts.set(r, (counts.get(r) || 0) + 1); }
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const aligned = main && entries.every(e => release(e) === main);
  const text = aligned ? 'Все подключения → ' + main.slice(0, 8) :
    'Расхождения подключений: ' + entries.filter(e => !main || release(e) !== main).map(e => e.name + ' → ' + (release(e)?.slice(0, 8) || e.error || 'не подключён')).join('; ');
  return row ? { text, priority: aligned ? 2 : undefined } : text;
}
// Необязательные записи снимаются целиком; обязательные могут превышать бюджет.
function fit(rows, budget = 3000) {
  const kept = new Set(rows), optional = rows.filter(r => r.priority != null)
    .sort((a, b) => a.priority - b.priority || a.updated - b.updated);
  let hidden = 0, works = 0;
  const text = () => [...rows.filter(r => kept.has(r)).map(r => r.text),
    ...(hidden ? ['Ещё не показано: ' + hidden + ' строк (из них работ: ' + works + ') — team_status full=true'] : [])].join('\n');
  for (const row of optional) {
    if (text().length <= budget) break;
    kept.delete(row); hidden += row.text.split('\n').length; if (row.work) works++;
  }
  return text();
}
async function compact(team, quota, snapshot = require('./job-snapshot').create(), options = {}) {
  const rows = [], jobs = {}, stores = require('./team-store');
  const add = (text, priority, extra = {}) => { if (text) rows.push({ text, priority, ...extra }); };
  const section = async fn => { try { await fn(); } catch (e) { add('Ошибка: ' + e.message); } };
  add(quota);
  for (const line of options.required || []) add(line);
  for (const line of options.restartWarnings || require('./restart-hold').warnings(path.dirname(team.state))) add(line);
  await section(() => require('./release-drift').lines(team.root, require('./paths').stateDir).forEach(line => add(line)));
  for (const who of require('./members').helpers) await section(async () => {
    const result = stores.list(who, true, snapshot); jobs[who] = result.jobs;
    result.errors.forEach(e => add('Ошибка чтения: ' + e));
    const waiting = result.jobs.filter(j => !j.archived && j.status === 'waiting_quota');
    if (waiting.length) {
      const times = waiting.map(j => Date.parse(j.nextAttemptAt)).filter(Number.isFinite);
      const next = times.length ? new Date(Math.min(...times)).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'время неизвестно';
      add(({ codex: 'Codex', antigravity: 'Antigravity', grok: 'Grok' }[who]) + ': Ждут квоту: ' + waiting.length + ' поручений, ближайшее продолжение ' + next + ' · подробности: full=true');
    }
    let decisions = 0, stops = 0;
    const active = ['running', 'queued', 'cancelling', 'cancel_requested', 'delivery_unclear', 'migration_conflict', 'applying'];
    for (const j of result.jobs.filter(j => !j.archived && (j.stopUnconfirmed || [...active, 'needs_decision', 'stop_unconfirmed'].includes(j.status)))) {
      const stopped = j.stopUnconfirmed || j.status === 'stop_unconfirmed';
      const old = Date.parse(j.startedAt) < Date.now() - 86400000;
      if (old && !active.includes(j.status)) {
        if (stopped) stops++;
        if (j.status === 'needs_decision') decisions++;
        continue;
      }
      let status = j.status;
      if (who !== 'grok' && ['running', 'cancelling', 'stop_unconfirmed'].includes(status) && await snapshot.ownerState(j.owner) === 'dead') status = who === 'codex' && j.write ? 'needs_decision' : 'lost';
      add(who + ' ' + j.id.slice(0, 8) + ': ' + require('./states')[status] + (stopped ? ' · ОСТАНОВКА НЕ ПОДТВЕРЖДЕНА' : '') + (j.nextAttemptAt ? ' до ' + j.nextAttemptAt : ''));
    }
    if (decisions) add(who + ': нужно решение по ' + decisions + ' поручениям старше суток — full=true');
    if (stops) add(who + ': остановка не подтверждена у ' + stops + ' поручений старше суток — full=true');
  });
  const [load, ...advice] = loadLine(team.state, jobs).split('\n');
  add(load, 1); advice.forEach(line => add(line));
  add('Рутина за сутки (этап «рутина»): ' + require('./members').helpers.map(who => who + ' — ' +
    (jobs[who] || []).filter(j => Date.parse(j.startedAt) > Date.now() - 86400000 && /^рутина(?:$|\s*[:—-])/i.test(j.stage || '')).length).join('; '), 0);
  await section(() => {
    const works = team.works(), done = works.filter(w => !w.error && (w.closed || w.stages.every(s => s.state === 'принят')));
    const unaccepted = done.reduce((n, w) => n + w.stages.filter(s => s.state === 'выдан без принятия').length, 0);
    add('Работы: завершено ' + done.length + '; этапов «выдан без принятия» в завершённых: ' + unaccepted + ' — подробности full=true');
    for (const w of works.filter(w => !done.includes(w))) {
      if (w.error) { add(w.error); continue; }
      const i = w.stages.findIndex(s => s.state !== 'принят');
      const block = [short(title(w), 65) + ': принято ' + require('./team').percent(w) + ' % · этап ' + (i + 1) + '/' + w.stages.length + ' ' + short(w.stages[i]?.title, 45) + '; далее: ' + short(w.next_step, 85)];
      for (const s of w.stages) {
        if (s.state === 'выдан без принятия') block.push(title(w) + ': ' + s.title + ' — выдан без принятия; ' + (s.gate?.reasons || []).join('; '));
        if (s.gate?.files?.length) block.push(title(w) + ': ' + s.title + ' — место помощника с чистой памятью заполнено файлом Claude; сервер его не проверял');
        if (s.gate?.warning) add(title(w) + ': ' + s.title + ' — ' + s.gate.warning);
      }
      add(block.join('\n'), 6, { work: true, updated: Date.parse(w.updated_at || w.created_at) || 0 });
    }
  });
  await section(() => {
    const dir = path.join(team.state, 'changes'), seen = new Set();
    const changes = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')).flatMap(n => {
      try { return [{ ...read(path.join(dir, n)), card: path.join(dir, n) }]; }
      catch (e) { add('Ошибка чтения изменения ' + n + ': ' + e.message); return []; }
    }) : [];
    add(mergedLine(team.root, changes.filter(c => c.status === 'слито')), 4);
    add('Изменения: закрыто: ' + changes.filter(c => c.status === 'закрыто без слияния').length, 3);
    for (const c of changes.filter(c => !['слито', 'закрыто без слияния'].includes(c.status))) {
      if (c.requestMark && !seen.has(c.requestMark)) {
        seen.add(c.requestMark); add('Запрос ' + c.requestMark + ': ' + short(c.request, 200) + ' · полный текст: ' + c.card);
      }
      add(short(changeTitle(c), 65) + ': ' + c.status + ' ' + (c.candidate || '').slice(0, 8));
    }
  });
  await section(() => {
    const file = path.join(team.root, 'live/deployed.json');
    if (fs.existsSync(file)) { const m = read(file); add('Последнее развёртывание: ' + m.commit.slice(0, 8) + ' · ' + localTime(m.at) + ' · ' + (m.method || 'способ не записан'), 5); }
    else add('Последнее развёртывание: не записано', 5);
    const op = require('./deploy-ops').list(team.root, { reconcile: false }).at(-1);
    if (op) {
      const cleanup = op.cleanup && { ...op.cleanup, blocked: op.cleanup.blocked?.length ? [op.cleanup.blocked.length + ' — full=true'] : [] };
      const optional = op.status === 'завершено' && (!cleanup || ['готово', 'отключена'].includes(cleanup.state)) && !cleanup?.failed && !cleanup?.uncheckedHiddenProcesses;
      add('Установка ' + op.id + ': ' + op.status + (op.reason ? ' · ' + op.reason : '') + (op.restart ? ' · ' + op.restart : '') + (op.cleanup ? ' · ' + require('./deploy-ops').cleanupLine(cleanup) : ''), optional ? 5 : undefined);
    }
  });
  await section(() => { const row = settings({ row: true }); add(row.text, row.priority); });
  await section(() => {
    const state = require('./paths').stateDir, file = path.join(state, 'migration.log');
    if (fs.existsSync(file)) {
      const m = read(file);
      for (const e of m.errors || []) add('Ошибка переноса · ' + (e.id || 'хранилище') + ' · ' + e.error);
      for (const e of m.conflicts || []) add('ПЕРЕНОС: КОНФЛИКТ · ' + e.kind + ' · ' + e.id);
    }
    const dir = path.join(state, 'quarantine');
    if (fs.existsSync(dir)) for (const id of fs.readdirSync(dir)) {
      const c = read(path.join(dir, id, 'card.json')); add('ПЕРЕНОС: ПОВРЕЖДЁН · ' + c.id + ' · ' + (c.migration?.reason || 'Причина не указана'));
    }
    const error = path.join(state, 'migration-error.json');
    if (fs.existsSync(error) && read(error).error) add('Ошибка сверки хранилища · ' + read(error).error);
  });
  return fit(rows, options.budget);
}
module.exports = { fit, changeTitle, localTime, compact, title, label, workTitle, loadLine, settings, grokText, mergedLine };
