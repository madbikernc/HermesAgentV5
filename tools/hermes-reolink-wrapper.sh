#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-reolink.service. Fetches BUZZ_TOKEN, MEMORY_TOKEN, and GUARD_TOKEN
# from Vaultwarden, exports them, then `exec`s the Reolink camera agent under its dedicated venv
# (reolink_aio is not in the shared system Python) — same fetch-then-exec pattern every other
# Buzz-subscriber service in this fleet already uses (see tools/hermes-nest-wrapper.sh).
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"
REOLINK_PYTHON="${REOLINK_PYTHON:-/opt/hermes/venvs/reolink/bin/python3}"

export BUZZ_TOKEN
BUZZ_TOKEN="$("$VAULT_GET" buzz-token password)"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

if GUARD_TOKEN="$("$VAULT_GET" guard-token password 2>/dev/null)"; then
  export GUARD_TOKEN
else
  echo "[hermes-reolink-wrapper] guard-token not in vault — this agent's own Layer 2 pass skipped" >&2
fi

exec "$REOLINK_PYTHON" "$REPO_DIR/tools/hermes-reolink.py"
