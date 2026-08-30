#!/usr/bin/env bash
# Version: 1.0.2
#
# 1.0.2 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default and the spark-2
# promotion SSH command's `cd` target repointed from HermesAgentV4 to HermesAgentV5.
#
# 1.0.1 — real bug caught on first live test: MATRIX_URL's default was copied from scripts that
# always run on Watch (loopback correct there); this script runs on Forge, where loopback silently
# pointed at nothing. Continuwuity binds 0.0.0.0:6167 and ufw already allows the whole /24 through,
# so the LAN IP default just works.
#
# hermes-dispatch-standby-check.sh — HermesAgentV5 S12, target §11.2 rung 2 ("idle standby
# dispatcher on Node B, activating on heartbeat loss"). Runs on Forge (spark-2), watches Watch's
# hermes-dispatch.py heartbeat (agent_state "dispatch"/"heartbeat" in hermes-memory, written every
# HEARTBEAT_INTERVAL_SECONDS by hermes-dispatch.py 1.1.0+) for staleness.
#
# Deliberately does NOT auto-start a competing dispatcher on staleness. hermes-buzz's claim
# exclusivity would make two simultaneously-active dispatchers *safe* (no double-processing — only
# one instance can claim a given message), but "safe" isn't the same bar as this fleet uses
# elsewhere for anything that changes live topology: pfSense stays read-only, hermes-forge-
# residency.py's drain/restore stays a CLI a human runs, model deactivation stayed manual (S8).
# Same call here — detection is automatic, promotion is one copy-pasteable command a human runs
# after actually looking at why the primary went quiet, same shape as every other real-time
# FleetOps alert in this fleet (hermes-buzz-lockup-check.sh, hermes-fabrication-guard.sh).
#
# Two conditions, each cooldown-gated so a persisting problem is reported once, not every cycle:
#   1. hermes-memory itself unreachable from here — can't even check. Framed honestly: if Watch's
#      own memory service is down, Buzz almost certainly is too (both live on Watch, target §11.1's
#      own "accepted current state" already covers a full Node A outage), so the promotion command
#      below won't work either until Watch itself is back — this alert says that explicitly rather
#      than dangling a command that would just fail.
#   2. hermes-memory reachable, but the heartbeat key is stale (or has never been written) beyond
#      STALE_THRESHOLD_SECONDS — Watch itself is up but the dispatcher process specifically is
#      stuck or gone in a way systemd's own Restart=always isn't fixing. This is the real
#      standby-promotion case; the alert includes the exact command.
#
# Usage: hermes-dispatch-standby-check.sh
# Exit 0: healthy. Exit 1: at least one problem found (and reported, subject to cooldown).
# Requires: tools/vault-get-secret.sh, jq, curl. Deploy via
# infra/hermes-dispatch/hermes-dispatch-standby-check.service/.timer on Forge (spark-2) — see that
# README for the full promotion runbook.
set -uo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
SPARK_IP="${SPARK_LAN_IP:-10.129.1.15}"
SPARK2_IP="${SPARK2_LAN_IP:-10.129.1.17}"
MEMORY_URL="${MEMORY_URL:-http://${SPARK_IP}:8102}"
# Unlike hermes-buzz-lockup-check.sh/hermes-fabrication-guard.sh (which both always run on Watch,
# co-located with Continuwuity), this script is designed to run on Forge — so the loopback default
# every other Matrix-notifying script in this fleet uses would be wrong here. Continuwuity binds
# 0.0.0.0:6167 and ufw already allows the whole /24 through to it, so the LAN IP just works.
MATRIX_URL="${MATRIX_URL:-http://${SPARK_IP}:6167}"
NOTICE_COOLDOWN="${DISPATCH_STANDBY_NOTICE_COOLDOWN:-3600}"
STALE_THRESHOLD_SECONDS="${DISPATCH_STANDBY_STALE_THRESHOLD:-120}"  # 4x HEARTBEAT_INTERVAL_SECONDS

STATE_DIR="/home/pmoney/.hermes/dispatch-standby-check"
mkdir -p "$STATE_DIR"

log() { echo "[hermes-dispatch-standby-check] $*"; }

MEMORY_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" memory-token password 2>/dev/null)"
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
    curl -sf -K - -X PUT "$MATRIX_URL/_matrix/client/v3/rooms/$room_enc/send/m.room.message/dispatch-standby-$key-$(date +%s%N)" \
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

PROMOTE_CMD="ssh spark-2 'cd ~/HermesAgentV5 && CLAIMANT=hermes-dispatch-standby ROUTER_URL=http://${SPARK_IP}:8080 DISPATCH_CHAT_URL=http://${SPARK_IP}:8097/v1/chat/completions BUZZ_URL=http://${SPARK_IP}:8101 MEMORY_URL=http://${SPARK_IP}:8102 GUARD_URL=http://${SPARK_IP}:8096 BUZZ_TOKEN=\$(./tools/vault-get-secret.sh buzz-token password) MEMORY_TOKEN=\$(./tools/vault-get-secret.sh memory-token password) GUARD_TOKEN=\$(./tools/vault-get-secret.sh guard-token password) python3 tools/hermes-dispatch.py'"

problems=0

heartbeat_resp="$(curl -sf --max-time 10 "$MEMORY_URL/state/dispatch/heartbeat" \
  -H "Authorization: Bearer $MEMORY_TOKEN" 2>/dev/null)"
curl_status=$?

if [ "$curl_status" -ne 0 ]; then
  notice "memory-unreachable" "[dispatch-standby-check] hermes-memory is unreachable from Forge at $MEMORY_URL — cannot check the dispatch heartbeat at all. This usually means Watch itself (not just the dispatcher process) is down, per target §11.1's accepted-outage case; the standby promotion command needs Buzz/memory reachable and won't work until Watch is back. Investigate Watch before promoting anything."
  problems=1
elif ! echo "$heartbeat_resp" | jq -e '.updated_at' >/dev/null 2>&1; then
  notice "heartbeat-missing" "[dispatch-standby-check] hermes-memory is reachable but has no 'dispatch'/'heartbeat' key at all — either hermes-dispatch has never run since S12's heartbeat was added, or the key was cleared. Not necessarily an outage; check hermes-dispatch.service on Watch by hand."
  problems=1
else
  updated_at="$(echo "$heartbeat_resp" | jq -r '.updated_at')"
  who="$(echo "$heartbeat_resp" | jq -r '.value')"
  now="$(date +%s)"
  age=$(( now - ${updated_at%.*} ))
  if [ "$age" -gt "$STALE_THRESHOLD_SECONDS" ]; then
    notice "heartbeat-stale" "[dispatch-standby-check] dispatch heartbeat is ${age}s old (last written by '$who', threshold ${STALE_THRESHOLD_SECONDS}s) — hermes-memory/Buzz are reachable, so Watch itself looks up, but hermes-dispatch specifically may be stuck (systemd's Restart=always doesn't catch a hang, only a crash). To promote a standby on Forge, run: $PROMOTE_CMD — see infra/hermes-dispatch/README.md for the full runbook, including how to stand it back down once the primary recovers."
    problems=1
  else
    clear_cooldown "memory-unreachable"
    clear_cooldown "heartbeat-missing"
    clear_cooldown "heartbeat-stale"
    log "healthy — dispatch heartbeat ${age}s old (last written by '$who')"
  fi
fi

exit "$problems"
