'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { inside, atomic } = require('./team-git');
const VERSION = '0.5.0';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const marker = state => path.join(state, '.migration-done-' + VERSION);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const finalState = card => ['done', 'applied', 'failed', 'cancelled'].includes(
  card.status === 'migration_conflict' ? card.migration?.originalStatus : card.status);
const INTERVAL_MS = 5 * 60 * 1000;
function sourcesFor(options, root, env) {
  return options.sources || [
    path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'most'),
    path.join(root, 'live/.deploy-state'),
  ];
}

function filesUnder(dir, prefix = '') {
  return fs.readdirSync(dir).sort().flatMap(name => {
    if (['locks', 'ready'].includes(name) || name.startsWith('.')) return [];
    const relative = path.join(prefix, name), file = inside(dir, name);
    if (fs.lstatSync(file).isDirectory()) return filesUnder(file, relative);
    return [relative];
  });
}

function bundle(source, kind, id) {
  const directory = inside(source, kind, id), flat = kind === 'codex-jobs' && !fs.existsSync(directory);
  const base = flat ? path.join(source, kind) : directory;
  const cardName = flat ? id + '.json' : 'card.json';
  // Карточка читается раньше списка файлов: поздний done не должен сочетаться
  // со списком файлов от ещё выполнявшегося задания.
  const originalCard = fs.readFileSync(inside(base, cardName));
  const names = flat ? fs.readdirSync(base).filter(n => n.startsWith(id + '.') && !n.endsWith('.tmp'))
    : filesUnder(base);
  const files = new Map(names.map(n => [n === cardName ? 'card.json' : n,
    n === cardName ? originalCard : fs.readFileSync(inside(base, n))]));
  if (!fs.readFileSync(inside(base, cardName)).equals(originalCard)) {
    const error = Error('Карточка изменилась во время сверки; повтор при следующей сверке');
    error.code = 'MIGRATION_SOURCE_CHANGED';
    throw error;
  }
  if (!files.has('card.json')) throw Error('Нет карточки комплекта ' + id);
  const card = JSON.parse(files.get('card.json').toString('utf8'));
  if (card.id && card.id !== id) throw Error('Номер карточки не совпадает с комплектом.');
  card.id ||= id;
  // У незавершённого задания объявленный результат ещё может не существовать.
  for (const key of ['resultFile', 'textFile', 'metaFile']) {
    if (!card[key]) continue;
    const filename = path.win32.basename(path.posix.basename(card[key]));
    if (!files.has(filename) && ['done', 'applied'].includes(card.status)) throw Error('Неполный комплект ' + id + ': нет ' + key);
    card[key] = filename;
  }
  if (card.retry?.inputDir) {
    const oldInput = card.retry.inputDir;
    if (fs.existsSync(oldInput)) {
      const safeInput = inside(source, path.relative(source, oldInput));
      for (const filename of filesUnder(safeInput)) {
        files.set(path.join('input', filename), fs.readFileSync(inside(safeInput, filename)));
      }
      card.retry = { ...card.retry, inputDir: 'input',
        args: card.retry.args.map(arg => String(arg).split(oldInput).join('$BUNDLE/input')) };
    } else if (['queued', 'running', 'waiting_quota'].includes(card.status)) {
      card.migration = { note: 'Входные файлы повторной попытки отсутствуют' };
    } else {
      // Завершённое поручение не возобновляется, входные копии могли быть штатно очищены.
      card.retry = null;
    }
  }
  if (['done', 'applied'].includes(card.status)) {
    const result = kind === 'jobs' ? 'result.txt' : card.resultFile;
    if (!result || !files.has(result)) throw Error('Неполный результат ' + id);
    const metaName = kind === 'jobs' ? 'meta.json' : card.metaFile;
    if (kind === 'jobs' && !files.has(metaName)) throw Error('Нет сведений результата ' + id);
    const meta = metaName && files.has(metaName) ? JSON.parse(files.get(metaName).toString('utf8')) : null;
    for (const expected of [meta?.hash, card.resultHash, card.migration?.resultHash].filter(Boolean)) {
      if (digest(files.get(result)) !== expected) throw Error('Хеш результата не совпадает: ' + id);
    }
  }
  if (!fs.readFileSync(inside(base, cardName)).equals(files.get('card.json'))) {
    const error = Error('Карточка изменилась во время сверки; повтор при следующей сверке');
    error.code = 'MIGRATION_SOURCE_CHANGED';
    throw error;
  }
  // Абсолютные пути не входят в отпечаток: одинаковые копии из разных источников совпадают.
  const normalized = { ...card };
  delete normalized.migration;
  if (normalized.status === 'migration_conflict') normalized.status = card.migration?.originalStatus;
  files.set('card.json', Buffer.from(JSON.stringify(normalized)));
  const fingerprint = digest([...files].sort(([a], [b]) => a.localeCompare(b))
    .map(([n, bytes]) => n + ':' + digest(bytes)).join('\n'));
  return { files, card, fingerprint };
}


function quarantine(source, kind, id, state, sourceIndex, error, result) {
  const destination = inside(state, 'quarantine', /^[\w-]{1,80}$/.test(id) ? id : digest(id).slice(0, 32));
  fs.mkdirSync(destination, { recursive: true });
  const copy = inside(destination, kind + '-' + sourceIndex);
  fs.mkdirSync(copy, { recursive: true });
  let directory;
  try { directory = inside(source, kind, id); } catch { directory = null; }
  const base = directory && fs.existsSync(directory) ? directory : inside(source, kind);
  let names = [];
  try { names = base === directory ? filesUnder(base) : fs.readdirSync(base).filter(n => n.startsWith(id + '.')); }
  catch (e) { result.errors.push({ id, error: e.message }); }
  for (const filename of names) {
    try { atomic(inside(copy, filename), fs.readFileSync(inside(base, filename))); }
    catch (e) { result.errors.push({ id, file: filename, error: e.message }); }
  }
  atomic(path.join(destination, 'card.json'), JSON.stringify({ id, status: 'migration_damaged',
    migration: { source, kind, reason: error.message, note: 'ПЕРЕНОС: ПОВРЕЖДЁН' } }, null, 2));
  result.errors.push({ id, kind, error: error.message, quarantine: destination });
}

async function migrate(options = {}) {
  const root = options.root || options.repoRoot;
  const state = options.state || options.stateDir;
  const env = options.env || process.env;
  if ((env.MOST_CLIENT || 'claude') !== 'claude' || env.MOST_PROBE_ONLY === '1') return;
  // team-v63 (п.17, заявка DeepSeek №5): дочерние серверы участников, поднятые исполнителем сценариев (senderRunner),
  // НЕ запускают первичную миграцию — иначе пять серверов на одном состоянии затевали бы пять сверок разом (сериализуются
  // замком, но это впустую), а сами сценарные дети оперируют карточками напрямую и в переносе старых карточек не нуждаются.
  if (env.MOST_SCENARIO_CHILD === '1') return;
  if (!require('./paths').samePath(state, path.join(root, 'state'))) return;
  fs.mkdirSync(state, { recursive: true });
  const locks = require('./locks');
  let lock;
  for (;;) {
    lock = await locks.tryLock('migration', path.resolve(state), {}, state);
    if (lock.ok) break;
    if (!lock.busy) throw Error('Перенос хранилища: не удалось получить блокировку.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try {
    const firstRun = !fs.existsSync(marker(state));
    const sources = sourcesFor(options, root, env);
    const previous = fs.existsSync(path.join(state, 'migration.log')) ? read(path.join(state, 'migration.log')) : {};
    const result = { at: new Date().toISOString(), copied: previous.copied || 0,
      updated: previous.updated || 0, skipped: 0, conflicts: previous.conflicts || [], errors: previous.errors || [] };
    for (const [sourceIndex, source] of sources.entries()) {
      if (!fs.existsSync(source)) continue;
      // Исторические имена хранилищ: перенос старых карточек, не перечень участников.
      for (const kind of ['jobs', 'codex-jobs']) {
        const dir = inside(source, kind);
        if (!fs.existsSync(dir)) continue;
        const ids = new Set(fs.readdirSync(dir).flatMap(n => {
          if (n.startsWith('.') || n.includes('.conflict-')) return [];
          if (fs.lstatSync(path.join(dir, n)).isDirectory() || fs.lstatSync(path.join(dir, n)).isSymbolicLink()) return [n];
          return kind === 'codex-jobs' && /^[\w-]+\.json$/.test(n) ? [n.slice(0, -5)] : [];
        }));
        for (const id of ids) {
          let jobLock;
          try {
            if (!/^[\w-]{1,80}$/.test(id)) throw Error('Некорректный номер переносимого задания.');
            jobLock = await locks.tryLock(kind === 'jobs' ? 'job' : 'codex_job', id, { jobId: id }, state);
            if (!jobLock.ok) { result.skipped++; continue; }
            const incoming = bundle(source, kind, id);
            const target = inside(state, kind, id);
            const flat = inside(state, kind, id + '.json');
            let destination = target, conflict = false, update = false;
            if (fs.existsSync(path.join(target, 'card.json')) || fs.existsSync(flat)) {
              let existing;
              try { existing = bundle(state, kind, id); }
              catch (error) { existing = { fingerprint: null }; }
              if (existing.fingerprint === incoming.fingerprint || existing.card?.migration?.fingerprint === incoming.fingerprint) { result.skipped++; continue; }
              if (existing.card && finalState(incoming.card) && !finalState(existing.card)) {
                update = fs.existsSync(path.join(target, 'card.json'));
              } else if (existing.card && finalState(existing.card) && !finalState(incoming.card)) {
                result.skipped++; continue;
              } else {
                if (existing.card && finalState(existing.card) && finalState(incoming.card)) {
                  const error = Error('Конфликт окончательных состояний задания');
                  quarantine(state, kind, id, state, 'current-' + existing.fingerprint.slice(0, 12), error, result);
                  quarantine(source, kind, id, state, sourceIndex + '-' + incoming.fingerprint.slice(0, 12), error, result);
                }
                destination = target + '.conflict-' + sourceIndex + '-' + incoming.fingerprint.slice(0, 12);
                conflict = true;
              }
            }
            if (update || !fs.existsSync(destination)) {
              const temporary = inside(state, kind, '.preparing-' + id + '-' + crypto.randomUUID());
              fs.mkdirSync(temporary, { recursive: true });
              for (const [filename, bytes] of incoming.files) {
                if (filename === 'card.json') continue;
                const out = inside(temporary, filename);
                fs.mkdirSync(path.dirname(out), { recursive: true });
                fs.writeFileSync(out, bytes, { flag: 'wx' });
                if (options.hook) { try { await options.hook('file', filename); } catch (e) { e.migrationInterrupted = true; throw e; } }
              }
              const card = { ...incoming.card };
              for (const key of ['resultFile', 'textFile', 'metaFile']) {
                if (card[key]) card[key] = path.join(destination, card[key]);
              }
              if (card.retry?.inputDir === 'input') {
                card.retry.inputDir = path.join(destination, 'input');
                card.retry.args = card.retry.args.map(arg => arg.split('$BUNDLE/input').join(card.retry.inputDir));
              }
              card.migration = { ...incoming.card.migration, fingerprint: incoming.fingerprint, originalStatus: card.status };
              const declaredResult = kind === 'jobs' ? 'result.txt' : incoming.card.resultFile;
              if (!declaredResult || !incoming.files.has(declaredResult)) card.migration.note = 'перенесено без результата';
              const resultName = kind === 'jobs' ? 'result.txt' : incoming.card.resultFile;
              if (['done', 'applied'].includes(incoming.card.status) && resultName && incoming.files.has(resultName)) {
                card.migration.resultHash = digest(incoming.files.get(resultName));
                delete card.migration.note;
              }
              if (conflict) card.status = 'migration_conflict';
              fs.writeFileSync(path.join(temporary, 'card.json'), JSON.stringify(card, null, 2));
              if (options.hook) { try { await options.hook('before_publish', id); } catch (e) { e.migrationInterrupted = true; throw e; } }
              // Новый комплект публикуется целиком; обновление завершается карточкой.
              if (update) {
                // Читатель увидит окончательное состояние лишь после публикации всех файлов.
                // Штатный замок задания исключает одновременную запись новым исполнителем.
                for (const [filename, bytes] of incoming.files) {
                  if (filename !== 'card.json') atomic(inside(destination, filename), bytes);
                }
                atomic(path.join(destination, 'card.json'), JSON.stringify(card, null, 2));
                result.updated++;
              } else {
                fs.renameSync(temporary, destination);
                result.copied++;
              }
            }
            if (conflict) {
              const file = fs.existsSync(path.join(target, 'card.json')) ? path.join(target, 'card.json') : flat;
              const card = read(file);
              card.migration ||= { originalStatus: card.status };
              card.status = 'migration_conflict';
              atomic(file, JSON.stringify(card, null, 2));
              result.conflicts.push({ kind, id, preserved: destination });
            }
          } catch (error) {
            if (error.migrationInterrupted) throw error;
            if (error.code === 'MIGRATION_SOURCE_CHANGED' || error.code === 'ENOENT') {
              result.errors.push({ id, kind, error: error.message });
              continue;
            }
            quarantine(source, kind, id, state, sourceIndex, error, result);
          } finally { if (jobLock?.ok) await jobLock.release(); }
        }
      }
      const team = inside(source, 'team');
      if (firstRun && fs.existsSync(team)) for (const filename of filesUnder(team)) {
        const bytes = fs.readFileSync(inside(team, filename));
        const target = inside(state, 'team', filename);
        if (fs.existsSync(target)) {
          if (fs.readFileSync(target).equals(bytes)) { result.skipped++; continue; }
          atomic(target + '.conflict-' + sourceIndex, bytes);
          result.conflicts.push({ kind: 'team', id: filename });
        } else { atomic(target, bytes); result.copied++; }
      }
    }
    for (const key of ['conflicts', 'errors']) result[key] = [...new Map(result[key].map(item => [JSON.stringify(item), item])).values()];
    atomic(path.join(state, 'migration.log'), JSON.stringify(result) + '\n');
    atomic(marker(state), JSON.stringify(result));
    const failure = path.join(state, 'migration-error.json');
    if (fs.existsSync(failure)) atomic(failure, JSON.stringify({ resolvedAt: result.at }));
    return result;
  } finally { await lock.release(); }
}
// Гейт первичной миграции (team-v62): пока она не завершилась — успехом ИЛИ записанной ошибкой — обработчики инструментов,
// которым нужно перенесённое состояние, ждут её (с пределом), а периодические триггеры очереди/уборки не запускаются.
// На initialize/tools/list гейт не влияет: их обслуживает MCP ещё до вызова инструментов.
let primarySettled = false, settleResolve, started = false;
const settledPromise = new Promise(resolve => { settleResolve = resolve; });
function settlePrimary() { if (!primarySettled) { primarySettled = true; settleResolve(); } }
// Миграция вообще применима? (как проверяет migrate(): только клиент claude, не проба, состояние == <repo>/state).
// Если неприменима — барьера нет: ждать нечего.
function applicable(env = process.env) {
  if ((env.MOST_CLIENT || 'claude') !== 'claude' || env.MOST_PROBE_ONLY === '1' || env.MOST_SCENARIO_CHILD === '1') return false;
  const paths = require('./paths');
  try { return paths.samePath(paths.stateDir, path.join(paths.repoRoot, 'state')); } catch { return false; }
}
// team-v63 (п.18, заявка Gemini): барьер «состояние ещё переносится» надо ВЗВЕСТИ синхронно ДО server.connect — иначе вызов
// инструмента, пришедший между connect() и .then(start()), проскочил бы мимо (started ещё false → waitPrimary пропускал). arm()
// ставит started синхронно, когда миграция применима; его зовёт бутстрап КАЖДОГО сервера перед connect. Тесты без бутстрапа
// arm() не зовут → для них барьер не висит. Идемпотентно.
function arm() { if (!started && applicable()) started = true; return started; }
function armedForTest() { return started; }
function resetForTest() { started = false; primarySettled = false; }
function primaryDone() { return primarySettled; }
// Ждём завершения первичной миграции не дольше timeoutMs. true — завершилась (или миграция неприменима).
async function waitPrimary(timeoutMs = Number(process.env.MOST_MIGRATION_WAIT_MS) || 20000) {
  // team-v63 (Г): ждать нечего, если первичная сверка в ЭТОМ процессе не запускалась (start() не вызван). start() вызывается
  // в бутстрапе сервера синхронно сразу после server.connect — раньше, чем событийный цикл обработает первый вызов инструмента,
  // — поэтому `started` к этому моменту уже выставлен, и боевой барьер сохраняется. А тесты, грузящие обработчики сервера БЕЗ
  // бутстрапа (internals), не вызывают start(): для них барьер не висит пустые 20 с (дефект: зависимость теста от миграции,
  // которой нет). Признак применимости миграции (applicable) оставлен как есть.
  if (primarySettled || !applicable() || !started) return true;
  let timer;
  const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)); });
  const settled = await Promise.race([settledPromise.then(() => true), timedOut]);
  clearTimeout(timer);
  return settled;
}
// Для обработчика инструмента: null — состояние готово; иначе понятный текст с предложением повторить.
async function awaitPrimary(timeoutMs = Number(process.env.MOST_MIGRATION_WAIT_MS) || 20000) {
  if (await waitPrimary(timeoutMs)) return null;
  return 'Состояние ещё переносится, повторите через ' + Math.max(1, Math.ceil(timeoutMs / 1000)) + ' с.';
}
// Первичная сверка идёт в ФОНЕ после server.connect; её ошибка не теряется, повтор по таймеру ставится всегда.
async function start(options, scheduler = {}) {
  started = true; // team-v63 (Г): синхронно отмечаем, что первичная сверка запущена в этом процессе (см. waitPrimary).
  const root = options.root || options.repoRoot, state = options.state || options.stateDir;
  const env = options.env || process.env;
  let result, failed = null;
  try {
    result = await migrate(options);
  } catch (error) {
    failed = error;
    try { atomic(path.join(state, 'migration-error.json'), JSON.stringify({ at: new Date().toISOString(), error: error.message })); }
    catch (writeError) { console.error('Перенос хранилища: не удалось записать migration-error.json: ' + writeError.message); }
    // Текст ошибки — в журнал сервера (не только «сбой операции»); он же виден в team_status.
    console.error('Перенос хранилища: первичная сверка не завершена: ' + (error && error.message || error));
  } finally {
    // Барьер снят: обработчики инструментов больше не ждут, периодические триггеры могут запускаться.
    settlePrimary();
  }
  // Миграция неприменима (не claude / проба / другое состояние) — ни повтора, ни барьера не нужно.
  if (!failed && !result) return;
  const sources = sourcesFor(options, root, env);
  // При успехе без источников повтор не нужен; при первичном СБОЕ таймер повторной сверки ставим всегда.
  if (!failed && !sources.some(source => fs.existsSync(source))) return;
  let running = false;
  const schedule = scheduler.setInterval || setInterval;
  const cancel = scheduler.clearInterval || clearInterval;
  const timer = schedule(async () => {
    if (running) return;
    if (!sources.some(source => fs.existsSync(source))) { cancel(timer); return; }
    running = true;
    try { await migrate(options); }
    catch (error) {
      atomic(path.join(state, 'migration-error.json'), JSON.stringify({ at: new Date().toISOString(), error: error.message }));
      console.error('Перенос хранилища: сверка не завершена: ' + error.message);
    } finally { running = false; }
  }, INTERVAL_MS);
  timer.unref?.();
  return timer;
}
module.exports = { migrate, start, bundle, marker, VERSION, INTERVAL_MS, waitPrimary, awaitPrimary, primaryDone, applicable, arm, armedForTest, resetForTest };
