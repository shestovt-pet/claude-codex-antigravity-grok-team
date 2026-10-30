'use strict';
const fs = require('fs'), path = require('path');
const runner = require('./runner-support');
async function main(args = process.argv.slice(2)) {
  const root = path.resolve(__dirname, '..');
  const log = runner.logPath(__dirname, process.env.MOST_TEST_OUTPUT || 'windows-test-output-' + path.basename(root) + '.txt');
  runner.mainBranch(root);
  const files = ['consilium-workflow.js', 'attribution.js', 'antigravity.js', 'part1.js', 'part2.js', 'trio-v2.js', 'trio-review.js', 'trio-v4.js', 'trio-v4-fix1.js', 'trio-v4-fix2.js', 'trio-v5.js', 'team-v6.js', 'team-v7.js', 'team-v8.js', 'team-v9.js', 'team-v10.js', 'team-v11.js', 'team-v12.js', 'team-v13.js', 'team-v14.js', 'team-v14-bridges.js'];
  files.push('team-v16-sources.js', 'team-v16-gate.js', 'team-v16-workflow.js', 'team-v16-status.js', 'team-v16-roles.js');
  files.push('team-v30.js', 'team-v30-notion.js', 'team-v30-review.js', 'team-v30-google.js', 'access-deepseek.js', 'team-v31.js', 'team-v36.js', 'team-v37.js', 'team-v42.js', 'team-v43.js', 'team-v44.js', 'team-v45.js', 'team-v46.js', 'team-v47.js');
  files.push('team-v17-rules.js', 'team-v23.js', 'team-v24.js', 'team-v25.js', 'team-v27.js', 'team-v28.js', 'team-v29.js');
  files.push('team-v18-word.js', 'team-v18-change.js');
  files.push('team-v19-claude-word.js', 'team-v21-paths.js', 'team-v22-full-access.js');
  if (args.some(f => !files.includes(f))) throw Error('Неизвестный набор тестов.');
  const temp = fs.mkdtempSync(path.join(__dirname, '.tmp-windows-'));
  fs.writeFileSync(log, '');
  const write = s => { process.stdout.write(s); fs.appendFileSync(log, s); };
  try {
    const result = await runner.runSuites(args.length ? args : files, { dir: __dirname, env: runner.environment(process.env, temp), write });
    write('\nВсего: успешно ' + result.passed + ', провалов ' + result.failures + ', пропущено ' + result.skipped + ', аварийных наборов ' + result.failedSuites + '.\n');
    return result.code;
  } finally { fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')); }
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
