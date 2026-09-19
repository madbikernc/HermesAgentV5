#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-self-repair-promote-gate.service. Fetches this worker's secrets from
# Vaultwarden and exports them, then `exec`s the gate — same pattern as every other wrapper in this
# fleet. Deliberately does NOT fetch or export anything GitHub-credential-shaped — this component
# only ever reads/posts Matrix messages and writes hermes-memory task state, never touches git.
# See tools/hermes-self-repair-promote-gate.py's own header for the full boundary.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

export FLEETOPS_MATRIX_TOKEN
FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password)"

export FLEETOPS_ROOM
FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room)"

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-self-repair-promote-gate.py"
