'use strict';
// Отпечаток будущего кандидата (team-v9 Р1): хеш дерева git из всего содержимого рабочей копии, включая новые файлы.
// Исключаются только результаты самого прогона: журнал этого клона и неотслеживаемые tests/.tmp-*.
// Отслеживаемые файлы входят всегда, как бы они ни назывались. Индекс клона не трогается.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  { execFileSync } = require('child_process');
const journal = (folder) => 'tests/windows-test-output-' + path.basename(path.resolve(folder)) + '.txt';

function fingerprint(folder) {
  const index = path.join(os.tmpdir(), 'most-fingerprint-' + process.pid + '-' + require('crypto').randomUUID());
  const run = (args) => execFileSync('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args],
    { cwd: folder, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' } });
  try {
    run(['read-tree', 'HEAD']);
    run(['add', '-A', '--', '.', ':(exclude)' + journal(folder), ':(exclude)tests/.tmp-*']);
    // Отслеживаемые tests/.tmp-* (например tests/.tmp-v6-restart-parse.ps1) — исходники, а не вывод прогона.
    // «Отслеживаемые» — по HEAD и по настоящему индексу клона (файл, добавленный git add, но ещё не в HEAD); индекс только читается.
    const real = execFileSync('git', ['ls-files', '-z', '--', 'tests/.tmp-*'], { cwd: folder, encoding: 'utf8', windowsHide: true,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'GIT_INDEX_FILE')), GIT_OPTIONAL_LOCKS: '0' } });
    const tracked = [...new Set([...run(['ls-files', '-z', '--', 'tests/.tmp-*']).split('\0'), ...real.split('\0')])]
      .filter(Boolean).filter((f) => fs.existsSync(path.join(folder, f)) || run(['ls-files', '--', f]).trim());
    if (tracked.length) run(['add', '-A', '-f', '--', ...tracked]);
    return run(['write-tree']).trim();
  } finally {
    for (const f of [index, index + '.lock']) try { fs.rmSync(f, { force: true }); } catch {}
  }
}

module.exports = { fingerprint, journal };
