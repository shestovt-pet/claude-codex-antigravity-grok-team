'use strict';
// team-v48 Г2b-2: фальшивый dsh для адаптерных тестов «нет срока» DeepSeek (настоящий процесс).
// Запускается через fake-dsh.cmd (dsh на Windows — .cmd, сервер зовёт его из оболочки).
// `--version` отвечает сразу и не читает stdin (иначе dshVersion ждал бы до таймаута).
// Иначе читает задачу из stdin: HANG — зависает как настоящий бегущий процесс до taskkill/отмены;
// в прочих случаях печатает NDJSON сессии и финала.
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('dsh 0.2.1-test\n'); process.exit(0); }
let buf = '';
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  if (buf.includes('HANG')) { setInterval(() => {}, 1000); return; }
  process.stdout.write('{"type":"session","sessionId":"s-g2b"}\n{"type":"final","text":"ОК"}\n');
});
