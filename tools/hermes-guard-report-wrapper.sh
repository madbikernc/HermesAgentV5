#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-guard-report.service. Fetches the two secrets this reporter needs
# from Vaultwarden and execs it -- the same wrapper pattern every other service in this fleet uses.
#
# It holds a hermes-memory token (to read the guard verdict log) and the shared FleetOps Matrix
# credential (to post the report). Deliberately nothing else: this component only ever reads
# verdicts and writes a chat message, and must never be able to change screening behaviour.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

export FLEETOPS_MATRIX_TOKEN
FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password || true)"

export FLEETOPS_ROOM
FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room || true)"

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-guard-report.py" "$@"
