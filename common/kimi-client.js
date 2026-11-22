'use strict';
// team-v58-any-chat (часть Д, доводка task7): путь настроек чата Kimi (user-mcp.json ядра kimi-code) «находится сам».
// Домашняя папка kimi-code НЕ зашита и НЕ читается из секретов Kimi: путь берётся по приоритету
//   (а) adapter_params.client_config участника kimi; (б) переменная MOST_KIMI_MCP_CONFIG; (в) сохранённое ранее значение
//   (state\kimi-client.json); (г) живой процесс настольного Kimi в таблице процессов (Kimi.exe с командной строкой
//   «… runner\cli.js start --config <X>\config.json …» → mcp.json = <X>\runtime\kimi-code\home\mcp.json; сам config.json
//   НЕ открывается — берётся только путь из командной строки). Кандидат принимается, только если папка
//   <…>\runtime\kimi-code\home существует. Найденный путь ЗАПОМИНАЕТСЯ в несекретном файле состояния, чтобы пережить
//   закрытие приложения Kimi (установщик запускается при закрытых приложениях). Факт и форма командной строки —
//   E:\Codex\work\v58-origin-probe\report2.md (раздел Kimi) и E:\Codex\work\v58-kimi-chat\report.md.
const fs = require('fs'), path = require('path');
const STATE_FILE = 'kimi-client.json';
const stateFile = (state = require('./paths').stateDir) => path.join(state, STATE_FILE);
// mcp.json домашней папки kimi-code по пути config.json из командной строки: <X>\config.json → <X>\runtime\kimi-code\home\mcp.json.
function homeFromConfig(configPath) {
  return path.join(path.dirname(configPath), 'runtime', 'kimi-code', 'home', 'mcp.json');
}
// Каталог прогона тестов (как chat-origin.underTestTmp): реальное состояние моста — E:\most\state, не временная папка.
// Решающий признак «боевого моста» для безопасности живого сканирования процессов — что каталог состояния НЕ временный.
function underTestTmp(p) {
  const r = path.resolve(String(p || ''));
  if (/[\\/]tests[\\/]\.tmp-/i.test(r)) return true;
  const under = base => { try { const rel = path.relative(path.resolve(base), r); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); } catch { return false; } };
  if (under(require('os').tmpdir())) return true;
  if (process.env.MOST_TEST_OUTSIDE && under(process.env.MOST_TEST_OUTSIDE)) return true;
  return false;
}
// (г) Путь по живой таблице процессов. config.json НЕ открывается — из командной строки берётся только его путь.
function fromProcesses(deps = {}) {
  let rows;
  try { rows = (deps.processes || (() => require('./fallback').processTable(true, { commandLine: true })))(); }
  catch { return null; }
  for (const r of rows || []) {
    if (!/kimi\.exe/i.test(String(r.name || ''))) continue;
    const m = String(r.commandLine || '').match(/runner[\\/]cli\.js\s+start\b[\s\S]*?--config\s+(?:"([^"]+)"|(\S+))/i);
    if (!m) continue;
    const cfg = m[1] || m[2];
    if (!/config\.json$/i.test(cfg)) continue;
    return homeFromConfig(cfg);
  }
  return null;
}
function readSaved(state) {
  try { const r = JSON.parse(fs.readFileSync(stateFile(state), 'utf8').replace(/^﻿/, '')); return r && typeof r.path === 'string' ? r.path : null; }
  catch { return null; }
}
function save(state, file, source) {
  const rec = { path: file, at: new Date().toISOString(), source };
  require('./team-git').atomic(stateFile(state), JSON.stringify(rec, null, 2) + '\n');
  return rec;
}
const homeExists = file => { try { return !!file && fs.existsSync(path.dirname(file)); } catch { return false; } };
// Разрешение пути по приоритету (а)(б)(в) и, при includeLive, (г). Принимается первый кандидат с существующей домашней
// папкой; если такого нет — возвращается кандидат высшего приоритета (для предупреждения итога установки) или null.
function resolve(member = {}, state = require('./paths').stateDir, { includeLive = false, processes } = {}) {
  const cands = [];
  const ac = member && member.adapter_params && member.adapter_params.client_config;
  if (ac) cands.push({ file: ac, source: 'client_config' });
  if (process.env.MOST_KIMI_MCP_CONFIG) cands.push({ file: process.env.MOST_KIMI_MCP_CONFIG, source: 'env' });
  const saved = readSaved(state); if (saved) cands.push({ file: saved, source: 'saved' });
  if (includeLive) { const live = fromProcesses({ processes }); if (live) cands.push({ file: live, source: 'process' }); }
  for (const c of cands) if (homeExists(c.file)) return { ...c, found: true };
  return cands[0] ? { ...cands[0], found: false } : { file: null, source: null, found: false };
}
function kimiMember() {
  try { return require('./members').all().find(m => m.state !== 'removed' && m.adapter === 'kimi-cli') || {}; }
  catch { return {}; }
}
// Найти и ЗАПОМНИТЬ путь (старт/готовность серверов моста; начало установки). Включает (г) живой процесс, сохраняет только
// принятый кандидат с существующей home и только если он добыт заново (не из уже сохранённого). Ошибок не бросает.
// БЕЗОПАСНОСТЬ: живая таблица процессов сканируется только для БОЕВОГО моста (каталог состояния НЕ временный) либо когда
// таблица передана явно (deps.processes в тестах). Иначе прогон deploy-тестов на машине с запущенным Kimi тронул бы живые
// настройки, увидев реальный путь. В бою установка идёт при закрытых приложениях — живого Kimi нет, берётся сохранённое/env.
function capture(state = require('./paths').stateDir, member, deps = {}) {
  try {
    const allowLive = !!deps.processes || !underTestTmp(state);
    const r = resolve(member || kimiMember(), state, { includeLive: allowLive, processes: deps.processes });
    if (r.found && r.source !== 'saved' && readSaved(state) !== r.file) save(state, r.file, r.source);
    return r;
  } catch { return { file: null, source: null, found: false }; }
}
module.exports = { resolve, capture, save, readSaved, fromProcesses, homeFromConfig, stateFile, kimiMember };
