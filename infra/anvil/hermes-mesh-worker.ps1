# Version: 1.0.0
#
# hermes-mesh-worker — what the HermesMeshWorker NSSM service runs (infra/anvil/README.md step 5).
# Anvil's counterpart of tools/hermes-render-worker-wrapper.sh: fetch broker-token from the vault into
# this process's environment (never to disk), then run the same hermes-render-worker.py every other
# worker node runs, with JOB_TYPE=mesh and the rest of its config from NSSM's AppEnvironmentExtra.
#
# If the vault fetch fails this exits non-zero and NSSM restarts it after AppRestartDelay — the same
# retry shape systemd's Restart=always gives the Linux wrappers.
#
# Revision History: 1.0.0 | 2026-09-27 | Initial version (S19, operator decisions: NSSM, native bw).

param(
    [string]$Repo = "C:\hermes\HermesAgentV5",
    [string]$Python = "C:\hermes\venv\Scripts\python.exe"
)

$ErrorActionPreference = "Stop"
$token = & (Join-Path $Repo "tools\vault-get-secret.ps1") -ItemName "broker-token" -Field "password"
if ($LASTEXITCODE -ne 0 -or -not $token) {
    [Console]::Error.WriteLine("[mesh-worker] could not fetch broker-token from the vault -- not starting")
    exit 1
}
$env:BROKER_TOKEN = $token
# Output goes to NSSM's log files, not a console: without UTF-8 mode, Python on Windows encodes a
# redirected stdout in the ANSI code page and dies on the first character outside it.
$env:PYTHONUTF8 = "1"
& $Python (Join-Path $Repo "tools\hermes-render-worker.py")
exit $LASTEXITCODE
