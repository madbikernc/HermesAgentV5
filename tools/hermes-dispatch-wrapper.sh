#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# systemd ExecStart for hermes-dispatch.service. Fetches BUZZ_TOKEN, MEMORY_TOKEN, and
# GUARD_TOKEN from Vaultwarden, exports them as real process environment variables, then `exec`s
# the dispatcher — replacing this shell rather than forking, so secrets exist only in the final
# process's environment block and never touch disk. Same pattern as hermes-broker-wrapper.sh.
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
  echo "[hermes-dispatch-wrapper] guard-token not in vault — dispatch's own Layer 2 pass skipped" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-dispatch.py"
