@echo off
rem Setup: checks, release, connections to found apps. Dry run: setup.cmd --dry-run
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите Node.js 18 или новее с https://nodejs.org и запустите setup.cmd снова.
  pause
  exit /b 1
)
node tools\setup.js %*
set CODE=%ERRORLEVEL%
rem Окно, открытое двойным щелчком, не закрывается, пока итог не прочитан.
if not defined MOST_SETUP_NOPAUSE pause
exit /b %CODE%
