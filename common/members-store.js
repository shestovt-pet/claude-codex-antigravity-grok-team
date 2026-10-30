'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROLES = ['conductor', 'fallback_conductor', 'voter', 'writer', 'literary', 'receives', 'sends'];
const ADAPTERS = ['codex-cli', 'agy-cli', 'dsh-headless', 'claude-print'];
const MCP_MASK = /^[a-zA-Z0-9_-]+\/(?:[a-zA-Z0-9_.-]+|\*)$/;
const fail = message => Object.assign(Error('Реестр участников: ' + message), { code: 'MEMBERS_UNAVAILABLE' });
function validate(value) {
  if (!value || !Number.isSafeInteger(value.rev) || value.rev < 0 || !['A', 'B', 'C'].includes(value.phase) || !Array.isArray(value.members)) throw fail('неверный снимок');
  const ids = new Set();
  for (const m of value.members) {
    if (!m || !/^[a-z][a-z0-9_-]{0,63}$/.test(m.id) || ['grok', 'team', 'user', 'unknown', 'job', 'fresh', 'archive', '__proto__', 'constructor'].includes(m.id) || ids.has(m.id) ||
        !/^[a-z][a-z0-9_-]*$/.test(m.family || '') || !m.title?.trim() || typeof m.specialization !== 'string' || typeof m.external !== 'boolean' ||
        !ADAPTERS.includes(m.adapter) || !m.adapter_params || Array.isArray(m.adapter_params) || typeof m.adapter_params !== 'object' ||
        !ROLES.every(r => typeof m.roles?.[r] === 'boolean') || !['active', 'paused', 'removed'].includes(m.state)) throw fail('неверная запись участника ' + (m?.id || '?'));
    if (m.mcp_allow !== undefined && (!Array.isArray(m.mcp_allow) || m.mcp_allow.some(x => typeof x !== 'string' || !MCP_MASK.test(x)))) throw fail('неверный mcp_allow ' + m.id);
    if (m.pause !== null && (!m.pause || !['manual', 'quota', 'outage', 'misconfig'].includes(m.pause.kind) ||
        !/^(participant|model:.+)$/.test(m.pause.scope) || !Number.isFinite(Date.parse(m.pause.since)) ||
        (m.pause.until !== null && !Number.isFinite(Date.parse(m.pause.until))) ||
        (m.pause.next_probe !== null && !Number.isFinite(Date.parse(m.pause.next_probe))))) throw fail('неверная пауза ' + m.id);
    if (m.state === 'paused' && !m.pause) throw fail('не указана причина паузы ' + m.id);
    ids.add(m.id);
  }
  return value;
}
function create(state = require('./paths').stateDir) {
  const file = path.join(state, 'members.json'), good = file + '.last-good', log = path.join(state, 'members-log.jsonl'), lock = path.join(state, 'members.lock');
  const atomic = (target, value) => {
    const tmp = target + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(tmp, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Windows может кратко держать last-good открытым у конкурентного читателя.
    // Повторяем только публикацию того же файла; старый снимок не удаляем.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, target); break; }
      catch (e) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 100) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  };
  const ACQUIRE_STALE_MS = 60000;
  // Живой владелец не прерывается; ESRCH — доказанно мёртв; null — проверить нельзя.
  function alive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'ESRCH' ? false : null; }
  }
  // Файл захвата или замка, оставленный аварийно: владелец мёртв либо (если владельца
  // прочесть нельзя) отметка старше минуты. Если PID записан, но процесс проверить нельзя
  // (EPERM/EACCES), замок сохраняется: возраст решает лишь для записи без владельца.
  function stale(file) {
    let stat, text = '';
    try { stat = fs.statSync(file); } catch { return false; }
    try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
    let owner; try { owner = JSON.parse(text); } catch {}
    const pid = owner?.pid;
    if (Number.isSafeInteger(pid) && pid > 0) return alive(pid) === false;
    return Date.now() - Number(stat.mtimeMs) > ACQUIRE_STALE_MS;
  }
  function drop(file) { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  function locked(fn) {
    fs.mkdirSync(state, { recursive: true });
    let fd;
    // Короткий конкурентный писатель заканчивает публикацию, затем проверяем rev.
    // Захват и замок несут владельца (pid, время): после аварии их снимает только тот,
    // кто докажет смерть владельца; живой или непроверяемый процесс не прерывается.
    for (let attempt = 0; fd === undefined; attempt++) {
      let claim, busy = false;
      const acquire = lock + '.acquire';
      try {
        // Все писатели сериализуют захват и уборку заведомо мёртвого владельца.
        if (fs.existsSync(acquire) && stale(acquire)) drop(acquire);
        try { claim = fs.openSync(acquire, 'wx'); }
        catch (e) {
          // Windows: одновременное создание и удаление .acquire даёт EPERM/EACCES/EBUSY;
          // повторяется только это открытие, ошибки записи владельца не маскируются.
          if (e.code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code))) busy = true;
          else throw e;
        }
        if (!busy) {
          fs.writeFileSync(claim, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
          if (fs.existsSync(lock) && stale(lock)) drop(lock);
          fd = fs.openSync(lock, 'wx');
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        }
      }
      catch (e) {
        if (fd !== undefined) { fs.closeSync(fd); drop(lock); fd = undefined; }
        // Повтор по EEXIST — это занятый замок; любая другая ошибка уходит как есть.
        if (e.code !== 'EEXIST') throw e;
        busy = true;
      }
      finally { if (claim !== undefined) { fs.closeSync(claim); drop(acquire); } }
      if (busy) {
        if (attempt >= 100) throw fail('members.lock занят: ' + lock + '; повторите с актуальной rev');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try { return fn(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  // Журнал читается целиком. Недописанная последняя строка (обрыв append до публикации
  // снимков) отбрасывается: она не могла быть зафиксирована. Любая другая ошибка — остановка.
  function logState() {
    let raw;
    try { raw = fs.readFileSync(log, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return { entries: [], torn: false, empty: true };
      throw fail('журнал изменений недоступен: ' + log + ': ' + e.message);
    }
    const lines = raw.split(/\r?\n/);
    const tail = lines.pop();
    if (tail && tail.trim()) lines.push(tail);
    const entries = [];
    let torn = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); }
      catch (e) {
        if (i === lines.length - 1 && !raw.endsWith('\n')) { torn = true; continue; }
        throw fail('журнал изменений повреждён: ' + log + ': строка ' + (i + 1) + ': ' + e.message);
      }
    }
    return { entries, torn, empty: raw.length === 0 };
  }
  function history() { return logState().entries; }
  function append(entry) {
    // Завершённая последняя строка (валидный JSON без перевода строки) дополняется
    // переводом строки; убирается только оборванный хвост, который не разбирается.
    try {
      const raw = fs.readFileSync(log, 'utf8');
      if (raw && !raw.endsWith('\n')) {
        const cut = raw.lastIndexOf('\n'), tail = cut < 0 ? raw : raw.slice(cut + 1);
        let complete = false;
        try { JSON.parse(tail); complete = true; } catch {}
        fs.writeFileSync(log, complete ? raw + '\n' : (cut < 0 ? '' : raw.slice(0, cut + 1)));
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const fd = fs.openSync(log, 'a');
    try { fs.writeFileSync(fd, JSON.stringify(entry) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  function existing(publish = false) {
    // Первый запуск нескольких серверов может совпасть с публикацией начального снимка.
    for (let i = 0; i < 100 && fs.existsSync(lock) && !fs.existsSync(file) && !fs.existsSync(good); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    let current, verified;
    try { current = validate(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
    try { verified = validate(JSON.parse(fs.readFileSync(good, 'utf8'))); } catch {}
    let value = verified && (!current || verified.rev > current.rev) ? verified : current;
    if (!value && [file, good].some(f => fs.existsSync(f))) throw fail('members.json и last-good недоступны; новые запуски и принятие остановлены');
    const logStateValue = logState(), entries = logStateValue.entries;
    // Журнал проверяется как строгая цепочка от init rev 0: без пропусков, дублей и перестановок,
    // с совпадением before/after соседних записей. Снимок любой редакции обязан совпадать
    // с after записи той же редакции: отставание и расхождение означают потерю или подмену записей.
    if (entries.length) {
      const first = entries[0];
      if (first.action !== 'init' || first.rev !== 0 || first.before != null)
        throw fail('журнал изменений должен начинаться с init rev 0: ' + log + '; новые запуски и принятие остановлены');
      let prev = null;
      for (const entry of entries) {
        let after;
        try { after = validate(entry.after); }
        catch (e) { throw fail('журнал не содержит проверенного снимка на rev ' + entry.rev + ': ' + log + ': ' + e.message + '; новые запуски и принятие остановлены'); }
        if (after.rev !== entry.rev) throw fail('запись журнала rev ' + entry.rev + ' содержит снимок rev ' + after.rev + ': ' + log);
        if (prev) {
          if (entry.rev !== prev.rev + 1)
            throw fail('разрыв, дубликат или перестановка ревизий журнала: ' + prev.rev + ' → ' + entry.rev + ': ' + log);
          if (JSON.stringify(entry.before) !== JSON.stringify(prev.after))
            throw fail('цепочка журнала расходится на rev ' + entry.rev + ': ' + log);
        }
        prev = entry;
      }
      if (value) {
        const own = entries.find(e => e.rev === value.rev);
        if (!own) throw fail('журнал изменений не покрывает редакцию ' + value.rev + ': ' + log);
        if (JSON.stringify(own.after) !== JSON.stringify(value))
          throw fail('снимок расходится с журналом на rev ' + value.rev + ': ' + log);
      }
    } else if (value) {
      throw fail('журнал изменений пуст, а снимок rev ' + value.rev + ': ' + log + '; новые запуски и принятие остановлены');
    }
    if (!value && !entries.length && !logStateValue.empty) {
      // Журнал есть, но записей нет: снимки утрачены. Пустой файл — прерванная первая запись.
      throw fail('снимки реестра утрачены, журнал без записей: ' + log + '; новые запуски и принятие остановлены');
    }
    let replayed = false;
    if (!value && entries.length) {
      // Снимки утрачены или ещё не опубликованы: редакция берётся из проверенной цепочки.
      value = entries[entries.length - 1].after;
      replayed = true;
    } else if (!value) {
      value = validate(require('./members-default')());
      if (publish) append({ action: 'init', rev: value.rev, at: new Date().toISOString(), who: 'system', reason: 'Первая инициализация', quote: null, before: null, after: value });
      replayed = true;
    } else if (entries[entries.length - 1].rev > value.rev) {
      // Журнал впереди снимка: незавершённая публикация; цепочка уже проверена целиком.
      value = entries[entries.length - 1].after;
      replayed = true;
    }
    if (replayed && publish) { atomic(good, value); atomic(file, value); }
    const notes = [];
    if (replayed) notes.push('Восстановлена редакция из журнала; незавершённая публикация снимков');
    else if (!current) notes.push('members.json повреждён или отсутствует; используется last-good');
    else if (verified && verified.rev > current.rev) notes.push('Незавершённая публикация members.json; используется более новый last-good');
    if (logStateValue.torn) notes.push('журнал изменений: недописанная последняя строка отброшена');
    return { ...value, warning: notes.length ? notes.join('. ') : null };
  }
  function read({ initialize = true } = {}) {
    // Замок, оставленный погибшим первым писателем, не должен запирать чистый реестр.
    if (fs.existsSync(lock) && stale(lock) && ![file, good, log].some(f => fs.existsSync(f))) drop(lock);
    if (![file, good, log, lock].some(f => fs.existsSync(f))) {
      // Чистые читатели и dry-run не создают состояние. Это ещё не инициализация:
      // первый сервер/писатель фиксирует тот же снимок под замком.
      if (!initialize) return { ...validate(require('./members-default')()), warning: null };
      return locked(() => {
      if ([file, good, log].some(f => fs.existsSync(f))) return existing(true);
      const value = validate(require('./members-default')());
      append({ action: 'init', rev: value.rev, at: new Date().toISOString(), who: 'system', reason: 'Первая инициализация', quote: null, before: null, after: value });
      atomic(good, value); atomic(file, value);
      return { ...value, warning: null };
      });
    }
    const result = existing();
    return initialize && result.warning?.startsWith('Восстановлена редакция') ? locked(() => existing(true)) : result;
  }
  function update(expectedRev, mutate, meta, options = {}) {
    if (!meta || !['action', 'who', 'reason'].every(k => typeof meta[k] === 'string' && meta[k].trim()) ||
        (meta.quote != null && typeof meta.quote !== 'string')) throw fail('для журнала нужны действие, автор, причина и текст цитаты');
    read();
    return locked(() => {
      const current = existing(true);
      // Журнал — write-ahead: после аварии не теряем редакцию уже начатой записи.
      const entries = logState().entries, latestRev = Math.max(current.rev, ...entries.map(e => e.rev));
      if (!Number.isSafeInteger(expectedRev) || expectedRev !== latestRev || current.rev !== latestRev)
        throw Object.assign(fail('конфликт rev: ожидалась ' + expectedRev + ', текущая ' + latestRev), { code: 'MEMBERS_REV_CONFLICT' });
      const before = { rev: current.rev, phase: current.phase, members: current.members };
      const next = structuredClone(before); mutate(next); next.rev = current.rev + 1; next.phase = options.phase || current.phase; validate(next);
      append({ quote: null, ...meta, at: new Date().toISOString(), rev: next.rev, before, after: next });
      atomic(good, next); atomic(file, next);
      return next;
    });
  }
  return { read, update, history, file, good, log, lock };
}
module.exports = { create, validate, ROLES, ADAPTERS, MCP_MASK };
