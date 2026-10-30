'use strict';
// Только первая инициализация. Действующие читатели используют members.js.
module.exports = () => ({ rev: 0, phase: 'A', members: [
  { id: 'claude', family: 'anthropic', title: 'Claude', specialization: 'дирижёр, веб-поиск, источники и термины', external: false,
    adapter: 'claude-print', adapter_params: {}, roles: { conductor: true, fallback_conductor: false, voter: false, writer: true, literary: false, receives: false, sends: true }, state: 'active', pause: null },
  { id: 'codex', family: 'openai', title: 'Codex', specialization: 'критика логики, код и автотесты', external: true,
    adapter: 'codex-cli', adapter_params: {}, roles: { conductor: false, fallback_conductor: true, voter: true, writer: true, literary: false, receives: true, sends: true }, state: 'active', pause: null },
  { id: 'antigravity', family: 'google', title: 'Antigravity', specialization: 'литературный текст и содержательная правка', external: true,
    adapter: 'agy-cli', adapter_params: {}, mcp_allow: ['team/team_status', 'team/team_rules', 'team/team_work', 'codex/codex_status', 'codex/codex_result', 'codex/codex_send', 'notion/*'], roles: { conductor: false, fallback_conductor: true, voter: true, writer: false, literary: true, receives: true, sends: true }, state: 'active', pause: null },
  { id: 'deepseek', family: 'deepseek', title: 'DeepSeek', specialization: 'чтение материалов; исполнение и голос включаются следующими кандидатами', external: true,
    adapter: 'dsh-headless', adapter_params: { profile: 'headless', models: { read: 'deepseek-v4-flash', review: 'deepseek-v4-pro' }, auth: 'saved' }, roles: { conductor: false, fallback_conductor: false, voter: false, writer: false, literary: false, receives: false, sends: false }, state: 'active', pause: null },
] });
