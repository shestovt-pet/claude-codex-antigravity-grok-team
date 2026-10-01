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
    if (!v || !require('./grok-gate').bound(v, c, phase)) return 'не запрошен';
    return v.decision || ({ running: 'ждём ответ', queued: 'ждём ответ', delivery_unclear: 'ждём ответ', failed: 'отказ', lost: 'потеряно', cancelled: 'отменено' }[v.status]) || v.status;
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
  return 'Нагрузка за 5 ч: Claude — ' + (fresh ? c.calls + ' обращений, перечитано ' + (c.reread / 1e6).toFixed(1) + ' млн' : 'нет замера за 5 ч') +
    '; Codex — ' + recent('codex').length + ' поручений; Antigravity — ' + a.length + ' поручений, ' + (a.reduce((n, j) => n + (Number(j.usage?.total_tokens) || 0), 0) / 1e6).toFixed(2) + ' млн токенов; Grok — ' + recent('grok').length + ' поручений.' +
    (fresh && c.reread > 50000000 ? '\nClaude перегружен: отдавайте чтение и ревью помощникам' : '');
}
function settings() {
  const d = require('./deploy'), cc = require('./client-configs'), entries = [];
  for (const file of d.configPaths()) {
    try {
      const c = d.snapshot(file).config;
      for (const n of ['team', 'codex', 'antigravity', 'grok']) entries.push({ name: 'Claude ' + file + ' / ' + n, arg: c.mcpServers?.[n]?.args?.[0] });
    } catch (e) { entries.push({ name: 'Claude ' + file, error: e.code === 'ENOENT' ? 'отсутствует' : 'ошибка чтения' }); }
  }
  for (const { file, kind } of cc.paths().filter(p => p.kind !== 'permissions')) {
    try {
      const s = d.snapshot(file), servers = kind === 'codex' ? cc.block(s.text).parsed.root.mcp_servers : s.config.mcpServers;
      for (const n of ['team', kind === 'codex' ? 'antigravity' : 'codex', 'grok']) entries.push({ name: kind + '/' + n, arg: servers?.[n]?.args?.[0] });
    } catch { entries.push({ name: kind, error: 'не подключён или ошибка чтения' }); }
  }
  const release = e => e.arg && /[\\/]live[\\/]([a-f0-9]{40})[\\/]servers[\\/]/.exec(e.arg)?.[1];
  const counts = new Map(); for (const e of entries) { const r = release(e); if (r) counts.set(r, (counts.get(r) || 0) + 1); }
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (main && entries.every(e => release(e) === main)) return 'Все подключения → ' + main.slice(0, 8);
  return 'Расхождения подключений: ' + entries.filter(e => !main || release(e) !== main).map(e => e.name + ' → ' + (release(e)?.slice(0, 8) || e.error || 'не подключён')).join('; ');
}
async function compact(team, quota) {
  const rows = [], jobs = {}, stores = require('./team-store');
  const section = async fn => { try { await fn(); } catch (e) { rows.push('Ошибка: ' + e.message); } };
  rows.push(quota);
  for (const who of ['codex', 'antigravity', 'grok']) await section(async () => {
    if (who === 'grok') for (const j of stores.list(who, false).jobs) await new (require('./grok').Grok)().refresh(j.id);
    const result = stores.list(who); jobs[who] = result.jobs;
    rows.push(...result.errors.map(e => 'Ошибка чтения: ' + e));
    const waiting = result.jobs.filter(j => !j.archived && j.status === 'waiting_quota');
    if (waiting.length) {
      const times = waiting.map(j => Date.parse(j.nextAttemptAt)).filter(Number.isFinite);
      const next = times.length ? new Date(Math.min(...times)).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'время неизвестно';
      rows.push(({ codex: 'Codex', antigravity: 'Antigravity', grok: 'Grok' }[who]) + ': Ждут квоту: ' + waiting.length + ' поручений, ближайшее продолжение ' + next + ' · подробности: full=true');
    }
    for (const j of result.jobs.filter(j => !j.archived && ['running', 'queued', 'needs_decision', 'cancelling', 'stop_unconfirmed', 'delivery_unclear', 'migration_conflict'].includes(j.status))) {
      let status = j.status;
      if (who !== 'grok' && ['running', 'cancelling', 'stop_unconfirmed'].includes(status) && await require('./locks').ownerState(j.owner) === 'dead') status = who === 'codex' && j.write ? 'needs_decision' : 'lost';
      rows.push(who + ' ' + j.id.slice(0, 8) + ': ' + require('./states')[status] + (j.nextAttemptAt ? ' до ' + j.nextAttemptAt : ''));
    }
  });
  rows.push(loadLine(team.state, jobs));
  rows.push('Рутина за сутки (этап «рутина»): ' + ['codex', 'antigravity', 'grok'].map(who => who + ' — ' +
    (jobs[who] || []).filter(j => Date.parse(j.startedAt) > Date.now() - 86400000 && /^рутина(?:$|\s*[:—-])/i.test(j.stage || '')).length).join('; '));
  await section(() => {
    const works = team.works(), done = works.filter(w => !w.error && (w.closed || w.stages.every(s => s.state === 'принят')));
    rows.push('Работы: завершено ' + done.length);
    for (const w of works.filter(w => !w.error)) {
      for (const s of w.stages) {
        if (s.state === 'выдан без принятия') rows.push(title(w) + ': ' + s.title + ' — выдан без принятия; ' + (s.gate?.reasons || []).join('; '));
        if (s.gate?.files?.length) rows.push(title(w) + ': ' + s.title + ' — место помощника с чистой памятью заполнено файлом Claude; сервер его не проверял');
        if (s.gate?.warning) rows.push(title(w) + ': ' + s.title + ' — ' + s.gate.warning);
      }
    }
    for (const w of works.filter(w => !done.includes(w))) {
      if (w.error) { rows.push(w.error); continue; }
      const i = w.stages.findIndex(s => s.state !== 'принят');
      rows.push(short(title(w), 65) + ': принято ' + require('./team').percent(w) + ' % · этап ' + (i + 1) + '/' + w.stages.length + ' ' + short(w.stages[i]?.title, 45) + '; далее: ' + short(w.next_step, 85));
    }
  });
  await section(() => {
    const dir = path.join(team.state, 'changes'), seen = new Set();
    const changes = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => ({ ...read(path.join(dir, n)), card: path.join(dir, n) })) : [];
    rows.push(mergedLine(team.root, changes.filter(c => c.status === 'слито')));
    rows.push('Изменения: закрыто: ' + changes.filter(c => c.status === 'закрыто без слияния').length);
    for (const c of changes.filter(c => !['слито', 'закрыто без слияния'].includes(c.status))) {
      if (c.requestMark && !seen.has(c.requestMark)) {
        seen.add(c.requestMark); rows.push('Запрос ' + c.requestMark + ': ' + short(c.request, 200) + ' · полный текст: ' + c.card);
      }
      rows.push(short(changeTitle(c), 65) + ': ' + c.status + ' ' + (c.candidate || '').slice(0, 8) + '; Grok: ' + grokText(c));
    }
  });
  await section(() => {
    const file = path.join(team.root, 'live/deployed.json');
    if (fs.existsSync(file)) { const m = read(file); rows.push('Последнее развёртывание: ' + m.commit.slice(0, 8) + ' · ' + localTime(m.at) + ' · ' + (m.method || 'способ не записан')); }
    else rows.push('Последнее развёртывание: не записано');
    const op = require('./deploy-ops').list(team.root).at(-1);
    if (op) rows.push('Установка ' + op.id + ': ' + op.status + (op.reason ? ' · ' + op.reason : '') + (op.restart ? ' · ' + op.restart : '') + (op.cleanup ? ' · ' + require('./deploy-ops').cleanupLine(op.cleanup) : ''));
  });
  await section(() => rows.push(settings()));
  await section(() => {
    const state = require('./paths').stateDir, file = path.join(state, 'migration.log');
    if (fs.existsSync(file)) {
      const m = read(file);
      for (const e of m.errors || []) rows.push('Ошибка переноса · ' + (e.id || 'хранилище') + ' · ' + e.error);
      for (const e of m.conflicts || []) rows.push('ПЕРЕНОС: КОНФЛИКТ · ' + e.kind + ' · ' + e.id);
    }
    const dir = path.join(state, 'quarantine');
    if (fs.existsSync(dir)) for (const id of fs.readdirSync(dir)) {
      const c = read(path.join(dir, id, 'card.json')); rows.push('ПЕРЕНОС: ПОВРЕЖДЁН · ' + c.id + ' · ' + (c.migration?.reason || 'Причина не указана'));
    }
    const error = path.join(state, 'migration-error.json');
    if (fs.existsSync(error) && read(error).error) rows.push('Ошибка сверки хранилища · ' + read(error).error);
  });
  return rows.join('\n');
}
module.exports = { changeTitle, localTime, compact, title, label, workTitle, loadLine, settings, grokText, mergedLine };
