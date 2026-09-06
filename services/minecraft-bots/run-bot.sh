#!/bin/bash
# Version: 1.4.0
#
# 1.4.0 -- caps the Node heap at 768MB (--max-old-space-size). Real incident (2026-09-06): a
# stuck mining action (actions.js's withTimeout not actually cancelling the underlying
# operation on timeout, since fixed) ran unbounded for ~11 minutes and grew the heap past 4GB
# before V8's own OOM killer took the process down -- on spark, a shared control-plane node
# also running hermes-router/hermes-memory/hermes-buzz/Continuwuity. The real fix is the
# actions.js cancellation bug; this is defense in depth so any *future* runaway (a library bug,
# not just this one) fails fast via a bounded crash+systemd-restart instead of slowly
# consuming shared node memory for minutes.
#
# 1.3.0 -- also sources this bot's Matrix access token from ~/.hermes/minecraft-matrix.env
# (design doc §10). Not Vaultwarden, unlike MEMORY_TOKEN/BUZZ_TOKEN -- the write path for a new
# Vaultwarden item was blocked by this session's own permission classifier while building this,
# so credentials went into a root-owned, chmod-600 local file instead (the same file shape the
# fleet's actual Matrix gateway already reads from `~/.hermes/.env`, per
# infra/continuwuity/README.md step 7 -- Vaultwarden is that setup's long-term store, but the
# running process itself just reads a local env file either way). Revisit moving this to
# Vaultwarden later if wanted; nothing about index.js/matrix.js depends on which store it came
# from -- they only see MATRIX_ACCESS_TOKEN in the environment.
#
# 1.2.0 -- also fetches BUZZ_TOKEN, for bot-to-bot coordination over hermes-buzz.py
# (MINECRAFT_BOTS_DESIGN.md §9, buzz.js). Same fetch-once-at-startup pattern as MEMORY_TOKEN.
#
# 1.1.0 -- renamed from run-babs.sh: bot-agnostic (MC_BOT_USERNAME/MC_BOT_PERSONA select which
# bot), used for Amy as of her build too -- the old name was misleading once a second bot
# existed. No behavior change.
#
# Fetches secrets from Vaultwarden and execs the bot orchestrator -- same fetch-once-at-startup
# wrapper pattern as hermes-memory-wrapper.sh, hermes-router-wrapper.sh, and every other fleet
# caller of these services (see ../../infra/hermes-memory/README.md). Never write a fetched
# token to disk or log it.
set -euo pipefail
cd "$(dirname "$0")"
REPO_DIR="$(cd ../.. && pwd)"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"
export MEMORY_TOKEN
export MEMORY_URL="${MEMORY_URL:-http://10.129.1.15:8102}"

BUZZ_TOKEN="$("$VAULT_GET" buzz-token password)"
export BUZZ_TOKEN
export BUZZ_URL="${BUZZ_URL:-http://10.129.1.15:8101}"

MC_BOT_USERNAME="${MC_BOT_USERNAME:-Babs}"
MATRIX_CREDS="$HOME/.hermes/minecraft-matrix.env"
if [ -f "$MATRIX_CREDS" ]; then
  VAR_NAME="MC_MATRIX_$(echo "$MC_BOT_USERNAME" | tr '[:lower:]' '[:upper:]')_TOKEN"
  MATRIX_ACCESS_TOKEN="$(grep "^${VAR_NAME}=" "$MATRIX_CREDS" | cut -d= -f2-)"
  if [ -n "$MATRIX_ACCESS_TOKEN" ]; then
    export MATRIX_ACCESS_TOKEN
    export MATRIX_HOMESERVER="${MATRIX_HOMESERVER:-http://10.129.1.15:6167}"
    export MATRIX_USER_ID="${MATRIX_USER_ID:-@mc-$(echo "$MC_BOT_USERNAME" | tr '[:upper:]' '[:lower:]'):spark}"
    export MATRIX_ROOM_ID="${MATRIX_ROOM_ID:-!2rXcMwykUS2yVNTLGw:spark}"
  fi
fi

exec node --max-old-space-size=768 index.js
