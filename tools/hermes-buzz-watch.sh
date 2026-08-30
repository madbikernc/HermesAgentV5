#!/usr/bin/env bash
# Version: 1.2.1
#
# 1.2.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default and the nudge
# prompt's `hermes-buzz.sh poll` path repointed from HermesAgentV4 to HermesAgentV5.
#
# 1.2.0 — real bug found live, 2026-08-17: "Amy has not responded to
# Sintra's question" turned out to be two independent, stacked bugs, not
# one. (1) Amy's gateway had a genuinely hung turn (a socket stuck in
# CLOSE-WAIT talking to her own local LLM backend) -- fixed by a live
# `systemctl restart hermes-gateway-amy.service`, same remedy already
# documented for this failure class. (2) Once healthy again, a second,
# freshly-posted nudge STILL produced no response -- traced by reading the
# Matrix adapter's own source directly (plugins/platforms/matrix/adapter.py)
# to MATRIX_REQUIRE_MENTION (default true): a fresh, non-thread message in
# a group-type room is silently dropped unless it carries a real @mention,
# and this nudge never did. Every nudge this watcher has ever sent was
# being gated out with no error surfaced anywhere; it only ever looked like
# it worked because a human message replying inside an existing bot thread
# (which bypasses the gate) happened to land in the same window. Fixed by
# adding a proper m.mentions.user_ids block (MSC3952) to post_matrix() --
# the adapter treats that field as authoritative regardless of body text or
# thread state. See LESSONS_LEARNED.md's dated §7 row for the full account.
#
# 1.1.0 — throttle added, direct request ("they should automatically
# answer... but we should probably have a throttle"). A watcher that always
# nudges on every new message, combined with a persona that auto-replies to
# a genuine request, is a real runaway-loop shape: Sintra answers Amy, that
# answer is itself a new message, Amy's own watcher nudges Amy to answer
# it, and so on with no natural stopping point — the same class of problem
# this project hit twice live the night Buzz was first used for real (a
# tool-call loop and a stuck-turn loop, LESSONS_LEARNED.md §7 1.29.0),
# just one layer up, between two agents instead of within one.
# Deliberately a rolling time window, not a lifetime/consecutive counter:
# a strict "stop after N alternating messages" trips once and — since
# every subsequent poll still sees that same alternating tail in Buzz's
# history — never naturally re-arms itself. A window ages out on its own:
# once the recent-message rate drops back under the cap, nudging resumes
# with no reset needed from anyone. While throttled, the cursor is
# deliberately NOT advanced -- the message still gets delivered (nudged)
# once the rate cools down, not dropped.
#
# hermes-buzz-watch.sh — lightweight watcher for one identity's Buzz inbox
# (IMPLEMENTATION_PLAN.md §7 Phase 32, tools/hermes-buzz.py/.sh). Answers
# the "how often should they check Buzz" design question directly: a plain
# script, no model involved, doing a cheap HTTP poll on a variable cadence
# and only ever producing a real agent turn when there's actually something
# new — never a fixed-interval LLM nudge regardless of content, which would
# burn a real API call on every empty check. Same "notice cheaply, respond
# only when warranted" split as the job broker and every other guard daemon
# in this fleet.
#
# Cadence: 5 minutes idle, 30 seconds when this identity is "expecting a
# reply" — derived live from Buzz's own message history each cycle (the
# single most recent message between the two agents was sent BY this
# identity, with nothing back yet), not a separate flag file. No new state
# to go stale, no cross-user permission issue writing into another
# identity's home to set a flag — hermes-buzz.sh/.py need zero changes for
# this.
#
# Runs centrally as pmoney (like hermes-wiki-checkin-trigger.sh), one
# instance per identity via the %i-templated systemd unit
# (infra/hermes-buzz/hermes-buzz-watch@.service) -- polling doesn't need
# either identity's own credentials, buzz-token is already shared, and the
# nudge trigger already has to run as the "never the persona" ops-ctl
# account regardless (same self-sender-echo-filter reason
# hermes-wiki-checkin-trigger.sh does).
#
# Usage: hermes-buzz-watch.sh <sintra|amy>
# Requires: tools/vault-get-secret.sh, jq, curl.
set -uo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
BUZZ_URL="${BUZZ_URL:-http://10.129.1.15:8101}"
MATRIX_URL="${MATRIX_URL:-http://127.0.0.1:6167}"
IDLE_INTERVAL="${BUZZ_WATCH_IDLE_INTERVAL:-300}"
EXPECTING_INTERVAL="${BUZZ_WATCH_EXPECTING_INTERVAL:-30}"
# Throttle: if more than THROTTLE_MAX_MESSAGES have been exchanged (either
# direction) in the last THROTTLE_WINDOW_SECONDS, pause nudging until the
# rate drops back under the cap. Defaults: 10 messages / 30 minutes -- a
# real, sustained back-and-forth conversation is well under this; an
# unthrottled auto-reply loop hits it within a couple of minutes.
THROTTLE_WINDOW_SECONDS="${BUZZ_WATCH_THROTTLE_WINDOW:-1800}"
THROTTLE_MAX_MESSAGES="${BUZZ_WATCH_THROTTLE_MAX:-10}"
# How often the "auto-nudging paused" notice itself is allowed to repeat --
# a separate, longer cooldown so the notice doesn't become its own spam.
THROTTLE_NOTICE_COOLDOWN="${BUZZ_WATCH_THROTTLE_NOTICE_COOLDOWN:-3600}"

ME="${1:?usage: hermes-buzz-watch.sh <sintra|amy>}"
case "$ME" in
  sintra) OTHER="amy";   HOME_ROOM="!teSvzXTJKwZyuh8QK8:spark" ;;
  amy)    OTHER="sintra"; HOME_ROOM="!KvSV6SCscjEO8QWjuP:spark" ;;
  *) echo "[hermes-buzz-watch:$ME] Unknown identity '$ME'" >&2; exit 1 ;;
esac

STATE_DIR="/home/pmoney/.hermes/buzz-watch"
CURSOR_FILE="$STATE_DIR/$ME-last-seq"
THROTTLE_NOTICE_FILE="$STATE_DIR/$ME-throttle-notice-at"
mkdir -p "$STATE_DIR"

log() { echo "[hermes-buzz-watch:$ME] $*"; }

TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" buzz-token password)"
if [ -z "$TOKEN" ]; then
  log "ERROR: could not fetch buzz-token, exiting"
  exit 1
fi
OPS_CTL_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" matrix-ops-ctl password)"
if [ -z "$OPS_CTL_TOKEN" ]; then
  log "ERROR: could not fetch matrix-ops-ctl token, exiting"
  exit 1
fi

cursor=0
[ -f "$CURSOR_FILE" ] && cursor="$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)"
[ -n "$cursor" ] || cursor=0

post_matrix() {
  local body="$1" room_enc resp mxid="@$ME:spark"
  room_enc="$(jq -rn --arg s "$HOME_ROOM" '$s|@uri')"
  # m.mentions.user_ids (MSC3952) is required here -- the adapter's own
  # MATRIX_REQUIRE_MENTION gating (default true) silently drops any fresh,
  # non-thread message with no @mention in a group-type room, and this
  # nudge is exactly that: a freestanding top-level message, not a reply
  # into an existing bot thread. Found 2026-08-17: every nudge this watcher
  # had ever sent was being gated out with no error anywhere -- it looked
  # like it worked earlier only because a *human* message ("check", sent as
  # a threaded reply, which bypasses gating via in_bot_thread) happened to
  # land in the same window. See LESSONS_LEARNED.md's dated §7 row.
  resp="$(printf 'header = "Authorization: Bearer %s"\n' "$OPS_CTL_TOKEN" | \
    curl -sf -K - -X PUT "$MATRIX_URL/_matrix/client/v3/rooms/$room_enc/send/m.room.message/buzzwatch-$(date +%s%N)" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg body "$body" --arg mxid "$mxid" '{msgtype: "m.text", body: $body, "m.mentions": {user_ids: [$mxid]}}')")"
  if [ -z "$resp" ] || ! echo "$resp" | jq -e '.event_id' >/dev/null 2>&1; then
    log "ERROR: post did not return an event_id: $resp"
    return 1
  fi
  log "posted to $ME's home room ($HOME_ROOM), event $(echo "$resp" | jq -r '.event_id')"
}

send_nudge() {
  local count="$1"
  post_matrix "SYSTEM (buzz-watch, automated): ${count} new Buzz message(s) have arrived from ${OTHER^} — a real external trigger, sent by a watcher outside your own control, not something you polled for. Check them now: ~/HermesAgentV5/tools/hermes-buzz.sh poll --since <the seq you last saw> (pass a timeout of at least 60s — see skills/buzz/SKILL.md). If it's a genuine question or request, go ahead and answer it over Buzz directly — you don't need to check with The Boss first for a routine reply. This nudge itself is not something to relay to The Boss unless asked."
}

send_throttle_notice() {
  local count="$1"
  post_matrix "SYSTEM (buzz-watch, automated): Buzz traffic with ${OTHER^} has been busy — ${count} messages in the last $((THROTTLE_WINDOW_SECONDS/60)) minutes — so automatic nudging is paused for now rather than keep the back-and-forth going unattended. Nothing is lost; waiting messages will be delivered as soon as traffic cools down. If The Boss wants this conversation to continue right now, they can prompt either of you directly."
}

log "watching (idle=${IDLE_INTERVAL}s, expecting-reply=${EXPECTING_INTERVAL}s, throttle=${THROTTLE_MAX_MESSAGES}msgs/${THROTTLE_WINDOW_SECONDS}s), cursor starts at $cursor"

while true; do
  # Expecting a reply iff the single most recent message overall was sent
  # BY this identity — i.e. it's still the other agent's move. Derived
  # fresh every cycle from Buzz's own data, not a flag either side has to
  # remember to set or clear.
  latest="$(curl -sf -H "Authorization: Bearer $TOKEN" "$BUZZ_URL/messages?limit=1" 2>/dev/null)"
  expecting=0
  if [ -n "$latest" ]; then
    from="$(echo "$latest" | jq -r '.messages[0].from_agent // empty' 2>/dev/null)"
    [ "$from" = "$ME" ] && expecting=1
  fi

  poll="$(curl -sf -H "Authorization: Bearer $TOKEN" "$BUZZ_URL/messages/poll?agent=$ME&since=$cursor&limit=50" 2>/dev/null)"
  if [ -n "$poll" ]; then
    count="$(echo "$poll" | jq '.messages | length' 2>/dev/null || echo 0)"
    if [ "${count:-0}" -gt 0 ]; then
      max_seq="$(echo "$poll" | jq '[.messages[].seq] | max' 2>/dev/null)"

      # Rolling-window throttle check: how much total Buzz traffic (either
      # direction) has there been recently, not just messages addressed to
      # $ME -- a fast loop shows up as high volume overall.
      recent="$(curl -sf -H "Authorization: Bearer $TOKEN" "$BUZZ_URL/messages?limit=50" 2>/dev/null)"
      cutoff=$(( $(date +%s) - THROTTLE_WINDOW_SECONDS ))
      recent_count="$(echo "$recent" | jq --argjson c "$cutoff" '[.messages[] | select(.created_at >= $c)] | length' 2>/dev/null || echo 0)"

      if [ "${recent_count:-0}" -ge "$THROTTLE_MAX_MESSAGES" ]; then
        # Throttled: cursor deliberately NOT advanced, so the still-unread
        # message gets nudged for real once the window cools down rather
        # than being silently dropped.
        last_notice=0
        [ -f "$THROTTLE_NOTICE_FILE" ] && last_notice="$(cat "$THROTTLE_NOTICE_FILE" 2>/dev/null || echo 0)"
        [ -n "$last_notice" ] || last_notice=0
        now=$(date +%s)
        if [ $(( now - last_notice )) -ge "$THROTTLE_NOTICE_COOLDOWN" ]; then
          if send_throttle_notice "$recent_count"; then
            echo "$now" > "$THROTTLE_NOTICE_FILE"
          fi
        fi
        log "throttled: $recent_count messages in last ${THROTTLE_WINDOW_SECONDS}s >= cap $THROTTLE_MAX_MESSAGES — nudge skipped, $count message(s) still pending"
      else
        if send_nudge "$count"; then
          cursor="$max_seq"
          echo "$cursor" > "$CURSOR_FILE"
          expecting=0
          rm -f "$THROTTLE_NOTICE_FILE"
        fi
      fi
    fi
  else
    log "WARNING: poll request failed (Buzz unreachable?) — will retry next cycle"
  fi

  if [ "$expecting" -eq 1 ]; then
    sleep "$EXPECTING_INTERVAL"
  else
    sleep "$IDLE_INTERVAL"
  fi
done
