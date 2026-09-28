'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const begin = '<!-- most:begin -->', end = '<!-- most:end -->';
const sectionFiles = { codex: 'codex-section.md', antigravity: 'antigravity-section.md' };
function body(kind) {
  if (!Object.hasOwn(sectionFiles, kind)) throw Error('Неизвестный помощник.');
  return require('./paths').withRoot(fs.readFileSync(path.join(__dirname, '../rules/helpers', sectionFiles[kind]), 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n', process.env.MOST_REPO_ROOT || require('./paths').repoRoot);
}
// Явная роль имеет приоритет; обычные пути сверяются с настройками, а не с порядком списка.
function target(value) {
  const file = typeof value === 'string' ? value : value.file;
  const role = typeof value === 'object' ? value.role : null;
  if (role) { if (!Object.hasOwn(sectionFiles, role)) throw Error('Неизвестный помощник.'); return { file, role }; }
  const key = path.resolve(file).toLowerCase();
  const home = process.env.USERPROFILE || os.homedir();
  const known = {
    codex: process.env.MOST_CODEX_RULES || path.join(home, '.codex/AGENTS.md'),
    antigravity: process.env.MOST_AGY_RULES || path.join(home, '.gemini/config/AGENTS.md'),
  };
  const matches = Object.entries(known).filter(([, p]) => path.resolve(p).toLowerCase() === key);
  if (matches.length !== 1) throw Error('Роль файла правил не определена однозначно: ' + file + '. Укажите role.');
  return { file, role: matches[0][0] };
}
function section(text) {
  const starts = [...text.matchAll(/<!-- most:begin -->/g)], ends = [...text.matchAll(/<!-- most:end -->/g)];
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) throw Error('Структура меток правил не распознана.');
    return { from: starts[0].index, to: ends[0].index + end.length };
  }
  const headings = [...text.matchAll(/^(#{1,6}) (?:Связка (?:трёх|четырёх) ИИ[^\r\n]*|Постоянный контекст: связка Claude, Codex и Antigravity)[ \t]*\r?$/gm)];
  if (headings.length !== 1) throw Error('Не найден единственный прежний раздел правил связки.');
  const h = headings[0], tail = text.slice(h.index + h[0].length);
  const next = new RegExp('^(?:#{1,' + h[1].length + '} |[ \\t]*</)', 'm').exec(tail);
  return { from: h.index, to: next ? h.index + h[0].length + next.index : text.length };
}
function framing(text) {
  const stack = [], tags = [];
  // Структурные теги стоят на отдельных строках; <номер> в обычном тексте — не обрамление.
  for (const m of text.matchAll(/^[ \t]*<(\/?)([A-Za-z][\w:.-]*(?:\[[^\]\r\n]+\])?)(?:[ \t]+[^<>\r\n]*)?>[ \t]*\r?$/gm)) {
    tags.push(m[0]);
    if (/\/>[ \t]*\r?$/.test(m[0])) continue;
    if (m[1]) { if (stack.pop() !== m[2]) throw Error('Нарушен баланс тегов обрамления правил.'); }
    else stack.push(m[2]);
  }
  if (stack.length) throw Error('Незакрытый тег обрамления правил.');
  return JSON.stringify(tags);
}
function splice(text, from, to, replacement) {
  const prefix = text.slice(0, from), suffix = text.slice(to), next = prefix + replacement + suffix;
  if (framing(text) !== framing(next)) throw Error('Замена затрагивает теги обрамления правил.');
  const bytes = Buffer.from(next), head = Buffer.from(prefix), tail = Buffer.from(suffix);
  if (!bytes.subarray(0, head.length).equals(head) || !bytes.subarray(bytes.length - tail.length).equals(tail))
    throw Error('Изменён текст вне раздела правил.');
  return next;
}
function replace(text, kind = 'codex') {
  const textBody = body(kind);
  const s = section(text), eol = text.includes('\r\n') ? '\r\n' : '\n';
  return splice(text, s.from, s.to, (begin + '\n' + textBody + end + (text.slice(s.from, s.to).startsWith(begin) ? '' : '\n\n')).replace(/\n/g, eol));
}
function paths() {
  const home = process.env.USERPROFILE || os.homedir();
  return [process.env.MOST_CODEX_RULES || path.join(home, '.codex/AGENTS.md'),
    process.env.MOST_AGY_RULES || path.join(home, '.gemini/config/AGENTS.md')];
}
async function configure({ files = paths(), hook, rollback = false } = {}) {
  const d = require('./deploy'), result = [];
  for (const value of files) {
    const file = typeof value === 'string' ? value : value.file;
    try {
      const s = d.snapshot(file);
      if (!fs.readFileSync(file).equals(Buffer.from(s.text))) throw Error('Кодировка правил не UTF-8; отказ без записи.');
      let next;
      if (rollback) {
        const old = d.snapshot(file + '.prev'), a = section(s.text), b = section(old.text);
        // У старого раздела перевод строки входил в диапазон; у меток он снаружи.
        const tail = old.text.slice(b.from, b.to).startsWith(begin) ? a.to : a.to + (s.text.slice(a.to).match(/^(?:\r?\n){2}/)?.[0].length || 0);
        next = splice(s.text, a.from, tail, old.text.slice(b.from, b.to));
      } else next = replace(s.text, target(value).role);
      if (next !== s.text) await d.switchConfigs([{ ...s, next, backup: !rollback }], hook);
      result.push(file + ': ' + (rollback ? 'раздел восстановлен' : 'правила обновлены'));
    } catch (e) { result.push(file + ': отказ: ' + e.message); }
  }
  return result;
}
function plans(files = paths()) {
  return files.filter(value => fs.existsSync(typeof value === 'string' ? value : value.file)).map(value => {
    const { file, role } = target(value);
    const s = require('./deploy').snapshot(file);
    if (!fs.readFileSync(file).equals(Buffer.from(s.text))) throw Error('Кодировка правил не UTF-8: ' + file);
    return { ...s, next: replace(s.text, role), backup: true };
  });
}
function evidence(plans, operation) {
  return plans.map(p => {
    const actual = fs.readFileSync(p.file, 'utf8');
    if (actual !== p.next) throw Error('Проверка содержимого правил не пройдена: ' + p.file);
    return { file: p.file, operation: operation || null, deliveryPerformed: true, changed: p.text !== p.next,
      contentVerified: true, sha256: require('crypto').createHash('sha256').update(actual).digest('hex') };
  });
}
// Установка (setup): файла правил нет — создать с одним разделом; файл есть, а раздела нет — дописать раздел в
// конец, не трогая чужой текст; раздел есть, но устарел (новая версия, другой корень) — заменить его. Перед
// правкой существующего файла — .prev, как у конфигов. Папка помощника должна существовать (приложение установлено).
async function ensure(value, { dryRun = false, hook } = {}) {
  const { file, role } = target(value);
  if (!fs.existsSync(path.dirname(file))) return file + ': пропущено — папки помощника нет';
  const block = begin + '\n' + body(role) + end + '\n';
  if (!fs.existsSync(file)) {
    if (!dryRun) fs.writeFileSync(file, block, { flag: 'wx' });
    return file + (dryRun ? ': будет создан с разделом связки' : ': создан с разделом связки');
  }
  const d = require('./deploy'), s = d.snapshot(file);
  if (!fs.readFileSync(file).equals(Buffer.from(s.text))) throw Error('Кодировка правил не UTF-8; отказ без записи: ' + file);
  let next, what;
  try { section(s.text); next = replace(s.text, role); what = 'обновлён'; } catch (e) {
    if (!/Не найден единственный прежний раздел/.test(e.message) || /<!-- most:(?:begin|end) -->/.test(s.text)) throw e;
    const eol = s.text.includes('\r\n') ? '\r\n' : '\n';
    next = s.text + (s.text && !s.text.endsWith('\n') ? eol : '') + (s.text ? eol : '') + block.replace(/\n/g, eol);
    what = 'дописан в конец';
  }
  if (next === s.text) return file + ': раздел связки актуален';
  if (dryRun) return file + ': раздел связки будет ' + what;
  await d.switchConfigs([{ ...s, next, backup: true }], hook);
  return file + ': раздел связки ' + what + ' (копия — .prev)';
}
module.exports = { section, replace, configure, paths, plans, evidence, body, target, ensure };
