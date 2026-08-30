#!/usr/bin/env bash
# Version: 1.1.1
#
# 1.1.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.1.0 — HermesAgentV5 S8: removed checks 2 and 3 (both watchers active; genuine
# unanswered-message lockup for sintra/amy specifically). Both were sintra/amy-specific and both
# retired with the personas — check 2 would otherwise false-alarm forever now that
# hermes-buzz-watch@sintra/@amy are intentionally disabled, and check 3's per-agent
# unanswered-message logic has no meaning once neither agent is receiving messages. Check 1
# (Buzz itself reachable) stays and matters more than ever: hermes-dispatch.py and
# hermes-presenter.py both depend on it now. A topic/claim-based lockup check for real
# specialist topics is a later stage's concern, not built yet.
#
# hermes-buzz-lockup-check.sh — cheap, frequent (5 min) health check for the Buzz channel
# itself, built after a real near-miss (2026-08-21, IMPLEMENTATION_PLAN.md Stage 8): a Buzz
# message sat unanswered for what looked like it could have been hours before a nudge finally
# fired. It turned out to be harmless (a one-off transient poll failure, not an actual stall —
# the watcher's own idle-cycle polling is silent when nothing new has arrived, which looks
# identical to "stuck" from the outside), but there was no way to tell the two apart without
# reading raw logs by hand. This script is that check, run automatically.
#
# No model involved — same "notice cheaply" split as hermes-buzz-watch.sh and every other guard
# daemon in this fleet. One thing is checked (down from three as of 1.1.0 — see that entry):
#   1. hermes-buzz.service itself unreachable.
#
# Alerts immediately to FleetOps (real-time, not folded into hermes-fleet-health.py's once-daily
# digest — direct request, since a stuck cross-persona channel is worth knowing about the same
# day, not in tomorrow's email) — same matrix_notice()-style plain POST every other real-time
# notice in this fleet already uses, msgtype m.notice, no @mention needed (FleetOps is not
# subject to the home-room MATRIX_REQUIRE_MENTION gate hermes-buzz-watch.sh had to work around).
#
# Each distinct condition gets its own cooldown file so a persisting problem is reported once,
# not every 5 minutes — same convention as hermes-buzz-watch.sh's own throttle-notice cooldown.
#
# Usage: hermes-buzz-lockup-check.sh
# Exit 0: healthy. Exit 1: at least one problem found (and reported, subject to cooldown).
# Requires: tools/vault-get-secret.sh, jq, curl. Runs centrally as pmoney, like
# hermes-buzz-watch.sh — see infra/hermes-buzz/hermes-buzz-lockup-check.service/.timer.
set -uo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
BUZZ_URL="${BUZZ_URL:-http://10.129.1.15:8101}"
MATRIX_URL="${MATRIX_URL:-http://127.0.0.1:6167}"
NOTICE_COOLDOWN="${BUZZ_LOCKUP_NOTICE_COOLDOWN:-3600}"

STATE_DIR="/home/pmoney/.hermes/buzz-lockup-check"
mkdir -p "$STATE_DIR"

log() { echo "[hermes-buzz-lockup-check] $*"; }

FLEETOPS_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" matrix-fleetops password 2>/dev/null)"
FLEETOPS_ROOM="$("$REPO_DIR/tools/vault-get-secret.sh" matrix-fleetops room 2>/dev/null)"

# Cooldown-gated FleetOps notice: $1 = condition key (used as the cooldown file name), $2 = body.
notice() {
  local key="$1" body="$2" cooldown_file="$STATE_DIR/$1-notice-at" now last=0
  now="$(date +%s)"
  [ -f "$cooldown_file" ] && last="$(cat "$cooldown_file" 2>/dev/null || echo 0)"
  [ -n "$last" ] || last=0
  if [ $(( now - last )) -lt "$NOTICE_COOLDOWN" ]; then
    log "SUPPRESSED (cooldown): $body"
    return
  fi
  if [ -z "$FLEETOPS_TOKEN" ] || [ -z "$FLEETOPS_ROOM" ]; then
    log "WARNING: no FleetOps credentials — cannot alert, logging only: $body"
    return
  fi
  local room_enc resp
  room_enc="$(jq -rn --arg s "$FLEETOPS_ROOM" '$s|@uri')"
  resp="$(printf 'header = "Authorization: Bearer %s"\n' "$FLEETOPS_TOKEN" | \
    curl -sf -K - -X PUT "$MATRIX_URL/_matrix/client/v3/rooms/$room_enc/send/m.room.message/lockup-$key-$(date +%s%N)" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg body "$body" '{msgtype: "m.notice", body: $body}')")"
  if echo "$resp" | jq -e '.event_id' >/dev/null 2>&1; then
    echo "$now" > "$cooldown_file"
    log "ALERTED: $body"
  else
    log "ERROR: FleetOps notice post failed: $resp"
  fi
}

clear_cooldown() { rm -f "$STATE_DIR/$1-notice-at"; }

problems=0

# 1. Buzz itself.
if ! curl -sf --max-time 10 "$BUZZ_URL/health" >/dev/null 2>&1; then
  notice "buzz-down" "[buzz-lockup-check] hermes-buzz.service is unreachable at $BUZZ_URL — hermes-dispatch and hermes-presenter cannot exchange pointer envelopes at all right now."
  problems=1
else
  clear_cooldown "buzz-down"
fi

if [ "$problems" -eq 0 ]; then
  log "healthy — buzz reachable"
fi
exit "$problems"
