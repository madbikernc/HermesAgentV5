#!/usr/bin/env bash
# Version: 1.1.0
#
# 1.1.0 (2026-09-02) — real bug found live on first deploy: hermes-nest.py's pubsub_listener()
# runs the Pub/Sub subscriber IN-PROCESS, as a background thread, not as a subprocess -- only the
# WebRTC frame-grab is isolated that way. The original 1.0.0 assumption ("only
# hermes-nest-framegrab.py needs the venv") was wrong: this process itself needs
# google-cloud-pubsub/google-auth too, and ran under /usr/bin/python3 with neither installed --
# ModuleNotFoundError killed the pubsub_listener thread on every startup (confirmed in the journal
# the moment this was actually deployed). Fixed to exec the same /opt/hermes/venvs/nest/ venv
# hermes-nest-framegrab.py already uses (it has all four packages -- aiortc, google-cloud-pubsub,
# google-auth, Pillow -- installed together already, no second venv needed).
#
# systemd ExecStart for hermes-nest.service. Fetches BUZZ_TOKEN, MEMORY_TOKEN, and GUARD_TOKEN
# from Vaultwarden, exports them, then `exec`s the nest camera agent under its venv — same
# fetch-then-exec pattern every other Buzz-subscriber service in this fleet already uses (see
# tools/hermes-probe-wrapper.sh).
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"
NEST_PYTHON="${NEST_PYTHON:-/opt/hermes/venvs/nest/bin/python3}"

export BUZZ_TOKEN
BUZZ_TOKEN="$("$VAULT_GET" buzz-token password)"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

if GUARD_TOKEN="$("$VAULT_GET" guard-token password 2>/dev/null)"; then
  export GUARD_TOKEN
else
  echo "[hermes-nest-wrapper] guard-token not in vault — this agent's own Layer 2 pass skipped" >&2
fi

exec "$NEST_PYTHON" "$REPO_DIR/tools/hermes-nest.py"
