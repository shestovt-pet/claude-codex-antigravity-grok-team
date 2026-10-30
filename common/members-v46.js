'use strict';
// team-v46: миграция реестра для полной матрицы поручений. Чистые функции над снимком реестра
// (rev/phase/members): deploy строит целевой снимок и пишет его атомарно; откат возвращает прежний.
const CLAUDE_MASKS = ['claude/claude_send', 'claude/claude_result', 'claude/claude_status'];
const TEAM_ASK_MASKS = ['team/team_ask', 'team/team_ask_result'];

// Вперёд: Claude получает поручения (receives=true); лимита нет (счётчик расхода — в quota-line.js);
// маски claude/* и team/team_ask, team/team_ask_result у Antigravity.
function forward(roster) {
  const next = structuredClone(roster);
  const claude = next.members?.find(m => m.id === 'claude');
  const agy = next.members?.find(m => m.id === 'antigravity');
  if (claude) {
    claude.roles = { ...claude.roles, receives: true };
    claude.adapter_params = { ...(claude.adapter_params || {}) };
    // team-v46 п.3: лимит limit_5h убран («Без предела»).
    delete claude.adapter_params.limit_5h;
  }
  if (agy) agy.mcp_allow = [...new Set([...(agy.mcp_allow || []), ...CLAUDE_MASKS, ...TEAM_ASK_MASKS])];
  return next;
}

// Откат: снимает receives у Claude и маски claude/* и team/team_ask* у Antigravity (подключение сервера claude удаляется конфигами).
function rollback(roster, original) {
  if (original) return structuredClone(original);
  const next = structuredClone(roster);
  const claude = next.members?.find(m => m.id === 'claude');
  const agy = next.members?.find(m => m.id === 'antigravity');
  if (claude) claude.roles = { ...claude.roles, receives: false };
  if (agy) agy.mcp_allow = (agy.mcp_allow || []).filter(x => !/^claude\//.test(x) && !TEAM_ASK_MASKS.includes(x));
  return next;
}

// Применяет миграцию к живому реестру под замком и возвращает true, если редакция изменилась.
// Запись — только через members-store (журнал и last-good); в снимок журнала не попадают служебные поля чтения.
function apply(stateDir, direction) {
  const store = require('./members-store').create(stateDir);
  // Чтение без инициализации: откат в чистом реестре (или без реестра) не должен создавать members.json.
  const current = store.read({ initialize: false });
  // Журнал members-store сохраняет исходный снимок атомарно с миграцией, включая limit_5h.
  const previous = direction === 'rollback' ? store.history().slice().reverse().find(e => e.action === 'team-v46') : null;
  if (direction === 'rollback' && previous && previous.reason?.startsWith('Откат')) return false;
  const original = previous?.before;
  if (direction === 'rollback' && !original) return false;
  const wanted = direction === 'rollback' ? rollback(current, original) : forward(current);
  if (JSON.stringify(wanted.members) === JSON.stringify(current.members)) return false;
  store.update(current.rev, next => { next.members = wanted.members; },
    { action: 'team-v46', who: 'deploy', reason: direction === 'rollback' ? 'Откат team-v46: Claude не получает поручения.' : 'Установка team-v46: полная матрица поручений.' },
    { phase: wanted.phase });
  return true;
}

function restore(stateDir, snapshot) {
  const store = require('./members-store').create(stateDir), current = store.read({ initialize: false });
  store.update(current.rev, next => { next.members = structuredClone(snapshot.members); },
    { action: 'team-v46-restore', who: 'deploy', reason: 'Восстановление исходного снимка после отказа установки.' },
    { phase: snapshot.phase });
}
module.exports = { forward, rollback, apply, restore, CLAUDE_MASKS, TEAM_ASK_MASKS };
