'use strict';
// Серверная история приёмки. Чтение строит снимок в памяти, запись принадлежит Team.work.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const clone = x => x == null ? x : structuredClone(x);
const equal = (a, b) => require('./client-configs').equal(a ?? null, b ?? null);
const fields = ['title', 'level', 'author', 'accept_criteria', 'source_jobs', 'partial_sources', 'material', 'artifact_manifest'];
function legacy(s) {
  const votes = clone(s.gate?.votes || []);
  return { legacy: true, version: s.version, at: null, rules_version: s.rules_version,
    needed: null, families: [...new Set(votes.filter(v => !v.count).map(v => v.family))], votes,
    replacements: clone((s.decisions || []).filter(d => d.kind === 'replace')), materials: null,
    criteria_sha256: null, level: s.level, author: clone(s.author) };
}
function materials(w, s) {
  return (s.material || []).map(file => {
    const bytes = fs.readFileSync(path.resolve(w.folder || require('./paths').repoRoot, file));
    return { path: file, sha256: sha(bytes), size: bytes.length };
  });
}
function record(w, s) {
  const votes = clone(s.gate?.votes || []), quorum = s.gate?.quorum || [];
  return { version: s.version, at: new Date().toISOString(), rules_version: s.rules_version,
    needed: quorum.length ? Math.max(...quorum.map(q => q.needed)) : null,
    families: [...new Set(votes.filter(v => !v.count).map(v => v.family))],
    votes, replacements: clone((s.decisions || []).filter(d => d.kind === 'replace')),
    materials: materials(w, s), criteria_sha256: sha(s.accept_criteria || ''), level: s.level, author: clone(s.author) };
}
// Отрезок серверного сообщения одного этапа: от «этап i из n — <название> · сделано:» до следующего этапа пакета или « · дальше:».
const START = '(?:^| · |; |приняты этапы: )этап \\d+ из \\d+ — ';
function segment(text, title) {
  const m = new RegExp(START + esc(title) + ' · сделано:').exec(text || '');
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(new RegExp('; этап \\d+ из \\d+ — | · дальше: '));
  return m[0] + (end < 0 ? rest : rest.slice(0, end));
}
const esc = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Р16: «это закрывает: <closes || accept_criteria>» из журнала должно совпасть с текущими полями этапа.
function closesMatch(n, s) {
  if (s.closes && s.accept_criteria) return false; // в журнал попадает только closes — критерий не доказан
  const want = s.closes || s.accept_criteria || '';
  const seg = segment(n.text, s.title);
  return seg != null && seg.endsWith(' · это закрывает: ' + want);
}
function notice(w, s) {
  let text;
  try { text = fs.readFileSync(path.join(require('./paths').stateDir, 'notify.log'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  // Р17(а): только серверное «<title(w)>: принято N % плана».
  const exact = new RegExp('^' + esc(require('./summary').title(w)) + ': принято \\d+(?:\\.\\d+)? % плана$');
  return text.split(/\r?\n/).flatMap(line => {
    let n; try { n = JSON.parse(line); } catch { return []; }
    if (!Number.isFinite(Date.parse(n.at)) || !exact.test(n.title || '')) return [];
    // Точное название и границы серверного сообщения, включая пакетную приёмку.
    return segment(n.text, s.title) != null ? [n] : [];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1) || null;
}
function humanDecision(w, s, at) {
  if (s.state === 'выдан без принятия' || s.override || s.one_family || s.gate?.issued ||
      (s.gate?.reasons || []).some(r => /выдан[о]? без принятия|по слову пользователя/.test(r))) return true;
  if ((w.removed_stages || []).some(r => r.id === s.id || r.title === s.title)) return true;
  return [...(s.decisions || []), ...(w.plan_changes || [])].some(d => Date.parse(d.at) >= Date.parse(at) &&
    /выда[нт]|без принятия|отказ|удал[её]|по слову|решени[ея] (?:пользователя|пользователя)/i.test(JSON.stringify(d)));
}
function negative(w, s, a, jobs, snapshot) {
  const g = require('./stage-gate');
  // Исторические голоса не перечитываются для нового кворума, но новый отзыв проверяется штатным разбором.
  const known = new Map((a.votes || []).map(v => [v.id, v]));
  // Замена выключенного Grok не голосует и не отказывает — как в самом пересчёте (stage-gate, stage-gate-v15, team-v23 О4).
  const rows = g.currentRows(w, s, jobs.filter(j => j.who !== 'grok'), a.version, [], snapshot).filter(r => r.replaces?.who !== 'grok' && (r.who !== 'fresh' || !/^(?:replacement|замена):\s*grok\s*$/m.test(r.reviewText || '')));
  return rows.find(r => r.count && (!known.has(r.id) || !known.get(r.id).count) &&
    !rows.some(n => n.who === r.who && !n.count && g.compare(n, r) > 0));
}
function invalidate(s, reason) {
  s.state = 'идёт'; s.gate ||= { files: [], reasons: [] };
  s.gate.reasons = [reason];
  return { handled: true, message: reason + ' — нужна повторная приёмка.' };
}
function preserve(w, s, old, jobs, snapshot) {
  if (!old) return { handled: false };
  // Поля истории берутся только из серверного old, даже при прямом вызове evaluate.
  delete s.acceptance; delete s.acceptance_history; delete s.acceptance_restore;
  // Серверная история прошлых приёмок восстанавливается из old всегда, в том числе при явном сбросе
  // принятого этапа: тогда меняется только состояние и доказательство текущей приёмки, а история — нет.
  if (old.acceptance_history) s.acceptance_history = clone(old.acceptance_history);
  // Явный сброс принятого этапа: пользователь снизил state (normalize снял evidence) — приёмку не восстанавливаем
  // в «принят» без доказательства. Этап сбрасывается, а сам сброс плана требует plan_change на уровне team.work
  // (иначе отказ /пояснения/). Без этого preserve возвращал «принят» уже без evidence → путаный отказ /доказательства/.
  if (old.state === 'принят' && s.state !== 'принят') return { handled: false };
  if (old.acceptance) s.acceptance = clone(old.acceptance);
  const g = require('./stage-gate');
  let restored = false, n;
  if (old.state === 'принят') s.acceptance ||= legacy(old);
  // «Выдан без принятия» — решение человека: история не восстанавливается и не показывается как сброс.
  else if (old.state !== 'выдан без принятия' && !old.acceptance && (n = notice(w, old))) {
    let reason;
    if (!old.version || !old.gate?.votes?.length) reason = 'не сохранены версия и голоса';
    // Р14: все голоса несут version, равную текущей (старый код при смене материала менял s.version, но не голоса).
    else if (old.gate.votes.some(v => !v.version || v.version !== old.version)) reason = 'голоса относятся к другой версии';
    else if (!closesMatch(n, s)) reason = 'изменены условия этапа';
    else if (old.source_jobs?.length || old.partial_sources?.length) reason = 'источники этапа не подтверждаются журналом';
    else if (humanDecision(w, s, n.at)) reason = 'после приёмки есть решение человека';
    else {
      try {
        if (g.version(w, s) !== old.version) reason = 'материал изменён';
        else if (fields.some(k => !equal(old[k], s[k]))) reason = 'изменены условия этапа';
        else if (negative(w, s, legacy(old), jobs, snapshot)) reason = 'есть новый отрицательный отзыв';
        else g.checkArtifacts(w, s);
      } catch (e) { reason = e.message; }
    }
    if (reason) {
      // Недоказанная история не превращается в приёмку; обычная оценка этапа продолжается (новая приёмка возможна).
      // Р15: строка о сбросе — только когда нет решения человека и нового отрицательного отзыва.
      if (!['после приёмки есть решение человека', 'есть новый отрицательный отзыв'].includes(reason)) s.acceptance_restore = { at: n.at, reason };
      return { handled: false };
    }
    s.acceptance = { ...legacy(old), at: n.at, restored_from: 'notify.log ' + n.at };
    restored = true;
  }
  // Р17(г): признак прежней приёмки (evidence с ПРИНЯТО у этапа «идёт»), но в журнале её нет — честно, без даты.
  if (old.state === 'идёт' && !old.acceptance && !n && /ПРИНЯТО/.test(old.evidence || '')) s.acceptance_restore = { at: null, reason: 'приёмка в журнале не найдена' };
  if (old.state !== 'принят' && !restored) return { handled: false };
  const a = s.acceptance;
  const v = g.version(w, s); // Ошибка чтения — штатное предупреждение, а не доказательство изменения.
  s.version = v;
  if (v !== a.version || fields.some(k => !equal(old[k], s[k])) ||
      (a.criteria_sha256 && a.criteria_sha256 !== sha(s.accept_criteria || '')) ||
      !equal(a.level, s.level) || !equal(a.author, s.author)) return invalidate(s, 'Этап изменён после «принят» — снова не принят');
  try { s.artifact_verification = g.checkArtifacts(w, s); }
  catch (e) { return invalidate(s, e.message); }
  if (s.fresh_review_file) { g.registerFile(w, s, s.fresh_review_file, v); delete s.fresh_review_file; }
  const refusal = negative(w, s, a, jobs, snapshot);
  if (refusal) { s.gate.lateVersion = v; return invalidate(s, 'запоздалый отказ: НЕ ПРИНЯТО ' + refusal.who + ', ' + refusal.id); }
  // Явная выдача по решению человека проходит обычные ворота.
  if (s.override || s.one_family || s.state === 'выдан без принятия') return { handled: false };
  s.state = 'принят';
  delete s.criterion_met;
  s.gate.reasons = [];
  return { handled: true, message: restored ? 'Приёмка восстановлена из ' + s.acceptance.restored_from : '' };
}
function finish(w, s, old) {
  if (s.state !== 'принят') return;
  if (old?.state === 'принят' && s.acceptance?.version === s.version) return;
  if (s.acceptance) (s.acceptance_history ||= []).push(clone(s.acceptance));
  s.acceptance = record(w, s);
}
const round = x => Math.round(x * 100) / 100;
const date = (x, time = false) => {
  if (!x || !Number.isFinite(new Date(x).getTime())) return 'дата не сохранена';
  const d = new Date(x), pad = n => String(n).padStart(2, '0');
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + (time ? ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : '');
};
function stageText(w, s) {
  if (s.acceptance_restore?.at === null && s.state === 'идёт') return 'Этап был принят? Приёмка в журнале не найдена — восстановить нельзя, нужна повторная приёмка';
  if (s.acceptance_restore && s.state === 'идёт') return 'Этап был принят ' + date(s.acceptance_restore.at) + ', приёмка сброшена старым кодом; восстановить нельзя: ' + s.acceptance_restore.reason + ' — нужна повторная приёмка';
  const a = s.acceptance;
  if (!a || ['принят', 'выдан без принятия'].includes(s.state)) return '';
  if (!a.materials) return 'Этап был принят для версии ' + a.version + ' (дата приёмки не сохранена); ' +
    (a.version !== s.version ? 'материал изменён после приёмки' : 'приёмка больше не действует') + ' — нужна повторная приёмка';
  const changes = [];
  for (const f of a.materials) {
    const file = path.resolve(w.folder || require('./paths').repoRoot, f.path);
    try {
      if (!(s.material || []).includes(f.path) || sha(fs.readFileSync(file)) !== f.sha256)
        changes.push(f.path + ' (' + date(fs.statSync(file).mtime, true) + ')');
    } catch { changes.push(f.path + ' (недоступен)'); }
  }
  for (const file of (s.material || []).filter(f => !a.materials.some(m => m.path === f))) {
    try { changes.push(file + ' (' + date(fs.statSync(path.resolve(w.folder || require('./paths').repoRoot, file)).mtime, true) + ')'); }
    catch { changes.push(file + ' (недоступен)'); }
  }
  return 'Этап принят ' + date(a.at) + ' для версии ' + a.version + '; после приёмки изменены: ' +
    (changes.join(', ') || 'условия приёмки или отзывы; ' + (s.gate?.reasons || []).join('; ')) + ' — нужна повторная приёмка';
}
function presentation(w) {
  const current = round(w.stages.filter(s => s.state === 'принят').reduce((n, s) => n + s.weight, 0));
  const previous = round(w.stages.filter(s => s.state === 'идёт' && s.acceptance).reduce((n, s) => n + s.weight, 0));
  return { current, previous, line: 'Принято ' + current + ' % плана' + (previous ? ' (ещё ' + previous + ' % было принято для прежних версий — нужна повторная приёмка)' : ''),
    details: w.stages.map(s => stageText(w, s)).filter(Boolean) };
}
// Чтение непринятого этапа (план/идёт): только проверка восстановления по журналу; обычная оценка ворот — лишь в update.
function restoreOnly(w, s, old, jobs, snapshot) {
  jobs ??= require('./stage-gate').allJobs(snapshot);
  const r = preserve(w, s, old, jobs, snapshot);
  if (s.state === 'принят' && s.acceptance?.restored_from) return r.message;
  const info = s.acceptance_restore;
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, clone(old));
  delete s.acceptance_restore;
  if (info) s.acceptance_restore = info;
  return s.gate?.message || '';
}
module.exports = { legacy, preserve, finish, presentation, stageText, notice, restoreOnly, __segment: segment, __closesMatch: closesMatch };
