#!/usr/bin/env bash
# Version: 1.2.0
#
# 1.2.0 (2026-11-13) — also fetches matrix-fleetops (optional, same as hermes-self-repair-apply-wrapper.sh)
# for FleetOps notices: backend outages and promoted fixes whose incident recurs (hermes-self-repair-bridge.py 2.6.0).
#
# 1.1.1 (2026-11-08) — real bug found live, first time this service was ever actually started
# (systemd: "status=203/EXEC"): this file, and its predecessor
# hermes-self-repair-minecraft-bridge-wrapper.sh before it since Phase 3's own original commit,
# had never been marked executable in git (100644, not 100755) -- latent since Phase 3, because
# nothing had ever tried to run it as a systemd ExecStart before now. Fixed with `git
# update-index --chmod=+x`; no content change.
#
# 1.1.0 (2026-11-08) — renamed from hermes-self-repair-minecraft-bridge-wrapper.sh alongside the
# bridge's own generalization (2.0.0, Phase 4/§8.4): it now serves every registered domain's
# detection source, not only minecraft-bots'.
#
# systemd ExecStart for hermes-self-repair-bridge.service. Fetches BUZZ_TOKEN and MEMORY_TOKEN
# from Vaultwarden, exports them, then `exec`s the bridge — same fetch-then-exec pattern every
# other Buzz-subscriber service in this fleet already uses (see
# tools/hermes-self-repair-generate-wrapper.sh). No BROKER_TOKEN, no GUARD_TOKEN: this process
# never talks to the broker, and never screens anything itself — whatever it submits is screened
# by hermes-self-repair-generate.py the same way any human-submitted task already is.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export BUZZ_TOKEN
BUZZ_TOKEN="$("$VAULT_GET" buzz-token password)"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

if FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password 2>/dev/null)"; then
  export FLEETOPS_MATRIX_TOKEN
  FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room 2>/dev/null || true)"
  [ -n "${FLEETOPS_ROOM:-}" ] && export FLEETOPS_ROOM
else
  echo "[hermes-self-repair-bridge-wrapper] matrix-fleetops not in vault — FleetOps notices disabled" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-self-repair-bridge.py"
