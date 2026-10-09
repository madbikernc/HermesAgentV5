#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-model-scout-gate.service (S20c's human decision gate). Same
# pattern and the same boundary as hermes-self-repair-promote-gate-wrapper.sh, which this gate is
# modeled on: Matrix credential plus a hermes-memory token, and deliberately nothing that could
# download a model, push to a remote, or start a benchmark. The gate's entire power is "write a
# task state and post a reply."
#
# Unlike the scout's own wrapper, both secrets are required here — a gate that cannot read the
# room has no function at all, so failing loudly at start is correct.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

export FLEETOPS_MATRIX_TOKEN
FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password)"

export FLEETOPS_ROOM
FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room)"

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-model-scout-gate.py"
