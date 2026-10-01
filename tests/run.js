'use strict';
const { spawn } = require('child_process'),
  fs = require('fs'),
  path = require('path');
process.env.MOST_NOTIFY = 'off';
// Уборка после установки не должна трогать поддельные корни прочих наборов (team-v10 Р5); team-v10.js проверяет её сам.
process.env.MOST_AFTER_DEPLOY = 'off';
process.env.MOST_CODEX_RULES = path.join(__dirname, 'missing-codex-rules.md');
process.env.MOST_AGY_RULES = path.join(__dirname, 'missing-agy-rules.md');
process.env.MOST_AGY_QUOTA_FILE = require('path').join(__dirname, 'missing-quota-fixture.json');
process.env.MOST_CODEX_CONFIG = require('path').join(__dirname, 'missing-codex-config.toml');
process.env.MOST_AGY_MCP_CONFIG = require('path').join(__dirname, 'missing-agy-config.json');
process.env.MOST_AGY_CONFIG = require('path').join(__dirname, 'missing-permissions.json');
// Журнал пишет сам прогон; имя по умолчанию — по папке клона изменения (team-v9 Р1).
const log = path.join(__dirname, process.env.MOST_TEST_OUTPUT || 'windows-test-output-' + path.basename(path.resolve(__dirname, '..')) + '.txt');
const temp = fs.mkdtempSync(path.join(__dirname, '.tmp-windows-'));
fs.writeFileSync(log, '');
let failed = false,
  passed = 0,
  failures = 0,
  skipped = 0;
function write(s) {
  process.stdout.write(s);
  fs.appendFileSync(log, s);
}
function finishLog() {
  // Вывод дочерних процессов приходит частями; очищаем только готовый журнал.
  fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, ''));
}
(async () => {
  const files = ['antigravity.js', 'part1.js', 'part2.js', 'trio-v2.js', 'trio-review.js', 'trio-v4.js', 'trio-v4-fix1.js', 'trio-v4-fix2.js', 'trio-v5.js', 'team-v6.js', 'team-v7.js', 'team-v8.js', 'team-v9.js', 'team-v10.js', 'team-v11.js', 'team-v12.js', 'team-v13.js', 'team-v14.js', 'team-v14-bridges.js'];
  const selected = process.argv.slice(2);
  if (selected.some(f => !files.includes(f))) throw Error('Неизвестный набор тестов.');
  for (const file of selected.length ? selected : files) {
    let text = '';
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      env: { ...process.env, MOST_TEST_KEEP: '1', TEMP: temp, TMP: temp },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (s) => {
      text += s;
      write(s);
    });
    child.stderr.on('data', write);
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) failed = true;
    const m = text.match(
      /Итого(?: дополнительно)?: (?:проверок )?пройдено (\d+), провалено (\d+)(?:, пропущено (\d+))?/,
    );
    if (m) {
      passed += Number(m[1]);
      failures += Number(m[2]);
      skipped += Number(m[3] || 0);
    } else failed = true;
  }
  write('\nВсего: успешно ' + passed + ', провалов ' + failures + ', пропущено ' + skipped + '.\n');
  finishLog();
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  write(String(e));
  finishLog();
  process.exitCode = 1;
});
