#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-game-admin.service. Fetches BUZZ_TOKEN, MEMORY_TOKEN, and
# GUARD_TOKEN from Vaultwarden, exports them, then `exec`s the game-admin agent — same
# fetch-then-exec pattern every other Buzz-subscriber service in this fleet already uses
# (copied from tools/hermes-status-wrapper.sh). hermes-game-admin.py itself runs under the plain
# system interpreter (stdlib + hermes_injection_guard + paramiko, same requirement
# hermes-game-server-monitor.py already has); the Zomboid "Zomboid Admin - muncraft" vault
# credential is fetched by hermes-game-server-monitor.py's own vault_get(), reused via import —
# no separate credential setup needed here.
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
  echo "[hermes-game-admin-wrapper] guard-token not in vault — this agent's own Layer 2 pass skipped" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-game-admin.py"
