'use strict';
// team-v59 (часть 3 п.1): отвязанный досчёт строки квот. Запускается краткой сводкой через detached spawn и пишет
// <state>/team/quota-cache.json. Внешние источники (Antigravity app, codex app-server) кратковременно держат событийный
// цикл — поэтому их сбор вынесен в ОТДЕЛЬНЫЙ процесс: ни ответ team_status, ни следующие инструменты сервера не ждут.
const path = require('path');
const state = process.env.MOST_QUOTA_REFRESH_STATE || path.join(require('./paths').stateDir, 'team');
const opts = { state, advice: false };
if (process.env.MOST_QUOTA_REFRESH_BINARY) opts.binary = process.env.MOST_QUOTA_REFRESH_BINARY;
if (process.env.MOST_QUOTA_REFRESH_AGYMODEL) opts.agyModel = process.env.MOST_QUOTA_REFRESH_AGYMODEL;
require('./quota-line').refreshLineCache(opts).then(() => process.exit(0), () => process.exit(1));
// Страховка: не висеть дольше разумного.
setTimeout(() => process.exit(1), Number(process.env.MOST_QUOTA_REFRESH_MAX_MS || 20000)).unref();
