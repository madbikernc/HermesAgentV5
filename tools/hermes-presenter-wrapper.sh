#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# systemd ExecStart for hermes-presenter.service. Fetches the presenter's Matrix credentials plus
# BUZZ_TOKEN/MEMORY_TOKEN from Vaultwarden, exports them, then `exec`s the presenter — same
# fetch-then-exec pattern every other service in this fleet already uses.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export MATRIX_USER_ID
MATRIX_USER_ID="$("$VAULT_GET" matrix-presenter username)"

export MATRIX_ACCESS_TOKEN
MATRIX_ACCESS_TOKEN="$("$VAULT_GET" matrix-presenter password)"

export MATRIX_HOMESERVER
MATRIX_HOMESERVER="$("$VAULT_GET" matrix-presenter homeserver)"

export BUZZ_TOKEN
BUZZ_TOKEN="$("$VAULT_GET" buzz-token password)"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-presenter.py"
