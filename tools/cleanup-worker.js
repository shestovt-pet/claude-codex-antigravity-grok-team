'use strict';
// team-v58 (task5 пп.2–3): отдельный процесс уборки после установки. Параметры приходят в окружении (не в командной строке):
// MOST_CLEANUP_ROOT, MOST_CLEANUP_ID, MOST_CLEANUP_LIMIT_MS; MOST_REPO_ROOT/MOST_STATE_DIR задаёт запускающий сервер team.
(async () => {
  const root = process.env.MOST_CLEANUP_ROOT, id = process.env.MOST_CLEANUP_ID;
  const limitMs = Number(process.env.MOST_CLEANUP_LIMIT_MS || 1800000);
  if (!root || !id) { process.exit(1); return; }
  try { await require('../common/cleanup-run').run({ root, id, limitMs, owner: 'после установки ' + id }); }
  catch (e) { process.exitCode = 1; }
  process.exit(process.exitCode || 0);
})();
