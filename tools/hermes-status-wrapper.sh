#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-status.service. Fetches BUZZ_TOKEN, MEMORY_TOKEN, and GUARD_TOKEN
# from Vaultwarden, exports them, then `exec`s the curated status-check agent — same fetch-then-
# exec pattern every other Buzz-subscriber service in this fleet already uses. hermes-status.py
# itself runs under the plain system interpreter (it only needs stdlib + hermes_injection_guard);
# it shells out to each backing skill's own documented venv interpreter internally, per source.
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
  echo "[hermes-status-wrapper] guard-token not in vault — this agent's own Layer 2 pass skipped" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-status.py"
