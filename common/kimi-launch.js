'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
// team-v56 А1 (ревью Codex №5): новая политика доказательства получает ОТДЕЛЬНУЮ версию. Прежние карточки базы писались по
// kimi-material-v1 (без mcpPolicy/profileKind/profileSha256/tool_calls) и читаются историческим reader'ом как есть —
// их действительные принятые/отклонённые голоса не переписываются и не обнуляются сменой роли. Новые карточки v56 требуют
// полный набор полей и проверку фактического потока (v2).
const POLICY_V1 = 'kimi-material-v1';
const POLICY = 'kimi-material-v2';
const MODELS = Object.freeze(['kimi-code/kimi-for-coding', 'kimi-code/k3', 'kimi-code/k3-256k', 'kimi-code/k3.1-pro', 'kimi-code/k3.1-pro-highspeed']);
const DEFAULT = MODELS[4];
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function model(value) { const m = value === undefined ? DEFAULT : value; if (!MODELS.includes(m)) throw Error('Неизвестный разрешённый алиас Kimi: ' + m); return m; }
// team-v56 А1/А2: запрет write/full_access снят (исполнение задаётся профилем агента), продолжение сеанса включено.
// Остаются недопустимыми: пустой continue_id (нужен номер собственной предыдущей карточки); полный доступ без записи;
// запись/полный доступ у роли «проверка» (она только читает). Остальные проверки продолжения — в send (владелец/цепочка/
// режим/папка/история/reservation) и повторно перед spawn; сюда они не входят, чтобы refusal(c) не отвергал валидную карточку.
function refusal(a) {
  const write = a.write === true, full = a.full_access === true || a.fullAccess === true;
  if (a.continue_id !== undefined && (typeof a.continue_id !== 'string' || !a.continue_id.trim())) return 'Пустой continue_id недопустим: укажите номер собственной предыдущей карточки Kimi.';
  if (full && !write) return 'Полный доступ Kimi требует write=true.';
  if (a.role === 'проверка' && (write || full)) return 'Роль «проверка» — только чтение: write/full_access недопустимы.';
  return null;
}
// team-v56 А1: профиль запуска (agent-file) с точным перечнем инструментов. Ограничения CLI, не ОС-песочница.
// Проверка — только чтение; писатель — Read/Write/Edit; полный доступ добавляет Bash для названных программ.
// Запрещено включать '*'/'mcp__*', встроенный Agent, навигацию браузера или Skill как обход Bash.
function profileSpec(job) {
  const read = ['Read', 'Grep', 'Glob'];
  if (job.role === 'проверка') return { kind: 'review', name: 'most-review.md', tools: read };
  if (!job.write) return { kind: 'reader', name: 'most-reader.md', tools: read };
  if (!job.fullAccess) return { kind: 'writer', name: 'most-writer.md', tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'] };
  return { kind: 'writer-full', name: 'most-writer-full.md', tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'] };
}
const PROFILE_TITLES = Object.freeze({ review: 'Профиль проверки', reader: 'Профиль чтения', writer: 'Профиль писателя', 'writer-full': 'Профиль писателя с запуском программ' });
// team-v56 А3: при включённых исходящих (совет/текст) в allowlist профиля добавляется ТОЧНЫЙ перечень инструментов
// моста (mcp__<server>__<tool>), без '*'/'mcp__*'. У роли «проверка» mcpTools пуст — MCP/Agent недоступны.
function profile(job, mcpTools = []) {
  const spec = profileSpec(job);
  const tools = [...spec.tools, ...(spec.kind === 'review' ? [] : mcpTools)];
  const hasMcp = tools.some(t => /^mcp__/.test(t));
  // team-v56 А1 (ревью Kimi №1): значение description содержит двоеточие («мост team-v56: …»), поэтому обязано быть в
  // двойных кавычках — иначе YAML видит вложенное отображение и --agent-file не загружается (CLI падает на инициализации).
  const text = ['---', 'name: ' + spec.name.replace(/\.md$/, ''), 'description: "мост team-v56: ' + PROFILE_TITLES[spec.kind] + '"',
    'tools:', ...tools.map(t => '  - ' + t), 'subagents: []', '---',
    PROFILE_TITLES[spec.kind] + '. Разрешены только перечисленные инструменты.',
    spec.tools.includes('Bash') ? 'Bash — только для названных в поручении программ; это разрешение, не ОС-песочница.'
      : 'Bash, запуск программ, Agent, навигация браузера, Skills недоступны.',
    hasMcp ? 'Исходящие поручения — только через перечисленные инструменты моста (MCP проекта); цикл и возврат к предку запрещены.'
      : 'MCP недоступен.', ''].join('\n');
  return { ...spec, tools, text, sha256: sha(text) };
}
// team-v56 А1: очищенная среда CLI вместо {...process.env}. Только явные системные имена (на Windows без учёта регистра);
// TEMP/TMP/TMPDIR — папка поручения на E; MOST_*, переменные доверия, NODE_OPTIONS, PYTHONPATH и прочее не наследуются.
// Единственное доверие (KIMI_CODE_TRUST_WORKSPACE для А3) добавляется отдельно и только после проверки манифеста — не здесь.
const ENV_ALLOW = Object.freeze(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'SYSTEMDRIVE']);
function cliEnv({ tempFolder, extra = {} } = {}) {
  const want = new Set(ENV_ALLOW.map(n => n.toLowerCase())), out = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && want.has(k.toLowerCase())) out[k] = v;
  if (tempFolder) { out.TEMP = tempFolder; out.TMP = tempFolder; out.TMPDIR = tempFolder; }
  return Object.assign(out, extra);
}
function binary() {
  const params = require('./members').all().find(m => m.adapter === 'kimi-cli')?.adapter_params || {};
  const file = params.path || path.join(process.env.USERPROFILE || '', '.kimi-code', 'bin', 'kimi.exe');
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.realpathSync(file) : null;
}
function identity(file = binary()) {
  if (!file) throw Error('Исполнитель Kimi не найден: настройте adapter_params.path.');
  return { path: file, sha256: sha(fs.readFileSync(file)) };
}
// team-v56 А1: args({model, jobId, inputFile, profileFile, sessionId}). Новый сеанс — --agent-file и новый inputFile;
// продолжение (А2) — --session и новый inputFile, без --agent-file/--continue (CLI запрещает их сочетать). Пути абсолютные,
// параметры — отдельные argv; sessionId берётся только из проверенной карточки А2 (в А1 не задаётся).
function args({ model: alias, jobId, inputFile, profileFile, sessionId } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(jobId || '')) throw Error('Некорректный номер поручения.');
  const name = inputFile ? path.basename(inputFile) : 'most-kimi-task-' + jobId + '.md';
  const out = ['-m', model(alias), '--output-format', 'stream-json'];
  if (sessionId) out.push('--session', sessionId);
  else if (profileFile) out.push('--agent-file', profileFile);
  out.push('-p', 'Прочитай файл ' + name + ' в текущей папке и выполни поручение. Ответ дай по-русски');
  return out;
}
// team-v56 Л1 (ревью Kimi круг 4): хеш реализации исходящих Kimi. Любая правка кода запуска/материала/ревью/MCP/миграции
// инвалидирует старый артефакт приёмки. Детерминированно и без зависимости от концов строк (CRLF→LF). Используется и
// привязкой приёмки (members-kimi.acceptanceBinding), и самим сервером при запуске (запись implHash в карточку поручения).
const IMPL_FILES = Object.freeze(['servers/kimi/index.js', 'common/kimi-launch.js', 'common/kimi-material.js', 'common/kimi-review.js', 'common/kimi-mcp.js', 'common/members-kimi.js', 'common/result-receipt.js']);
function implementationHash() {
  const root = path.resolve(__dirname, '..');
  return sha(IMPL_FILES.map(rel => rel + '\0' + sha(fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n'))).join('\n'));
}
function parser() {
  const decoder = new StringDecoder('utf8'); let buffer = '', last = null, version = null, session = null, bad = false, count = 0;
  // team-v56 А1 (ревью Kimi №4/Codex №6): tool_calls и результаты инструментов НЕ отбрасываются, а сохраняются как
  // доказательство. toolCalls — имена фактически вызванных инструментов (Read/Write/Bash/Agent/mcp__…), toolResults —
  // число событий роли tool. Финальным ответом остаётся последний assistant.content. По этим именам evidence() проверяет
  // независимость ревью (только read-инструменты, нет Agent/MCP/делегаций).
  // team-v56 Л2 (ревью круг 5, М1): след получения результата потомка по stream.ndjson родителя УБРАН — он засчитывал любой
  // ответ на *_result (в т.ч. «ещё работает»/ошибку). Теперь факт выдачи готового результата пишет сервер-получатель в
  // карточку потомка (common/result-receipt). Парсер родителя его больше не выводит.
  const toolCalls = []; let toolResults = 0;
  function line(s) {
    if (!s.trim()) return;
    try {
      const e = JSON.parse(s); count++;
      if (e.role === 'meta' && e.type === 'system.version' && typeof e.version === 'string') version = e.version;
      // team-v56 А2: из session.resume_hint берём ТОЛЬКО структурированный session_id для --session при продолжении;
      // поле command никогда не исполняется и даже не сохраняется как команда.
      else if (e.role === 'meta' && e.type === 'session.resume_hint') { if (typeof e.session_id === 'string' && e.session_id.trim()) session = e.session_id.trim(); }
      else if (e.role === 'assistant' && Array.isArray(e.tool_calls)) { for (const tc of e.tool_calls) {
        const n = tc?.function?.name ?? tc?.name; toolCalls.push(typeof n === 'string' && n ? n : '?');
      } }
      else if (e.role === 'assistant' && typeof e.content === 'string') last = e.content;
      else if (e.role === 'tool' && typeof e.tool_call_id === 'string') { toolResults++; }
      else bad = true;
    } catch { bad = true; }
  }
  function push(data) { buffer += Buffer.isBuffer(data) ? decoder.write(data) : data; let i; while ((i = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } }
  return { push, finish(code, stderr = '') {
    buffer += decoder.end(); if (buffer.trim()) line(buffer); buffer = '';
    const ok = code === 0 && !bad && !!version && typeof last === 'string' && !!last.trim();
    return { ok, text: last, version, session, events: count, toolCalls: [...toolCalls], toolResults, bad,
      errorKind: ok ? null : /error: failed to run prompt: Model .+ is not configured in config\.toml/.test(stderr) ? 'model_not_configured' : 'unknown',
      diagnostic: ok ? null : 'Kimi не завершил поручение: ' + (code !== 0 ? 'код ' + code : bad ? 'неизвестный или повреждённый поток' : 'нет текстового ответа') };
  } };
}
// team-v56 А1 (ревью Kimi №4/Codex №6): разбор СОХРАНЁННОГО потока stream.ndjson тем же парсером. evidence() вызывает
// analyze по фактическим байтам (а не по доверенному полю карточки), чтобы проверить набор инструментов и полноту событий.
const READ_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
function analyze(data, { code = 0, stderr = '' } = {}) { const p = parser(); p.push(data); return p.finish(code, stderr); }
// Запись совместимости создаётся при живой приёмке; она не является доказательством запрета записи.
function compatibility(file = binary(), state = require('./paths').stateDir) {
  try {
    const cli = identity(file), p = JSON.parse(fs.readFileSync(path.join(state, 'kimi-compatibility.json'), 'utf8'));
    return p.status === 'passed' && p.policy === POLICY && p.sha256 === cli.sha256 && p.path === cli.path && typeof p.version === 'string' && p.version && p.delivery === true && p.parsing === true && p.detection === true ? p : null;
  } catch { return null; }
}
// Только явный шаг разрешённой установки/живой приёмки. Сервер и техническая MCP-проба
// не вызывают CLI ради справки; таймаут относится только к --version/--help, не к поручению.
function inspect({ file = binary(), cwd, tempFolder, prefixArgs = [], timeoutMs = 8000 } = {}) {
  if (process.env.MOST_PROBE_ONLY === '1') return { skipped: true, reason: 'MOST_PROBE_ONLY' };
  if (!path.isAbsolute(cwd || '') || !path.isAbsolute(tempFolder || '')) throw Error('Укажите отдельные абсолютные папки проверки и временных файлов.');
  const cli = identity(file), output = {};
  for (const flag of ['--version', '--help']) {
    const r = require('child_process').spawnSync(cli.path, [...prefixArgs, flag], { cwd, env: cliEnv({ tempFolder }),
      encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    if (r.error || r.status !== 0) throw Error('Проверка Kimi ' + flag + ' не завершена: ' + (r.error?.code || r.status));
    output[flag] = r.stdout;
  }
  const version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(output['--version'])?.[0];
  if (!version || !output['--help'].trim()) throw Error('Версия или справка CLI не распознана.');
  if (identity(cli.path).sha256 !== cli.sha256) throw Error('CLI изменился во время проверки.');
  return { ...cli, version, helpSha256: sha(output['--help']) };
}
// Фиксирует результаты отдельной живой приёмки; сама проверка файлов/потока этим вызовом не выполняется.
function recordCompatibility(result, state = require('./paths').stateDir) {
  if (process.env.MOST_PROBE_ONLY === '1') throw Error('Техническая проба не подтверждает совместимость Kimi.');
  if (!result || !result.path || result.sha256 !== identity(result.path).sha256 || !result.version || result.delivery !== true || result.parsing !== true || result.detection !== true)
    throw Error('Нет полного результата живой проверки совместимости Kimi.');
  const record = { ...result, policy: POLICY, status: 'passed', at: new Date().toISOString() };
  const target = path.join(state, 'kimi-compatibility.json'); require('./team-git').atomic(target, JSON.stringify(record, null, 2)); return record;
}
module.exports = { POLICY, POLICY_V1, READ_TOOLS, MODELS, DEFAULT, sha, model, refusal, profileSpec, profile, cliEnv, ENV_ALLOW, binary, identity, args, parser, analyze, compatibility, inspect, recordCompatibility, implementationHash, IMPL_FILES };
