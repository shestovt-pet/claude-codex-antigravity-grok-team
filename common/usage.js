'use strict';
// team-v63 (п.6): учёт объёма и времени поручения. chars_in — текст поручения + вложения (знаки, что реально ушло модели);
// chars_out — длина ответа; seconds — время от запуска CLI до завершения. Токены ставятся ТОЛЬКО если CLI их сообщил
// (usage в потоке/выводе) — без догадок: чего CLI не сообщает, поле не ставим.

// Объём входа в знаках: задача + материал (a.text) + вложения. Вызывается на постановке (до запуска).
function charsIn(a, attachmentsChars = 0) {
  return (a.task ? String(a.task).length : 0) + (a.text ? String(a.text).length : 0) + (attachmentsChars || 0);
}

// Финал: длина ответа и секунды. resultText — окончательный текст (если доступен), иначе берётся длина файла результата.
function finalize(card, { resultText } = {}) {
  if (typeof resultText === 'string') card.chars_out = resultText.length;
  const start = Date.parse(card.childStartedAt || card.startedAt || '');
  const end = Date.parse(card.finishedAt || new Date().toISOString());
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) card.seconds = Math.round((end - start) / 100) / 10;
}

// Токены из события Codex (turn.completed несёт usage). Поля различаются по версиям — читаем мягко.
function codexTokens(event) {
  const u = event && (event.usage || event.info?.usage || event.token_usage);
  if (!u || typeof u !== 'object') return null;
  const inp = pick(u, ['input_tokens', 'prompt_tokens', 'input']);
  const out = pick(u, ['output_tokens', 'completion_tokens', 'output']);
  const cached = pick(u, ['cached_input_tokens', 'cache_read_input_tokens', 'cached']);
  if (inp == null && out == null) return null;
  return clean({ tokens_in: inp, tokens_out: out, tokens_cached: cached });
}

// Токены из структуры usage общего вида (DeepSeek final.usage, Kimi stream, agy). Возвращает поля или null.
// cache-622 (М3): понимает и поля DeepSeek API prompt_cache_hit_tokens / prompt_cache_miss_tokens (вход = попадание +
// промах, если prompt_tokens не дан; из кэша = попадание), и поля потока dsh inputTokens / cacheReadTokens /
// cacheWriteTokens / outputTokens (у dsh inputTokens — вход БЕЗ кэша; totalTokens = inputTokens + cacheReadTokens +
// cacheWriteTokens + outputTokens — так его считает и сверяет сам dsh (normalizeUsage: totalTokens − outputTokens обязано
// равняться input + cacheRead + cacheWrite); живая проба dsh 23.11.2026: 1303 + 9472 + 0 + 2 = 10777), и поле agy cache_read_tokens.
function genericTokens(u) {
  if (!u || typeof u !== 'object') return null;
  if (['inputTokens', 'outputTokens', 'cacheReadTokens'].some(k => Number.isFinite(u[k]))) return dshTokens(u);
  // Формат Anthropic (Claude-исполнитель): input_tokens — без кэша; вход целиком = input + cache_read + cache_creation.
  if (Number.isFinite(u.input_tokens) && Number.isFinite(u.cache_creation_input_tokens)) {
    const read = Number.isFinite(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0;
    return clean({ tokens_in: u.input_tokens + read + u.cache_creation_input_tokens, tokens_out: pick(u, ['output_tokens']), tokens_cached: read });
  }
  // Формат agy (Antigravity): input_tokens — без кэша, cache_read_tokens отдельно (живая проба agy 1.5.15 23.11.2026:
  // input 2919 + cache_read 11944 на продолженном ходу, total_tokens = input + output). Вход целиком = input + cache_read.
  if (Number.isFinite(u.input_tokens) && Number.isFinite(u.cache_read_tokens)) {
    return clean({ tokens_in: u.input_tokens + u.cache_read_tokens, tokens_out: pick(u, ['output_tokens']), tokens_cached: u.cache_read_tokens });
  }
  const hit = pick(u, ['prompt_cache_hit_tokens']), miss = pick(u, ['prompt_cache_miss_tokens']);
  let inp = pick(u, ['input_tokens', 'prompt_tokens', 'input', 'tokens_in']);
  if (inp == null && (hit != null || miss != null)) inp = (hit || 0) + (miss || 0);
  const out = pick(u, ['output_tokens', 'completion_tokens', 'output', 'tokens_out']);
  const cached = pick(u, ['cached_input_tokens', 'cache_read_input_tokens', 'cache_read_tokens', 'prompt_cache_hit_tokens', 'cached', 'tokens_cached']);
  if (inp == null && out == null) return null;
  return clean({ tokens_in: inp, tokens_out: out, tokens_cached: cached });
}

// cache-622 (М3, У3): usage шага dsh (событие {type:'status', phase:'step_end', usage:{…}}). Вход = без кэша + чтение кэша +
// запись кэша; из кэша — чтение кэша. Так tokens_in + tokens_out == totalTokens шага (формула dsh, сверена живой пробой).
function dshTokens(u) {
  if (!u || typeof u !== 'object') return null;
  const n = k => Number.isFinite(u[k]) ? u[k] : 0;
  if (!['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some(k => Number.isFinite(u[k]))) return null;
  return clean({ tokens_in: n('inputTokens') + n('cacheReadTokens') + n('cacheWriteTokens'), tokens_cached: n('cacheReadTokens'), tokens_out: n('outputTokens') });
}
// Сумма токенов (по шагам одного хода). a, b — объекты { tokens_in, tokens_cached, tokens_out } или null.
function addTokens(a, b) {
  if (!b) return a || null;
  if (!a) return { ...b };
  const r = { ...a };
  for (const k of ['tokens_in', 'tokens_cached', 'tokens_out']) if (Number.isFinite(b[k])) r[k] = (Number.isFinite(r[k]) ? r[k] : 0) + b[k];
  return r;
}

// cache-622 (М3): Kimi Code CLI 2.7.2 токенов в потоке stream-json не отдаёт. Они есть в журнале сеанса
// <дом kimi-code>/sessions/<wd_…>/<session_id>/agents/main/wire.jsonl — события {type:'usage.record', usage:{inputOther,
// inputCacheRead, inputCacheCreation, output}} по одному на шаг (найдено в журналах живых поручений 23.11.2026). Папку сеанса
// даёт <дом>/session_index.jsonl ({sessionId, sessionDir}). Берём записи ПОСЛЕДНЕГО хода (после последнего turn.prompt):
// при продолжении журнал хранит и прежние ходы.
function kimiHome(env = process.env) {
  return env.MOST_KIMI_CODE_HOME || require('path').join(env.USERPROFILE || require('os').homedir(), '.kimi-code');
}
function kimiWireFile(sessionId, home = kimiHome()) {
  const fs = require('fs'), path = require('path');
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(sessionId)) return null;
  let dir = null;
  try {
    for (const line of fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8').split(/\r?\n/)) {
      if (!line.includes(sessionId)) continue;
      try { const e = JSON.parse(line); if (e.sessionId === sessionId && typeof e.sessionDir === 'string') dir = e.sessionDir; } catch {}
    }
  } catch {}
  if (!dir) {
    try { const holder = fs.readdirSync(path.join(home, 'sessions')).find(n => fs.existsSync(path.join(home, 'sessions', n, sessionId))); if (holder) dir = path.join(home, 'sessions', holder, sessionId); } catch {}
  }
  if (!dir) return null;
  const file = path.join(dir, 'agents', 'main', 'wire.jsonl');
  return fs.existsSync(file) ? file : null;
}
function kimiWireTokens(text) {
  let turn = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === 'turn.prompt') { turn = null; continue; }
    if (e?.type !== 'usage.record' || !e.usage || typeof e.usage !== 'object') continue;
    const u = e.usage, n = k => Number.isFinite(u[k]) ? u[k] : 0;
    turn = addTokens(turn, { tokens_in: n('inputOther') + n('inputCacheRead') + n('inputCacheCreation'), tokens_cached: n('inputCacheRead'), tokens_out: n('output') });
  }
  return turn;
}
function kimiTokens(sessionId, home) {
  const file = kimiWireFile(sessionId, home);
  if (!file) return null;
  try { return kimiWireTokens(require('fs').readFileSync(file, 'utf8')); } catch { return null; }
}

function pick(o, keys) { for (const k of keys) if (Number.isFinite(o[k])) return o[k]; return null; }
function clean(o) { const r = {}; for (const [k, v] of Object.entries(o)) if (Number.isFinite(v)) r[k] = v; return Object.keys(r).length ? r : null; }

module.exports = { charsIn, finalize, codexTokens, genericTokens, dshTokens, addTokens, kimiHome, kimiWireFile, kimiWireTokens, kimiTokens };
