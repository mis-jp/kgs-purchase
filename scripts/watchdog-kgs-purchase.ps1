# Health watchdog for kgs-purchase-http.
# Probes localhost:3001 and force-restarts if the process is dead or hung.
# Does not restart on HTTP 503 (app is up, MySQL is down).
#
# Keep this script FAST and SIDE-EFFECT FREE except for the restart path.
# Never call ensure-node-path.ps1 here — it can scan/download and hang SYSTEM jobs.
#
#   .\scripts\watchdog-kgs-purchase.ps1
#   .\scripts\watchdog-kgs-purchase.ps1 -DryRun
#
# Pause during deploys by creating .watchdog-pause in the repo root.
param(
    [string]$RepoPath = '',
    [string]$HealthUrl = 'http://127.0.0.1:3001/kgs-purchase/api/health',
    [int]$Port = 3001,
    [string]$Pm2App = 'kgs-purchase-http',
    [int]$TimeoutSec = 5,
    [int]$CooldownSec = 180,
    [int]$PauseMaxAgeMin = 90,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
if (-not $RepoPath) {
    $RepoPath = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path -LiteralPath $RepoPath)) {
    Write-Error "Repo path not found: $RepoPath"
    exit 1
}
Set-Location -LiteralPath $RepoPath

$pauseFile = Join-Path $RepoPath '.watchdog-pause'
$restartFile = Join-Path $RepoPath '.watchdog-last-restart'
$logDir = 'C:\Users\Administrator\.pm2\logs'
$logFile = Join-Path $logDir 'kgs-purchase-watchdog.log'
$lockFile = Join-Path $RepoPath '.watchdog-lock'

function Write-WatchLog([string]$Message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    try {
        if (-not (Test-Path -LiteralPath $logDir)) {
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        }
        $ok = $false
        for ($i = 0; $i -lt 3 -and -not $ok; $i++) {
            try {
                Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 -ErrorAction Stop
                $ok = $true
            } catch {
                Start-Sleep -Milliseconds 150
            }
        }
    } catch {
    }
}

function Get-ListeningPids([int]$ListenPort) {
    $ids = @()
    $pattern = 'TCP\s+[0-9.:\[\]]+:' + $ListenPort + '\s+.*LISTENING'
    $netstatLines = netstat -ano 2>&1 | Select-String $pattern
    foreach ($line in $netstatLines) {
        $parts = ($line.ToString().Trim() -split '\s+')
        $procId = $parts[-1]
        if ($procId -match '^\d+$' -and [int]$procId -ne 0) {
            $ids += [int]$procId
        }
    }
    return @($ids | Select-Object -Unique)
}

function Test-DeployPaused {
    if (-not (Test-Path -LiteralPath $pauseFile)) { return $false }
    $ageMin = ((Get-Date) - (Get-Item -LiteralPath $pauseFile).LastWriteTime).TotalMinutes
    if ($ageMin -gt $PauseMaxAgeMin) {
        Write-WatchLog ("WARN stale pause file ({0}m) - ignoring" -f [int]$ageMin)
        Remove-Item -LiteralPath $pauseFile -Force -ErrorAction SilentlyContinue
        return $false
    }
    return $true
}

function Test-InCooldown {
    if (-not (Test-Path -LiteralPath $restartFile)) { return $false }
    $ageSec = ((Get-Date) - (Get-Item -LiteralPath $restartFile).LastWriteTime).TotalSeconds
    return ($ageSec -lt $CooldownSec)
}

function Enter-WatchdogLock {
    if (Test-Path -LiteralPath $lockFile) {
        $ageSec = ((Get-Date) - (Get-Item -LiteralPath $lockFile).LastWriteTime).TotalSeconds
        if ($ageSec -lt 120) {
            Write-WatchLog "SKIP another watchdog run in progress"
            return $false
        }
        Write-WatchLog ("WARN stale lock ({0}s) - taking over" -f [int]$ageSec)
        Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
    }
    Set-Content -LiteralPath $lockFile -Value (Get-Date -Format o) -Encoding ASCII
    return $true
}

function Exit-WatchdogLock {
    Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
}

function Initialize-Pm2Path {
    $dirs = @(
        'C:\Users\Administrator\AppData\Roaming\npm',
        'C:\Program Files\nodejs'
    )
    foreach ($dir in $dirs) {
        if (Test-Path -LiteralPath $dir) {
            $parts = $env:Path -split ';' | Where-Object {
                $_ -and $_.TrimEnd('\') -ne $dir.TrimEnd('\')
            }
            $env:Path = ($dir + ';' + ($parts -join ';')).TrimEnd(';')
        }
    }
    $adminPm2Home = 'C:\Users\Administrator\.pm2'
    if (Test-Path -LiteralPath $adminPm2Home) {
        $env:PM2_HOME = $adminPm2Home
    }
}

function Invoke-Pm2([string[]]$Pm2Args, [int]$WaitSec = 25) {
    $pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue
    if (-not $pm2Cmd) {
        throw 'pm2 not on PATH'
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $pm2Cmd.Source
    $psi.Arguments = ($Pm2Args -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables['PM2_HOME'] = $env:PM2_HOME
    $psi.EnvironmentVariables['Path'] = $env:Path
    $proc = [System.Diagnostics.Process]::Start($psi)
    if (-not $proc.WaitForExit($WaitSec * 1000)) {
        try { $proc.Kill() } catch {}
        throw ("pm2 {0} timed out after {1}s" -f ($Pm2Args -join ' '), $WaitSec)
    }
    return $proc.ExitCode
}

function Get-HealthProbe {
    $outFile = Join-Path $env:TEMP ('kgs-watchdog-health-{0}.out' -f $PID)
    $code = '000'
    try {
        $code = & curl.exe -s -o $outFile -w '%{http_code}' --connect-timeout 2 --max-time $TimeoutSec $HealthUrl 2>$null
        if (-not $code) { $code = '000' }
        $code = $code.ToString().Trim()
    } catch {
        $code = '000'
    } finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    }

    if ($code -match '^\d{3}$' -and $code -ne '000') {
        return @{ Kind = 'http'; Code = $code }
    }
    return @{ Kind = 'down'; Code = '000' }
}

function Restart-KgsPurchase([string]$Reason) {
    if ($DryRun) {
        Write-WatchLog "DRYRUN would restart ($Reason)"
        return
    }
    if (Test-InCooldown) {
        Write-WatchLog ("SKIP restart ($Reason) - cooldown {0}s" -f $CooldownSec)
        return
    }

    Write-WatchLog "RESTART $Pm2App - $Reason"
    Set-Content -LiteralPath $restartFile -Value (Get-Date -Format o) -Encoding ASCII

    Initialize-Pm2Path

    $listenPids = Get-ListeningPids -ListenPort $Port
    foreach ($procId in $listenPids) {
        Write-WatchLog "Force-killing hung PID $procId on :$Port"
        cmd /c "taskkill /F /PID $procId /T" 2>&1 | Out-Null
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1

    try {
        [void](Invoke-Pm2 @('delete', $Pm2App) 15)
    } catch {
        Write-WatchLog ("WARN pm2 delete: {0}" -f $_.Exception.Message)
    }

    $serverJs = Join-Path $RepoPath '.next\standalone\server.js'
    if (-not (Test-Path -LiteralPath $serverJs)) {
        Write-WatchLog "ERROR cannot start - standalone server.js missing"
        return
    }

    $eco = Join-Path $RepoPath 'ecosystem.config.js'
    try {
        [void](Invoke-Pm2 @('start', $eco, '--only', $Pm2App) 30)
        try { [void](Invoke-Pm2 @('save') 15) } catch {}
        Write-WatchLog "pm2 start $Pm2App complete"
    } catch {
        Write-WatchLog ("ERROR pm2 start failed: {0}" -f $_.Exception.Message)
    }
}

try {
    if (-not (Enter-WatchdogLock)) { exit 0 }

    if (Test-DeployPaused) {
        Write-WatchLog "SKIP deploy pause active"
        exit 0
    }

    $listenPids = Get-ListeningPids -ListenPort $Port
    if ($listenPids.Count -eq 0) {
        Restart-KgsPurchase "nothing listening on :$Port"
        exit 0
    }

    $probe = Get-HealthProbe
    if ($probe.Kind -eq 'http') {
        Write-WatchLog ("OK health HTTP {0} pids={1}" -f $probe.Code, ($listenPids -join ','))
        exit 0
    }

    Write-WatchLog ("WARN health timeout (pids={0}) - retrying once" -f ($listenPids -join ','))
    Start-Sleep -Seconds 3
    $retry = Get-HealthProbe
    if ($retry.Kind -eq 'http') {
        Write-WatchLog ("OK health recovered HTTP {0}" -f $retry.Code)
        exit 0
    }

    Restart-KgsPurchase "health timed out twice (hung process)"
    exit 0
} catch {
    $errMsg = $_.Exception.Message
    Write-WatchLog "ERROR $errMsg"
    exit 1
} finally {
    Exit-WatchdogLock
}
