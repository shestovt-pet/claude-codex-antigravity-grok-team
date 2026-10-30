'use strict';
// Снимки рабочих байтов, без git и без изменения проверяемых файлов.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 50 * 1024 * 1024;
const extensions = new Set('.js .cjs .mjs .ts .json .md .txt .yml .yaml .toml .ps1 .cmd .bat .sh .html .css .csv .xml .srt'.split(' '));
const names = new Set('.gitignore .gitattributes Dockerfile Makefile LICENSE README'.split(' '));
const textFile = p => extensions.has(path.extname(p).toLowerCase()) || names.has(path.basename(p));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const size = v => Number(String(v).split(':')[0]);
const reason = e => e.code || e.message;
function snapshot(folder, state, { dir, errors = [] } = {}) {
  const out = { dir, files: new Map(), errors };
  if (!state) return { ...out, skipped: 'список файлов не составлен' };
  const files = [...state].filter(([p]) => textFile(p));
  if (files.reduce((n, [, v]) => n + size(v), 0) > MAX_TOTAL)
    return { ...out, skipped: 'больше 50 МБ текста' };
  if (!dir) throw Error('Не задан каталог format-before');
  for (const [p, v] of files) {
    if (size(v) > MAX_FILE) { out.files.set(p, { error: 'больше 2 МБ до поручения' }); continue; }
    try {
      const target = path.join(dir, p);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(folder, p), target);
      out.files.set(p, { saved: true });
    } catch (e) { out.files.set(p, { error: reason(e) }); }
  }
  return out;
}
function decode(b) {
  let utf8 = true;
  try { new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { utf8 = false; }
  const text = b.toString('utf8');
  return { utf8, fffd: (text.match(/\uFFFD/g) || []).length,
    bom: b.subarray(0, 3).equals(Buffer.from([239, 187, 191])), text: text.replace(/^\uFEFF/, '') };
}
function lines(text) {
  const result = []; let start = 0;
  for (const m of text.matchAll(/\r\n|\n|\r/g)) {
    result.push({ text: text.slice(start, m.index), end: m[0] }); start = m.index + m[0].length;
    if (result.length > 200000) throw Error('сравнение слишком дорогое');
  }
  if (start < text.length) result.push({ text: text.slice(start), end: '' });
  return result;
}
// Майерс: фронт и цепочки совпавших участков; и время, и число узлов ограничены шагами.
function endings(a, b, maxSteps = 200000) {
  let steps = 0, frontier = new Map([[1, { x: 0, node: null }]]);
  const step = () => { if (++steps > maxSteps) throw Error('сравнение слишком дорогое'); };
  for (let d = 0; d <= a.length + b.length; d++) {
    const next = new Map();
    for (let k = -d; k <= d; k += 2) {
      step();
      const left = frontier.get(k - 1), right = frontier.get(k + 1);
      const down = k === -d || (k !== d && (left?.x ?? -1) < (right?.x ?? -1));
      const prev = down ? right : left;
      let x = (prev?.x || 0) + (down ? 0 : 1), y = x - k, node = prev?.node || null;
      const fromX = x, fromY = y;
      while (x < a.length && y < b.length && a[x].text === b[y].text) { step(); x++; y++; }
      if (x > fromX) node = { fromX, fromY, length: x - fromX, prev: node };
      if (x >= a.length && y >= b.length) {
        let count = 0, example;
        for (; node; node = node.prev) for (let i = 0; i < node.length; i++) {
          const old = a[node.fromX + i], current = b[node.fromY + i];
          if (old.end !== current.end) { count++; example = { line: node.fromY + i + 1, before: old.end, after: current.end }; }
        }
        return { count, example };
      }
      next.set(k, { x, node });
    }
    frontier = next;
  }
}
const endName = s => ({ '\r\n': 'CRLF', '\n': 'LF', '\r': 'CR', '': 'нет' })[s];
function compare(folder, snap, before, writes, { errors = [], maxSteps = 200000 } = {}) {
  const result = { formatCheck: 'проверено', formatSuspicions: [] }, incomplete = [];
  if (snap?.skipped || !before || !writes) return { ...result, formatCheck: 'пропущено: ' + (snap?.skipped || (!before ? 'список файлов не составлен' : 'список записанных файлов не составлен')) };
  if (!snap) return { ...result, formatCheck: 'неполная: нет снимка до поручения' };
  const walk = (when, list) => { if (list.length) incomplete.push('обход папки ' + when + ' поручения с ошибками (' + list.map(e => e.path + ', ' + e.code).join('; ') + ')'); };
  walk('до', snap.errors || []); walk('после', errors.filter(e => e.op !== 'readFileSync'));
  const readErrors = errors.filter(e => e.op === 'readFileSync');
  for (const e of readErrors) incomplete.push(e.path + ': ошибка чтения при вычислении sha256, ' + e.code);
  let unchecked = readErrors.length;
  for (const entry of writes.filter(e => e.sha256 !== null && textFile(e.path))) {
    const issues = [];
    try {
      const file = path.join(folder, entry.path);
      if (fs.statSync(file).size > MAX_FILE) throw Error('больше 2 МБ после поручения');
      const buf = fs.readFileSync(file);
      if (buf.length > MAX_FILE) throw Error('больше 2 МБ после поручения');
      if (sha(buf) !== entry.sha256) throw Error('файл изменился после поручения');
      const after = decode(buf); let old = { utf8: true, fffd: 0 };
      if (before.has(entry.path)) {
        const saved = snap.files.get(entry.path);
        if (!saved?.saved) throw Error(saved?.error || 'исходник недоступен');
        const original = fs.readFileSync(path.join(snap.dir, entry.path));
        if (original.length > MAX_FILE) throw Error('больше 2 МБ до поручения');
        old = decode(original);
        if (old.bom !== after.bom) issues.push(old.bom ? 'BOM пропал' : 'BOM появился');
      } else if (snap.errors?.length) throw Error('новизна неизвестна: обход папки до поручения с ошибками');
      if (after.fffd > old.fffd) issues.push('появился U+FFFD');
      if (old.utf8 && !after.utf8) issues.push('невалидный UTF-8');
      if (old.text !== undefined) {
        const change = endings(lines(old.text), lines(after.text), maxSteps);
        if (change.count) issues.push('у ' + change.count + ' неизменённых строк сменилось окончание (пример: строка ' + change.example.line + ', ' + endName(change.example.before) + ' → ' + endName(change.example.after) + ')');
      }
    } catch (e) { unchecked++; incomplete.push(entry.path + ': ' + reason(e)); }
    if (issues.length) result.formatSuspicions.push({ path: entry.path, issues });
  }
  if (incomplete.length) result.formatCheck = 'неполная: ' + unchecked + ' файлов не проверено; ' + incomplete.join('; ');
  return result;
}
function cleanup(snap) { if (snap?.dir) fs.rmSync(snap.dir, { recursive: true, force: true }); }
function warning(job) {
  if (!job.write) return '';
  const rows = job.formatSuspicions || [], out = [];
  if (rows.length) out.push('⚠ Подозрение на порчу формата: ' + rows.slice(0, 10).map(r => r.path + ' — ' + r.issues.join('; ')).join('; ') + (rows.length > 10 ? '; и ещё ' + (rows.length - 10) : ''));
  if (job.formatCheck && job.formatCheck !== 'проверено') out.push('⚠ Проверка формата неполная: ' + job.formatCheck);
  return out.join('\n');
}
module.exports = { snapshot, compare, cleanup, warning, textFile, endings, lines };
