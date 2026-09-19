#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-self-repair-apply.service. Fetches this worker's secrets from
# Vaultwarden and exports them as real process environment variables, then `exec`s the worker —
# same pattern as hermes-remediate-worker-wrapper.sh, which this is closely modeled on.
#
# Deliberately does NOT fetch or export anything GitHub-credential-shaped — this worker pushes only
# to GIT_REMOTE (default nas2-selfrepair), never origin. If a future edit to this wrapper ever adds
# a GitHub token/credential fetch, that defeats the entire point of Step 3's isolation boundary —
# see tools/hermes-self-repair-apply.py's own header and infra/hermes-self-repair/README.md.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export BROKER_TOKEN
BROKER_TOKEN="$("$VAULT_GET" broker-token password)"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

if FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password 2>/dev/null)"; then
  export FLEETOPS_MATRIX_TOKEN
  FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room 2>/dev/null || true)"
  [ -n "${FLEETOPS_ROOM:-}" ] && export FLEETOPS_ROOM
else
  echo "[hermes-self-repair-apply-wrapper] matrix-fleetops not in vault — FleetOps escalation notices disabled" >&2
fi

if EMAIL_PASSWORD="$("$VAULT_GET" email-sintra password 2>/dev/null)"; then
  export EMAIL_PASSWORD
  export EMAIL_FROM="mercury@canislupisnc.net"
else
  echo "[hermes-self-repair-apply-wrapper] email-sintra not in vault — escalation email disabled" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-self-repair-apply.py"
