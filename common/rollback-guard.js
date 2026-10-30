'use strict';
// Записи новых ворот (rules_version 16, голос DeepSeek, reconsider_by_other), которые релиз А не прочитает.
// Изменения связки лежат в state/team/changes (Team.changeFile = path.join(state, 'changes')); этапы — root/works.
const fs = require('fs'), path = require('path');
function ls(dir, ext) {
  try { return fs.readdirSync(dir).filter(n => n.endsWith(ext) && !n.startsWith('.')); } catch { return []; }
}
// Возвращает распарсенный объект; ошибка чтения/разбора существующего файла — блокер отката.
function read(file) {
  try { return { data: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) }; }
  catch (e) { return { error: file + ': ' + e.message }; }
}
function blockers(stateDir, root) {
  const out = [];
  const changeDirs = [path.join(stateDir, 'team', 'changes'), path.join(stateDir, 'changes')];
  for (const ch of changeDirs) for (const n of ls(ch, '.json')) {
    const r = read(path.join(ch, n));
    if (r.error) { out.push('изменение ' + n + ': не читается (' + r.error + ')'); continue; }
    const c = r.data;
    if (c && Number(c.rules_version) >= 16) out.push('изменение ' + n + ': по правилам 16');
    for (const v of [...(c?.verdicts || []), ...(c?.designVotes || [])]) if (v && v.who === 'deepseek') out.push('изменение ' + n + ': голос deepseek');
    for (const d of [...(c?.decisions || []), ...(c?.designDecisions || [])]) if (d && d.kind === 'reconsider_by_other') out.push('изменение ' + n + ': reconsider_by_other');
  }
  const ws = path.join(root, 'works');
  for (const n of ls(ws, '.json')) {
    const r = read(path.join(ws, n));
    if (r.error) { out.push('работа ' + n + ': не читается (' + r.error + ')'); continue; }
    const w = r.data;
    for (const s of w?.stages || []) {
      if (s && Number(s.rules_version) >= 16) out.push('работа ' + n + ': этап «' + (s.title || s.id) + '» по правилам 16');
      if (s && ((s.gate?.votes || []).some(v => v.who === 'deepseek') || (s.gate?.helpers || []).some(h => h.who === 'deepseek')))
        out.push('работа ' + n + ': голос deepseek на этапе «' + (s.title || s.id) + '»');
      for (const d of s?.decisions || []) if (d && d.kind === 'reconsider_by_other') out.push('работа ' + n + ': reconsider_by_other');
    }
  }
  return out;
}
module.exports = { blockers };
