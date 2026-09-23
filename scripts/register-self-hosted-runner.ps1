<#
Registers and starts a self-hosted GitHub Actions runner for KGS-PURCHASE on this Windows server.

ONE-TIME SETUP (run on production server as Administrator):

  1. Open: https://github.com/mis-jp/kgs-purchase/settings/actions/runners/new?arch=x64&os=win
  2. Copy the registration token (expires in ~1 hour)
  3. Run:

     cd C:\Users\Administrator\Desktop\Github\KGS-PURCHASE
     .\scripts\register-self-hosted-runner.ps1 -RegistrationToken "PASTE_TOKEN_HERE"

After the runner shows "Idle" on GitHub, every push to main auto-deploys to:
  https://kelinconnect.com/kgs-purchase/signin
#>
param(
    [Parameter(Mandatory = $false)]
    [string]$OwnerRepo = "mis-jp/kgs-purchase",

    [Parameter(Mandatory = $false)]
    [string]$RegistrationToken = "",

    [string]$RunnerName = "kgs-purchase-runner",
    [string]$RunnerLabels = "self-hosted,windows",
    [string]$RunnerVersion = "v2.323.0",
    [string]$InstallPath = "C:\Users\Administrator\Desktop\Github\KGS-PURCHASE\actions-runner"
)

function Assert-Admin {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Error "Run PowerShell as Administrator."
        exit 1
    }
}

Assert-Admin

$repoUrl = "https://github.com/$OwnerRepo"
Write-Host "=== KGS-PURCHASE GitHub Actions runner ===" -ForegroundColor Cyan
Write-Host "Repository : $repoUrl"
Write-Host "Runner name: $RunnerName"
Write-Host "Labels     : $RunnerLabels"
Write-Host "Install at : $InstallPath"
Write-Host ""

if (-not (Test-Path $InstallPath)) {
    New-Item -ItemType Directory -Path $InstallPath | Out-Null
}
Set-Location $InstallPath

$needsDownload = -not (Test-Path ".\config.cmd")
if ($needsDownload) {
    $zip = "actions-runner-win-x64-$RunnerVersion.zip"
    $downloadUrl = "https://github.com/actions/runner/releases/download/$RunnerVersion/$zip"
    Write-Host "Downloading runner $RunnerVersion ..."
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath . -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
}

if (-not $RegistrationToken) {
    Write-Host ""
    Write-Host "No -RegistrationToken provided." -ForegroundColor Yellow
    Write-Host "Get a token from:" -ForegroundColor Yellow
    Write-Host "  $repoUrl/settings/actions/runners/new?arch=x64&os=win" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Then run:" -ForegroundColor Yellow
    Write-Host "  .\scripts\register-self-hosted-runner.ps1 -RegistrationToken `"YOUR_TOKEN`"" -ForegroundColor White
    exit 0
}

# Stop existing service if re-registering
if (Test-Path ".\svc.stop") {
    & .\svc.stop 2>$null
}
if (Test-Path ".\svc.uninstall") {
    & .\svc.uninstall 2>$null
}

Write-Host "Configuring runner ..."
& .\config.cmd remove --token $RegistrationToken 2>$null
& .\config.cmd `
    --url $repoUrl `
    --token $RegistrationToken `
    --name $RunnerName `
    --work _work `
    --labels $RunnerLabels `
    --unattended `
    --replace

if ($LASTEXITCODE -ne 0) {
    Write-Error "config.cmd failed. Token may be expired — generate a new one from GitHub."
    exit 1
}

Write-Host "Installing runner as Windows service ..."
& .\svc.install

# Must match PM2 (Local System). NETWORK SERVICE cannot stop the live app,
# so activate-next-build fails with a locked .next and auto-deploy rolls back.
$svcName = (Get-Service -Name "actions.runner.*" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'KGS-PURCHASE|kgs-purchase' } |
    Select-Object -First 1 -ExpandProperty Name)
if (-not $svcName) {
    $svcName = (Get-Service -Name "actions.runner.*" -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty Name)
}
if ($svcName) {
    Write-Host "Configuring $svcName to run as Local System..."
    sc.exe config $svcName obj= LocalSystem | Out-Null
}

& .\svc.start

Start-Sleep -Seconds 3
$svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host ""
    Write-Host "SUCCESS: Runner service is running ($($svc.Name))." -ForegroundColor Green
    $cim = Get-CimInstance Win32_Service -Filter "Name='$($svc.Name)'"
    Write-Host "Logon account: $($cim.StartName)" -ForegroundColor Green
    Write-Host "Verify on GitHub: $repoUrl/settings/actions/runners" -ForegroundColor Green
    Write-Host ""
    Write-Host "Queued deploy workflows should start within a minute." -ForegroundColor Green
    Write-Host "Or push to main / click 'Run workflow' on Deploy to Production." -ForegroundColor Green
} else {
    Write-Warning "Service may not be running. Try manually: cd $InstallPath; .\run.cmd"
    exit 1
}
