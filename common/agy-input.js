'use strict';
// Предел всего собранного поручения, включая рабочий текст, опоры и инструкции.
const MAX_MATERIAL_BYTES = 8 * 1024 * 1024;
function userEvent(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_MATERIAL_BYTES)
    throw Error('Материал поручения превышает предел 8 МиБ (8388608 байт UTF-8). Сократите материал.');
  return JSON.stringify({ event: 'user', message: { content: text } }) + '\n';
}
function parseResults(raw) {
  const results = [], diagnostics = [], denied = [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const addDenied = value => {
    if (Array.isArray(value)) denied.push(...value);
    else if (value) denied.push(value);
  };
  for (const line of raw.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.event === 'result') {
      const result = object(event.result) ? event.result : null;
      results.push(result);
      if (result?.error) diagnostics.push(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));
      addDenied(result?.denied_actions || result?.deniedActions);
    }
    // Текст модели и вывод прочитанных файлов — данные, а не диагностика отказа.
    const step = event?.event === 'step_update' ? event.step_update : null;
    if (step?.step_type === 'tool') {
      const tool = step.tool_info;
      if (tool?.error) diagnostics.push(JSON.stringify({ name: tool.name || step.tool_name, error: tool.error }));
      addDenied(tool?.denied_actions || tool?.deniedActions);
    }
  }
  return { obj: results.at(-1) || null, candidates: results.length, diagnostics, denied };
}
function permission(res) {
  const explicit = res.denied && (!Array.isArray(res.denied) || res.denied.length) ? res.denied : null;
  const text = [res.stderr, res.agyError, ...(res.diagnostics || []), explicit ? JSON.stringify(explicit) : ''].filter(Boolean).join('\n');
  const denial = /auto-denied|permission[^\n]{0,120}(?:denied|required)|required[^\n]{0,120}permission|отказ[^\n]{0,60}разреш|denied_actions/i.test(text) || !!explicit;
  if (!denial) return null;
  // Повторяем только явно распознанный отказ read_file; прочие запреты не повторяем.
  const lines = text.split(/\r?\n/).filter(l => /denied|permission|отказ/i.test(l));
  if (explicit) lines.push(JSON.stringify(explicit));
  const readOnly = lines.length && lines.every(l => /read_file/i.test(l) && !/write_file|run_command|shell|execute|edit_file|delete/i.test(l));
  return { retryable: !!readOnly, reason: readOnly ? 'Antigravity не получил разрешение прочитать материал поручения.' : 'Antigravity получил отказ разрешения инструмента; автоматический повтор не разрешён.' };
}
function protocolError(res) {
  if (res.cancelled || res.timedOut || permission(res)) return null;
  const text = [res.stderr, res.agyError].filter(Boolean).join('\n');
  const explicit = /stream input (?:message|event)[^\n]*(?:missing|invalid|unsupported)|(?:unsupported|invalid) stream input (?:message|event)|flag provided but not defined:[^\n]*(?:input-format|output-format)|(?:unknown|unsupported|invalid|unrecognized)[^\n]*(?:input-format|output-format|stream-json)|(?:input-format|output-format|stream-json)[^\n]*(?:unknown|unsupported|invalid|not supported)|(?:invalid|malformed)[^\n]*(?:NDJSON|JSON input)|(?:failed|unable) to (?:parse|decode)[^\n]*(?:input|message)/i.test(text);
  return explicit ? text.slice(0, 2000) : null;
}
function outputLimit(res, text = '') {
  const diagnostic = [res.stderr, res.agyError, res.error, ...(res.diagnostics || [])].filter(Boolean).join('\n');
  if (!/output[ _-]+token[ _-]+limit/i.test(diagnostic)) return null;
  const lines = String(text).split(/\r?\n/).length;
  const size = Math.max(1, Math.min(40, Math.floor(lines / 2)));
  return 'Ответ не поместился — отправьте правку частями по ' + size + ' строк. Автоматическое деление не выполнялось.';
}
const INLINE_NOTICE = 'Весь материал приложен, файлы не открывать.';
module.exports = { MAX_MATERIAL_BYTES, userEvent, parseResults, permission, protocolError, outputLimit, INLINE_NOTICE };
