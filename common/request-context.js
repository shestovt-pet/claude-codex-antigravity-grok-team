'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const context = new AsyncLocalStorage();
function scope(args = {}) {
  return Object.fromEntries(['owner', 'work'].filter(k => typeof args?.[k] === 'string' && args[k].trim()).map(k => [k, args[k].trim()]));
}
module.exports = { context, scope };
