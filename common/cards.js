'use strict';
const fs = require('fs');

// Частичный JSON тоже может быть следствием одновременной записи карточки.
function readCard(file) {
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      const retryable = ['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || error instanceof SyntaxError;
      if (!retryable || attempt >= 8) {
        logFailure(error);
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

// Не выводим message/stack: там могут оказаться тексты поручения и пути.
function logFailure(error) {
  const allowed = ['EBUSY', 'EPERM', 'EACCES', 'ENOENT', 'EIO'];
  const code = allowed.includes(error?.code) ? error.code : error instanceof SyntaxError ? 'JSON' : 'ERROR';
  console.error('Codex: сбой операции (' + code + ').');
}

function guarded(fn) {
  return (...args) => {
    try {
      return Promise.resolve(fn(...args)).catch(logFailure);
    } catch (error) {
      logFailure(error);
    }
  };
}

module.exports = { readCard, logFailure, guarded };
