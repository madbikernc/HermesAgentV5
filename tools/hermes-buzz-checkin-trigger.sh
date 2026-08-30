#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default and the check-in
# prompt's `hermes-buzz.sh send` path repointed from HermesAgentV4 to HermesAgentV5.
#
# hermes-buzz-checkin-trigger.sh — real, external "consider checking in with the other identity
# over Buzz" trigger, direct request (IMPLEMENTATION_PLAN.md Stage 8): Sintra and Amy shouldn't
# need The Boss to prompt them to talk to each other. hermes-buzz-watch.sh already closes the
# reactive half of that gap (nudges when a real message is waiting) — this closes the proactive
# half, encouraging an occasional check-in even when neither owes the other a reply.
#
# Same "never the persona, real inbound Matrix event, no special invocation path" pattern as
# hermes-wiki-checkin-trigger.sh, posted as @hermes-ops-ctl:spark for the same self-sender-filter
# reason. Unlike that script, this one DOES set m.mentions.user_ids (MSC3952) on the post —
# hermes-buzz-watch.sh 1.2.0 found live that a fresh, non-thread message into one of these same
# home rooms is silently dropped with no error anywhere unless it carries a real @mention
# (MATRIX_REQUIRE_MENTION, default true); building this fresh, there's no reason to repeat a bug
# already root-caused once. (hermes-wiki-checkin-trigger.sh itself predates that finding and may
# have the same latent gap — worth auditing separately; not touched here.)
#
# Deliberately just a suggestion, not a task: the prompt below explicitly says checking in is
# optional and low-stakes, and says nothing needs to be reported to The Boss. This is a much
# higher-frequency trigger than hermes-wiki-checkin's once-daily cadence (direct request: "more
# often than daily"; every 4 hours chosen as frequent enough to feel like real ongoing contact
# without manufacturing constant chatter) — hermes-buzz-watch.sh's own rolling-window throttle
# already guards the actual Buzz channel against runaway back-and-forth if a check-in happens to
# land mid-conversation, so no separate throttle was added here.
#
# Meant to be run by a pmoney-owned systemd timer, one instance per identity, offset so both
# aren't reasoning at once — see infra/hermes-buzz/hermes-buzz-checkin@.service and its two
# .timer units.
#
# Usage: hermes-buzz-checkin-trigger.sh <sintra|amy>
# Requires: tools/vault-get-secret.sh, jq, curl.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
MATRIX_URL="${MATRIX_URL:-http://127.0.0.1:6167}"

ME="${1:?usage: hermes-buzz-checkin-trigger.sh <sintra|amy>}"
case "$ME" in
  sintra) OTHER="Amy";    HOME_ROOM="!teSvzXTJKwZyuh8QK8:spark" ;;
  amy)    OTHER="Sintra"; HOME_ROOM="!KvSV6SCscjEO8QWjuP:spark" ;;
  *) echo "[buzz-checkin-trigger] Unknown identity '$ME' — no home room mapping" >&2; exit 1 ;;
esac

log() { echo "[buzz-checkin-trigger:$ME] $*" >&2; }

OPS_CTL_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" matrix-ops-ctl password)"
if [ -z "$OPS_CTL_TOKEN" ]; then
  log "ERROR: could not fetch matrix-ops-ctl token, exiting"
  exit 1
fi

PROMPT="SYSTEM (buzz-checkin, automated): a real external trigger, sent by a systemd timer outside your own control, not something you polled for. If you'd like, take a moment to check in with ${OTHER} over Buzz (~/HermesAgentV5/tools/hermes-buzz.sh send \"...\" — see skills/buzz/SKILL.md) — a real question, a status check, or just confirming things are running smoothly on her end is all fine. This is entirely optional and low-stakes: skip it if you're mid-task or have nothing worth saying, and don't relay this nudge or its outcome to The Boss unless asked."

txn="buzzcheckin-$(date +%s%N)"
ROOM_ID_ENC="$(jq -rn --arg s "$HOME_ROOM" '$s|@uri')"
mxid="@${ME}:spark"
resp="$(printf 'header = "Authorization: Bearer %s"\n' "$OPS_CTL_TOKEN" | \
  curl -sf -K - -X PUT "$MATRIX_URL/_matrix/client/v3/rooms/$ROOM_ID_ENC/send/m.room.message/$txn" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg body "$PROMPT" --arg mxid "$mxid" '{msgtype: "m.text", body: $body, "m.mentions": {user_ids: [$mxid]}}')")"

if [ -z "$resp" ] || ! echo "$resp" | jq -e '.event_id' >/dev/null 2>&1; then
  log "ERROR: post did not return an event_id: $resp"
  exit 1
fi
log "check-in prompt posted to $ME's home room ($HOME_ROOM), event $(echo "$resp" | jq -r '.event_id')"
