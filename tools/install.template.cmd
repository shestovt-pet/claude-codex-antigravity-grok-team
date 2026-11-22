@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
set "MOST_INSTALL_SELF=%~f0"
powershell.exe -NoLogo -NoProfile -Command "$ErrorActionPreference='Stop'; try { $t=[IO.File]::ReadAllText($env:MOST_INSTALL_SELF,[Text.Encoding]::UTF8); $parts=[regex]::Split($t,'(?m)^:__MOST_POWERSHELL__\r?$'); if($parts.Count -ne 2){throw 'Не удалось прочитать встроенный сценарий'}; & ([scriptblock]::Create($parts[1])) } catch { Write-Host $_ -ForegroundColor Red; exit 1 }"
set "MOST_INSTALL_EXIT=%ERRORLEVEL%"
echo.
echo Код завершения: %MOST_INSTALL_EXIT%
echo Нажмите любую клавишу, чтобы закрыть окно.
pause >nul
exit /b %MOST_INSTALL_EXIT%
:__MOST_POWERSHELL__
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$root = 'E:\most'
$commit = '__COMMIT__'
$release = Join-Path $root ('live\' + $commit)
$node = 'C:\Program Files\nodejs\node.exe'
$cli = Join-Path $release 'tools\deploy.js'
function Get-BlockingProcesses {
    $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    if (-not ($rows | Where-Object ProcessId -eq $PID)) { throw 'Не удалось получить полный список процессов. Установка запрещена.' }
    foreach ($p in $rows) {
        $reason = $null
        if ($p.Name -match '^(claude|codex|Antigravity|DeepSeek Harness|ChatGPT|dsh|agy|kimi)\.exe$') {
            $reason = 'Приложение-клиент или его исполнитель'
        } elseif ($p.Name -match '^node(?:\.exe)?$') {
            if (-not $p.CommandLine -or -not $p.CreationDate) {
                $reason = 'Команда или время запуска Node недоступны: отсутствие серверов не доказано'
            } elseif ($p.CommandLine -match '(?i)(?:[\\/]|\s)servers[\\/]|(?:[\\/])most[\\/]index\.[cm]?js|antigravity|@anthropic-ai[\\/]claude-code|@deepseek-ai|[\\/]dsh[\\/]') {
                $reason = 'Сервер моста или клиент командной строки'
            }
        }
        if ($reason) {
            $parent = $rows | Where-Object ProcessId -eq $p.ParentProcessId | Select-Object -First 1
            [pscustomobject]@{ PID=$p.ProcessId; Application=$p.Name; Parent=$parent.Name; Reason=$reason; Command=$p.CommandLine }
        }
    }
}
Write-Host ('Установка моста: выпуск ' + $commit + '. Не открывайте приложения до итогового сообщения.')
Write-Host 'Полностью выйдите из Claude Desktop, Codex/ChatGPT, Antigravity, DeepSeek Harness и Kimi, включая значки в трее.'
Write-Host 'Сначала дождитесь завершения всех поручений. Этот файл сам приложения не закрывает.'
Write-Host 'Если останутся старые карточки или замки записи, установщик покажет их список и спросит слово пользователя'
Write-Host 'прямо в этом окне: наберите его с клавиатуры, чтобы перекрыть проверку, либо завершите поручения и повторите.'
foreach ($file in @($node, $cli, (Join-Path $release 'probe-ok.json'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw ('Не найден обязательный файл: ' + $file) }
}
while ($true) {
    $blocked = @(Get-BlockingProcesses)
    if ($blocked.Count -eq 0) {
        Start-Sleep -Seconds 2
        $blocked = @(Get-BlockingProcesses)
        if ($blocked.Count -eq 0) { break }
    }
    Write-Host 'Установка пока не запускается. Закройте перечисленные приложения; дождитесь выхода их серверов:' -ForegroundColor Yellow
    $blocked | Format-Table PID,Application,Parent,Reason -Wrap -AutoSize | Out-Host
    foreach ($p in $blocked | Where-Object Application -match '^node') { Write-Host ('PID ' + $p.PID + ': ' + $p.Command) }
    $answer = Read-Host 'После закрытия нажмите Enter для повторной проверки; Q — выход'
    if ($answer -eq 'Q') { Write-Host 'Отменено пользователем, установка не запускалась.'; exit 2 }
}
$env:MOST_REPO_ROOT = $root
$env:MOST_STATE_DIR = Join-Path $root 'state'
$env:MOST_JOB_ID = ''
$env:MOST_CLIENT = ''
$taskTemp = 'E:\Codex\temp\most-install'
[IO.Directory]::CreateDirectory($taskTemp) | Out-Null
$env:TEMP = $taskTemp
$env:TMP = $taskTemp
$env:TMPDIR = $taskTemp
$started = [DateTime]::UtcNow
Write-Host ('Запуск: "' + $node + '" "' + $cli + '" --root "' + $root + '" --commit ' + $commit)
Push-Location -LiteralPath $release
try {
    & $node $cli --root $root --commit $commit
    $code = $LASTEXITCODE
} finally { Pop-Location }
# team-v57 (ред.6/7): один запуск tools\deploy.js в этой же консоли (stdin/stdout унаследованы) — диалог со списком и
# словом пользователя ведёт сам deploy.js. Ненулевой код возврата означает НАСТОЯЩИЙ отказ или ошибку (в т.ч. пустое слово/
# отказ проверки), и файл об этом сообщает: установка не выполнена.
if ($code -ne 0) {
    throw ('Установщик вернул ненулевой код ' + $code + ': установка НЕ выполнена — настоящий отказ или ошибка (например, пустое слово или отказ проверки). Детали — в выводе выше и в state\deploy-ops. Не запускайте второй установщик и не открывайте клиенты.')
}
$op = Get-ChildItem -LiteralPath (Join-Path $root 'state\deploy-ops') -Filter '*.json' | ForEach-Object {
    Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
} | Where-Object { $_.release -eq $release -and [DateTime]::Parse($_.createdAt).ToUniversalTime() -ge $started } | Sort-Object createdAt | Select-Object -Last 1
if (-not $op -or $op.status -ne 'завершено') {
    throw 'Код возврата 0, но итог операции не подтверждён (истекли 5 минут ожидания или запись не дошла). Не запускайте второй установщик и не открывайте клиенты; проверьте state\deploy-ops.'
}
$deployed = Get-Content -LiteralPath (Join-Path $root 'live\deployed.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($deployed.commit -ne $commit) {
    throw 'Итоговые отметки не совпали: установка не подтверждена. Сохраните вывод и передайте Claude.'
}
Write-Host ('Готово: операция ' + $op.id + '; deployed.json = ' + $commit) -ForegroundColor Green
# team-v57 (ред.6/7): печатаем ОБА поля барьера установки.
if ($op.gatePassed) {
    Write-Host ('Пропущено по слову на карточке: ' + (@($op.gatePassed.passedByCardWord).Count) + '; по перезагрузке Windows: ' + (@($op.gatePassed.passedByReboot).Count) + '.')
}
if ($op.overriddenByWord -and $op.overriddenByWord.quote) {
    $w = $op.overriddenByWord
    Write-Host ('Проверка перекрыта словом пользователя (канал ' + $w.channel + '): «' + $w.quote + '». Перекрыто (будет оборвано) записей: ' + ((@($w.running).Count) + (@($w.blockers).Count)) + '.')
}
Write-Host 'Теперь можно вручную открыть Claude Desktop и остальные приложения.'
exit 0
