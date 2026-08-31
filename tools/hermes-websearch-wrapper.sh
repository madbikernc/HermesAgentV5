#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-websearch.service. Fetches BUZZ_TOKEN, MEMORY_TOKEN, GUARD_TOKEN,
# and TAVILY_API_KEY from Vaultwarden, exports them, then `exec`s the internet-search fallback
# agent — same fetch-then-exec pattern every other Buzz-subscriber service in this fleet already
# uses. TAVILY_API_KEY is the one existing vault item, `password` field, no per-node scoping —
# same shared, non-`<node>`-suffixed item name tools/hermes-gateway-wrapper.sh already fetches for
# the retired v1-era gateway's built-in `web` toolset.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export BUZZ_TOKEN
BUZZ_TOKEN="$("$VAULT_GET" buzz-token password)"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

export TAVILY_API_KEY
TAVILY_API_KEY="$("$VAULT_GET" TAVILY_API_KEY password)"

if GUARD_TOKEN="$("$VAULT_GET" guard-token password 2>/dev/null)"; then
  export GUARD_TOKEN
else
  echo "[hermes-websearch-wrapper] guard-token not in vault — this agent's own Layer 2 pass skipped" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-websearch.py"
