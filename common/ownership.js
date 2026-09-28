'use strict';
// Чья запись подключения: своя — только если принадлежит ЭТОМУ корню установки.
const path = require('path');
// Слэши к одному виду, «.» и «..» раскрыты (C:\A\..\B — это C:\B, не корень C:\A), регистр не учитывается.
const norm = (p) => {
  const s = String(p ?? '').replace(/[\\/]+/g, '\\');
  return (s ? path.win32.normalize(s) : '').replace(/\\$/, '').toLowerCase();
};

function pointsInto(entry, root) {
  const r = norm(root) + '\\';
  return [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])].some((a) => norm(a).startsWith(r)) ||
    (entry?.env?.MOST_REPO_ROOT != null && norm(entry.env.MOST_REPO_ROOT) === norm(root));
}

function own(entry, name, root) {
  if (entry == null) return true;
  const m = norm(entry?.args?.[0]).match(/^(.*)\\live\\[0-9a-f]{40}\\servers\\([a-z]+)\\index\.js$/);
  if (m && m[1] === norm(root) && m[2] === name) return true;
  return entry?.env?.MOST_REPO_ROOT != null && norm(entry.env.MOST_REPO_ROOT) === norm(root);
}

function describe(entry) {
  const text = [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])].filter((v) => v != null).join(' ') ||
    String(entry?.url ?? entry?.env?.MOST_REPO_ROOT ?? 'без пути');
  return text.length > 160 ? text.slice(0, 157) + '…' : text;
}

function assertOwn(servers, list, root, file) {
  const bad = list.filter((n) => Object.hasOwn(servers || {}, n) && !own(servers[n], n, root));
  if (bad.length) throw Error('Чужие записи подключений в ' + file + ': ' +
    bad.map((n) => '«' + n + '» → ' + describe(servers[n])).join('; ') +
    '. Они не от этой установки (' + root + '), файл не изменён. Уберите эти записи сами или запустите установку из той папки, на которую они указывают.');
}

module.exports = { norm, own, pointsInto, assertOwn };
