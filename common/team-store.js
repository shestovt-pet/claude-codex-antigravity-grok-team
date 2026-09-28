'use strict';
// Чтение карточек не импортирует серверы и не поднимает очереди.
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  crypto = require('crypto');
const { stateDir, isInsideReal } = require('./paths');
const roots = () => ({
  codex: process.env.MOST_CODEX_JOBS_DIR || path.join(stateDir, 'codex-jobs'),
  antigravity: path.join(stateDir, 'jobs'),
  grok: path.join(stateDir, 'grok-jobs'),
  // Архив старых заданий Codex — только если задан явно (team-v11: без личных путей по умолчанию).
  archive: process.env.MOST_CODEX_ARCHIVE_DIR || null,
});
function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function list(who, includeArchive = true) {
  const r = roots(),
    result = [],
    errors = [];
  for (const [dir, archived] of [[r[who], false], ...(who === 'codex' && includeArchive && r.archive ? [[r.archive, true]] : [])]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.includes('.conflict-') || name.startsWith('.')) continue;
      let file = path.join(dir, name);
      try {
        const bundle = who === 'antigravity' || fs.statSync(file).isDirectory();
        file = bundle ? path.join(dir, name, 'card.json') : file;
        if (!bundle && !name.endsWith('.json')) continue;
        if (!bundle && fs.existsSync(path.join(dir, name.slice(0, -5), 'card.json'))) continue;
        if (!fs.existsSync(file)) continue;
        if (!isInsideReal(file, dir)) throw Error('Карточка вне хранилища.');
        const j = read(file);
        result.push({ ...j, archived, cardFile: file });
      } catch (e) {
        if (e.code !== 'ENOENT') errors.push(file + ': ' + e.message);
      }
    }
  }
  return { jobs: result, errors };
}

function review(who, id, base, candidate, decision = 'ПРИНЯТО', requestMark, designHash) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id || '')) throw Error('Некорректный номер ревью.');
  if (fs.existsSync(path.join(path.dirname(roots()[who]), 'quarantine', id, 'card.json')))
    throw Error('ПЕРЕНОС: ПОВРЕЖДЁН — задание находится в карантине.');
  const j = list(who, false).jobs.find((j) => j.id === id);
  if (!j || j.status !== 'done' || j.archived)
    throw Error('Нужно завершённое задание ревью из действующего хранилища.');
  if (who === 'codex' && (j.write || j.previous))
    throw Error('Ревью Codex должно быть новым сеансом только для чтения.');
  if (who === 'antigravity' && !['review', 'zamechaniya'].includes(j.mode || j.rezhim))
    throw Error('Нужно задание Antigravity в режиме ревью.');
  const task = (j.task || j.poruchenie || '') + (who === 'grok' ? '\n' + (j.text || '') : '');
  if (requestMark && !task.includes(requestMark)) throw Error('В поручении ревью нет метки запроса ' + requestMark + '.');
  if (designHash && !new RegExp('(^|[^a-fA-F0-9])' + designHash.slice(0, 12) + '(?:' + designHash.slice(12) + ')?([^a-fA-F0-9]|$)').test(task))
    throw Error('В поручении нет хеша замысла ' + designHash + '.');
  for (const hash of [base, candidate].filter(Boolean))
    if (!new RegExp('(^|[^a-fA-F0-9])' + hash + '([^a-fA-F0-9]|$)').test(task))
      throw Error('В поручении нет точной пары базы и кандидата.');
  const dir = roots()[who],
    file = who === 'antigravity' ? path.join(path.dirname(j.cardFile), 'result.txt')
      : who === 'grok' ? path.join(dir, id + '.result.txt') : resultPath(j, dir);
  if (!file || !isInsideReal(file, dir)) throw Error('Результат вне хранилища.');
  const text = fs.readFileSync(file, 'utf8');
  if (j.migration?.resultHash && j.migration.resultHash !==
      crypto.createHash('sha256').update(text).digest('hex')) {
    throw Error('Хеш перенесённого результата ревью не совпадает.');
  }
  if (who === 'antigravity') {
    const meta = read(path.join(path.dirname(j.cardFile), 'meta.json'));
    if (meta.hash !== crypto.createHash('sha256').update(text).digest('hex'))
      throw Error('Хеш результата ревью не совпадает.');
  }
  let last = text.trim().split(/\r?\n/).at(-1);
  if (who === 'grok') {
    if (j.lateHash || j.cancelled || j.resultHash !== crypto.createHash('sha256').update(text).digest('hex')) {
      throw Error('Ответ Grok не является проверенным голосом.');
    }
    const parsed = require('./grok').parseReply(Buffer.from(text));
    if (!parsed) throw Error('Ответ Grok не завершён.');
    last = parsed.verdict;
  }
  // Вердикт в парном выделении Markdown (**ПРИНЯТО**, *…*, __…__, _…_) — тот же вердикт (team-v9 Р8, mujzy1iw, muk06rbu).
  last = (last || '').trim().replace(/^(\*\*|\*|__|_)(.+)\1$/, '$2').trim();
  const matches = decision === 'ПРИНЯТО' ? last === 'ПРИНЯТО'
    : decision === 'НЕ ПРИНЯТО' && /^НЕ ПРИНЯТО: [1-9]\d* блокирующ(?:ее|их)$/.test(last);
  if (!matches) throw Error('Последняя строка ревью не соответствует вердикту ' + decision + '.');
  return { ...j, reviewText: text };
}
function resultPath(job, dir = roots().codex) {
  const bundle = path.join(dir, job.id);
  const base = fs.existsSync(path.join(bundle, 'card.json')) ? bundle : dir;
  // Берём только имя объявленного результата, путь всегда строится внутри действующего хранилища.
  const declared = job.resultFile && path.win32.basename(path.posix.basename(job.resultFile));
  const filename = declared || job.id + '.attempt-' + (job.quotaAttempts || 0) + '.result.txt';
  if (!filename.startsWith(job.id + '.')) throw Error('Результат не относится к номеру поручения.');
  return path.join(base, filename);
}
module.exports = { list, review, roots, resultPath };
