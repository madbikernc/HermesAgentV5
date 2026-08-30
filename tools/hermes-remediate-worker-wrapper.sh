#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# systemd ExecStart for hermes-remediate-worker@<identity>.service. Fetches this worker's secrets
# from Vaultwarden, exports them as real process environment variables, then `exec`s the worker —
# same pattern as hermes-buzz-wrapper.sh/hermes-broker-wrapper.sh, for the same reason
# (IMPLEMENTATION_PLAN.md §2b).
#
# One instance per node, parameterized by identity: JOB_TYPE becomes "remediate-<identity>" so this
# node's worker only ever claims jobs for the identity that actually lives here (spark ->
# remediate-sintra, spark-2 -> remediate-amy) — mirrors hermes-buzz-watch@.service's own %i pattern.
#
# Usage: hermes-remediate-worker-wrapper.sh <sintra|amy>
set -euo pipefail

IDENTITY="${1:?usage: hermes-remediate-worker-wrapper.sh <sintra|amy>}"
REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

case "$IDENTITY" in
  sintra) EMAIL_FROM_DEFAULT="mercury@canislupisnc.net"; EMAIL_ITEM="email-sintra" ;;
  amy)    EMAIL_FROM_DEFAULT="mercury2@canislupisnc.net"; EMAIL_ITEM="email-amy" ;;
  *) echo "[hermes-remediate-worker-wrapper] Unknown identity '$IDENTITY'" >&2; exit 1 ;;
esac

export JOB_TYPE="remediate-$IDENTITY"
export EMAIL_FROM="$EMAIL_FROM_DEFAULT"
export ALLOWLIST_PATH="$REPO_DIR/infra/hermes-remediate/allowlist.json"

export BROKER_TOKEN
BROKER_TOKEN="$("$VAULT_GET" broker-token password)"

if FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password 2>/dev/null)"; then
  export FLEETOPS_MATRIX_TOKEN
  FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room 2>/dev/null || true)"
  [ -n "${FLEETOPS_ROOM:-}" ] && export FLEETOPS_ROOM
else
  echo "[hermes-remediate-worker-wrapper:$IDENTITY] matrix-fleetops not in vault — FleetOps escalation notices disabled" >&2
fi

if OPS_CTL_TOKEN="$("$VAULT_GET" matrix-ops-ctl password 2>/dev/null)"; then
  export OPS_CTL_TOKEN
else
  echo "[hermes-remediate-worker-wrapper:$IDENTITY] matrix-ops-ctl not in vault — send-nudge action disabled" >&2
fi

if EMAIL_PASSWORD="$("$VAULT_GET" "$EMAIL_ITEM" password 2>/dev/null)"; then
  export EMAIL_PASSWORD
else
  echo "[hermes-remediate-worker-wrapper:$IDENTITY] $EMAIL_ITEM not in vault — escalation email disabled" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-remediate-worker.py"
