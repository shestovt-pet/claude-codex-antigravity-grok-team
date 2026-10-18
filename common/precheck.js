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
// сохраняется); обязательные голоса — с учётом replaces, как в commit.
function designVoteWarnings(c) {
  if (c?.fast || !c?.request || !c.designHash) return [];
  let hash = c.designHash;
  const out = [];
  if (c.designFile) {
    try {
      hash = require('crypto').createHash('sha256').update(fs.readFileSync(c.designFile)).digest('hex');
      if (hash !== c.designHash) out.push('файл замысла изменён после записи: ' + hash.slice(0, 8) + ' вместо ' + c.designHash.slice(0, 8) +
        ' — голоса по прежней редакции не считаются, отправьте новую обоим');
    } catch (e) { return ['файл замысла не прочитан (' + e.message.split('\n')[0] + ') — голоса по замыслу не проверены']; }
  }
  const short = hash.slice(0, 8), names = { codex: 'Codex', antigravity: 'Antigravity' };
  // team-v18 К7 (а): места — той же функцией, что в commit и merge (common/team-seats.js).
  const seats = require('./team-seats'), current = { ...c, designHash: hash };
  for (const who of ['codex', 'antigravity']) {
    const st = seats.seat(current, who, 'design');
    if (st.closed) continue;
    if (st.blocked) out.push(names[who] + ': по замыслу ' + short + ' — НЕ ПРИНЯТО; commit откажет');
    else out.push(names[who] + ' не голосовал по замыслу ' + short + ': commit откажет — отправьте ему эту редакцию');
  }
  return out;
}

// team-v18 К7 (б): системные задания изменения, номер которых не встречается в добавленных строках lessons.md.
function systemicWarnings(change, lessonsDiff) {
  const added = addedLines(lessonsDiff || '').map((l) => l.text).join('\n');
  return (change?.systemic || []).filter((v) => v.who !== 'grok' && !added.includes(String(v.job_id).slice(0, 8)))
    .map((v) => 'системное замечание ' + v.who + ' ' + v.job_id + ': номера нет в добавленных строках lessons.md — урок до commit');
}

function precheck({ folder, designFile, lessonsDiff, change }) {
  const warnings = [], unrecognized = [];
  warnings.push(...designVoteWarnings(change));
  warnings.push(...systemicWarnings(change, lessonsDiff));
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

module.exports = { designVoteWarnings, systemicWarnings, precheck, precheckText, checkDesign, checkLessons, addedLines, plainLines, declaredTests };

// Граница быстрого пути исполняется кодом сервера, а не кодом проверяемого клона.
const fastCommon = new Set(('access after-deploy agy-input agy-quota agy-tools artifact-manifest brief-support cards cleanup client-configs client-rules consilium-workflow consilium-workflow-v2 deploy deploy-ops fallback fallback-detect fingerprint grok grok-gate job-cancel job-snapshot locks members model-family notify ownership path-compat paths precheck probe proposed-actions provenance public-transport quota release-drift request-context restart schema server-instructions stage-gate stage-gate-v15 stage-schema state-migration task-roles team team-git team-seats team-store toml-records user-confirm user-word work-owner').split(' ').map(n => 'common/' + n + '.js'));
function fastProtected(file) {
  const f = file.toLowerCase();
  return fastCommon.has(f) || /^(?:agents\.md|setup\.cmd|package(?:-lock)?\.json|\.gitattributes|\.gitignore|\.gitmodules|\.npmrc)$/.test(f) ||
    /^(?:rules|skill|servers|scripts|tools)\//.test(f) ||
    /^tests\/(?:run\.js|fake-[^/]*\.js|[^/]*fixture[^/]*\.js|team-worker\.js|\.tmp-v6-restart-parse\.ps1)$/.test(f) || /^tests\/(?:fixtures|live)\//.test(f);
}
function fastNote(note) {
  if (typeof note !== 'string' || !note.trim() ||
      !['симптом', 'что меняется', 'затронутые места', 'тест', 'откат'].every(key => new RegExp('(?:^|[;\\r\\n])\\s*' + key + '\\s*:\\s*[^;\\r\\n\\s]', 'i').test(note)))
    throw Error('Нужна карточка note: симптом: …; что меняется: …; затронутые места: …; тест: до/после; откат: …');
  return note.trim();
}
function checkFast(folder, base, candidate, capture = false) {
  const fail = why => { throw Error('не малая правка — нужен замысел: ' + why + '; team_change start без fast.'); };
  let total = 0;
  const inspect = (run, tree) => {
    const check = target => {
      const opts = ['--no-ext-diff', '--no-textconv', '--no-abbrev', '-M', '-C', '--find-copies-harder'];
      const raw = run(['diff', '--raw', '-z', ...opts, base, target, '--']).split('\0');
      for (let i = 0; i < raw.length && raw[i];) {
        const header = raw[i++].match(/^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/), file = raw[i++];
        if (!header || !file) fail('не разобран NUL-вывод git');
        const [, oldMode, newMode, , oid, kind] = header;
        if (['R', 'C'].includes(kind)) fail('переименование или копирование ' + file + ' → ' + raw[i]);
        if (!['A', 'M'].includes(kind)) fail('удаление или смена типа ' + file);
        if (!['100644', '100755'].includes(newMode) || (kind === 'M' && oldMode !== newMode)) fail('ссылка, подмодуль или смена режима ' + file);
        if (fastProtected(file)) fail('защищённый путь ' + file);
        let cur = folder;
        for (const part of file.split('/')) {
          cur = require('path').join(cur, part);
          if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) fail('ссылка или junction ' + file);
        }
        if (kind === 'A' && !/^tests\/[^/]+\.js$/i.test(file)) fail('новый файл вне tests/*.js: ' + file);
        // Проверяем байты независимо от diff-драйвера из старого .gitattributes.
        const blob = Buffer.from(run(['cat-file', 'blob', oid], true));
        if (blob.includes(0)) fail('двоичный файл ' + file);
        try { new TextDecoder('utf-8', { fatal: true }).decode(blob); }
        catch { fail('не UTF-8 файл ' + file); }
      }
      let lines = 0;
      for (const row of run(['diff', '--numstat', '-z', ...opts, base, target, '--']).split('\0').filter(Boolean)) {
        const m = row.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
        if (!m || m[1] === '-' || m[2] === '-') fail('двоичный файл или неверный numstat');
        if (m[3].toLowerCase() !== 'lessons.md') lines += Number(m[1]) + Number(m[2]);
      }
      if (lines > 80) fail(lines + ' изменённых строк, предел 80');
      return lines;
    };
    if (candidate) check(candidate);
    total = check(tree);
  };
  // exact=true: то же будущее дерево, что git add -A, включая staged и новые файлы.
  const tree = require('./fingerprint').fingerprint(folder, inspect, true);
  return capture ? { lines: total, tree } : total;
}
Object.assign(module.exports, { fastNote, fastProtected, checkFast });
