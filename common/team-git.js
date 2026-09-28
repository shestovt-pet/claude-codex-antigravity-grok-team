'use strict';
const fs = require('fs'),
  path = require('path'),
  { execFileSync } = require('child_process');
const { isInsideReal, samePath } = require('./paths');
function name(value) {
  if (!/^[a-z0-9-]{1,40}$/.test(value || '')) throw Error('Имя: от 1 до 40 строчных латинских букв, цифр или дефисов.');
  return value;
}

function inside(root, ...parts) {
  const file = path.resolve(root, ...parts);
  if (!isInsideReal(file, root)) throw Error('Путь выходит за корень репозитория.');
  let cur = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    cur = path.join(cur, part);
    if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink())
      throw Error('Ссылки и переходы каталогов в служебном пути запрещены.');
  }
  return file;
}

function git(root, args, options = {}) {
  const { recoverIndex = true, skipIndexLock = false, ...spawnOptions } = options;
  // Команды только чтения (развёртывание) индекс не трогают: замок не проверяется и не переименовывается (team-v11).
  if (!skipIndexLock) checkIndexLock(root, { recover: recoverIndex });
  // Хуки отключены: сервер не должен исполнять произвольный код из репозитория.
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      ...spawnOptions,
    },
  );
}

function checkIndexLock(root, deps = {}) {
  const file = path.join(root, '.git', 'index.lock');
  if (!fs.existsSync(file)) return;
  if (deps.recover === false) throw Error('git занят');
  if (fs.lstatSync(file).isSymbolicLink()) throw Error('git занят: замок является ссылкой.');
  const age = Date.now() - fs.statSync(file).mtimeMs;
  let alive = true;
  try {
    const output = deps.processes ? deps.processes() : execFileSync(
      process.platform === 'win32' ? 'tasklist.exe' : 'ps',
      process.platform === 'win32' ? ['/FI', 'IMAGENAME eq git.exe', '/FO', 'CSV', '/NH'] : ['-A', '-o', 'comm='],
      { encoding: 'utf8', windowsHide: true },
    );
    alive = /(?:^|["\s\/])git(?:\.exe)?(?:["\s]|$)/im.test(output);
  } catch { throw Error('git занят: не удалось проверить процессы.'); }
  if (alive || age <= 120000) throw Error('git занят');
  fs.renameSync(file, file + '.stale-' + Date.now() + '-' + require('crypto').randomUUID());
}

// Только чтение для развёртывания под другим пользователем Windows; без глобальных настроек.
function deployGit(root, args) {
  if (!['rev-parse', 'archive', 'ls-tree', 'cat-file', 'show'].includes(args[0]))
    throw Error('Команда не разрешена для чтения при развёртывании.');
  const safe = require('./paths').canon(root).replace(/\\/g, '/');
  return git(root, ['-c', 'safe.directory=' + safe, ...args], { skipIndexLock: true });
}

function repository(root, run = git) {
  if (!samePath(run(root, ['rev-parse', '--show-toplevel']).trim(), root))
    throw Error('Нужен корень отдельного репозитория.');
  const dir = run(root, ['rev-parse', '--absolute-git-dir']).trim();
  if (
    !isInsideReal(dir, root) ||
    fs.lstatSync(path.join(root, '.git')).isSymbolicLink() ||
    !fs.statSync(path.join(root, '.git')).isDirectory()
  )
    throw Error('Нужен самостоятельный клон с собственным .git внутри папки.');
}

function hash(root, ref = 'main', run = git) {
  if (ref !== 'main' && !/^[a-f0-9]{7,40}$/.test(ref)) throw Error('Нужен main или хеш коммита.');
  return run(root, ['rev-parse', '--verify', ref + '^{commit}']).trim();
}

function clean(root, trackedOnly = false) {
  return !git(root, ['status', '--porcelain', '--untracked-files=' + (trackedOnly ? 'no' : 'all')]).trim();
}

function atomic(file, text) {
  const tmp = file + '.' + require('crypto').randomUUID() + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}
module.exports = { name, inside, git, deployGit, repository, hash, clean, atomic, checkIndexLock };
