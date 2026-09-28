
$ErrorActionPreference = 'Stop'
$started = Get-Date
$log = 'unused.log'
$release = 'release'
$state = 'state'
function Complete($success, $reason) {
  Record ('итог ' + 'static-check' + ' ' + $success)
  (@{runId='static-check';release=$release;startedAt=$started.ToUniversalTime().ToString('o');finishedAt=(Get-Date).ToUniversalTime().ToString('o');success=$success;reason=$reason} | ConvertTo-Json -Compress) | Out-File -LiteralPath 'unused.json' -Encoding utf8
}
function Record($text) { $text | Out-File -LiteralPath $log -Append -Encoding utf8 }
function Tell($text) {
  Record $text
  $env:MOST_TOAST_DATA = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{title='Связка';text=$text} | ConvertTo-Json -Compress)))
  $notifyResult = 'передано системе'
  try {
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MOST_TOAST_DATA)) | ConvertFrom-Json
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>')
$nodes = $xml.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($xml.CreateTextNode($data.title)) | Out-Null
$nodes.Item(1).AppendChild($xml.CreateTextNode($data.text)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
 } catch { $notifyResult = 'ошибка уведомления Windows'; Record $notifyResult }
  try { (@{at=(Get-Date -Format o);title='Связка';text=$text;result=$notifyResult} | ConvertTo-Json -Compress) | Out-File -LiteralPath (Join-Path $state 'notify.log') -Append -Encoding utf8 } catch { Record 'Ошибка записи журнала уведомлений' }
}
Record 'запущен static-check'
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
    if (($exe -like '*WindowsApps*' -and $app) -or (-not $exe -and $app)) { Start-Process explorer.exe -WindowStyle Hidden -ArgumentList ('shell:AppsFolder\' + $app) }
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
        $ready = Get-Content -LiteralPath (Join-Path $state ('ready\' + $name + '.json')) -Raw -Encoding utf8 | ConvertFrom-Json
        if ([DateTime]::Parse($ready.startedAt).ToUniversalTime() -le $started.ToUniversalTime() -or $ready.release -ne $release -or -not (Get-Process -Id $ready.pid -ErrorAction SilentlyContinue)) { $missing += $name }
      } catch { $missing += $name }
    }
    if ($missing.Count -eq 0) { break }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  if ($missing.Count) { Complete $false ('Не готовы: ' + ($missing -join ', ')); Tell ('Перезапуск Claude: не готовы ' + ($missing -join ', ') + ' — истекло время ожидания') }
  else { Complete $true 'Все четыре сервера готовы'; Tell 'Claude перезапущен, серверы release работают' }
} catch { Complete $false $_.Exception.Message; Tell ('Перезапуск Claude: не готовы team, codex, antigravity, grok — ' + $_.Exception.Message) }
