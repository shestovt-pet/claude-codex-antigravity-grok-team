@echo off
setlocal
set MOST_FALLBACK_HUMAN=1
set ROOT=%~dp0..
node "%ROOT%\tools\host-fallback.js" %*