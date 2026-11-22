'use strict';
// team-v56 А3: исходящие поручения Kimi через проектный MCP. Конфиг создаётся мостом ТОЛЬКО в служебной
// executionFolder (не в целевой папке проекта; целевой .kimi-code/mcp.json не трогаем) и ТОЛЬКО для ролей
// совет/текст. Для роли «проверка» конфиг не создаётся вообще (policy none): KIMI_CODE_TRUST_WORKSPACE в
// окружении CLI отсутствует, профиль не получает MCP/Agent. Среда MCP-процесса — jobEnv(newJobId) ровно из семи
// служебных полей; полное окружение и секреты в конфиг не сериализуются. Посторонний сервер в служебной папке — отказ.
const fs = require('fs'), path = require('path');
const fallback = require('./fallback');

// Точное имя переменной доверия (сохранённая положительная проба). TRUST_WORKSPACE/TRUST — не её имена.
const TRUST_VAR = 'KIMI_CODE_TRUST_WORKSPACE';
// Ровно семь ключей среды MCP-процесса: системная среда приходит из очищенного cliEnv, а эти поля закрепляются здесь.
const MCP_ENV_KEYS = Object.freeze(['MOST_CLIENT', 'MOST_JOB_ID', 'MOST_REPO_ROOT', 'MOST_STATE_DIR', 'TEMP', 'TMP', 'TMPDIR']);
// Допустимые получатели исходящих Kimi (профиль ПОРУЧЕНИЙ, не чата) и точный перечень инструментов каждого сервера.
// team-v58 (§3б): профиль поручений расширен на всех участников связки (claude, codex, antigravity, deepseek, team) с НАБОРОМ
// ИСПОЛНИТЕЛЯ — send/result/status/cancel у серверов-участников и team_ask/team_ask_result + чтение team (status/rules/work).
// Инструментов дирижёра здесь нет: ни team_change/team_word/team_members/team_inbox, ни antigravity_apply — права поручения не
// расширяются до прав чата (служебный профиль поручений остаётся «исполнительским»). Kimi → Kimi недопустим: kimi среди
// получателей нет. Конкретные права фильтрует общий job-chain получателя; это граница профиля.
const peer = s => [s + '_send', s + '_result', s + '_status', s + '_cancel'];
const RECIPIENTS = Object.freeze({
  claude: peer('claude'),
  codex: peer('codex'),
  antigravity: peer('antigravity'),
  deepseek: peer('deepseek'),
  team: ['team_ask', 'team_ask_result', 'team_status', 'team_rules', 'team_work'],
});

// Политика MCP поручения: «проверка» — none всегда; иначе project только при включённой у места способности sends.
function policy(job = {}, sends = false) {
  if (job.role === 'проверка') return 'none';
  return sends ? 'project' : 'none';
}

// Имена инструментов для allowlist профиля (mcp__<server>__<tool>). Без '*'/'mcp__*' — только точные имена.
function profileTools(servers = Object.keys(RECIPIENTS)) {
  const out = [];
  for (const name of servers) for (const tool of RECIPIENTS[name] || []) out.push('mcp__' + name + '__' + tool);
  return out;
}

// Среда одной MCP-записи: jobEnv(newJobId, {только доверенные значения}). jobEnv общего fallback добавляет
// MOST_JOB_ID/MOST_CLIENT=job и снимает MOST_AUTHORITY; второй аргумент ограничивает базу — без него копировался бы
// весь process.env (common/fallback.js). Затем сверяем ровно семь ключей: чужой MOST_JOB_ID и MOST_AUTHORITY не наследуются.
function mcpEnv(newJobId, { root, state, tempFolder }) {
  if (!newJobId) throw Error('kimi-mcp: нет номера текущего поручения для среды MCP.');
  if (!root || !state || !tempFolder) throw Error('kimi-mcp: нужны repo/state и папка задания для среды MCP.');
  const env = fallback.jobEnv(newJobId, { MOST_REPO_ROOT: root, MOST_STATE_DIR: state, TEMP: tempFolder, TMP: tempFolder, TMPDIR: tempFolder });
  const keys = Object.keys(env).sort();
  if (keys.length !== MCP_ENV_KEYS.length || keys.some((k, i) => k !== [...MCP_ENV_KEYS].sort()[i]))
    throw Error('kimi-mcp: среда MCP содержит лишние или недостающие ключи: ' + keys.join(', '));
  if (String(env.MOST_JOB_ID) !== String(newJobId) || env.MOST_CLIENT !== 'job' || 'MOST_AUTHORITY' in env)
    throw Error('kimi-mcp: служебная идентичность MCP не соответствует текущему поручению.');
  return env;
}

// Одна запись сервера: абсолютный node (command), абсолютный entrypoint (argv-массив), точная среда. Относительных путей нет.
function serverEntry(name, { node, serversDir, env }) {
  const entry = path.join(serversDir, name, 'index.js');
  if (!path.isAbsolute(node) || !path.isAbsolute(entry)) throw Error('kimi-mcp: нужны абсолютные node и entrypoint сервера ' + name + '.');
  return { command: node, args: [entry], env };
}

// Собирает конфиг проектного MCP для совет/текст. Для «проверки» и выключенного sends возвращает { policy:'none' }.
// Серверы — из перечня доверенных получателей (RECIPIENTS). Любой сервер вне перечня в уже существующем служебном
// конфиге — отказ (посторонняя запись не объединяется). Целевой пользовательский проект не трогаем.
function build({ job = {}, sends = false, newJobId, executionFolder, serversDir, node = process.execPath, root, state, tempFolder, servers }) {
  const pol = policy(job, sends);
  if (pol === 'none') return { policy: 'none', trust: {}, tools: [] };
  const names = (servers && servers.length ? servers : Object.keys(RECIPIENTS)).filter(n => RECIPIENTS[n]);
  if (!names.length) throw Error('kimi-mcp: нет доступных получателей исходящих Kimi.');
  const env = mcpEnv(newJobId, { root, state, tempFolder });
  const mcpServers = {};
  for (const name of names) mcpServers[name] = serverEntry(name, { node, serversDir, env });
  const content = { mcpServers };
  const relFile = path.join('.kimi-code', 'mcp.json');
  return { policy: 'project', content, relFile, env, tools: profileTools(names),
    trust: { [TRUST_VAR]: '1' }, servers: names };
}

// Проверяет, что в служебной папке нет постороннего MCP-сервера сверх собственного манифеста. Любая чужая запись — отказ.
function assertNoForeign(executionFolder, content) {
  const file = path.join(executionFolder, '.kimi-code', 'mcp.json');
  if (!fs.existsSync(file)) return;
  let existing;
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { throw Error('kimi-mcp: нечитаемый служебный mcp.json: ' + e.message); }
  const want = new Set(Object.keys(content.mcpServers));
  for (const name of Object.keys(existing.mcpServers || {})) if (!want.has(name)) throw Error('kimi-mcp: посторонний MCP-сервер в служебной папке: ' + name + ' — отказ, записи не объединяются.');
}

// Пишет служебный .kimi-code/mcp.json в executionFolder (не в целевой проект). Возвращает абсолютный путь и SHA.
function write(executionFolder, built) {
  if (!built || built.policy !== 'project') return null;
  assertNoForeign(executionFolder, built.content);
  const dir = path.join(executionFolder, '.kimi-code');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mcp.json');
  const serialized = JSON.stringify(built.content, null, 2);
  fs.writeFileSync(file, serialized, { encoding: 'utf8' });
  return { file, sha256: require('./kimi-launch').sha(serialized), tools: built.tools };
}

module.exports = { TRUST_VAR, MCP_ENV_KEYS, RECIPIENTS, policy, profileTools, mcpEnv, build, write, assertNoForeign, serverEntry };
