#!/usr/bin/env bash
# Version: 1.1.0
#
# 1.1.0 (2026-09-05) — email identity is now per-node (spark->email-mercury,
# spark-2->email-mercury2, homed13->none), not a uniform "always try mercury@" default. Found
# live: HomeD13 has no persona and was never provisioned to decrypt any email item at all
# (vault-get-secret.sh's own per-node sealed-credential scoping, working as designed) --
# calling it anyway cost a full ~40-60s of real retries failing every single day before
# falling through gracefully. HomeD13 now skips the vault call entirely and gets a
# Matrix-only digest.
#
# systemd ExecStart for hermes-node-baseline-scan@<node>.service. Fetches this scan's secrets
# from Vaultwarden, exports them as real process environment variables, then `exec`s the
# scanner — same pattern as tools/hermes-remediate-worker-wrapper.sh /
# tools/hermes-buzz-wrapper.sh (IMPLEMENTATION_PLAN.md §2b: credentials live in Vaultwarden,
# never in a config file on disk).
#
# One instance per node, parameterized by node name so HERMES_HOME and the email "From" can
# differ per host (spark/spark-2 run under their own persona's HERMES_HOME; homed13 has no
# persona, per HERMES_AGENT_HEALTH_STATUS_REQUIREMENTS.md's own precedent for that node — see
# infra/hermes-node-baseline/README.md for the exact HERMES_HOME each node should set).
#
# Usage: hermes-node-baseline-scan-wrapper.sh <node-name>
set -euo pipefail

NODE="${1:?usage: hermes-node-baseline-scan-wrapper.sh <node-name>}"
REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

if FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password 2>/dev/null)"; then
  export FLEETOPS_MATRIX_TOKEN
  FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room 2>/dev/null || true)"
  [ -n "${FLEETOPS_ROOM:-}" ] && export FLEETOPS_ROOM
else
  echo "[hermes-node-baseline-scan-wrapper:$NODE] matrix-fleetops not in vault — FleetOps digest disabled" >&2
fi

# Per-node email identity -- NOT a uniform "always try mercury@" default. Found live
# 2026-09-05: HomeD13 has no persona and was never provisioned to decrypt ANY email item
# (vault-get-secret.sh's own per-node sealed-credential scoping, working as designed, not a
# bug) -- calling it anyway cost a full ~40-60s of retries failing every single day before
# falling through. HomeD13 gets Matrix-only digests; that's a real, known limitation (see
# README), not silently degraded.
case "$NODE" in
  spark)    EMAIL_ITEM="email-mercury" ;;
  spark-2)  EMAIL_ITEM="email-mercury2" ;;
  *)        EMAIL_ITEM="" ;;
esac

if [ -n "$EMAIL_ITEM" ]; then
  export EMAIL_FROM="${EMAIL_FROM:-$([ "$NODE" = spark-2 ] && echo mercury2@canislupisnc.net || echo mercury@canislupisnc.net)}"
  if EMAIL_PASSWORD="$("$VAULT_GET" "$EMAIL_ITEM" password 2>/dev/null)"; then
    export EMAIL_PASSWORD
  else
    echo "[hermes-node-baseline-scan-wrapper:$NODE] $EMAIL_ITEM not in vault — digest email disabled" >&2
  fi
else
  echo "[hermes-node-baseline-scan-wrapper:$NODE] no email identity configured for this node — Matrix-only digest" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-node-baseline-scan.py"
