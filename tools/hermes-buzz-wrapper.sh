#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# systemd ExecStart for hermes-buzz.service. Fetches Buzz's secrets from
# Vaultwarden, exports them as real process environment variables, then
# `exec`s the service — replacing this shell rather than forking, so secrets
# exist only in the final process's environment block and never touch disk.
#
# Same pattern as tools/hermes-broker-wrapper.sh, for the same reason
# (IMPLEMENTATION_PLAN.md §2b).
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export BUZZ_TOKEN
BUZZ_TOKEN="$("$VAULT_GET" buzz-token password)"

if FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password 2>/dev/null)"; then
  export FLEETOPS_MATRIX_TOKEN
  BUZZLOG_ROOM="$("$VAULT_GET" matrix-fleetops buzzlog_room 2>/dev/null || true)"
  [ -n "${BUZZLOG_ROOM:-}" ] && export BUZZLOG_ROOM
else
  echo "[hermes-buzz-wrapper] matrix-fleetops not in vault yet — starting without BuzzLog mirroring" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-buzz.py"
