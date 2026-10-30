'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const context = new AsyncLocalStorage();
function scope(params = {}) {
  const args = params?.arguments || {};
  return {
    ...Object.fromEntries(['owner', 'work'].filter(k => typeof args?.[k] === 'string' && args[k].trim()).map(k => [k, args[k].trim()])),
    ...(typeof params?.name === 'string' && params.name.trim() ? { tool: params.name.trim() } : {}),
  };
}
module.exports = { context, scope };
