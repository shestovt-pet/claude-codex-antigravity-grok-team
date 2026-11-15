'use strict';
// team-v48 Г2b-2: фальшивый claude-исполнитель (настоящий процесс) для адаптерных тестов «нет срока».
// Сервер claude запускает бинарь без оболочки и с фиксированными флагами (claudeArgs.buildArgs),
// поэтому в тесте cp.spawn перенаправлен на `node fake-claude.js` (подмена бинаря, как CODEX_PATH у codex).
// Задача приходит в stdin: HANG — зависает до taskkill/отмены; иначе печатает строку result и выходит.
let buf = '';
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  if (buf.includes('HANG')) { setInterval(() => {}, 1000); return; }
  process.stdout.write(JSON.stringify({ type: 'result', result: 'ПРИНЯТО' }) + '\n');
});
