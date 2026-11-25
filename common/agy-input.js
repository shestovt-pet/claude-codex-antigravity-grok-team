'use strict';
// team-v48e Г7: предел размера собранного поручения снят безусловно (тумблер MOST_MAX_MATERIAL_BYTES удалён) — материал
// любого объёма доставляется целиком; отказа по размеру материала больше нет.
function userEvent(text) {
  return JSON.stringify({ event: 'user', message: { content: text } }) + '\n';
}
function parseResults(raw) {
  const results = [], diagnostics = [], denied = [];
  // cache-622 (М2): id разговора agy (поле conversation_id в событиях init/step_update/result; живая проба agy 1.5.15,
  // 23.11.2026). Надёжным считается только единственное значение во всех событиях; разнобой или отсутствие — null.
  const conversations = new Set();
  // Расход ЭТОГО хода: сумма usage завершённых шагов (у result.usage продолженного разговора — накопленный итог всех ходов).
  const steps = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, thinking_tokens: 0, total_tokens: 0 }; let stepUsage = false;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const addDenied = value => {
    if (Array.isArray(value)) denied.push(...value);
    else if (value) denied.push(value);
  };
  for (const line of raw.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    for (const holder of [event, event?.init, event?.step_update, event?.result])
      if (holder && typeof holder.conversation_id === 'string' && holder.conversation_id.trim()) conversations.add(holder.conversation_id.trim());
    const su = event?.event === 'step_update' ? event.step_update?.usage : null;
    if (su && typeof su === 'object') { stepUsage = true; for (const k of Object.keys(steps)) if (Number.isFinite(su[k])) steps[k] += su[k]; }
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
  const conversationId = conversations.size === 1 && /^[A-Za-z0-9-]{8,80}$/.test([...conversations][0]) ? [...conversations][0] : null;
  return { obj: results.at(-1) || null, candidates: results.length, diagnostics, denied, conversationId, turnUsage: stepUsage ? steps : null };
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
// cache-622 (Б1): материал длиннее порога (prompt-order.inlineLimit) передаётся файлом во временной папке (--add-dir).
const FILE_MATERIAL_NOTICE = 'Материал поручения лежит файлом (путь — в строке «Материал в файле»); прочитай его, другие файлы не открывай.';
module.exports = { userEvent, parseResults, permission, protocolError, outputLimit, INLINE_NOTICE, FILE_MATERIAL_NOTICE };
