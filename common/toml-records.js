'use strict';
// Читаем структуру и значения, не пересобирая чужой текст TOML.
// Позиции лексем нужны для проверки служебных меток вне строк и составных значений.
function tokens(text) {
  const out = [];
  let i = 0;
  const bad = () => { throw Error('Не удалось разобрать настройки TOML.'); };
  while (i < text.length) {
    const start = i, c = text[i];
    if (/[ \t\r\uFEFF]/.test(c)) { i++; continue; }
    if (c === '\n') { out.push({ type: 'nl', start, end: ++i }); continue; }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      out.push({ type: 'comment', value: text.slice(start, i).replace(/\r$/, ''), start, end: i }); continue;
    }
    if (c === '"' || c === "'") {
      const multi = text.slice(i, i + 3) === c.repeat(3);
      i += multi ? 3 : 1;
      let value = '', closed = false;
      if (multi && text[i] === '\r' && text[i + 1] === '\n') i += 2;
      else if (multi && text[i] === '\n') i++;
      while (i < text.length) {
        if (text[i] === c && (!multi || text.slice(i, i + 3) === c.repeat(3))) {
          i += multi ? 3 : 1;
          if (multi) for (let n = 0; n < 2 && text[i] === c; n++, i++) value += c;
          closed = true; break;
        }
        if (!multi && /[\r\n]/.test(text[i])) bad();
        if (c === '"' && text[i] === '\\') {
          i++;
          if (multi && /^[ \t\r]*\n/.test(text.slice(i))) { while (/\s/.test(text[i] || '') && i < text.length) i++; continue; }
          const esc = text[i++], simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
          if (Object.hasOwn(simple, esc)) value += simple[esc];
          else if (esc === 'u' || esc === 'U') {
            const count = esc === 'u' ? 4 : 8, digits = text.slice(i, i + count);
            if (!new RegExp('^[0-9a-fA-F]{' + count + '}$').test(digits)) bad();
            const code = parseInt(digits, 16); if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) bad();
            value += String.fromCodePoint(code); i += count;
          } else bad();
        } else { value += text[i] === '\r' && text[i + 1] === '\n' ? (i++, '\n') : text[i]; i++; }
      }
      if (!closed) bad();
      out.push({ type: 'string', value, start, end: i }); continue;
    }
    if ('[]=.,{}'.includes(c)) { out.push({ type: c, value: c, start, end: ++i }); continue; }
    while (i < text.length && !/[\s#"'\[\]=.,{}]/.test(text[i])) i++;
    if (i === start) bad();
    out.push({ type: 'word', value: text.slice(start, i), start, end: i });
  }
  return out;
}
function document(text) {
  const all = tokens(text), ts = all.filter(t => t.type !== 'comment');
  let i = 0, table = [];
  const records = [], root = Object.create(null);
  const bad = () => { throw Error('Не удалось разобрать настройки TOML.'); };
  const take = type => { if (ts[i]?.type !== type) bad(); return ts[i++]; };
  const skip = () => { while (ts[i]?.type === 'nl') i++; };
  function key() {
    const parts = [];
    do {
      if (parts.length) take('.');
      const t = ts[i++]; if (!t || !['string', 'word'].includes(t.type) || (t.type === 'word' && !/^[\w-]+$/.test(t.value))) bad();
      parts.push(t.value);
    } while (ts[i]?.type === '.');
    return parts;
  }
  function set(obj, parts, value) {
    for (const p of parts.slice(0, -1)) {
      if (!Object.hasOwn(obj, p)) obj[p] = Object.create(null);
      if (!obj[p] || typeof obj[p] !== 'object') bad();
      obj = obj[p];
    }
    obj[parts.at(-1)] = value;
  }
  function value() {
    if (ts[i]?.type === 'string') return ts[i++].value;
    if (ts[i]?.type === '[') {
      i++; const out = []; skip();
      while (ts[i]?.type !== ']') { out.push(value()); skip(); if (ts[i]?.type !== ',') break; i++; skip(); }
      take(']'); return out;
    }
    if (ts[i]?.type === '{') {
      i++; const out = Object.create(null); skip();
      while (ts[i]?.type !== '}') { const k = key(); take('='); set(out, k, value()); skip(); if (ts[i]?.type !== ',') break; i++; skip(); }
      take('}'); return out;
    }
    const start = i;
    while (ts[i] && ['word', '.'].includes(ts[i].type)) i++;
    if (start === i) bad();
    const raw = ts.slice(start, i).map(t => t.value).join('').replace(/_/g, '');
    if (raw === 'true' || raw === 'false') return raw === 'true';
    if (/^[+-]?(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|0x[\da-f]+|0o[0-7]+|0b[01]+)$/i.test(raw)) return Number(raw);
    return { scalar: raw }; // даты и специальные числовые значения
  }
  while (i < ts.length) {
    skip(); if (i === ts.length) break;
    const start = ts[i].start;
    if (ts[i].type === '[') {
      i++; const array = ts[i]?.type === '['; if (array) i++;
      table = key(); take(']'); if (array) take(']');
      records.push({ path: table, start, header: true });
    } else {
      const k = [...table, ...key()]; take('='); const v = value();
      records.push({ path: k, value: v, start }); set(root, k, v);
    }
    if (i < ts.length && ts[i].type !== 'nl') bad();
  }
  return { tokens: all, records, root };
}
module.exports = { tokens, document };
