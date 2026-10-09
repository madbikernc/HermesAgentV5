#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-model-scout.service (S20's daily pass). Fetches this component's
# secrets from Vaultwarden and exports them, then `exec`s the scout — the same wrapper pattern
# every other service in this fleet uses, and deliberately the same two secrets as
# hermes-self-repair-promote-gate-wrapper.sh: a hermes-memory token and the shared FleetOps
# Matrix credential. Nothing else. This component holds no model-download credential, no GitHub
# credential, and no benchmark-execution rights.
#
# The FleetOps pair is fetched best-effort rather than required: hermes-model-scout.py degrades to
# logging its offers when the credential is absent, and a lost notice must never cost a tracked
# backlog entry.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

export FLEETOPS_MATRIX_TOKEN
FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password || true)"

export FLEETOPS_ROOM
FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room || true)"

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-model-scout.py" "$@"
