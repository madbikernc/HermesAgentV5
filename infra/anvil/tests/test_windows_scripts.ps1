# Version: 1.0.0
#
# Checks for Anvil's PowerShell pieces (S19, operator decisions 2026-09-27: NSSM, native bw, 30-min
# repo sync). Runs on any Windows box with Windows PowerShell 5.1 and git — no bw, no NSSM, no admin:
#   - every .ps1 in infra\anvil and tools parses
#   - tools\vault-get-secret.ps1 against a mock `bw`: exact-name resolution (not substring), retries,
#     honest failure, custom fields, bw's credentials cleared from the environment afterwards, and a
#     missing bootstrap refused
#   - infra\anvil\hermes-repo-sync.ps1 against real throwaway git repos: no-op, fast-forward, a
#     non-installed service skipped, and a diverged checkout reported as a failure
#   powershell -NoProfile -ExecutionPolicy Bypass -File infra\anvil\tests\test_windows_scripts.ps1
#
# Revision History: 1.0.0 | 2026-09-27 | Initial checks.

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$Tmp = Join-Path $env:TEMP ("s19-ps-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $Tmp | Out-Null
$script:passed = 0

function Check([string]$Name, [scriptblock]$Body) {
    & $Body
    $script:passed++
    Write-Host "PASS: $Name"
}
function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERT FAILED: $Message" }
}

# ---- parse ----------------------------------------------------------------------------------

Check "every Anvil/tools PowerShell script parses" {
    $files = @(Get-ChildItem (Join-Path $Repo "infra\anvil\*.ps1")) + @(Get-ChildItem (Join-Path $Repo "tools\*.ps1")) +
             @(Get-ChildItem (Join-Path $Repo "infra\anvil\tests\*.ps1"))
    Assert ($files.Count -ge 6) "expected at least 6 scripts, found $($files.Count)"
    foreach ($f in $files) {
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errors) | Out-Null
        Assert ($errors.Count -eq 0) "$($f.Name): $($errors -join '; ')"
    }
}

# ---- vault-get-secret.ps1 against a mock bw -------------------------------------------------

$global:BwCalls = New-Object System.Collections.ArrayList
$global:BwUnlockFailures = 0
function global:bw {
    [void]$global:BwCalls.Add(($args -join " "))
    $global:LASTEXITCODE = 0
    switch ($args[0]) {
        "unlock" {
            if ($global:BwUnlockFailures -gt 0) { $global:BwUnlockFailures--; $global:LASTEXITCODE = 1; return }
            if ($env:BW_PASSWORD -ne "master-pw" -or $env:BW_CLIENTSECRET -ne "client-secret") {
                $global:LASTEXITCODE = 1; return
            }
            return "SESSION123"
        }
        "list" {
            # A substring match and a case variant alongside the real one: `bw get <name>` would
            # hit "More than one result was found" here (vault-get-secret.sh 1.5.0).
            return '[{"id":"id-old","name":"broker-token-old"},{"id":"id-exact","name":"broker-token"},{"id":"id-case","name":"Broker-Token"}]'
        }
        "get" {
            if ($args[1] -eq "password" -and $args[2] -eq "id-exact") { return "the-real-token" }
            if ($args[1] -eq "item") { return '{"fields":[{"name":"api_key","value":"field-value"}]}' }
            $global:LASTEXITCODE = 1
            return
        }
        default { return }
    }
}

$HermesDir = Join-Path $Tmp "hermes"
New-Item -ItemType Directory -Path $HermesDir | Out-Null
[pscustomobject]@{
    ServerUrl      = "https://vw.test"
    ClientId       = "user.test"
    ClientSecret   = (ConvertTo-SecureString "client-secret" -AsPlainText -Force)
    MasterPassword = (ConvertTo-SecureString "master-pw" -AsPlainText -Force)
    CaCertPath     = ""
} | Export-Clixml -LiteralPath (Join-Path $HermesDir "vault-bootstrap.clixml")
$Vault = Join-Path $Repo "tools\vault-get-secret.ps1"

Check "vault: exact-name item resolved, isolated profile configured, locked afterwards" {
    $global:BwCalls.Clear()
    $value = & $Vault -ItemName "broker-token" -HermesDir $HermesDir 2>$null
    Assert ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
    Assert ($value -eq "the-real-token") "got '$value'"
    Assert ($global:BwCalls -contains "config server https://vw.test") "server not configured: $($global:BwCalls -join ' | ')"
    Assert ($global:BwCalls -contains "get password id-exact --session SESSION123") "not resolved by id"
    Assert ($global:BwCalls[-1] -eq "lock") "last call was '$($global:BwCalls[-1])', not lock"
}

Check "vault: bw's credentials are cleared from the environment afterwards" {
    foreach ($name in "BW_CLIENTID", "BW_CLIENTSECRET", "BW_PASSWORD", "BITWARDENCLI_APPDATA_DIR") {
        Assert (-not (Test-Path "Env:$name")) "$name still set"
    }
}

Check "vault: custom field read from the item" {
    $value = & $Vault -ItemName "broker-token" -Field "api_key" -HermesDir $HermesDir 2>$null
    Assert ($LASTEXITCODE -eq 0 -and $value -eq "field-value") "got '$value' exit $LASTEXITCODE"
}

Check "vault: two failed unlocks are retried, logging out between attempts" {
    $global:BwCalls.Clear()
    $global:BwUnlockFailures = 2
    $value = & $Vault -ItemName "broker-token" -HermesDir $HermesDir 2>$null
    Assert ($LASTEXITCODE -eq 0 -and $value -eq "the-real-token") "got '$value' exit $LASTEXITCODE"
    Assert (@($global:BwCalls | Where-Object { $_ -eq "logout" }).Count -eq 2) "expected 2 logouts"
}

Check "vault: three failures exit 1 with no value, never a partial one" {
    $global:BwUnlockFailures = 5
    $value = & $Vault -ItemName "broker-token" -HermesDir $HermesDir 2>$null
    Assert ($LASTEXITCODE -eq 1) "exit $LASTEXITCODE"
    Assert (-not $value) "returned '$value'"
    $global:BwUnlockFailures = 0
}

Check "vault: a missing bootstrap is refused" {
    $empty = Join-Path $Tmp "empty"
    New-Item -ItemType Directory -Path $empty | Out-Null
    $value = & $Vault -ItemName "broker-token" -HermesDir $empty 2>$null
    Assert ($LASTEXITCODE -eq 1 -and -not $value) "exit $LASTEXITCODE value '$value'"
}

Remove-Item Function:\bw

# ---- hermes-repo-sync.ps1 against real git repos --------------------------------------------

function Invoke-Git([string]$Dir, [string[]]$GitArgs) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & git -c user.name=test -c user.email=test@test -C $Dir @GitArgs 2>&1 | Out-Null } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed in $Dir" }
}
$origin = Join-Path $Tmp "origin.git"
$anvil = Join-Path $Tmp "anvil-checkout"
$dev = Join-Path $Tmp "dev-checkout"
Invoke-Git $Tmp @("init", "--bare", "-b", "master", $origin)
Invoke-Git $Tmp @("clone", $origin, $dev)
Set-Content -LiteralPath (Join-Path $dev "a.txt") -Value "1"
Invoke-Git $dev @("add", "a.txt"); Invoke-Git $dev @("commit", "-m", "one"); Invoke-Git $dev @("push", "origin", "master")
Invoke-Git $Tmp @("clone", $origin, $anvil)
$SyncLogs = Join-Path $Tmp "sync-logs"
$Sync = Join-Path $Repo "infra\anvil\hermes-repo-sync.ps1"

function Invoke-Sync {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Sync -Repo $anvil `
        -Services "HermesNoSuchService" -LogDir $SyncLogs 2>&1
    return $LASTEXITCODE
}
function Get-SyncLog { if (Test-Path (Join-Path $SyncLogs "repo-sync.log")) { return @(Get-Content (Join-Path $SyncLogs "repo-sync.log")) } return @() }

Check "repo-sync: nothing new is a silent no-op" {
    Assert ((Invoke-Sync) -eq 0) "non-zero exit"
    Assert ((Get-SyncLog).Count -eq 0) "logged on a no-op"
}

Check "repo-sync: a new commit is fast-forwarded and a missing service skipped, not fatal" {
    Set-Content -LiteralPath (Join-Path $dev "a.txt") -Value "2"
    Invoke-Git $dev @("commit", "-am", "two"); Invoke-Git $dev @("push", "origin", "master")
    Assert ((Invoke-Sync) -eq 0) "non-zero exit"
    Assert ((Get-Content (Join-Path $anvil "a.txt")) -eq "2") "checkout not updated"
    $log = (Get-SyncLog) -join "`n"
    Assert ($log -match "pulled \w+ -> \w+") "no pulled line: $log"
    Assert ($log -match "HermesNoSuchService not installed -- skipped") "service not reported: $log"
}

Check "repo-sync: a diverged checkout fails loudly instead of merging" {
    Set-Content -LiteralPath (Join-Path $anvil "local.txt") -Value "local"
    Invoke-Git $anvil @("add", "local.txt"); Invoke-Git $anvil @("commit", "-m", "local edit")
    Set-Content -LiteralPath (Join-Path $dev "a.txt") -Value "3"
    Invoke-Git $dev @("commit", "-am", "three"); Invoke-Git $dev @("push", "origin", "master")
    Assert ((Invoke-Sync) -eq 1) "diverged pull did not fail"
    Assert (((Get-SyncLog) -join "`n") -match "ERROR: git pull --ff-only failed") "failure not logged"
}

Write-Host ""
Write-Host "$script:passed checks passed (scratch in $Tmp)"
