#!/usr/bin/env bash
# Version: 1.1.0
#
# 1.1.0 (2026-11-13) — also fetches matrix-fleetops (optional, same as hermes-self-repair-apply-wrapper.sh)
# for FleetOps notices: deadlocked reviews (hermes-self-repair-generate.py 1.5.0).
#
# 1.0.1 (2026-11-07) — real bug found live, first-ever real self-repair task: this header used to
# claim "no BROKER_TOKEN needed — this agent never talks to the broker directly." False — Step 2's
# own submit_apply_job() (hermes-self-repair-generate.py, BROKER_URL/BROKER_TOKEN, its own header
# line 77) POSTs the selfrepair-apply hand-off job directly to the broker on convergence. With no
# BROKER_TOKEN in this wrapper's exported environment, that POST goes out with no Authorization
# header, is refused, the exception is caught and merely logged — so `done` was reached, a real
# diff was produced, but Step 3 never received a job and nothing ever reached nas2-selfrepair.
# Confirmed via the live process's own /proc/<pid>/environ: BUZZ_TOKEN/MEMORY_TOKEN/GUARD_TOKEN
# present, BROKER_TOKEN absent. Fixed by fetching it the same required (non-optional) way
# `hermes-self-repair-apply-wrapper.sh` already does.
#
# systemd ExecStart for hermes-self-repair-generate.service. Fetches BUZZ_TOKEN, MEMORY_TOKEN,
# GUARD_TOKEN, and BROKER_TOKEN from Vaultwarden, exports them, then `exec`s the self-repair
# generation engine — same fetch-then-exec pattern every other Buzz-subscriber service in this
# fleet already uses (see tools/hermes-dualcoder-wrapper.sh, which this was originally a near-exact
# copy of).
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
VAULT_GET="$REPO_DIR/tools/vault-get-secret.sh"

export BUZZ_TOKEN
BUZZ_TOKEN="$("$VAULT_GET" buzz-token password)"

export MEMORY_TOKEN
MEMORY_TOKEN="$("$VAULT_GET" memory-token password)"

export BROKER_TOKEN
BROKER_TOKEN="$("$VAULT_GET" broker-token password)"

if GUARD_TOKEN="$("$VAULT_GET" guard-token password 2>/dev/null)"; then
  export GUARD_TOKEN
else
  echo "[hermes-self-repair-generate-wrapper] guard-token not in vault — this agent's own Layer 2 pass skipped" >&2
fi

if FLEETOPS_MATRIX_TOKEN="$("$VAULT_GET" matrix-fleetops password 2>/dev/null)"; then
  export FLEETOPS_MATRIX_TOKEN
  FLEETOPS_ROOM="$("$VAULT_GET" matrix-fleetops room 2>/dev/null || true)"
  [ -n "${FLEETOPS_ROOM:-}" ] && export FLEETOPS_ROOM
else
  echo "[hermes-self-repair-generate-wrapper] matrix-fleetops not in vault — FleetOps notices disabled" >&2
fi

exec /usr/bin/python3 "$REPO_DIR/tools/hermes-self-repair-generate.py"
