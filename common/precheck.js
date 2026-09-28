'use strict';
// Самопроверка Claude перед ревью (team-v9 Р2): только предупреждения, ничего не правит и не блокирует.
const fs = require('fs'),
  path = require('path');

// Строки вне блоков кода и цитат: [{ n, text }].
function plainLines(text) {
  let fence = false;
  return text.split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t })).filter(({ text: t }) => {
    if (/^\s*(```|~~~)/.test(t)) { fence = !fence; return false; }
    return !fence && !/^\s*>/.test(t);
  });
}

function checkDesign(file) {
  const warnings = [], name = path.basename(file);
  const lines = plainLines(fs.readFileSync(file, 'utf8'));
  const first = lines[0]?.text.match(/редакция\s+(\d+)/i)?.[1];
  const defined = new Map();
  let draft = null;
  for (const { n, text } of lines) {
    const heading = text.match(/^(#+)\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      if (draft && level <= draft.level) draft = null;
      const m = heading[2].match(/\(редакция\s+(\d+)\)/i);
      if (m && first && m[1] !== first)
        warnings.push(name + ':' + n + ': в заголовке «редакция ' + m[1] + '», а в первой строке — «редакция ' + first + '»');
      if (/Дополнение|Черновик/i.test(heading[2])) draft = { level, n };
      continue;
    }
    const r = text.match(/^\s*Р(\d+)\./);
    if (!r) continue;
    if (draft && defined.has(r[1]))
      warnings.push(name + ':' + n + ': раздел черновика (строка ' + draft.n + ') повторно определяет Р' + r[1] + ', уже определённое в строке ' + defined.get(r[1]));
    else if (!defined.has(r[1])) defined.set(r[1], n);
  }
  // team-v10 Р1–Р2: обязательные разделы замысла.
  const headings = lines.filter(({ text }) => /^#+\s/.test(text)).map(({ text }) => text.replace(/^#+\s+/, '').trim());
  for (const need of ['Опасные случаи', 'Живая проверка'])
    if (!headings.some((h) => h.startsWith(need))) warnings.push(name + ': нет раздела «' + need + '»');
  return warnings;
}

// Добавленные в разнице строки lessons.md: [{ n, text }] (номера — в рабочем дереве).
function addedLines(diff) {
  const out = [];
  let n = 0;
  for (const line of diff.split(/\r?\n/)) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { n = Number(h[1]); continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) out.push({ n: n++, text: line.slice(1) });
    else if (!line.startsWith('-') && !line.startsWith('\\')) n++;
  }
  return out;
}

// Звёздочка входит в совпадение, чтобы маску вроде tests/.tmp-* узнать и пропустить.
const PATH = /(?<![\w/.-])((?:rules|skill|common|servers|tools|tests)\/[\wА-Яа-яЁё./*-]*[\wА-Яа-яЁё*])/g;
// Объявленные тесты: вызов test('<название>' в начале строки кода. Однострочные и блочные комментарии, строки и
// шаблонные литералы (в том числе многострочные) пропускаются, поэтому «test(» внутри них не считается.
function declaredTests(src) {
  const names = new Set();
  let i = 0, lineStart = true;
  // Вложенные ${`…`} в шаблоне не разбираются: для файлов тестов это приемлемо, худший исход — ложное предупреждение.
  const skipString = (q) => { i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } i++; };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { lineStart = true; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; lineStart = false; continue; }
    if (lineStart && src.startsWith('test(', i)) {
      let j = i + 5;
      while (src[j] === ' ' || src[j] === '\t') j++;
      const q = src[j];
      if (q === "'" || q === '"' || q === '`') {
        let k = j + 1, name = '';
        while (k < src.length && src[k] !== q) { if (src[k] === '\\') { name += src[k + 1]; k += 2; } else name += src[k++]; }
        names.add(name);
      }
      i += 5; lineStart = false; continue;
    }
    lineStart = false;
    if (ch === "'" || ch === '"' || ch === '`') { skipString(ch); continue; }
    i++;
  }
  return names;
}

function checkLessons(folder, diff) {
  const warnings = [], unrecognized = [];
  for (const { n, text } of addedLines(diff)) {
    const where = text.match(/Где закрыто:(.*?)(?:Проверка:|$)/)?.[1];
    if (where) for (const [, p] of where.matchAll(PATH)) {
      if (p.includes('*')) continue;
      if (!fs.existsSync(path.join(folder, p))) warnings.push('lessons.md:' + n + ': в «Где закрыто» нет пути ' + p);
    }
    const check = text.match(/Проверка:(.*)$/)?.[1];
    if (check === undefined) continue;
    // Ссылка: «tests/<файл>.js», за ней ноль или больше «тест «<название>»» до следующей ссылки на файл.
    const refs = [...check.matchAll(/tests\/[\wА-Яа-яЁё.-]+\.js/g)];
    if (!refs.length) { unrecognized.push('lessons.md:' + n + ': «Проверка» без ссылки на tests/…'); continue; }
    refs.forEach((m, k) => {
      const file = m[0], full = path.join(folder, file);
      const tail = check.slice(m.index + file.length, k + 1 < refs.length ? refs[k + 1].index : undefined);
      if (!fs.existsSync(full)) { warnings.push('lessons.md:' + n + ': нет файла ' + file); return; }
      const declared = declaredTests(fs.readFileSync(full, 'utf8'));
      // Название может содержать вложенные «…» одного уровня.
      for (const [, test] of tail.matchAll(/тест\s*«((?:[^«»]|«[^«»]*»)+)»/g))
        if (!declared.has(test)) warnings.push('lessons.md:' + n + ': в ' + file + ' нет теста «' + test + '»');
    });
  }
  return { warnings, unrecognized };
}

// team-v12 Р3: голоса по ТЕКУЩЕЙ редакции замысла видны до commit и merge. Хеш берётся из файла (карточка не
// сохраняется); обязательные голоса — с учётом replaces, как в commit; Grok — по bound и состоянию записанного запроса.
function designVoteWarnings(c) {
  if (!c?.request || !c.designHash) return [];
  let hash = c.designHash;
  const out = [];
  if (c.designFile) {
    try {
      hash = require('crypto').createHash('sha256').update(fs.readFileSync(c.designFile)).digest('hex');
      if (hash !== c.designHash) out.push('файл замысла изменён после записи: ' + hash.slice(0, 8) + ' вместо ' + c.designHash.slice(0, 8) +
        ' — голоса по прежней редакции не считаются, отправьте новую всем троим');
    } catch (e) { return ['файл замысла не прочитан (' + e.message.split('\n')[0] + ') — голоса по замыслу не проверены']; }
  }
  const short = hash.slice(0, 8), names = { codex: 'Codex', antigravity: 'Antigravity' };
  for (const who of ['codex', 'antigravity']) {
    const v = (c.designVotes || []).filter((x) => (x.replaces || x.who) === who).at(-1);
    if (!v || v.designHash !== hash) out.push(names[who] + ' не голосовал по замыслу ' + short + ': commit откажет — отправьте ему эту редакцию');
    else if (v.decision !== 'ПРИНЯТО') out.push(names[who] + ': по замыслу ' + short + ' — ' + v.decision + '; commit откажет');
  }
  const g = c.grokDesign;
  if (!g || g.designHash !== hash) out.push('Grok не запрошен по замыслу ' + short + ': merge откажет — отправьте ему эту редакцию');
  else if (g.status === 'недоступен') out.push('Grok недоступен по замыслу ' + short + ': merge потребует абзац «Grok недоступен ' + (c.name || '<имя>') + ':» в lessons.md');
  else if (['running', 'queued', 'delivery_unclear'].includes(g.status)) out.push('Grok: ждём ответ по замыслу ' + short + ' (' + g.job_id + ')');
  // Допустимые решения — как в grok-gate.check: при отказе поручения — «Отклонено:» или «Grok недоступен:».
  else if (g.status === 'failed') out.push('Grok: отказ поручения по замыслу ' + short + ' — merge потребует абзац с «Отклонено:» или «Grok недоступен:» для ' + String(g.job_id).slice(0, 8));
  else if (g.decision !== 'ПРИНЯТО') out.push('Grok: ' + (g.decision || g.status) + ' по замыслу ' + short + ' — merge потребует абзац с «Где закрыто:» или «Отклонено:» для ' + String(g.job_id).slice(0, 8));
  return out;
}

function precheck({ folder, designFile, lessonsDiff, change }) {
  const warnings = [], unrecognized = [];
  warnings.push(...designVoteWarnings(change));
  try {
    if (designFile) warnings.push(...checkDesign(designFile));
  } catch (e) { warnings.push('замысел не прочитан: ' + e.message); }
  try {
    const l = checkLessons(folder, lessonsDiff || '');
    warnings.push(...l.warnings); unrecognized.push(...l.unrecognized);
  } catch (e) { warnings.push('уроки не проверены: ' + e.message); }
  return { warnings, unrecognized };
}

function precheckText(r) {
  return 'Самопроверка: ' + (r.warnings.length ? 'предупреждений ' + r.warnings.length + '\n' + r.warnings.map((w) => '- ' + w).join('\n') : 'предупреждений нет') +
    (r.unrecognized.length ? '\nНе распознано (проверьте сами):\n' + r.unrecognized.map((w) => '- ' + w).join('\n') : '');
}

module.exports = { designVoteWarnings, precheck, precheckText, checkDesign, checkLessons, addedLines, plainLines, declaredTests };
