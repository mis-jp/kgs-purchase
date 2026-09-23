<#
Grants NETWORK SERVICE access so the GitHub Actions runner service can read/deploy
this repo. Required when the runner is installed under the Administrator profile.

Run once as Administrator:
  .\scripts\fix-runner-permissions.ps1
#>
$ErrorActionPreference = 'Stop'

$account = 'NT AUTHORITY\NETWORK SERVICE'
$repoPath = 'C:\Users\Administrator\Desktop\Github\KGS-PURCHASE'
$runnerPath = Join-Path $repoPath 'actions-runner'

$traversePaths = @(
    'C:\Users\Administrator',
    'C:\Users\Administrator\Desktop',
    'C:\Users\Administrator\Desktop\Github'
)

foreach ($path in $traversePaths) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    Write-Host "Grant traverse on $path"
    & icacls $path /grant "${account}:(RX)" | Out-Null
}

Write-Host "Grant modify on repo root (inherits to new files): $repoPath"
& icacls $repoPath /grant "${account}:(OI)(CI)M" | Out-Null

$repoChildren = @(
    '.git', 'app', 'components', 'lib', 'services', 'styles', 'public', 'scripts',
    '.github', 'nginx', '.next', 'actions-runner'
)
foreach ($child in $repoChildren) {
    $childPath = Join-Path $repoPath $child
    if (-not (Test-Path -LiteralPath $childPath)) { continue }
    Write-Host "Grant modify on $childPath"
    & icacls $childPath /grant "${account}:(OI)(CI)M" /T | Out-Null
}

$serviceName = 'actions.runner.mis-jp-kgs-purchase.kgs-purchase-runner'
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -ne 'Running') {
        Write-Host "Starting $serviceName ..."
        Start-Service -Name $serviceName
        Start-Sleep -Seconds 4
    }
    $svc.Refresh()
    Write-Host "Runner service status: $($svc.Status)" -ForegroundColor $(if ($svc.Status -eq 'Running') { 'Green' } else { 'Yellow' })
} else {
    Write-Warning "Service $serviceName not found. Run scripts\register-self-hosted-runner.ps1"
}
