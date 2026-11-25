'use strict';
const fs = require('fs'), path = require('path');
function claudeText(q) {
  if (!q) return 'данные не предоставлены; процент пятичасового лимита не виден';
  if (q.calls !== undefined) return `замер сеанса (не процент лимита): ${q.calls} обращений, перечитано ${(q.reread / 1e6).toLocaleString('ru-RU', {maximumFractionDigits: 1})} млн, написано ${(q.written / 1e6).toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 2})} млн за ${q.window_h} ч · ${q.source}, ${q.taken_at}`;
  return `использовано ${q.percent} %, сброс ${q.resets_at || 'данные не предоставлены'} · ${q.source}, ${q.taken_at}`;
}
// team-v46 п.6: Claude-исполнитель — отдельный сеанс; счётчик поручений за 5 ч и сутки (счётчик расхода, не квота провайдера).
function claudeExecutorText(state = path.join(require('./paths').stateDir, 'team')) {
  const count = ms => { try { return require('./team-store').list('claude', false).jobs.filter(j => Date.parse(j.startedAt) > Date.now() - ms).length; } catch { return null; } };
  const h5 = count(5 * 3600000), d24 = count(24 * 3600000);
  return 'поручений за 5 ч: ' + (h5 == null ? 'не видно' : h5) + ', за сутки: ' + (d24 == null ? 'не видно' : d24) + ' (счётчик расхода, не квота провайдера)';
}
function claudeExecutorRow(state = path.join(require('./paths').stateDir, 'team')) {
  const m = require('./members').active().find(x => x.adapter === 'claude-print');
  if (!m) return '';
  return require('./members').executorTitle(m) + ' — ' + claudeExecutorText(state);
}
// team-v58 (task5 п.1): квота Codex в краткой сводке — внешний процесс app-server (до 15 с) держал сводку. Теперь значение
// кэшируется (срок годности несколько минут) и берётся с коротким пределом ожидания (3–5 с); при истечении предела или
// недоступности источника — прошлое значение с его же пометкой времени снимка (taken_at в тексте), а не ожидание.
let codexCache = null; // { value, at }
function resetCodexCache() { codexCache = null; }
async function codexQuotaCached(q, binary, codex) {
  if (codex) return codex; // явно переданный источник (прямой вызов/тесты) кэш не использует
  const ttl = Number(process.env.MOST_CODEX_QUOTA_TTL_MS || 180000);
  const timeout = Number(process.env.MOST_CODEX_QUOTA_TIMEOUT_MS || 5000);
  if (codexCache && Date.now() - codexCache.at < ttl) return codexCache.value;
  let v;
  try { v = binary ? await q.codexQuota(binary, undefined, timeout) : (q.rollout() || { source: 'данные не предоставлены' }); }
  catch (e) { v = { source: 'ошибка источника квоты', error: e.message }; }
  if (!v.error) { codexCache = { value: v, at: Date.now() }; return v; }
  return codexCache ? codexCache.value : v; // предел истёк/источник недоступен — прошлый снимок с его временем
}
// team-v59 (часть 3 п.1): внешние источники квоты (codex app-server + Antigravity app) на холодном процессе давали до 7.5 с —
// держали краткую сводку. Теперь строку квот кэшируем на диске (срок годности несколько минут) ПЛЮС в кратком режиме жёсткий
// бюджет ожидания: не успели за budgetMs → прошлое значение с временем снимка (или «данные ещё не получены»), а свежее
// дорасчитывается в фоне и ложится в кэш для следующего вызова. Кэш — не источник прав и на голоса не влияет.
function cacheTime(at) { const d = new Date(at); return Number.isFinite(d.getTime()) ? d.toLocaleString('ru-RU') : 'время неизвестно'; }
// Внешний сбор квоты (Antigravity через Get-CimInstance, codex app-server) кратковременно держит событийный цикл — предел
// ожидания в самом процессе его НЕ разрывает. Поэтому в кратком режиме путь ответа НИКОГДА не вызывает внешний сборщик:
// локальные части квоты (снимок Claude из файла, счётчик Claude-исполнителя) считает мгновенно, а ВНЕШНИЕ части (codex, agy)
// берёт из кэша на диске (прошлое значение с временем) и запускает обновление ОТДЕЛЬНЫМ отвязанным процессом (не держит ни
// этот ответ, ни следующие инструменты). Нет кэша — на месте внешних частей «обновляется в фоне». Троттлинг — по метке/времени.
function extCacheFile(state) { return path.join(state, 'quota-ext-cache.json'); }
function readExtCache(state) { try { return JSON.parse(fs.readFileSync(extCacheFile(state), 'utf8')); } catch { return null; } }
function writeExtCache(state, v) { try { fs.mkdirSync(state, { recursive: true }); const f = extCacheFile(state), tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, f); } catch {} }
function refreshMarker(state) { return path.join(state, 'quota-ext-cache.refreshing'); }
function spawnRefresh(state, opts) {
  try {
    const marker = refreshMarker(state), throttle = Number(process.env.MOST_QUOTA_REFRESH_THROTTLE_MS || 10000);
    try { if (Date.now() - fs.statSync(marker).mtimeMs < throttle) return; } catch {}
    fs.mkdirSync(state, { recursive: true });
    try { fs.writeFileSync(marker, new Date().toISOString()); } catch {}
    const env = { ...process.env, MOST_QUOTA_REFRESH_STATE: state };
    if (opts?.binary) env.MOST_QUOTA_REFRESH_BINARY = opts.binary;
    if (opts?.agyModel) env.MOST_QUOTA_REFRESH_AGYMODEL = opts.agyModel;
    const child = require('child_process').spawn(process.execPath, [path.join(__dirname, 'quota-refresh.js')], { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on('error', () => {});
    child.unref();
  } catch {}
}
// Тексты внешних частей (без обращения к внешним процессам): по снимку codex (c) и Antigravity (a).
function codexCliText(q, c) { return (c.all?.length || c.five_hour || c.weekly ? 'семья openai · ' : '') + (c.error ? 'данные не предоставлены: ' + c.error : q.quotaText(c).replace(/\n/g, ', ')); }
function agyCliText(a) { return a.data ? a.text : 'данные не предоставлены: ' + a.text; }
// Сбор внешних снимков (медленная часть — вынесена отдельно).
async function externalSnapshot({ binary, codex } = {}) {
  const q = require('./quota');
  const [c, a] = await Promise.all([codexQuotaCached(q, binary, codex), require('./agy-quota').agySnapshot()]);
  return { c, a, codexText: codexCliText(q, c), agyText: agyCliText(a) };
}
// Сборка всей строки из локального снимка Claude и готовых текстов внешних частей.
function composeLine({ state = path.join(require('./paths').stateDir, 'team'), executor = true }, codexText, agyText) {
  let claude;
  try { claude = claudeText(JSON.parse(fs.readFileSync(path.join(state, 'claude-quota.json'), 'utf8'))); }
  catch (e) { claude = e.code === 'ENOENT' ? 'данные не предоставлены; процент пятичасового лимита не виден' : 'данные не предоставлены: ошибка чтения снимка'; }
  const registry = require('./members');
  const texts = {
    'claude-print': (claude.includes('данные не предоставлены') ? '' : 'семья anthropic · ') + claude,
    'codex-cli': codexText,
    'agy-cli': agyText,
  };
  const rows = registry.active().flatMap(m => {
    if (m.adapter !== 'claude-print') return [m.title + ' — ' + (markText(m) || texts[m.adapter] || 'источник квоты не подключён (А)')];
    const base = [m.title + ' Desktop (отдельно от Claude через Antigravity) — ' + texts['claude-print']];
    // team-v46: исполнитель — отдельный сеанс; в плотной строке квот подпись сокращена (полная — в заголовке «Участники»).
    if (executor) base.push('Claude-исполнитель — ' + claudeExecutorText(state));
    return base;
  });
  return 'Квоты: ' + rows.join('; ') + ' · Квота не удостоверяет модель ответа · снимок ' + new Date().toLocaleString('ru-RU');
}
// quota-622 (слово пользователя 23.11.2026): у DeepSeek источника квоты нет, но мост знает отказ провайдера — «на счёте нет
// денег» (ACCOUNT_QUOTA) или «лимит исчерпан» — по отметке на карточках (quota-mark). Показываем её со временем отметки.
// Только для DeepSeek (dsh-headless): чтение карточек одного участника, локально, без внешних процессов.
function markText(m) {
  if (m.adapter !== 'dsh-headless') return null;
  try { return require('./quota-mark').statusText(require('./team-store').list(m.id, false).jobs); } catch { return null; }
}
async function quotaLine(opts = {}) {
  const state = opts.state || path.join(require('./paths').stateDir, 'team');
  const budgetMs = opts.budgetMs;
  if (!budgetMs) return buildLine(opts); // полная сводка/прямой вызов — считает сразу, без кэша
  const ext = readExtCache(state);
  const ttl = Number(process.env.MOST_QUOTA_CACHE_TTL_MS || 180000);
  const fresh = ext && Date.now() - Date.parse(ext.at) < ttl;
  if (!fresh) spawnRefresh(state, opts); // обновление внешних частей в отвязанном процессе; ответ его не ждёт
  const codexText = ext ? ext.codexText : 'данные источника обновляются в фоне (повторите team_status через пару секунд)';
  const agyText = ext ? ext.agyText : 'данные источника обновляются в фоне';
  let line = composeLine(opts, codexText, agyText);
  if (ext && !fresh) line += ' · (codex/agy: снимок ' + cacheTime(ext.at) + ', обновляются в фоне)';
  // team-v59 (часть 3): подсказки по ВНЕШНЕЙ квоте (codex/agy) берутся из кэша — считать их на пути ответа нельзя (внешний
  // снимок дорогой, блокирует цикл). Нет кэша — без подсказок (появятся со следующего вызова после фонового досчёта).
  if (opts.advice && ext && (ext.codexAdvice || ext.agyAdvice)) line += '\n' + (ext.codexAdvice || '') + '\n' + (ext.agyAdvice || '');
  return line;
}
// Пересчёт кэша внешних частей: из отвязанного процесса (quota-refresh.js) и напрямую тестами/стартом сервера.
async function refreshLineCache(opts = {}) {
  const state = opts.state || path.join(require('./paths').stateDir, 'team');
  const snap = await externalSnapshot(opts);
  const qa = require('./quota-advice');
  // team-v59 (часть 3): подсказки по внешней квоте считаются вместе со снимком и кладутся в кэш — краткая сводка берёт их
  // оттуда, не считая на пути ответа. agyModel — из опций (отвязанный досчёт получает его через MOST_QUOTA_REFRESH_AGYMODEL).
  writeExtCache(state, { codexText: snap.codexText, agyText: snap.agyText,
    codexAdvice: qa.codexAdvice(snap.c), agyAdvice: qa.agyAdvice(snap.a, opts.agyModel), at: new Date().toISOString() });
  try { fs.unlinkSync(refreshMarker(state)); } catch {}
  return composeLine(opts, snap.codexText, snap.agyText);
}
async function buildLine(opts = {}) {
  const { binary, codex, advice = false, agyModel } = opts;
  const snap = await externalSnapshot({ binary, codex });
  const line = composeLine(opts, snap.codexText, snap.agyText);
  return line + (advice ? '\n' + require('./quota-advice').codexAdvice(snap.c) + '\n' + require('./quota-advice').agyAdvice(snap.a, agyModel) : '');
}
module.exports = { quotaLine, buildLine, composeLine, markText, refreshLineCache, readExtCache, writeExtCache, externalSnapshot, claudeText, claudeExecutorText, claudeExecutorRow, resetCodexCache, codexQuotaCached };
