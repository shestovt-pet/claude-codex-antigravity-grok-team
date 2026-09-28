'use strict';
// Отдельная живая проба. Импорт обработчика проверки не запускает agy.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const agy = require('../common/agy-input');
const EXPECTED = 'ПРОБА_TEAM_V6_OK';
function validate(record) {
  const parsed = agy.parseResults(record.stdout || ''), result = parsed.obj, reasons = [];
  if (record.error || record.status !== 0 || record.signal) reasons.push('Процесс не завершился успешно.');
  if (!result) reasons.push('Нет завершающего события результата.');
  else {
    if (result.status !== 'SUCCESS') reasons.push('Итоговый статус не подтверждает успех.');
    if (typeof result.response !== 'string' || result.response.trim() !== EXPECTED) reasons.push('Не получен точный ожидаемый непустой ответ.');
    if (result.error) reasons.push('В итоговом событии есть ошибка.');
  }
  if (agy.permission({ stderr: record.stderr, agyError: result?.error, diagnostics: parsed.diagnostics, denied: parsed.denied })) reasons.push('Диагностика содержит отказ разрешения.');
  return { ok: reasons.length === 0, reasons, streamParse: parsed };
}
function main() {
  const executable = process.env.AGY_PATH || 'C:\\Users\\user\\AppData\\Local\\agy\\bin\\agy.exe';
  const folder = fs.mkdtempSync(path.join(__dirname, '.tmp-v6-live-'));
  const material = 'Проверочный материал. '.repeat(2000) + '\nОтветь только: ' + EXPECTED + '. Файлы не читай, не меняй, инструменты не вызывай.';
  const input = agy.userEvent(material);
  const records = [['--version'], ['--help'], ['--input-format', 'stream-json', '--output-format', 'stream-json']].map(args => {
    const r = spawnSync(executable, args, { cwd: folder, input: args.includes('--input-format') ? input : undefined, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    return { args, status: r.status, signal: r.signal, error: r.error ? { code: r.error.code, message: r.error.message } : null, stdout: r.stdout, stderr: r.stderr };
  });
  const validation = validate(records[2]);
  const report = { at: new Date().toISOString(), platform: process.platform, executable, folder, materialBytes: Buffer.byteLength(material), inputBytes: Buffer.byteLength(input), records, validation };
  fs.writeFileSync(path.join(__dirname, 'team-v6-agy-probe.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = !validation.ok || records.some(r => r.error || r.status !== 0 || r.signal) ? 1 : 0;
  return report;
}
if (require.main === module) main();
module.exports = { validate, EXPECTED, main };
