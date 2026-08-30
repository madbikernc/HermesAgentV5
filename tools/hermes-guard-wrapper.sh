#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# systemd ExecStart for hermes-guard.service. Fetches GUARD_TOKEN from Vaultwarden, exports it as
# a real process environment variable, then `exec`s the guard service — replacing this shell
# rather than forking, so the secret exists only in the final process's environment block and
# never touches disk. Same pattern as hermes-broker-wrapper.sh.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"
PYTHON="${GUARD_PYTHON:-/opt/benchmark-venv/bin/python3}"

export GUARD_TOKEN
GUARD_TOKEN="$("$VAULT_GET" guard-token password)"

exec "$PYTHON" "$REPO_DIR/tools/hermes-guard.py"
