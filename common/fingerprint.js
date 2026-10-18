'use strict';
// Отпечаток будущего кандидата (team-v9 Р1): хеш дерева git из всего содержимого рабочей копии, включая новые файлы.
// Исключаются только результаты самого прогона: журнал этого клона и неотслеживаемые tests/.tmp-*.
// Отслеживаемые файлы входят всегда, как бы они ни назывались. Индекс клона не трогается.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { execFileSync } = require('child_process');
const journal = (folder) => 'tests/windows-test-output-' + path.basename(path.resolve(folder)) + '.txt';

function fingerprint(folder, inspect, exact = false) {
  const index = path.join(os.tmpdir(), 'most-fingerprint-' + process.pid + '-' + require('crypto').randomUUID());
  // team-v12 Р4: новые объекты (файлы рабочей копии, дерево) пишутся во временную папку, объекты клона только
  // читаются через alternates — в .git клона ничего не создаётся (в подключённой папке удалить их было бы нечем).
  const objects = index + '-objects';
  // Все места, откуда клон читает объекты: собственная папка объектов клона (без переопределений), папка из
  // GIT_OBJECT_DIRECTORY и alternates из окружения, если они заданы (Codex d8da5f4e, случай 27).
  const gitPath = (env) => path.resolve(folder, execFileSync('git', ['rev-parse', '--git-path', 'objects'],
    { cwd: folder, encoding: 'utf8', windowsHide: true, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } }).trim());
  const bare = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(k)));
  const sources = [...new Set([gitPath(bare), gitPath(process.env),
    ...String(process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES || '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(folder, p))])];
  fs.mkdirSync(objects, { recursive: true });
  const run = (args, binary = false) => execFileSync('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args],
    { cwd: folder, encoding: binary ? null : 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0',
      GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: sources.join(path.delimiter) } });
  try {
    // Точное git add -A сохраняет и принудительно добавленные игнорируемые файлы.
    const sourceIndex = exact ? path.resolve(folder, execFileSync('git', ['rev-parse', '--git-path', 'index'],
      { cwd: folder, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()) : null;
    if (sourceIndex && fs.existsSync(sourceIndex)) fs.copyFileSync(sourceIndex, index);
    else run(['read-tree', 'HEAD']);
    run(exact ? ['add', '-A'] : ['add', '-A', '--', '.', ':(exclude)' + journal(folder), ':(exclude)tests/.tmp-*']);
    // Отслеживаемые tests/.tmp-* (например tests/.tmp-v6-restart-parse.ps1) — исходники, а не вывод прогона.
    // «Отслеживаемые» — по HEAD и по настоящему индексу клона (файл, добавленный git add, но ещё не в HEAD); индекс только читается.
    const real = execFileSync('git', ['ls-files', '-z', '--', 'tests/.tmp-*'], { cwd: folder, encoding: 'utf8', windowsHide: true,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'GIT_INDEX_FILE')), GIT_OPTIONAL_LOCKS: '0' } });
    const tracked = [...new Set([...run(['ls-files', '-z', '--', 'tests/.tmp-*']).split('\0'), ...real.split('\0')])]
      .filter(Boolean).filter((f) => fs.existsSync(path.join(folder, f)) || run(['ls-files', '--', f]).trim());
    if (tracked.length) run(['add', '-A', '-f', '--', ...tracked]);
    const tree = run(['write-tree']).trim();
    if (inspect) inspect(run, tree);
    return tree;
  } finally {
    for (const f of [index, index + '.lock', objects]) try { fs.rmSync(f, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { fingerprint, journal };
