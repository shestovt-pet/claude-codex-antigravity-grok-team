'use strict';
const fs = require('fs'), path = require('path'), { randomUUID } = require('crypto');
const { samePath } = require('./paths');
const { realOrGiven } = require('./path-compat');
const quote = s => "'" + String(s).replace(/'/g, "''") + "'";
// close: false — только запуск Claude Desktop без закрытия (team-v19 К5: Claude закрыт, слово записал гость).
function script({ runId, id = runId, log, release, state, result, close = true }) {
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
${close ? closingScript({ state, runId, id }) : ''}  function Launch {
    if (($exe -like '*WindowsApps*' -and $app) -or (-not $exe -and $app)) { Start-Process explorer.exe -WindowStyle Hidden -ArgumentList ('shell:AppsFolder\\' + $app) }
    else { Start-Process -FilePath $exe -WindowStyle Hidden }
  }
  Launch
  Start-Sleep -Seconds 5
  if (-not (Get-Process -Name claude -ErrorAction SilentlyContinue)) { Launch }
  $deadline = (Get-Date).AddSeconds(300)
  do {
    $missing = @()
    foreach ($name in @(${require('./members').servers.map(quote).join(', ')})) {
      try {
        $ready = Get-Content -LiteralPath (Join-Path $state ('ready\\' + $name + '.json')) -Raw -Encoding utf8 | ConvertFrom-Json
        if ([DateTime]::Parse($ready.startedAt).ToUniversalTime() -le $started.ToUniversalTime() -or $ready.release -ne $release -or -not (Get-Process -Id $ready.pid -ErrorAction SilentlyContinue)) { $missing += $name }
      } catch { $missing += $name }
    }
    if ($missing.Count -eq 0) { break }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  if ($missing.Count) { Complete $false ('Не готовы: ' + ($missing -join ', ')); Tell ('Перезапуск Claude: не готовы ' + ($missing -join ', ') + ' — истекло время ожидания') }
  else { Complete $true 'Все три сервера готовы'; Tell ${quote('Claude перезапущен, серверы ' + path.basename(release).slice(0, 8) + ' работают')} }
} catch { Complete $false $_.Exception.Message; Tell ('Перезапуск Claude: не готовы team, codex, antigravity — ' + $_.Exception.Message) }
`;
}
function closingScript({ state, runId, id = runId }) {
  return `
  function Publish-Claim($file, $value) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
    $temp = $file + '.' + $PID + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
      [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Depth 12 -Compress), (New-Object Text.UTF8Encoding($false)))
      [IO.File]::Move($temp, $file)
      return $true
    } catch { return $false }
    finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
  }
  function Target-Process($target) {
    try { $p = Get-Process -Id $target.pid -ErrorAction Stop }
    catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { return $null }; throw }
    if (-not $p) { return $null }
    $p.Refresh()
    if ($p.HasExited) { return $null }
    if ($p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss') -ne ([DateTime]::Parse($target.startedAt)).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss')) { return $null }
    return $p
  }
  $me = Get-Process -Id $PID
  try { $targets = @(Get-Process -Name claude -ErrorAction Stop | ForEach-Object { @{pid=$_.Id;startedAt=$_.StartTime.ToUniversalTime().ToString('o')} }) }
  catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenName*') { $targets = @() } else { throw } }
  $claim = @{decision='закрываю';id=${quote(id)};runId=${quote(runId)};pid=$PID;startedAt=$me.StartTime.ToUniversalTime().ToString('o');publishedAt=(Get-Date).ToUniversalTime().ToString('o');targets=$targets}
  if (-not (Publish-Claim ${quote(require('./restart-hold').claimFile(state, runId))} $claim)) { throw 'Решение перезапуска уже принято или не опубликовано; Claude не закрыт' }
  foreach ($target in $targets) { $p = Target-Process $target; if ($p) { $p.CloseMainWindow() | Out-Null } }
  Start-Sleep -Seconds 8
  foreach ($target in $targets) { $p = Target-Process $target; if ($p) { $p | Stop-Process -Force -ErrorAction Stop } }
  $closeDeadline = (Get-Date).AddSeconds(30)
  do {
    $remaining = @($targets | Where-Object { Target-Process $_ })
    if (-not $remaining.Count) { break }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $closeDeadline)
  if ($remaining.Count) { throw 'Закрытие процессов Claude из targets не подтверждено' }
  if (-not (Publish-Claim ${quote(require('./restart-hold').claimFile(state, runId, true))} @{closedAt=(Get-Date).ToUniversalTime().ToString('o')})) { throw 'Не опубликована отметка закрытия Claude' }
`;
}
// Политика выполнения по умолчанию (Restricted) запрещает -File без Bypass: без него сценарий молча не запускался (живая проверка 27.09.2026).
function launchCommand(file) {
  return 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + file + '"';
}
// Окружение без переменных связки: окружение гостя (MOST_CLIENT=codex и прочее) в Claude не попадает (team-v19 К5).
function cleanEnv(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !/^MOST_/i.test(k)));
}
async function restart({ root, release, state, id, waitCompletion = false, close = true }, deps = {}) {
  root = realOrGiven(root); release = realOrGiven(release); state ||= path.join(root, 'state');
  const runId = randomUUID(), folder = path.join(root, 'live/restart'), file = path.join(folder, runId + '.ps1'), log = path.join(folder, runId + '.log');
  const result = log + '.json', env = cleanEnv(), hold = require('./restart-hold');
  let pause, launchConfirmed = false;
  const confirmLaunch = () => {
    try {
      if (fs.readFileSync(log).toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).includes('запущен ' + runId)) launchConfirmed = true;
    } catch {}
    return launchConfirmed;
  };
  const planned = () => (close ? 'Перезапуск' : 'Запуск') + ' Claude запланирован (' + runId + '): итог — уведомлением Windows и в ' + log;
  if (close) {
    pause = await hold.begin(state, { runId, id: id || runId }, deps.hold || {});
    try {
      const live = await (deps.running || require('./live-jobs').running)({ stateDir: state });
      if (live.length) throw Error('идут поручения ' + require('./live-jobs').describe(live));
    } catch (e) {
      const cancelled = await hold.abort(state, pause, deps.hold || {});
      throw Object.assign(Error('Настройки переключены, Claude не перезапущен: ' + e.message + '. Повторите deploy с перезапуском, когда поручения закончатся.'), { restartNotStarted: cancelled, restartStarted: !cancelled });
    }
  }
  const launch = deps.launch || (async file => new Promise((resolve, reject) => {
    const command = launchCommand(file);
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      "$ErrorActionPreference='Stop'; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=" + quote(command) + "}; Write-Output ('CREATE_RETURN=' + $r.ReturnValue)"],
    { windowsHide: true, timeout: 10000, env }, (e, stdout) => {
      const code = String(stdout || '').match(/CREATE_RETURN=(\d+)/);
      if (code && Number(code[1]) !== 0) reject(Object.assign(Error('Отказ создания сценария перезапуска: ' + code[1]), { creationRefused: true }));
      else if (e || !code) reject(Error('Запуск сценария перезапуска не подтверждён.'));
      else resolve();
    });
  }));
  const fail = async e => {
    if (!pause) throw e;
    const cancelled = await hold.abort(state, pause, deps.hold || {}).catch(() => false);
    confirmLaunch();
    e.restartNotStarted = cancelled; e.restartStarted = !cancelled;
    e.message = (cancelled ? (launchConfirmed ? 'Перезапуск не завершён: сценарий запущен, закрытие отменено. ' : 'Перезапуск не запущен: запуск сценария не подтверждён, отменён. ') : 'Перезапуск не подтверждён; пауза сохранена. ') + e.message;
    throw e;
  };
  try {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(file, Buffer.from('\uFEFF' + script({ runId, id: id || runId, log, release, state, result, close })));
    try { await launch(file, { runId, id: id || runId, log, result, env, close, state, release }); }
    catch (e) {
      if (!pause || e.creationRefused) throw e;
      const cancelled = await hold.abort(state, pause, deps.hold || {});
      if (cancelled) throw e;
      const d = hold.decision(state, pause);
      if (d.error || d.value?.decision !== 'закрываю') throw e;
      // Отметка доказывает запуск, даже если ответ Create потерялся.
      return waitCompletion ? await waitForCompletion({ runId, log, result, release, state }, deps) : planned();
    }
    if (waitCompletion) {
      confirmLaunch();
      return await waitForCompletion({ runId, log, result, release, state }, deps);
    }
    const deadline = Date.now() + Math.min(15000, deps.waitMs ?? 15000);
    while (Date.now() < deadline) {
      if (confirmLaunch()) return planned();
      await new Promise(r => setTimeout(r, 100));
    }
    if (confirmLaunch()) return planned();
    throw Error('Запуск сценария перезапуска не подтверждён: ' + log);
  } catch (e) { return fail(e); }
}
async function waitForCompletion(info, deps = {}) {
  const now = deps.now || Date.now, sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const deadline = now() + (deps.completionMs ?? 340000);
  while (now() < deadline) {
    if (fs.existsSync(info.result)) {
      let value;
      try { value = JSON.parse(fs.readFileSync(info.result, 'utf8').replace(/^\uFEFF/, '')); } catch { await sleep(250); continue; }
      if (value.runId !== info.runId || !samePath(value.release, info.release)) throw Error('Чужой итог перезапуска.');
      if (value.success !== true) throw Error('Перезапуск не подтверждён: ' + value.reason);
      if (!fs.readFileSync(info.log, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).includes('итог ' + info.runId + ' True')) throw Error('Успешный журнал перезапуска не подтверждён.');
      const started = Date.parse(value.startedAt);
      if (!Number.isFinite(started) || !Number.isFinite(Date.parse(value.finishedAt)) || Date.parse(value.finishedAt) < started) throw Error('Неверное время итога перезапуска.');
      const ready = require('./members').servers.map(name => {
        const r = JSON.parse(fs.readFileSync(path.join(info.state, 'ready', name + '.json'), 'utf8'));
        if (!samePath(r.release, info.release) || !(Date.parse(r.startedAt) > started) || (deps.alive || require('./deploy-ops').alive)(r.pid) !== true)
          throw Error('Готовность нового сервера не подтверждена: ' + name);
        return { name, ...r };
      });
      return { message: 'Claude перезапущен; все три сервера нового релиза готовы.', log: info.log, result: info.result, ...value, ready };
    }
    await sleep(250);
  }
  throw Error('Истекло время ожидания итога перезапуска: ' + info.log);
}
module.exports = { restart, script, launchCommand, waitForCompletion, cleanEnv, closingScript };
