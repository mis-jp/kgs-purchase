# Register a Windows Task Scheduler job that restarts kgs-purchase-http
# when the process is dead or hung (Cloudflare 502).
#
#   .\scripts\register-watchdog-task.ps1
#   .\scripts\register-watchdog-task.ps1 -Remove
param(
    [string]$RepoPath = (Join-Path $PSScriptRoot '..'),
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$RepoPath = (Resolve-Path $RepoPath).Path
$taskName = 'KGS-Purchase-Watchdog'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    cmd /c "schtasks /Delete /TN `"$taskName`" /F >NUL 2>&1" | Out-Null
    Write-Host "Removed scheduled task: $taskName" -ForegroundColor Green
    exit 0
}

$wrapper = Join-Path $RepoPath 'scripts\run-watchdog-kgs-purchase.bat'
@(
    '@echo off',
    'setlocal',
    "set REPO=$RepoPath",
    'set LOGDIR=C:\Users\Administrator\.pm2\logs',
    'set PS=C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',
    'if not exist "%LOGDIR%" mkdir "%LOGDIR%"',
    'cd /d "%REPO%"',
    '"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\watchdog-kgs-purchase.ps1"',
    'exit /b %ERRORLEVEL%'
) | Set-Content -Path $wrapper -Encoding ASCII

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
cmd /c "schtasks /Delete /TN `"$taskName`" /F >NUL 2>&1" | Out-Null

# schtasks handles daily+minute repeat reliably on this Windows build
cmd /c "schtasks /Create /TN `"$taskName`" /TR `"$wrapper`" /SC DAILY /ST 00:01 /RI 1 /DU 23:59 /RU SYSTEM /RL HIGHEST /F"
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed" }

# Tighten runtime limits so a hung restart cannot block the next checks
$task = Get-ScheduledTask -TaskName $taskName
$settings = $task.Settings
$settings.ExecutionTimeLimit = 'PT2M'
$settings.MultipleInstances = 'IgnoreNew'
$settings.StartWhenAvailable = $true
Set-ScheduledTask -TaskName $taskName -Settings $settings | Out-Null

Write-Host "Registered scheduled task: $taskName" -ForegroundColor Green
Write-Host "  Probe:  http://127.0.0.1:3001/kgs-purchase/api/health every 1 minute"
Write-Host "  Limit:  2 minute max runtime; ignore overlapping runs"
Write-Host "  Action: force-kill + pm2 start if the process is dead or hung"
Write-Host "  Log:    C:\Users\Administrator\.pm2\logs\kgs-purchase-watchdog.log"
Write-Host ""
Write-Host "To pause during maintenance: create $RepoPath\.watchdog-pause"
Write-Host "To remove: .\scripts\register-watchdog-task.ps1 -Remove"
