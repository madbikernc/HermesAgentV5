# Version: 1.0.0
#
# 1.0.0 (2026-09-27, HermesAgentV5 S19d) — initial version: the Windows counterpart of
# vault-get-secret.sh, for Anvil (operator decision 2026-09-27: native `bw` CLI, not WSL, not a
# DPAPI copy of the secret itself). Vaultwarden stays the single source of truth; the secret is
# fetched into the caller's memory and never written to disk.
#
# What carries over from vault-get-secret.sh, deliberately:
#   - an ISOLATED `bw` profile (BITWARDENCLI_APPDATA_DIR), 1.6.0's lesson: two callers sharing one
#     profile evict each other's unlocked session
#   - exact-name item resolution before `bw get` (1.5.0's lesson: `bw get <name>` substring-matches,
#     so 'Hermes Reolink' failed once 'Hermes Reolink Mail' existed)
#   - three attempts, `bw logout` between them, `bw lock` at the end
#   - an empty result is a failure, never a value
# What differs: the Linux nodes decrypt `bw`'s own bootstrap credentials (API key, master password)
# with systemd-creds. Windows has no systemd-creds, so they live in vault-bootstrap.clixml, written by
# infra/anvil/set-vault-bootstrap.ps1 with Export-Clixml, whose SecureStrings are DPAPI-encrypted to
# the one Windows account that wrote them, on this one machine. Only the service account can read it.
# No cross-process lock (vault-get-secret.sh's flock): on Anvil exactly one caller exists, the mesh
# worker's wrapper, and it runs once at service start.
#
# Usage: vault-get-secret.ps1 -ItemName <name> [-Field password|username|notes|<custom field>]
#   stdout: the value (pipeline output, so `$x = & vault-get-secret.ps1 ...` captures it)
#   exit:   0 found, 1 not found / vault unreachable / bootstrap missing
# Requires: the Bitwarden CLI (`bw`) on PATH; vault-bootstrap.clixml under -HermesDir.

param(
    [Parameter(Mandatory = $true)][string]$ItemName,
    [string]$Field = "password",
    [string]$HermesDir = (Join-Path $env:ProgramData "Hermes")
)

$ErrorActionPreference = "Stop"

function Write-Err([string]$Message) {
    [Console]::Error.WriteLine("[vault-get-secret] $Message")
}

# Windows PowerShell 5.1: with ErrorActionPreference=Stop, a native command's stderr redirected with
# 2>$null becomes a terminating error. Relax it for the call itself and read the real exit code.
function Invoke-Bw([string[]]$BwArgs) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & bw @BwArgs 2>$null
        return [pscustomobject]@{ Out = ($out -join "`n"); Code = $LASTEXITCODE }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function ConvertTo-Plain([Security.SecureString]$Secure) {
    return (New-Object System.Management.Automation.PSCredential("x", $Secure)).GetNetworkCredential().Password
}

function Get-SecretOnce {
    Invoke-Bw @("login", "--apikey") | Out-Null   # "already logged in" is not a failure
    $unlock = Invoke-Bw @("unlock", "--passwordenv", "BW_PASSWORD", "--raw")
    if ($unlock.Code -ne 0 -or -not $unlock.Out) { return "" }
    $session = $unlock.Out
    Invoke-Bw @("sync", "--session", $session) | Out-Null

    $ref = $ItemName
    $list = Invoke-Bw @("list", "items", "--search", $ItemName, "--session", $session)
    if ($list.Code -eq 0 -and $list.Out) {
        $exact = @(($list.Out | ConvertFrom-Json) | Where-Object { $_.name -ceq $ItemName })
        if ($exact.Count -eq 1) { $ref = $exact[0].id }
    }

    if (@("password", "username", "notes") -contains $Field) {
        $got = Invoke-Bw @("get", $Field, $ref, "--session", $session)
        if ($got.Code -eq 0) { return $got.Out }
        return ""
    }
    $item = Invoke-Bw @("get", "item", $ref, "--session", $session)
    if ($item.Code -ne 0 -or -not $item.Out) { return "" }
    $match = @((($item.Out | ConvertFrom-Json).fields) | Where-Object { $_.name -eq $Field })
    if ($match.Count -ge 1) { return [string]$match[0].value }
    return ""
}

$bootstrapPath = Join-Path $HermesDir "vault-bootstrap.clixml"
if (-not (Test-Path -LiteralPath $bootstrapPath)) {
    Write-Err "no $bootstrapPath -- run infra\anvil\set-vault-bootstrap.ps1 AS THE SERVICE ACCOUNT first"
    exit 1
}
try {
    $bootstrap = Import-Clixml -LiteralPath $bootstrapPath
    $env:BW_CLIENTID = $bootstrap.ClientId
    $env:BW_CLIENTSECRET = ConvertTo-Plain $bootstrap.ClientSecret
    $env:BW_PASSWORD = ConvertTo-Plain $bootstrap.MasterPassword
} catch {
    # DPAPI refuses to decrypt for any account but the one that wrote the file.
    Write-Err "cannot read $bootstrapPath as $([Security.Principal.WindowsIdentity]::GetCurrent().Name): $($_.Exception.Message)"
    exit 1
}

$env:BITWARDENCLI_APPDATA_DIR = Join-Path $HermesDir "bw-appdata"
if ($bootstrap.CaCertPath) { $env:NODE_EXTRA_CA_CERTS = $bootstrap.CaCertPath }
New-Item -ItemType Directory -Force -Path $env:BITWARDENCLI_APPDATA_DIR | Out-Null

$result = ""
try {
    if (-not (Test-Path -LiteralPath (Join-Path $env:BITWARDENCLI_APPDATA_DIR "data.json"))) {
        Invoke-Bw @("config", "server", $bootstrap.ServerUrl) | Out-Null
    }
    foreach ($attempt in 1..3) {
        $result = Get-SecretOnce
        if ($result) { break }
        Invoke-Bw @("logout") | Out-Null
        Start-Sleep -Seconds 2
    }
} finally {
    Invoke-Bw @("lock") | Out-Null
    foreach ($name in "BW_CLIENTID", "BW_CLIENTSECRET", "BW_PASSWORD", "BITWARDENCLI_APPDATA_DIR", "NODE_EXTRA_CA_CERTS") {
        Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    }
}

if (-not $result) {
    Write-Err "could not fetch '$Field' from '$ItemName' after 3 attempts"
    exit 1
}
Write-Output $result
exit 0
