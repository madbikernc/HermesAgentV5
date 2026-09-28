# Version: 1.0.0
#
# One-time: store the Bitwarden CLI's own bootstrap credentials for tools\vault-get-secret.ps1
# (infra/anvil/README.md step 5). Anvil's counterpart of the Linux nodes'
# /etc/credstore.encrypted/vaultwarden-<node>-{apikey,masterpw}.
#
# MUST RUN AS THE SERVICE ACCOUNT, not as you:
#   runas /user:.\hermes "powershell -NoProfile -ExecutionPolicy Bypass -File C:\hermes\HermesAgentV5\infra\anvil\set-vault-bootstrap.ps1"
# Export-Clixml encrypts the SecureStrings with DPAPI for the account that runs it, on this machine
# only. Written as anyone else, the service cannot decrypt it — vault-get-secret.ps1 then fails with
# a clear message rather than a wrong value.
#
# The Vaultwarden account: least privilege — an account that can see only the `broker-token` item.
#
# Revision History: 1.0.0 | 2026-09-27 | Initial version (S19, operator decision: native bw).

param([string]$HermesDir = (Join-Path $env:ProgramData "Hermes"))

$ErrorActionPreference = "Stop"
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
Write-Host "Storing Vaultwarden bootstrap credentials readable ONLY by: $me"
if ((Read-Host "Is that the mesh worker's service account? (yes/no)") -ne "yes") {
    Write-Host "Stopped. Re-run with runas /user:<service account> (see this script's header)."
    exit 1
}

$bootstrap = [ordered]@{
    ServerUrl      = Read-Host "Vaultwarden server URL (same as the Linux nodes' 'bw config server')"
    ClientId       = Read-Host "API key client_id (user.xxxx)"
    ClientSecret   = Read-Host "API key client_secret" -AsSecureString
    MasterPassword = Read-Host "Master password" -AsSecureString
    CaCertPath     = Read-Host "Path to a copy of the fleet's vw-lan.crt (blank if the server cert is publicly trusted)"
}
if ($bootstrap.CaCertPath -and -not (Test-Path -LiteralPath $bootstrap.CaCertPath)) {
    throw "CA certificate not found at $($bootstrap.CaCertPath)"
}

New-Item -ItemType Directory -Force -Path $HermesDir | Out-Null
$path = Join-Path $HermesDir "vault-bootstrap.clixml"
[pscustomobject]$bootstrap | Export-Clixml -LiteralPath $path
# Only this account and Administrators may even read the (already DPAPI-encrypted) file.
& icacls $path /inheritance:r /grant:r "${me}:(R,W)" "*S-1-5-32-544:(F)" | Out-Null
Write-Host "Written: $path"

$test = & (Join-Path $PSScriptRoot "..\..\tools\vault-get-secret.ps1") -ItemName "broker-token" -HermesDir $HermesDir
if ($LASTEXITCODE -eq 0 -and $test) {
    Write-Host "Verified: broker-token fetched from the vault ($($test.Length) characters)."
} else {
    Write-Host "NOT verified: could not fetch broker-token with these credentials. Fix and re-run."
    exit 1
}
