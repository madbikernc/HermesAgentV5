#!/usr/bin/env bash
# Version: 1.1.0
#
# 1.1.0 (2026-10-21, S33 fix): hermes-guard-report.py 1.4.0 reads memory.db directly, read-only,
# instead of calling hermes-memory over HTTP -- a local file open needs no bearer token, so the
# memory-token vault fetch is gone. Comment below updated to match; it only ever quoted the two
# secrets this wrapper actually fetches, now one.
#
# systemd ExecStart for hermes-guard-report.service. Fetches the FleetOps Matrix credential this
# reporter needs to post its summary, and execs it -- the same wrapper pattern every other
# service in this fleet uses.
#
# Deliberately nothing else: this component only ever reads verdicts (from a local read-only
# file, no credential needed) and writes a chat message, and must never be able to change
# screening behaviour.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export FLEETOPS_MATRIX_TOKEN
FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password || true)"

export FLEETOPS_ROOM
FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room || true)"

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-guard-report.py" "$@"
