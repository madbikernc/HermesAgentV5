#!/usr/bin/env bash
# Version: 1.0.0
#
# systemd ExecStart for hermes-self-repair-minecraft-bridge.service. Fetches BUZZ_TOKEN and
# MEMORY_TOKEN from Vaultwarden, exports them, then `exec`s the bridge — same fetch-then-exec
# pattern every other Buzz-subscriber service in this fleet already uses (see
# tools/hermes-self-repair-generate-wrapper.sh). No BROKER_TOKEN, no GUARD_TOKEN: this process
# never talks to the broker, and never screens anything itself — whatever it submits is screened
# by hermes-self-repair-generate.py the same way any human-submitted task already is.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export BUZZ_TOKEN
BUZZ_TOKEN="$("$VAULT_GET" buzz-token password)"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-self-repair-minecraft-bridge.py"
