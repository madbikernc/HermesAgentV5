#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# systemd ExecStart for hermes-broker.service. Fetches the broker's secrets from
# Vaultwarden, exports them as real process environment variables, then `exec`s
# the broker — replacing this shell rather than forking, so the secrets exist
# only in the final process's environment block and never touch disk.
#
# Same pattern as tools/hermes-gateway-wrapper.sh, for the same reason
# (IMPLEMENTATION_PLAN.md §2b). Accepted trade-off, identical to that one:
# Vaultwarden must be reachable for every broker start, not just initial setup.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export BROKER_TOKEN
BROKER_TOKEN="$("$VAULT_GET" broker-token password)"

# The @fleetops Matrix account is provisioned separately by The Boss (creating a
# Matrix account needs registration reopened or the admin account, neither of
# which this node holds — §5 constraint 3). Until that item exists, the broker
# still runs: jobs complete and artifacts are stored, only delivery is skipped.
if FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password 2>/dev/null)"; then
  export FLEETOPS_MATRIX_TOKEN
  FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room 2>/dev/null || true)"
  [ -n "${FLEETOPS_ROOM:-}" ] && export FLEETOPS_ROOM
else
  echo "[hermes-broker-wrapper] matrix-fleetops not in vault yet — starting without delivery" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-broker.py"
