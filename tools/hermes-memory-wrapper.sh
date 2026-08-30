#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# systemd ExecStart for hermes-memory.service. Fetches MEMORY_TOKEN from Vaultwarden, exports it
# as a real process environment variable, then `exec`s the memory service — replacing this shell
# rather than forking, so the secret exists only in the final process's environment block and
# never touches disk. Same pattern as hermes-broker-wrapper.sh, for the same reason
# (IMPLEMENTATION_PLAN.md §2b).
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"
PYTHON="${MEMORY_PYTHON:-/opt/hermes/venvs/rag/bin/python3}"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

exec "$PYTHON" "$REPO_DIR/tools/hermes-memory.py"
