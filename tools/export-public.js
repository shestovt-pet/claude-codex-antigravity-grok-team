#!/usr/bin/env node
'use strict';
// Публичная копия связки без истории и личных данных (team-v11 Р3):
//   node tools/export-public.js <пустая папка> [--commit main] [--holder <логин GitHub>]
// Берёт зафиксированный коммит через git archive, убирает журналы прогонов и личный скилл, обезличивает текст,
// добавляет LICENSE и отказывает, если после замен осталась хоть одна запрещённая строка.
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  { execFileSync } = require('child_process');

// Что не публикуется.
const EXCLUDE = [/^tests\/[^/]*output[^/]*\.txt$/i, /\.log$/i, /^skill\/vtm-hronika\//];
// Личные строки не хранятся в репозитории: список лежит в state\public-export.json (state\ не попадает в git):
// { "userFolder": "<имя папки в C:\Users>", "replace": [["<было>", "<стало>"], …], "forbidden": ["<строка>", …],
//   "allow": ["<публичная строка, содержащая запрещённую, например логин GitHub>", …] }.
// replace применяется по порядку (длинные формы раньше коротких), forbidden ищется без учёта регистра после замен;
// вхождения allow (строки, которые публичны сами по себе) перед поиском вырезаются.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function loadTerms(file) {
  let t;
  try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw Error('Нет списка личных строк ' + file + ': ' + e.message); }
  if (!t.userFolder || !Array.isArray(t.replace) || !Array.isArray(t.forbidden) || !t.forbidden.length) throw Error('Список личных строк неполон: нужны userFolder, replace, forbidden.');
  const replace = [[new RegExp('([A-Za-z]:(?:\\\\\\\\|\\\\|/)+Users(?:\\\\\\\\|\\\\|/)+)' + esc(t.userFolder) + '(?![\\w])', 'gi'), '$1user'],
    ...t.replace.map(([from, to]) => [new RegExp(esc(from), 'g'), to])];
  const forbidden = t.forbidden.map((f) => new RegExp(esc(f), 'i'));
  const allow = (Array.isArray(t.allow) ? t.allow : []).filter(Boolean).map((a) => new RegExp(esc(a), 'gi'));
  return { replace, forbidden, allow };
}

function isText(buf) { return !buf.includes(0); }
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}
function scrub(text, terms) {
  let n = 0;
  for (const [re, to] of terms.replace) text = text.replace(re, (...m) => { n++; return to.replace('$1', m[1] || ''); });
  return { text, n };
}
function leaks(dir, terms) {
  const found = [];
  for (const rel of walk(dir)) {
    const buf = fs.readFileSync(path.join(dir, rel));
    const hay = rel + '\n' + (isText(buf) ? buf.toString('utf8') : '');
    // Номер строки и файл, но не сама строка: вывод не должен повторять личные данные. Строка 0 — имя файла.
    hay.split(/\r?\n/).forEach((line, i) => {
      for (const a of terms.allow || []) line = line.replace(a, ' ');
      terms.forbidden.forEach((re, k) => { if (re.test(line)) found.push(rel + ':' + (i ? i : 'имя файла') + ' (запрещённая строка №' + (k + 1) + ')'); });
    });
  }
  return found;
}
function mitLicense(holder, year = new Date().getFullYear()) {
  return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

// Вошедший аккаунт GitHub: { login, id }. Логин и id не вводятся руками (замысел Р3/Р4).
function ghUser(run = (args) => execFileSync(ghPath(), args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })) {
  const u = JSON.parse(run(['api', 'user']));
  if (!/^[A-Za-z0-9-]{1,39}$/.test(u.login || '') || !Number.isInteger(u.id)) throw Error('gh api user вернул не логин и id.');
  return { login: u.login, id: u.id, email: u.id + '+' + u.login + '@users.noreply.github.com' };
}
function ghPath() {
  const p = 'C:\\Program Files\\GitHub CLI\\gh.exe';
  return process.env.MOST_GH || (process.platform === 'win32' && fs.existsSync(p) ? p : 'gh');
}
const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

function exportPublic({ root = path.resolve(__dirname, '..'), target, commit = 'main', holder, termsFile, git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }) {
  if (!target) throw Error('Укажите папку для публичной копии.');
  if (!holder) throw Error('Нужен правообладатель — логин GitHub.');
  const terms = loadTerms(termsFile || path.join(require('../common/paths').stateDir, 'public-export.json'));
  if (!/^[A-Za-z0-9-]{1,39}$/.test(holder) || terms.forbidden.some((re) => re.test(holder)))
    throw Error('Правообладатель в LICENSE должен быть логином GitHub без личных данных.');
  root = fs.realpathSync(root);
  target = path.resolve(target);
  // Назначение: новая или пустая папка, не ссылка и не внутри связки (иначе копия попадёт в её дерево).
  if (fs.existsSync(target)) {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) throw Error('Папка назначения не должна быть ссылкой или файлом: ' + target);
    if (fs.readdirSync(target).length) throw Error('Папка ' + target + ' не пуста.');
  }
  let parent = path.dirname(target);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const real = path.join(fs.realpathSync(parent), path.relative(parent, target));
  if (inside(real, root)) throw Error('Папка назначения внутри связки: выберите папку вне ' + root);
  // Один полный хеш на всю выгрузку.
  const hash = git(['rev-parse', '--verify', commit + '^{commit}']).trim();
  if (!/^[0-9a-f]{40}$/.test(hash)) throw Error('Не удалось определить коммит ' + commit);
  const odd = git(['ls-tree', '-r', '--full-tree', hash]).split('\n').filter(Boolean)
    .filter((l) => !/^100(644|755) blob /.test(l)).map((l) => l.split('\t')[1]);
  if (odd.length) throw Error('В дереве есть ссылки или подмодули, выгрузка отказана: ' + odd.slice(0, 10).join(', '));
  fs.mkdirSync(target, { recursive: true });
  const tar = path.join(os.tmpdir(), 'most-public-' + process.pid + '-' + Date.now() + '.tar');
  try {
    git(['archive', '--format=tar', '-o', tar, hash]);
    execFileSync('tar', ['-xf', tar, '-C', target], { windowsHide: true, stdio: 'pipe' });
  } finally { try { fs.rmSync(tar, { force: true }); } catch {} }
  const excluded = [], broken = [];
  let replaced = 0;
  for (const rel of walk(target)) {
    const file = path.join(target, rel);
    if (EXCLUDE.some((re) => re.test(rel))) { fs.rmSync(file); excluded.push(rel); continue; }
    const buf = fs.readFileSync(file), text = buf.toString('utf8');
    // Только UTF-8 текст: в двоичном файле замены и поиск личных строк ненадёжны.
    if (!isText(buf) || !Buffer.from(text, 'utf8').equals(buf)) { broken.push(rel); continue; }
    const r = scrub(text, terms);
    if (r.n) { fs.writeFileSync(file, r.text); replaced += r.n; }
  }
  if (broken.length) throw Error('Не UTF-8 или двоичные файлы, выгрузка отказана: ' + broken.slice(0, 10).join(', '));
  // Пустые каталоги после исключений.
  for (const dir of ['skill/vtm-hronika']) try { fs.rmSync(path.join(target, dir), { recursive: true, force: true }); } catch {}
  fs.writeFileSync(path.join(target, 'LICENSE'), mitLicense(holder));
  const found = leaks(target, terms);
  if (found.length) throw Error('В публичной копии остались личные данные (' + found.length + '):\n' + found.slice(0, 20).join('\n'));
  return { target, commit: hash, files: walk(target).length, excluded, replaced };
}

if (require.main === module) {
  const argv = process.argv.slice(2), opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const user = ghUser();
    if (opt('--holder') && opt('--holder') !== user.login) throw Error('--holder не совпадает с вошедшим аккаунтом gh (' + user.login + ').');
    const r = exportPublic({ target: argv.find((a, i) => !a.startsWith('--') && !['--commit', '--holder'].includes(argv[i - 1])), commit: opt('--commit') || 'main', holder: user.login });
    console.log('Публичная копия: ' + r.target + '\nКоммит: ' + r.commit + '\nФайлов: ' + r.files + '\nИсключено: ' + r.excluded.length + '\nЗамен личных данных: ' + r.replaced +
      '\nЛичных строк не осталось.\nАвтор коммита публикации: ' + user.login + ' <' + user.email + '>');
  } catch (e) { console.error('Ошибка экспорта: ' + e.message); process.exitCode = 1; }
}
module.exports = { exportPublic, scrub, leaks, loadTerms, ghUser, mitLicense, EXCLUDE };
