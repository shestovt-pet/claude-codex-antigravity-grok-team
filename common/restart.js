'use strict';
const fs = require('fs'), path = require('path'), { randomUUID } = require('crypto');
const quote = s => "'" + String(s).replace(/'/g, "''") + "'";
function script({ runId, log, release, state, result }) {
  return `
$ErrorActionPreference = 'Stop'
$started = Get-Date
$log = ${quote(log)}
$release = ${quote(release)}
$state = ${quote(state)}
function Complete($success, $reason) {
  Record ('итог ' + ${quote(runId)} + ' ' + $success)
  (@{runId=${quote(runId)};release=$release;startedAt=$started.ToUniversalTime().ToString('o');finishedAt=(Get-Date).ToUniversalTime().ToString('o');success=$success;reason=$reason} | ConvertTo-Json -Compress) | Out-File -LiteralPath ${quote(result || log + '.json')} -Encoding utf8
}
function Record($text) { $text | Out-File -LiteralPath $log -Append -Encoding utf8 }
function Tell($text) {
  Record $text
  $env:MOST_TOAST_DATA = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{title='Связка';text=$text} | ConvertTo-Json -Compress)))
  $notifyResult = 'передано системе'
  try { ${require('./notify').script} } catch { $notifyResult = 'ошибка уведомления Windows'; Record $notifyResult }
  try { (@{at=(Get-Date -Format o);title='Связка';text=$text;result=$notifyResult} | ConvertTo-Json -Compress) | Out-File -LiteralPath (Join-Path $state 'notify.log') -Append -Encoding utf8 } catch { Record 'Ошибка записи журнала уведомлений' }
}
Record ${quote('запущен ' + runId)}
try {
  Start-Sleep -Seconds 5
  $proc = Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
  $exe = if ($proc) { $proc.Path } else { '' }
  $app = (Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1).AppID
  if (-not $exe -and -not $app) { throw 'Не найден способ запуска Claude' }
  Get-Process -Name claude -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  Start-Sleep -Seconds 8
  Get-Process -Name claude -ErrorAction SilentlyContinue | Stop-Process -Force
  function Launch {
    if (($exe -like '*WindowsApps*' -and $app) -or (-not $exe -and $app)) { Start-Process explorer.exe -WindowStyle Hidden -ArgumentList ('shell:AppsFolder\\' + $app) }
    else { Start-Process -FilePath $exe -WindowStyle Hidden }
  }
  Launch
  Start-Sleep -Seconds 5
  if (-not (Get-Process -Name claude -ErrorAction SilentlyContinue)) { Launch }
  $deadline = (Get-Date).AddSeconds(300)
  do {
    $missing = @()
    foreach ($name in @('team', 'codex', 'antigravity', 'grok')) {
      try {
        $ready = Get-Content -LiteralPath (Join-Path $state ('ready\\' + $name + '.json')) -Raw -Encoding utf8 | ConvertFrom-Json
        if ([DateTime]::Parse($ready.startedAt).ToUniversalTime() -le $started.ToUniversalTime() -or $ready.release -ne $release -or -not (Get-Process -Id $ready.pid -ErrorAction SilentlyContinue)) { $missing += $name }
      } catch { $missing += $name }
    }
    if ($missing.Count -eq 0) { break }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  if ($missing.Count) { Complete $false ('Не готовы: ' + ($missing -join ', ')); Tell ('Перезапуск Claude: не готовы ' + ($missing -join ', ') + ' — истекло время ожидания') }
  else { Complete $true 'Все четыре сервера готовы'; Tell ${quote('Claude перезапущен, серверы ' + path.basename(release).slice(0, 8) + ' работают')} }
} catch { Complete $false $_.Exception.Message; Tell ('Перезапуск Claude: не готовы team, codex, antigravity, grok — ' + $_.Exception.Message) }
`;
}
// Политика выполнения по умолчанию (Restricted) запрещает -File без Bypass: без него сценарий молча не запускался (живая проверка 27.09.2026).
function launchCommand(file) {
  return 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + file + '"';
}
async function restart({ root, release, state, waitCompletion = false }, deps = {}) {
  state = path.join(root, 'state');
  const runId = randomUUID(), folder = path.join(root, 'live/restart'), file = path.join(folder, runId + '.ps1'), log = path.join(folder, runId + '.log');
  const result = log + '.json';
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(file, '\uFEFF' + script({runId, log, release, state, result}), 'utf8');
  const launch = deps.launch || (async file => new Promise((resolve, reject) => {
    const command = launchCommand(file);
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=" + quote(command) + "}; if ($r.ReturnValue -ne 0) { exit 1 }"], { windowsHide: true, timeout: 10000 }, e => e ? reject(Error('Не удалось запустить сценарий перезапуска.')) : resolve());
  }));
  const deadline = Date.now() + Math.min(15000, deps.waitMs ?? 15000);
  await launch(file, {runId, log, result});
  if (waitCompletion) {
    try { return await waitForCompletion({runId, log, result, release, state}, deps); }
    catch (e) { e.restartStarted = true; throw e; }
  }
  while (Date.now() < deadline) {
    try { if (fs.readFileSync(log, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).includes('запущен ' + runId)) return `Перезапуск Claude запланирован (${runId}): через ~5 с Claude закроется и откроется снова; итог — уведомлением Windows и в ${log}`; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error('Запуск сценария перезапуска не подтверждён: ' + log);
}
async function waitForCompletion(info, deps = {}) {
  const now = deps.now || Date.now, sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const deadline = now() + (deps.completionMs ?? 340000);
  while (now() < deadline) {
    if (fs.existsSync(info.result)) {
      let value;
      try { value = JSON.parse(fs.readFileSync(info.result, 'utf8').replace(/^\uFEFF/, '')); } catch { await sleep(250); continue; }
      if (value.runId !== info.runId || value.release !== info.release) throw Error('Чужой итог перезапуска.');
      if (value.success !== true) throw Error('Перезапуск не подтверждён: ' + value.reason);
      if (!fs.readFileSync(info.log, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).includes('итог ' + info.runId + ' True')) throw Error('Успешный журнал перезапуска не подтверждён.');
      const started = Date.parse(value.startedAt);
      if (!Number.isFinite(started) || !Number.isFinite(Date.parse(value.finishedAt)) || Date.parse(value.finishedAt) < started) throw Error('Неверное время итога перезапуска.');
      const ready = ['team', 'codex', 'antigravity', 'grok'].map(name => {
        const r = JSON.parse(fs.readFileSync(path.join(info.state, 'ready', name + '.json'), 'utf8'));
        if (r.release !== info.release || !(Date.parse(r.startedAt) > started) || (deps.alive || require('./deploy-ops').alive)(r.pid) !== true)
          throw Error('Готовность нового сервера не подтверждена: ' + name);
        return { name, ...r };
      });
      return { message: 'Claude перезапущен; все четыре сервера нового релиза готовы.', log: info.log, result: info.result, ...value, ready };
    }
    await sleep(250);
  }
  throw Error('Истекло время ожидания итога перезапуска: ' + info.log);
}
module.exports = { restart, script, launchCommand, waitForCompletion };
