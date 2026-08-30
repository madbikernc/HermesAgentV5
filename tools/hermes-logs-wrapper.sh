#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# systemd ExecStart for hermes-logs.service. Fetches BUZZ_TOKEN, MEMORY_TOKEN, and GUARD_TOKEN
# from Vaultwarden, exports them, then `exec`s the log analyst — same fetch-then-exec pattern
# every other Buzz-subscriber service in this fleet already uses.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export BUZZ_TOKEN
BUZZ_TOKEN="$("$VAULT_GET" buzz-token password)"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

if GUARD_TOKEN="$("$VAULT_GET" guard-token password 2>/dev/null)"; then
  export GUARD_TOKEN
else
  echo "[hermes-logs-wrapper] guard-token not in vault — this agent's own Layer 2 pass skipped" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-logs.py"
