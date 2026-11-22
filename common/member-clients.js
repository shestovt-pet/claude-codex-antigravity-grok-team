'use strict';
// Форматы приложений, не перечень участников. Новый участник известного адаптера
// может задать client_config/client_rules в adapter_params.
const path = require('path'), os = require('os');
const formats = {
  'codex-cli': { kind: 'codex', config: '.codex/config.toml', rules: '.codex/AGENTS.md', configEnv: 'MOST_CODEX_CONFIG', rulesEnv: 'MOST_CODEX_RULES', section: 'codex-section.md' },
  'agy-cli': { kind: 'agy', config: '.gemini/config/mcp_config.json', rules: '.gemini/config/AGENTS.md', configEnv: 'MOST_AGY_MCP_CONFIG', rulesEnv: 'MOST_AGY_RULES', section: 'antigravity-section.md' },
  'dsh-headless': { kind: 'dsh', config: '.dsh/profiles/desktop/cordis.patch.yml', rules: '.dsh/AGENTS.md', configEnv: 'MOST_DSH_CONFIG', rulesEnv: 'MOST_DSH_RULES', section: 'member-section.md' },
  // Чат настольного Kimi: ядро kimi-code читает user-mcp.json из домашней папки kimi-code (research v58-kimi-chat). Путь по
  // умолчанию по реестру НЕ выводится (adapter_params пусты), поэтому зашитого пути под home нет: файл настроек берётся из
  // adapter_params.client_config участника, иначе из MOST_KIMI_MCP_CONFIG; если не задан — клиент не подключается (предупреждение
  // в итоге установки, см. client-configs.warnings), установка не падает. Правил (AGENTS.md) у Kimi нет: подтверждённого места
  // пользовательских правил ядра исследование не нашло (см. report6), поэтому rules не задаём.
  'kimi-cli': { kind: 'kimi', configEnv: 'MOST_KIMI_MCP_CONFIG', section: 'member-section.md' },
};
function all(roster = require('./members').all()) {
  const home = process.env.USERPROFILE || os.homedir();
  const seen = new Set();
  const configs = new Set(), rules = new Set();
  return roster.filter(m => m.state !== 'removed').flatMap(m => {
    const f = formats[m.adapter]; if (!f) return [];
    // Несколько участников на адаптере не перезаписывают один профиль приложения.
    // Форматы без пути под домашней папкой (kimi): путь настроек чата Kimi находится сам — приоритет (а) client_config,
    // (б) MOST_KIMI_MCP_CONFIG, (в) сохранённое в state\kimi-client.json (его пишет kimi-client.capture при старте серверов
    // и в начале установки, когда Kimi виден в таблице процессов). Живой процесс (г) здесь НЕ сканируется (это горячий путь
    // чтения состава) — он учитывается только в capture. Без принятого пути клиент не подключается (config=null → return []).
    const config = f.kind === 'kimi'
      ? require('./kimi-client').resolve(m).file
      : m.adapter_params.client_config || (!seen.has(m.adapter) ? process.env[f.configEnv] || (f.config ? path.join(home, f.config) : null) : null);
    if (f.kind !== 'kimi' && !m.adapter_params.client_config && config) seen.add(m.adapter);
    if (!config) return [];
    const rulesFile = f.rules ? (m.adapter_params.client_rules || (!m.adapter_params.client_config ? process.env[f.rulesEnv] || path.join(home, f.rules) : null)) : null;
    const key = file => path.resolve(file).toLowerCase();
    if (configs.has(key(config)) || rulesFile && rules.has(key(rulesFile))) throw Error('Клиенты реестра используют один файл настроек или правил: ' + config);
    configs.add(key(config)); if (rulesFile) rules.add(key(rulesFile));
    return [{ ...f, id: m.id, title: m.title, file: config, rulesFile }];
  });
}
module.exports = { all, formats };
