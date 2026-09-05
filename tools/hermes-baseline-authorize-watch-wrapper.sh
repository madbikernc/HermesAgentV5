#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-baseline-authorize-watch.service. Fetches this watcher's
# secrets from Vaultwarden and exports them as real process environment variables, then
# `exec`s the watcher -- same pattern as tools/hermes-remediate-worker-wrapper.sh /
# tools/hermes-buzz-wrapper.sh (IMPLEMENTATION_PLAN.md §2b).
#
# Single instance, one node only (wherever FleetOps polling already happens) -- unlike
# hermes-node-baseline-scan-wrapper.sh this takes no node-name argument.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

export BUZZ_TOKEN
BUZZ_TOKEN="$("$VAULT_GET" buzz-token password)"

export FLEETOPS_MATRIX_TOKEN
FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password)"
FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room 2>/dev/null || true)"
[ -n "${FLEETOPS_ROOM:-}" ] && export FLEETOPS_ROOM

if BROKER_TOKEN="$("$VAULT_GET" broker-token password 2>/dev/null)"; then
  export BROKER_TOKEN
else
  echo "[hermes-baseline-authorize-watch-wrapper] broker-token not in vault — service-restart routing disabled, falls back to manual-required" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-baseline-authorize-watch.py"
