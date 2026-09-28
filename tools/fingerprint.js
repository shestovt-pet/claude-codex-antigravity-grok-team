'use strict';
// Печатает отпечаток будущего кандидата: node tools/fingerprint.js [папка клона]. Ничего не меняет в клоне.
const folder = require('path').resolve(process.argv[2] || process.cwd());
console.log('Отпечаток кандидата: ' + require('../common/fingerprint').fingerprint(folder));
