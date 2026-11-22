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
function genericTokens(u) {
  if (!u || typeof u !== 'object') return null;
  const inp = pick(u, ['input_tokens', 'prompt_tokens', 'input', 'tokens_in']);
  const out = pick(u, ['output_tokens', 'completion_tokens', 'output', 'tokens_out']);
  const cached = pick(u, ['cached_input_tokens', 'cache_read_input_tokens', 'cached', 'tokens_cached']);
  if (inp == null && out == null) return null;
  return clean({ tokens_in: inp, tokens_out: out, tokens_cached: cached });
}

function pick(o, keys) { for (const k of keys) if (Number.isFinite(o[k])) return o[k]; return null; }
function clean(o) { const r = {}; for (const [k, v] of Object.entries(o)) if (Number.isFinite(v)) r[k] = v; return Object.keys(r).length ? r : null; }

module.exports = { charsIn, finalize, codexTokens, genericTokens };
