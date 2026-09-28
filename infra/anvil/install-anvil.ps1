# Version: 1.0.0
#
# install-anvil — the Windows-side services for Anvil (infra/anvil/README.md steps 5–6), from the
# operator decisions of 2026-09-27: NSSM services, native bw secrets, a 30-minute repo-sync task.
# Run once, elevated, after ComfyUI + TRELLIS.2 and the mesh venv exist. Safe to re-run: every
# setting is (re)applied, nothing is duplicated.
#
# Creates:
#   HermesComfyUI     NSSM service: ComfyUI on 127.0.0.1 only (no --listen), restart on exit
#   HermesMeshWorker  NSSM service: hermes-mesh-worker.ps1 -> hermes-render-worker.py, JOB_TYPE=mesh,
#                     depends on HermesComfyUI, restart on exit after 15s (systemd's Restart=always)
#   HermesRepoSync    scheduled task, SYSTEM, every 30 min + at boot: hermes-repo-sync.ps1
#   a firewall rule blocking inbound 8188 (belt and braces; ComfyUI is loopback-only anyway)
#   C:\ProgramData\Hermes (logs, bw profile, vault bootstrap), writable by the service account
#
# Does NOT do — each needs the service account's own identity, so it is printed as a next step:
#   the vault bootstrap (set-vault-bootstrap.ps1) and the NAS2 SMB credential (cmdkey).
#
# Revision History: 1.0.0 | 2026-09-27 | Initial version (S19).

param(
    [Parameter(Mandatory = $true)][string]$ComfyDir,          # the ComfyUI checkout (has main.py)
    [Parameter(Mandatory = $true)][string]$ComfyPython,       # ComfyUI's own venv python.exe
    [string]$Nssm = "C:\hermes\nssm\nssm.exe",
    [string]$Repo = "C:\hermes\HermesAgentV5",
    [string]$Python = "C:\hermes\venv\Scripts\python.exe",    # the mesh venv (requirements-mesh.txt)
    [string]$ServiceUser = ".\hermes",
    [string]$BrokerUrl = "http://10.129.1.15:8100",
    [string]$ArchiveDir = "\\10.129.1.167\PMoney\Private\Hermes\Meshes",
    [string]$MeshOutDir = "C:\hermes\mesh-out",
    [int]$JobTimeout = 3600                                   # PROVISIONAL until exit gate 2
)

$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this elevated (as Administrator)."
}
foreach ($p in $Nssm, $Python, $ComfyPython, (Join-Path $ComfyDir "main.py"), (Join-Path $Repo "tools\hermes-render-worker.py")) {
    if (-not (Test-Path -LiteralPath $p)) { throw "not found: $p" }
}
$workflow = Join-Path $Repo "infra\anvil\workflows\trellis2-mesh-only.api.json"
if (-not (Test-Path -LiteralPath $workflow)) {
    Write-Warning "no exported workflow at $workflow yet (README step 3) - the worker will fail every job until it exists"
}

$cred = Get-Credential -UserName $ServiceUser -Message "Password for the service account both services run as"
$password = $cred.GetNetworkCredential().Password

function Invoke-Nssm([string[]]$NssmArgs) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { $out = & $Nssm @NssmArgs 2>&1 } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "nssm $($NssmArgs[0..1] -join ' ') failed: $($out -join ' ')" }
}

# icacls does not accept the ".Ser" form NSSM uses for a local account.
$aclUser = $ServiceUser -replace '^\.\\', "$env:COMPUTERNAME\"
$hermesData = Join-Path $env:ProgramData "Hermes"
$logs = Join-Path $hermesData "logs"
foreach ($dir in $hermesData, $logs, $MeshOutDir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    & icacls $dir /grant "${aclUser}:(OI)(CI)M" | Out-Null
}

function Set-HermesService([string]$Name, [string]$Display, [string]$App, [string]$AppArgs, [string]$Dir,
                     [string[]]$Environment, [string]$DependsOn) {
    if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) {
        Invoke-Nssm @("install", $Name, $App)
    }
    Invoke-Nssm @("set", $Name, "Application", $App)
    Invoke-Nssm @("set", $Name, "AppParameters", $AppArgs)
    Invoke-Nssm @("set", $Name, "AppDirectory", $Dir)
    Invoke-Nssm @("set", $Name, "DisplayName", $Display)
    Invoke-Nssm @("set", $Name, "ObjectName", $ServiceUser, $password)
    Invoke-Nssm @("set", $Name, "Start", "SERVICE_AUTO_START")
    Invoke-Nssm @("set", $Name, "AppExit", "Default", "Restart")
    Invoke-Nssm @("set", $Name, "AppRestartDelay", "15000")
    Invoke-Nssm @("set", $Name, "AppStdout", (Join-Path $logs "$Name.log"))
    Invoke-Nssm @("set", $Name, "AppStderr", (Join-Path $logs "$Name.log"))
    Invoke-Nssm @("set", $Name, "AppRotateFiles", "1")
    Invoke-Nssm @("set", $Name, "AppRotateOnline", "1")
    Invoke-Nssm @("set", $Name, "AppRotateBytes", "10485760")
    if ($Environment) { Invoke-Nssm (@("set", $Name, "AppEnvironmentExtra") + $Environment) }
    if ($DependsOn) { Invoke-Nssm @("set", $Name, "DependOnService", $DependsOn) }
    Write-Host "configured service $Name"
}

# ComfyUI binds 127.0.0.1 by default; passing --listen would expose it. Deliberately absent.
Set-HermesService -Name "HermesComfyUI" -Display "Hermes ComfyUI (Anvil, loopback only)" `
    -App $ComfyPython -AppArgs "main.py" -Dir $ComfyDir -Environment @("PYTHONUTF8=1")

Set-HermesService -Name "HermesMeshWorker" -Display "Hermes mesh worker (Anvil)" `
    -App "powershell.exe" `
    -AppArgs "-NoProfile -ExecutionPolicy Bypass -File `"$Repo\infra\anvil\hermes-mesh-worker.ps1`" -Repo `"$Repo`" -Python `"$Python`"" `
    -Dir $Repo -DependsOn "HermesComfyUI" -Environment @(
        "BROKER_URL=$BrokerUrl", "WORKER_NAME=anvil", "JOB_TYPE=mesh", "POLL_SECONDS=10",
        "JOB_TIMEOUT=$JobTimeout", "MESH_COMFY_TIMEOUT=$JobTimeout",
        "GENERATE_SCRIPT=$Repo\tools\hermes-generate-mesh.py",
        "MESH_OUT_DIR=$MeshOutDir", "MESH_ARCHIVE_DIR=$ArchiveDir")

if (-not (Get-NetFirewallRule -DisplayName "ComfyUI 8188 - no inbound (Anvil)" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "ComfyUI 8188 - no inbound (Anvil)" -Direction Inbound `
        -Protocol TCP -LocalPort 8188 -Action Block | Out-Null
    Write-Host "added firewall rule blocking inbound 8188"
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Repo\infra\anvil\hermes-repo-sync.ps1`" -Repo `"$Repo`""
$every30 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 30)
$atBoot = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "HermesRepoSync" -Action $action -Trigger @($every30, $atBoot) `
    -User "SYSTEM" -RunLevel Highest -Force | Out-Null
Write-Host "registered scheduled task HermesRepoSync (every 30 min + at boot, as SYSTEM)"

Write-Host ""
Write-Host "Next, as the service account ($ServiceUser) - both are per-account, so they cannot be done from here:"
Write-Host "  1. runas /user:$ServiceUser `"powershell -NoProfile -ExecutionPolicy Bypass -File $Repo\infra\anvil\set-vault-bootstrap.ps1`""
Write-Host "  2. runas /user:$ServiceUser `"cmdkey /add:10.129.1.167 /user:<NAS2 user> /pass`"   (SMB access to $ArchiveDir)"
Write-Host "Then: Start-Service HermesComfyUI, HermesMeshWorker; logs in $logs"
