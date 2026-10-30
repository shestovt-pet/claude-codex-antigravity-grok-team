'use strict';
// team-v46 п.5а: общее правило папок для любой записи (все серверы, подпоручения, гости, Antigravity-перенос).
// Папка — только вне корня связки, его клонов, релизов и содержащих их папок; realpath, раскрытие junction и
// граница сегмента пути. Вызывается при постановке и повторно перед запуском. Исключение одно: дирижёр
// (клиент claude, не гость) — своя рабочая копия .work\<изменение> без полного доступа.
const fs = require('fs'), path = require('path');
const paths = require('./paths');

function forbiddenRoots(root = paths.repoRoot) {
  // Корни клонов: безопасное умолчание E:/test-most, явная настройка MOST_CLONE_ROOTS
  // (JSON-массив абсолютных путей) и рабочие копии из .work. Тестовые папки задаются вне них.
  // team-v46: дополнительно сам физический корень связки (там, где лежит код) — в тестах MOST_REPO_ROOT
  // подменяется, но запись в релиз/рабочую копию кода остаётся запрещённой (team-v25 О3: RELEASE-копия).
  const physical = path.resolve(__dirname, '..');
  const workDir = path.join(root, '.work');
  // Явная настройка дополнительных корней клонов; безопасное умолчание сохраняется всегда.
  const configured = process.env.MOST_CLONE_ROOTS ? JSON.parse(process.env.MOST_CLONE_ROOTS) : [];
  if (!Array.isArray(configured) || configured.some(p => typeof p !== 'string' || !path.isAbsolute(p)))
    throw Error('MOST_CLONE_ROOTS должен быть JSON-массивом абсолютных папок.');
  const clones = [path.resolve('E:/test-most'), ...configured];
  try { for (const n of fs.readdirSync(workDir, { withFileTypes: true })) if (n.isDirectory()) clones.push(path.join(workDir, n.name)); }
  catch {}
  return [...new Set([physical, path.join(physical, 'live'), root, path.join(root, 'live'), ...clones])];
}

function insideForbidden(folder, roots = forbiddenRoots()) {
  for (const r of roots) {
    try { if (paths.isSameOrInsideReal(folder, r) || paths.isSameOrInsideReal(r, folder)) return r; }
    catch {}
  }
  return null;
}

// Своя рабочая копия дирижёра: папка внутри <root>\.work\<изменение>, карточка изменения — его (owner совпадает).
function ownWorkCopy(folder, opts = {}) {
  if (!opts.owner) return false;
  const root = opts.root || paths.repoRoot;
  const workDir = path.join(root, '.work');
  // Исключение действует только на физическую рабочую копию, без переадресаций по пути.
  const logical = path.relative(path.resolve(workDir), path.resolve(folder));
  if (!logical || logical === '..' || logical.startsWith('..' + path.sep) || path.isAbsolute(logical)) return false;
  let current = workDir;
  try {
    for (const part of ['', ...logical.split(path.sep)]) {
      if (part) current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
  } catch { return false; }
  let rel;
  try { rel = path.relative(paths.canonMaybe(workDir), paths.canonMaybe(folder)); }
  catch { return false; }
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const name = rel.split(path.sep)[0];
  if (!/^[a-z0-9-]{1,40}$/.test(name)) return false;
  try {
    const card = JSON.parse(fs.readFileSync(path.join(opts.stateDir || paths.stateDir, 'changes', name + '.json'), 'utf8').replace(/^\uFEFF/, ''));
    return card.owner === opts.owner && card.status !== 'закрыто';
  } catch { return false; }
}

// Отказ записи или полного доступа в запрещённой папке; null — папка допустима.
function refusal(folder, opts = {}) {
  if (!path.isAbsolute(folder) || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory())
    return 'Нужна абсолютная существующая папка.';
  const hit = insideForbidden(folder, forbiddenRoots(opts.root));
  if (!hit) return null;
  // Исключение п.5а: дирижёр, запись без полного доступа, своя рабочая копия .work\<изменение>.
  if (!opts.fullAccess && opts.client === 'claude' && !opts.guest && ownWorkCopy(folder, opts)) return null;
  return (opts.fullAccess ? 'Полный доступ запрещён' : 'Запись запрещена') +
    ' в папке связки, её клоне, релизе или содержащей их папке.';
}

module.exports = { refusal, forbiddenRoots, insideForbidden, ownWorkCopy };
