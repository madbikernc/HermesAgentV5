#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-nest.service. Fetches BUZZ_TOKEN, MEMORY_TOKEN, and GUARD_TOKEN
# from Vaultwarden, exports them, then `exec`s the nest camera agent — same fetch-then-exec
# pattern every other Buzz-subscriber service in this fleet already uses (see
# tools/hermes-probe-wrapper.sh). The agent itself runs under the system Python (like every other
# specialist) — only tools/hermes-nest-framegrab.py needs the dedicated /opt/hermes/venvs/nest/
# venv, and it's invoked directly by hermes-nest.py via FRAMEGRAB_PYTHON, not via this wrapper.
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
  echo "[hermes-nest-wrapper] guard-token not in vault — this agent's own Layer 2 pass skipped" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-nest.py"
