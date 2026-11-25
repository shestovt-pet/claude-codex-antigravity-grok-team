'use strict';
// team-v46: аргументы claude.exe (режим печати -p), правила разрешений и обязательные флаги.
// Задание передаётся через stdin, не в argv. Точные значения флагов сверяются с `claude --help` установленной
// версии при запуске (см. servers/claude). Синтаксис пути с буквой диска Windows для Edit — Edit(//e/путь/**).
const path = require('path'), fs = require('fs');
const BUILTIN_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
// Флаги, без которых поручение не запускается вовсе (проверяются по `claude --help`).
const REQUIRED_FLAGS = ['-p', '--tools', '--strict-mcp-config', '--mcp-config', '--permission-mode', '--output-format'];
const OPTIONAL_FLAGS = ['--max-turns', '--no-session-persistence', '--setting-sources', '--settings'];

// Правило разрешения записи Claude Code на Windows: Edit(//e/путь/**). Claude Code приводит пути Windows к виду
// /e/путь (буква диска строчная, без двоеточия) — правило Edit(//E:/путь/**) не совпадает (team-v48b, эксперимент
// 2a2e9e47). Write(путь) Claude Code не сопоставляет никогда: Write и Edit проверяются по Edit-правилам.
function editRule(folder) {
  const raw = String(folder || '');
  const abs = (/^[a-zA-Z]:/.test(raw) ? path.win32.resolve(raw) : path.resolve(raw)).replace(/\\/g, '/');
  const m = /^([a-zA-Z]):(.*)$/.exec(abs);
  const body = m ? '//' + m[1].toLowerCase() + (m[2].startsWith('/') ? '' : '/') + m[2] : '//' + abs.replace(/^\/+/, '');
  return 'Edit(' + body.replace(/\/+$/, '') + '/**' + ')';
}
function allowedTools(job = {}) {
  if (job.fullAccessApplied) return ['Bash'];
  if (job.write) return [editRule(job.folder)];
  return [];
}
function settings(job = {}) {
  if (job.fullAccessApplied) return { permissions: {} };
  if (job.write) return { permissions: { deny: ['Bash'], additionalDirectories: [] } };
  return { permissions: { deny: ['Edit', 'Write', 'Bash'], additionalDirectories: [] } };
}
function buildArgs(files, params = {}, job = {}, helpText = '') {
  const supported = supportedFlags(helpText);
  // team-v48e (§2.6): предел ходов не навязывается — тумблер MOST_CLAUDE_MAX_TURNS удалён. Явный params.max_turns>0 (параметр
  // конкретного поручения, не тумблер возврата) сохраняется; иначе предела ходов нет.
  const maxTurns = Number.isInteger(params.max_turns) && params.max_turns > 0 ? params.max_turns : null;
  const writeTools = job.write || job.fullAccessApplied ? ['Edit', 'Write'] : [];
  const tools = [...BUILTIN_TOOLS, ...writeTools, ...(job.fullAccessApplied ? ['Bash'] : [])];
  const allowed = [...BUILTIN_TOOLS, ...allowedTools(job)];
  if (fs.existsSync(files.mcpConfig)) {
    const config = JSON.parse(fs.readFileSync(files.mcpConfig, 'utf8'));
    for (const name of Object.keys(config.mcpServers || {})) allowed.push('mcp__' + name + '__*');
  }
  const args = [
    '-p',
    '--output-format', 'json',
    ...(maxTurns && supported.has('--max-turns') ? ['--max-turns', String(maxTurns)] : []),
    ...(supported.has('--no-session-persistence') ? ['--no-session-persistence'] : []),
    '--tools', tools.join(','),
    ...(allowed.length ? ['--allowedTools', ...allowed] : []),
    // cache-622 (М4): модель по классу задачи (sonnet для простых и чтения) или названная в поручении; без неё — модель аккаунта.
    ...(typeof job.model === 'string' && job.model ? ['--model', job.model] : []),
    '--strict-mcp-config',
    '--mcp-config', files.mcpConfig,
    ...(supported.has('--setting-sources') ? ['--setting-sources', ''] : []),
    ...(supported.has('--settings') ? ['--settings', files.settings] : []),
  ];
  if (job.fullAccessApplied) args.push('--permission-mode', 'bypassPermissions');
  else args.push('--permission-mode', 'default');
  return args;
}
// team-v48e (ревью п.1): после сверки папки с замком правило Edit перенаводится на проверенный канонический путь
// из замка (не повторный разбор job.folder). Для полного доступа правила Edit нет (Bash+bypass) — перенаводить нечего.
function retargetEditRule(args, fromFolder, toFolder) {
  const i = args.indexOf(editRule(fromFolder));
  if (i >= 0) args[i] = editRule(toFolder);
  return args;
}
// Флаги из обязательного списка, которых нет в выводе `claude --help` (или версия не ответила).
function supportedFlags(helpText) {
  return new Set(String(helpText || '').match(/--[a-zA-Z][\w-]*|-[a-zA-Z](?=[\s,/]|$)/g) || []);
}
function missingFlags(helpText) {
  const supported = supportedFlags(helpText);
  return REQUIRED_FLAGS.filter((f) => !supported.has(f));
}
module.exports = { BUILTIN_TOOLS, REQUIRED_FLAGS, OPTIONAL_FLAGS, buildArgs, missingFlags, editRule, retargetEditRule, allowedTools, settings };
