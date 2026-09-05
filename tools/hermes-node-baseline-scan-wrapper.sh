#!/usr/bin/env bash
# Version: 1.0.0
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

export EMAIL_FROM="${EMAIL_FROM:-mercury@canislupisnc.net}"
if EMAIL_PASSWORD="$("$VAULT_GET" "email-${EMAIL_FROM%%@*}" password 2>/dev/null)"; then
  export EMAIL_PASSWORD
else
  echo "[hermes-node-baseline-scan-wrapper:$NODE] email-${EMAIL_FROM%%@*} not in vault — digest email disabled" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-node-baseline-scan.py"
