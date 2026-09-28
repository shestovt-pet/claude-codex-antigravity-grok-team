'use strict';
// team-v13: хвосты team-v12. Подпись Grok (Р1) проверяется в tests/trio-v4.js, отпечаток (Р2) — в tests/team-v12.js;
// здесь — порядок публикации (Р3–Р4), уроки и версия (Р5).
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [], test = (label, fn) => tests.push({ label, fn });

test('Р1–Р2: проверки подписи и отпечатка стоят в своих наборах', () => {
  assert.match(read('common/grok.js'), /\/\^контроль \(\[0-9a-f\]\{64\}\)\$\/iu/);
  assert.match(read('tests/trio-v4.js'), /«Контроль» и «контроль» с верным HMAC приняты/);
  assert.match(read('tests/team-v12.js'), /только GIT_OBJECT_DIRECTORY/);
  assert.match(read('tests/team-v12.js'), /только alternates/);
});
test('Р3–Р5: порядок публикации, уроки, версия', () => {
  const p = read('docs/publish.md').replace(/\s+/g, ' ');
  assert.match(p, /credential\.helper= -c "credential\.helper=!gh auth git-credential" push origin main/);
  assert.match(p, /credential\.helper= -c 'credential\.helper=!gh auth git-credential' push origin main/, 'строка для PowerShell');
  assert.match(p, /--description "…"` — БЕЗ `--push`/, 'gh repo create без --push (Antigravity muku81vm)');
  assert.match(p, /Test-Path/);
  assert(!/git config --global|gh auth setup-git/.test(p), 'глобальный git config не меняется');
  assert.match(p, /окно входа дольше минуты/);
  for (const re of [/claude_desktop_config\.json` = `\{"mcpServers":\{"other":\{"command":"keep"\}\}\}`/, /\.codex\\config\.toml` = строка `# мой текст`/,
/\.gemini\\config\\config\.json` = `\{\}`/,
    /подключены Claude, Codex и Antigravity/, /раздел связки актуален/, /6016aa2d/, /\{"mcpServers":\{"mine":\{"command":"keep"\}\}\}/,
    /Get-ChildItem Env:MOST_\*/, /без этого префикса/, /\.codex\\AGENTS\.md/, /\.gemini\\config\\AGENTS\.md/]) assert.match(p, re);
  // Codex 0f710966, Grok b7afe01d: п. 4 ставит MOST_AFTER_DEPLOY, п. 5 требует пустого MOST_* — поэтому п. 5 убирает ВСЕ MOST_*.
  assert(p.includes('Get-ChildItem Env:MOST_* | ForEach-Object { Remove-Item "Env:$($_.Name)" }'), 'убираются все MOST_*');
  const i4 = p.indexOf("$env:MOST_AFTER_DEPLOY='off'"), iClear = p.indexOf('Get-ChildItem Env:MOST_* | ForEach-Object'), iCheck = p.indexOf('проверка `Get-ChildItem Env:MOST_*`');
  assert(i4 >= 0 && i4 < iClear && iClear < iCheck, 'порядок: п. 4 ставит, п. 5 сначала убирает всё, потом проверяет');
  // Codex c4b6bc98: все переопределения путей названы (их убирает общая очистка).
  for (const v of ['MOST_CLAUDE_CONFIGS', 'MOST_CODEX_CONFIG', 'MOST_AGY_MCP_CONFIG', 'MOST_AGY_CONFIG', 'MOST_CODEX_RULES', 'MOST_AGY_RULES', 'MOST_REPO_ROOT', 'MOST_STATE_DIR'])
    assert(p.includes('Env:' + v), v);
  for (const [file, re] of [['common/deploy.js', /MOST_CLAUDE_CONFIGS/], ['common/client-configs.js', /MOST_CODEX_CONFIG[\s\S]*MOST_AGY_MCP_CONFIG[\s\S]*MOST_AGY_CONFIG/], ['common/client-rules.js', /MOST_CODEX_RULES[\s\S]*MOST_AGY_RULES/]])
    assert.match(read(file), re, 'список переменных в publish.md совпадает с кодом: ' + file);
  const l = read('lessons.md');
  assert.match(l, /## 58\. Верный ответ Grok отвергнут из-за регистра слова/);
  assert.match(read('tests/run.js'), /'team-v13\.js'/);
  assert.equal(require('../package.json').version, '0.5.8');
});

(async () => {
  console.log('team-v13: ' + process.platform + ' ' + process.version);
  let passed = 0, failed = 0;
  for (const t of tests) { try { await t.fn(); passed++; console.log('OK ' + t.label); } catch (e) { failed++; console.log('ПРОВАЛ ' + t.label + '\n' + e.stack); } }
  console.log('Итого: пройдено ' + passed + ', провалено ' + failed + ', пропущено 0'); process.exitCode = failed ? 1 : 0;
})();
