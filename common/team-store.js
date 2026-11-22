'use strict';
// Чтение карточек не импортирует серверы и не поднимает очереди.
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  crypto = require('crypto');
const { stateDir, isInsideReal } = require('./paths');
// jobs/codex-jobs и архив Grok — явная совместимость исторических карточек.
const legacyRoots = () => ({
  codex: process.env.MOST_CODEX_JOBS_DIR || path.join(stateDir, 'codex-jobs'),
  antigravity: path.join(stateDir, 'jobs'),
  grok: path.join(stateDir, 'grok-jobs'),
  // Архив старых заданий Codex — только если задан явно (team-v11: без личных путей по умолчанию).
  archive: process.env.MOST_CODEX_ARCHIVE_DIR || null,
});
function roots() {
  return { ...Object.fromEntries(require('./members').all().filter(m => require('./members').adapters[m.adapter]).map(m => [m.id, path.join(stateDir, m.id + '-jobs')])), ...legacyRoots() };
}
function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// team-v58 (task5 п.1): кэш разобранных карточек в памяти сервера. Краткая сводка team_status читала и JSON-разбирала тела
// карточек (на бою ~11 000) на КАЖДЫЙ вызов, да ещё с stat/exists/realpath на каждую, — отсюда секунды-десятки секунд.
// Кэш по хранилищу: имя файла → { время изменения (нс, NTFS 100 нс), размер, разобранная карточка }.
//  — новая или изменившаяся карточка перечитывается (расхождение размера/времени — чтение заново), видна сразу;
//  — стабильная (завершённая, старше суток) карточка из кэша не перечитывается и даже не stat'ится на каждый вызов —
//    тяжёлые проверки (stat/exists/isInsideReal/parse) для неё не повторяются, как требует п.1 («не читает тела старых
//    завершённых карточек на каждый вызов; полные карточки — только для незавершённых и свежих, окно 24 ч»).
// Проверка хешей и байтов (review/source) идёт отдельным read(file) мимо кэша. Исчезнувшие имена чистятся из кэша.
const scanCache = new Map(); // dir -> Map(name -> { mtimeNs(строка), size(число), job, cardFile })
const STABLE_STATUS = new Set(['done', 'applied', 'cancelled', 'failed', 'lost']);
function stableCard(job, now) {
  return job && STABLE_STATUS.has(job.status) && !job.stopUnconfirmed && Date.parse(job.startedAt || job.createdAt || 0) < now - 86400000;
}

// team-v59 (часть 3 п.1): дешёвый индекс карточек на диске. Кэш v58 живёт в памяти процесса — у каждого из десятков серверов
// свой, и ПЕРВЫЙ (холодный) вызов team_status в процессе читал и JSON-разбирал все тела карточек (на бою тысячи). Индекс
// (имя → mtime, размер, разобранная карточка) переживает перезапуск процесса: холодный проход загружает один файл индекса и
// возвращает стабильные карточки без обращения к каждому файлу. Индекс — НЕ источник прав и на голоса не влияет: каждая
// незавершённая/свежая запись всё равно переcверяется stat по mtime/размеру и при расхождении перечитывается; проверки
// хешей ревью/текста идут мимо индекса (review/source читают файлы заново). Запись — атомарно, последний писатель побеждает;
// сбой чтения индекса просто возвращает к полному проходу.
function indexFile(dir) {
  const tag = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 8);
  return path.join(stateDir, 'scan-index', path.basename(dir) + '-' + tag + '.json');
}
function loadDiskIndex(dir) {
  const cache = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(indexFile(dir), 'utf8'));
    if (data && data.v === 1 && data.entries && typeof data.entries === 'object')
      for (const [name, e] of Object.entries(data.entries))
        if (e && typeof e.m === 'string' && typeof e.s === 'number' && e.j && typeof e.c === 'string')
          cache.set(name, { mtimeNs: e.m, size: e.s, job: e.j, cardFile: e.c });
  } catch {}
  return cache;
}
// team-v61 (п.11): в индекс пишем карточку БЕЗ тяжёлых СЫРЫХ полезных нагрузок исполнения — именно они раздували индекс до
// сотен МБ (retry Antigravity ~118 МБ: args/stdin повтора CLI; writes ~93+53 МБ: список изменений писателя). retry нужен
// только НЕзавершённым поручениям (их карточки всегда читаются свежими, не из индекса) — убираем всегда. writes из снимка
// читает лишь fallback-атрибуция авторства codex (common/fallback.writers) — оставляем его ТОЛЬКО у codex, у остальных
// убираем. Остальные (лёгкие) поля сохраняются, поэтому сводка/очереди/приёмка/ревью работают как прежде; это кэш — любая
// сверка хешей ревью/текста и серверные проверки читают сами файлы карточек заново, мимо индекса.
const HEAVY_ALWAYS = ['retry'];
function trimForIndex(job, keepWrites) {
  if (!job || typeof job !== 'object') return job;
  if (!HEAVY_ALWAYS.some(k => k in job) && (keepWrites || !('writes' in job))) return job;
  const t = { ...job };
  for (const k of HEAVY_ALWAYS) delete t[k];
  if (!keepWrites) delete t.writes;
  return t;
}
function saveDiskIndex(dir, cache, keepWrites) {
  try {
    const entries = {};
    for (const [name, e] of cache) entries[name] = { m: e.mtimeNs, s: e.size, j: trimForIndex(e.job, keepWrites), c: e.cardFile };
    const file = indexFile(dir), base = path.basename(file), home = path.dirname(file);
    fs.mkdirSync(home, { recursive: true });
    // Старые поколения не копятся: убираем прежние незавершённые .tmp-* этого индекса (от прерванных записей).
    try { for (const n of fs.readdirSync(home)) if (n.startsWith(base + '.tmp-')) { try { fs.unlinkSync(path.join(home, n)); } catch {} } } catch {}
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: Date.now(), entries }));
    fs.renameSync(tmp, file);
  } catch {}
}

// Сканирование сохраняет ошибки действующего хранилища и архива отдельно.
function scan(who, includeArchive = true) {
  const r = roots();
  const bundleStore = who === 'antigravity' || require('./members').adapterOf(who) === 'agy-cli';
  const now = Date.now();
  return [[r[who], false], ...(who === 'codex' && includeArchive && r.archive ? [[r.archive, true]] : [])].map(([dir, archived]) => {
    const jobs = [], errors = [];
    let ents;
    try { ents = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []; }
    catch (error) { return { archived, jobs, errors, error }; }
    // Холодный процесс поднимает индекс с диска, чтобы не читать тела всех карточек заново.
    const keepWrites = who === 'codex';
    let cache = scanCache.get(dir), cold = false; if (!cache) { scanCache.set(dir, cache = loadDiskIndex(dir)); cold = true; }
    const seen = new Set();
    let dirty = false;
    // team-v61 (п.11): прежний «полный» индекс (с тяжёлыми сырыми полями) один раз пересобирается в сжатый при холодном
    // подъёме — чтобы уже установленный большой индекс сжался сам, без ручной правки живого состояния.
    if (cold) for (const e of cache.values()) if (e.job && ('retry' in e.job || (!keepWrites && 'writes' in e.job))) { dirty = true; break; }
    for (const ent of ents) {
      const name = ent.name;
      if (name.includes('.conflict-') || name.startsWith('.')) continue;
      const entry = path.join(dir, name);
      try {
        const hit = cache.get(name);
        // Стабильная карточка — отдаём из кэша/индекса без единого обращения к диску (кроме перечисления каталога выше).
        if (hit && stableCard(hit.job, now)) { seen.add(name); jobs.push({ ...hit.job, archived, cardFile: hit.cardFile }); continue; }
        const entStat = fs.statSync(entry, { bigint: true });
        const bundle = bundleStore || entStat.isDirectory();
        const cardFile = bundle ? path.join(entry, 'card.json') : entry;
        if (!bundle && !name.endsWith('.json')) continue;
        const sig = bundle ? fs.statSync(cardFile, { bigint: true }) : entStat;
        const mtimeNs = sig.mtimeNs.toString(), size = Number(sig.size);
        seen.add(name);
        if (hit && hit.cardFile === cardFile && hit.mtimeNs === mtimeNs && hit.size === size) { jobs.push({ ...hit.job, archived, cardFile }); continue; }
        // Новая или изменившаяся карточка — полные проверки и чтение.
        if (!bundle && fs.existsSync(path.join(dir, name.slice(0, -5), 'card.json'))) continue;
        if (!isInsideReal(cardFile, dir)) throw Error('Карточка вне хранилища.');
        const job = read(cardFile);
        cache.set(name, { mtimeNs, size, job, cardFile });
        dirty = true;
        jobs.push({ ...job, archived, cardFile });
      } catch (e) {
        // Карточка могла исчезнуть после перечисления; это не сбой её чтения.
        if (e.code !== 'ENOENT') errors.push(entry + ': ' + e.message);
      }
    }
    for (const n of cache.keys()) if (!seen.has(n)) { cache.delete(n); dirty = true; }
    if (dirty) saveDiskIndex(dir, cache, keepWrites);
    return { archived, jobs, errors };
  });
}
function listing(entries, includeArchive = true) {
  const selected = entries.filter(e => includeArchive || !e.archived);
  for (const e of selected) if (e.error) throw e.error;
  return { jobs: selected.flatMap(e => e.jobs), errors: selected.flatMap(e => e.errors) };
}
function list(who, includeArchive = true, snapshot) {
  return snapshot ? snapshot.list(who, includeArchive) : listing(scan(who, includeArchive));
}

function review(who, id, base, candidate, decision = 'ПРИНЯТО', requestMark, designHash, workReview = false, snapshot) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id || '')) throw Error('Некорректный номер ревью.');
  if (fs.existsSync(path.join(path.dirname(roots()[who]), 'quarantine', id, 'card.json')))
    throw Error('ПЕРЕНОС: ПОВРЕЖДЁН — задание находится в карантине.');
  const listed = list(who, false, snapshot);
  if (listed.errors.length) throw Object.assign(Error(id + ': нельзя прочитать поручения: ' + listed.errors.join('; ')), { code: 'STAGE_READ_FAILED' });
  const j = snapshot ? snapshot.get(who, id) : listed.jobs.find((j) => j.id === id);
  if (!j || j.status !== 'done' || j.archived)
    throw Error('Нужно завершённое задание ревью из действующего хранилища.');
  if (require('./members').adapterOf(who) === 'kimi-cli') require('./kimi-review').evidence(j);
  if (j.parentJob) throw Error('Подпоручение из поручения голосом не засчитывается: ревью выдаёт дирижёр из чата.');
  if ((who === 'codex' || require('./members').adapterOf(who) === 'codex-cli') && (j.write || j.previous) && (!workReview || j.role !== 'совет'))
    throw Error('Ревью Codex должно быть новым сеансом только для чтения.');
  if (who === 'deepseek' || require('./members').adapterOf(who) === 'dsh-headless') {
    if (j.write || j.previous || j.role !== 'проверка')
      throw Error('Голос DeepSeek должен быть новым сеансом проверки только для чтения.');
    if (j.profile !== 'most-review')
      throw Error('Голос DeepSeek засчитывается только из профиля most-review.');
    if (!j.modelConfirmed || require('./model-family').family(j.reportedModel) !== 'deepseek')
      throw Error('Голос DeepSeek не засчитан: фактическая модель сеанса не подтверждена.');
    if (!require('./dsh-probe').ok())
      throw Error('Голос DeepSeek не засчитывается: нет успешной пробы отказа записи установленной версии dsh.');
    if (!j.dshVersion || j.dshVersion !== require('./dsh-probe').version())
      throw Error('Голос DeepSeek не засчитывается: версия dsh карточки не совпадает с версией пробы.');
  }
  if (!workReview && (who === 'antigravity' || require('./members').adapterOf(who) === 'agy-cli') && !['review', 'zamechaniya'].includes(j.mode || j.rezhim))
    throw Error('Нужно задание Antigravity в режиме ревью.');
  const task = (j.task || j.poruchenie || '') + (who === 'grok' ? '\n' + (j.text || '') : '');
  if (requestMark && !task.includes(requestMark)) throw Error('В поручении ревью нет метки запроса ' + requestMark + '.');
  if (designHash && !new RegExp('(^|[^a-fA-F0-9])' + designHash.slice(0, 12) + '(?:' + designHash.slice(12) + ')?([^a-fA-F0-9]|$)').test(task))
    throw Error('В поручении нет хеша замысла ' + designHash + '.');
  for (const hash of [base, candidate].filter(Boolean))
    if (!new RegExp('(^|[^a-fA-F0-9])' + hash + '([^a-fA-F0-9]|$)').test(task))
      throw Error('В поручении нет точной пары базы и кандидата.');
  const dir = roots()[who],
    file = (who === 'antigravity' || require('./members').adapterOf(who) === 'agy-cli') ? path.join(path.dirname(j.cardFile), 'result.txt')
      : who === 'grok' ? path.join(dir, id + '.result.txt') : resultPath(j, dir);
  if (!file || !isInsideReal(file, dir)) throw Error('Результат вне хранилища.');
  const text = fs.readFileSync(file, 'utf8');
  if (j.migration?.resultHash && j.migration.resultHash !==
      crypto.createHash('sha256').update(text).digest('hex')) {
    throw Error('Хеш перенесённого результата ревью не совпадает.');
  }
  if ((who === 'antigravity' || require('./members').adapterOf(who) === 'agy-cli')) {
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
// Проверка источника текста не требует вердикта, но использует те же сохранённые байты и хеши.
function source(who, id, snapshot) {
  const listed = list(who, false, snapshot);
  if (listed.errors.length) throw Object.assign(Error(id + ': нельзя прочитать источник: ' + listed.errors.join('; ')), { code: 'STAGE_READ_FAILED' });
  const j = snapshot ? snapshot.get(who, id) : listed.jobs.find(j => j.id === id);
  if (!j || !['done', 'applied'].includes(j.status) || j.cancelled || j.lateHash) throw Error(id + ': нет принятого сервером результата текста.');
  const dir = roots()[who];
  const file = (who === 'antigravity' || require('./members').adapterOf(who) === 'agy-cli') ? path.join(path.dirname(j.cardFile), 'result.txt') : who === 'grok' ? path.join(dir, id + '.result.txt') : resultPath(j, dir);
  if (!isInsideReal(file, dir)) throw Error('Результат вне хранилища.');
  const text = fs.readFileSync(file, 'utf8'), hash = crypto.createHash('sha256').update(text).digest('hex');
  if ((j.migration?.resultHash && j.migration.resultHash !== hash) ||
      ((who === 'antigravity' || require('./members').adapterOf(who) === 'agy-cli') && read(path.join(path.dirname(j.cardFile), 'meta.json')).hash !== hash) ||
      (who === 'grok' && (j.resultHash !== hash || !require('./grok').parseReply(Buffer.from(text)))))
    throw Error(id + ': хеш результата текста не совпадает.');
  return text;
}
module.exports = { scan, listing, list, review, roots, resultPath, source, trimForIndex };
