'use strict';
// Чья запись подключения: своя — только если принадлежит ЭТОМУ корню установки.
const path = require('path');
// Слэши к одному виду, «.» и «..» раскрыты (C:\A\..\B — это C:\B, не корень C:\A), регистр не учитывается.
const norm = (p) => {
  const s = String(p ?? '').replace(/[\\/]+/g, '\\');
  return (s ? path.win32.normalize(s) : '').replace(/\\$/, '').toLowerCase();
};

// Существующий путь раскрывается через realpath (ссылки, переходы каталогов — junction), остальное — как строка.
const fs = require('fs');
const isPath = (p) => typeof p === 'string' && (/^[a-z]:[\\/]/i.test(p) || /^[\\/]{2}[^\\/]/.test(p) || (process.platform !== 'win32' && p.startsWith('/')));
function real(p) {
  if (!isPath(p)) return norm(p);
  // Путь с буквой диска вне Windows (тесты) — только как строка: раскрывать его на этой системе нечем.
  if (process.platform !== 'win32' && /^[a-z]:/i.test(p)) return norm(p);
  // Файла может ещё не быть (старый путь, удалённый релиз): раскрывается ближайшая существующая папка выше.
  let base = String(p), rest = [];
  for (let i = 0; i < 64; i++) {
    try { return norm(path.join(fs.realpathSync.native(base), ...rest)); } catch {}
    const up = path.dirname(base);
    if (up === base) break;
    rest.unshift(path.basename(base)); base = up;
  }
  return norm(p);
}
const inRoot = (p, root) => { const r = real(root); return real(p) === r || real(p).startsWith(r + '\\'); };
// Команда node (из PATH или C:\Program Files\nodejs\node.exe) — не путь установки.
const isNode = (p) => /^node(\.exe)?$/i.test(path.win32.basename(String(p ?? '')));

// Пути записи, кроме самой команды node (node из PATH, C:\Program Files\nodejs\node.exe, nvm, scoop — любой node/node.exe).
const entryPaths = (entry) => [...(isNode(entry?.command) ? [] : [entry?.command]), ...(Array.isArray(entry?.args) ? entry.args : [])].filter(isPath);
const envRoot = (entry) => entry?.env?.MOST_REPO_ROOT;

// Старые записи прежних версий (most, npx-сервер antigravity) удаляются, только если запись указывает в этот корень
// и ни один её признак не указывает в другое место (team-v12 Р2, Codex 7c835105): противоречие — не наша.
function pointsInto(entry, root) {
  const paths = entryPaths(entry), env = envRoot(entry);
  if (env != null && real(env) !== real(root)) return false;
  if (paths.some((p) => !inRoot(p, root))) return false;
  return paths.some((p) => inRoot(p, root) && real(p) !== real(root)) || (env != null && real(env) === real(root));
}

// Своя запись: все признаки согласно указывают на этот корень —
// (а) args[0] ровно <корень>\live\<40 hex>\servers\<имя>\index.js, или (б) MOST_REPO_ROOT этого корня;
// при этом MOST_REPO_ROOT (если есть) — этот корень и ни один путь записи не ведёт за его пределы.
function own(entry, name, root) {
  if (entry == null) return true;
  const env = envRoot(entry);
  if (env != null && real(env) !== real(root)) return false;
  if (entryPaths(entry).some((p) => !inRoot(p, root))) return false;
  const m = real(entry?.args?.[0]).match(/^(.*)\\live\\[0-9a-f]{40}\\servers\\([a-z]+)\\index\.js$/);
  if (m) return m[1] === real(root) && m[2] === name;
  return env != null;
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

module.exports = { norm, real, own, pointsInto, assertOwn };
