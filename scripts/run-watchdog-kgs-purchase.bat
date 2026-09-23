@echo off
setlocal
set REPO=C:\Users\Administrator\Desktop\Github\KGS-PURCHASE
set LOGDIR=C:\Users\Administrator\.pm2\logs
set PS=C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%REPO%"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\watchdog-kgs-purchase.ps1"
exit /b %ERRORLEVEL%
