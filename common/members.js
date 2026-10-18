'use strict';
// Рабочий состав; Grok остаётся только в истории прежних выпусков.
const servers = Object.freeze(['team', 'codex', 'antigravity']);
const helpers = Object.freeze(servers.filter(n => n !== 'team'));
const seats = Object.freeze({ codex: 'openai', antigravity: 'google' });
const grokDisabled = 'Grok выключен из связки (13.10.2026)';
module.exports = { servers, helpers, seats, grokDisabled };
