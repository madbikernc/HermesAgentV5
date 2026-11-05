#!/usr/bin/env bash
# Version: 1.1.0
#
# 1.1.0 (2026-11-04) — after stopping an idle role, restarts any always-resident backend
# hermes-model-wake-worker.py 1.7.0 displaced to make room for it (listed in
# WAKE_STATE_DIR/<role>.displaced), so super comes back once log-analyst idles out.
#
# hermes-model-idle-sleep — stops an on-demand model backend after it's sat idle too long
# (IMPLEMENTATION_PLAN.md §4a, §6 Stage 2). Companion to hermes-model-wake-worker.py, which
# touches WAKE_STATE_DIR/<role>.last_used on every wake (including "already warm"). Deliberately
# a separate, timer-triggered script rather than a background thread in the wake worker or the
# router — a stuck/crashed wake worker must not also mean a `super` that never sleeps again.
#
# Runs locally on the node hosting the on-demand backend (today: `spark`, for `super`) — no
# cross-node privilege needed, same as the wake worker.
#
# Usage: hermes-model-idle-sleep.sh <role> <systemd-unit> [idle-seconds]
#   idle-seconds defaults to 900 (15 minutes).
#
# Intended as a systemd .timer target (e.g. every 5 minutes), one instance per on-demand role —
# see infra/hermes-router/hermes-super-idle-sleep.timer.template.
set -euo pipefail

ROLE="${1:?usage: hermes-model-idle-sleep.sh <role> <systemd-unit> [idle-seconds]}"
UNIT="${2:?usage: hermes-model-idle-sleep.sh <role> <systemd-unit> [idle-seconds]}"
IDLE_SECONDS="${3:-900}"

STATE_DIR="${WAKE_STATE_DIR:-$HOME/.hermes/state/wake}"
LAST_USED_FILE="$STATE_DIR/$ROLE.last_used"

log() { echo "[hermes-model-idle-sleep] $*"; }

DISPLACED_FILE="$STATE_DIR/$ROLE.displaced"

restore_displaced() {
  [ -f "$DISPLACED_FILE" ] || return 0
  while read -r displaced; do
    [ -n "$displaced" ] || continue
    log "restarting $displaced, displaced earlier to make room for $ROLE"
    sudo systemctl start "$displaced"
  done < "$DISPLACED_FILE"
  rm -f "$DISPLACED_FILE"
}

if ! sudo systemctl is-active --quiet "$UNIT"; then
  restore_displaced  # stopped some other way (crash, manual stop) -- still owes the restart
  exit 0
fi

if [ ! -f "$LAST_USED_FILE" ]; then
  log "$ROLE ($UNIT) is active but has no last_used record — leaving it alone, not guessing"
  exit 0
fi

LAST_USED="$(cat "$LAST_USED_FILE")"
NOW="$(date +%s)"
IDLE="$(python3 -c "print(int($NOW - $LAST_USED))")"

if [ "$IDLE" -ge "$IDLE_SECONDS" ]; then
  log "$ROLE ($UNIT) idle for ${IDLE}s (>= ${IDLE_SECONDS}s) — stopping"
  sudo systemctl stop "$UNIT"
  restore_displaced
else
  log "$ROLE ($UNIT) idle for ${IDLE}s (< ${IDLE_SECONDS}s) — leaving it running"
fi
