# Version: 1.0.0
#
# hermes-repo-sync — Anvil's counterpart of tools/hermes-repo-sync.sh 2.0.0 (operator decision
# 2026-09-27: scheduled task every 30 minutes). S14's hermes-repo-autopull.timer does not reach
# Windows, and a silently stale node is a failure this fleet has already had once (HomeD13).
# Fast-forward pull only; if HEAD moved, restart the services that run this checkout's code, since
# a pull alone leaves the old code running in memory (hermes-repo-sync.sh 2.0.0's own finding).
#
# Runs as SYSTEM (the HermesRepoSync scheduled task) so it can restart services. The checkout is
# owned by an administrator, so git's dubious-ownership check is satisfied for this one repo only
# (-c safe.directory=<repo>), never globally.
#
# Revision History: 1.0.0 | 2026-09-27 | Initial version (S19).

param(
    [string]$Repo = "C:\hermes\HermesAgentV5",
    [string[]]$Services = @("HermesMeshWorker"),
    [string]$LogDir = (Join-Path $env:ProgramData "Hermes\logs"),
    [switch]$NoRestart
)

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logFile = Join-Path $LogDir "repo-sync.log"
function Write-Log([string]$Message) {
    Add-Content -LiteralPath $logFile -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message)
}

$safe = "safe.directory=" + ($Repo -replace "\\", "/")
function Invoke-Git([string[]]$GitArgs) {
    $out = & git -c $safe -C $Repo @GitArgs 2>&1
    return [pscustomobject]@{ Out = ($out -join "`n"); Code = $LASTEXITCODE }
}

$before = (Invoke-Git @("rev-parse", "HEAD")).Out
$pull = Invoke-Git @("pull", "--ff-only")
if ($pull.Code -ne 0) {
    Write-Log "ERROR: git pull --ff-only failed (exit $($pull.Code)): $($pull.Out)"
    exit 1
}
$after = (Invoke-Git @("rev-parse", "HEAD")).Out
if ($before -eq $after) {
    exit 0
}

Write-Log "pulled $before -> $after"
if ($NoRestart) {
    Write-Log "-NoRestart: services left running the old code"
    exit 0
}
$failed = $false
foreach ($name in $Services) {
    if (-not (Get-Service -Name $name -ErrorAction SilentlyContinue)) {
        Write-Log "service $name not installed -- skipped"
        continue
    }
    try {
        Restart-Service -Name $name -Force -ErrorAction Stop
        Write-Log "restarted $name"
    } catch {
        Write-Log "ERROR: could not restart ${name}: $($_.Exception.Message)"
        $failed = $true
    }
}
if ($failed) { exit 1 }
exit 0
