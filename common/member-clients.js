'use strict';
// Форматы приложений, не перечень участников. Новый участник известного адаптера
// может задать client_config/client_rules в adapter_params.
const path = require('path'), os = require('os');
const formats = {
  'codex-cli': { kind: 'codex', config: '.codex/config.toml', rules: '.codex/AGENTS.md', configEnv: 'MOST_CODEX_CONFIG', rulesEnv: 'MOST_CODEX_RULES', section: 'codex-section.md' },
  'agy-cli': { kind: 'agy', config: '.gemini/config/mcp_config.json', rules: '.gemini/config/AGENTS.md', configEnv: 'MOST_AGY_MCP_CONFIG', rulesEnv: 'MOST_AGY_RULES', section: 'antigravity-section.md' },
  'dsh-headless': { kind: 'dsh', config: '.dsh/profiles/desktop/cordis.patch.yml', rules: '.dsh/AGENTS.md', configEnv: 'MOST_DSH_CONFIG', rulesEnv: 'MOST_DSH_RULES', section: 'member-section.md' },
};
function all(roster = require('./members').all()) {
  const home = process.env.USERPROFILE || os.homedir();
  const seen = new Set();
  const configs = new Set(), rules = new Set();
  return roster.filter(m => m.state !== 'removed').flatMap(m => {
    const f = formats[m.adapter]; if (!f) return [];
    // Несколько участников на адаптере не перезаписывают один профиль приложения.
    const config = m.adapter_params.client_config || (!seen.has(m.adapter) ? process.env[f.configEnv] || path.join(home, f.config) : null);
    if (!m.adapter_params.client_config && config) seen.add(m.adapter);
    if (!config) return [];
    const rulesFile = m.adapter_params.client_rules || (!m.adapter_params.client_config ? process.env[f.rulesEnv] || path.join(home, f.rules) : null);
    const key = file => path.resolve(file).toLowerCase();
    if (configs.has(key(config)) || rulesFile && rules.has(key(rulesFile))) throw Error('Клиенты реестра используют один файл настроек или правил: ' + config);
    configs.add(key(config)); if (rulesFile) rules.add(key(rulesFile));
    return [{ ...f, id: m.id, title: m.title, file: config, rulesFile }];
  });
}
module.exports = { all, formats };
