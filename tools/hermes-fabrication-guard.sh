#!/usr/bin/env bash
# Version: 2.1.1
#
# 2.1.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 2.1.0 (HermesAgentV5 S6): added "dispatch" to the claim pattern and the FleetOps notice match.
# The `nano` exclusion below was correct reasoning for V4 (nano is each persona's own default
# backend — claiming to have used it is not a meaningful, checkable claim) and is wrong for
# `dispatch`: V5 IMPLEMENTATION_PLAN.md's S6 explicitly calls this out, since the dispatcher is
# exactly the kind of delegation target this guard exists to fabrication-check once anything
# claims to have used it. `hermes-router.py` already emits the same "{role} called" FleetOps
# notice for every role including new ones — no router change was needed for this to work, only
# the two regexes here. No live traffic exercises `dispatch` yet (nothing publishes to its Buzz
# topic in production until S7/S8's cutover), so this extension has no observable effect today;
# it is here so the check is already in place before the first real claim needs catching.
#
# 2.0.0 (HermesAgentV4): role names updated from weaver/muse to super/coder/muse
# (IMPLEMENTATION_PLAN.md §1, §2c) — found live 2026-08-21 while re-verifying honest delegation
# for the new backends, not caught by the original migration audit, which had filed this file as
# an unchanged carry-over. `nano`/`omni` are deliberately NOT added to the claim pattern, matching
# the original script's own precedent of never including `core`/`vision` — those are each
# persona's own default model, never a delegation target requiring a FleetOps cross-check, only
# `super`/`coder`/`muse` are (see `skills/model-delegation/SKILL.md`).
#
# 1.4.0 — security-review follow-up: room IDs are now percent-encoded
# (jq's @uri) before being embedded in Matrix API URLs.
#
# 1.3.0 — three fixes from a security review:
# (1) Matrix bearer tokens no longer transit curl's argv (were visible via
#     `ps`/`/proc/<pid>/cmdline` for the life of each call) — moved to a
#     `curl -K -` stdin config, verified live that the header still sends
#     correctly and the token no longer appears in the process's own argv.
# (2) The self-correction exclusion filter used to match on a content
#     prefix alone (`startswith("SYSTEM (fabrication-guard")`), which isn't
#     tied to real provenance — anything that got the persona to emit text
#     starting with that exact string (e.g. a prompt-injected instruction)
#     would be silently exempted from claim detection while still asserting
#     a real fabrication. Fixed to track the actual event_id of every
#     correction this guard itself posts (from its own PUT response) and
#     exclude by that instead — an event_id the guard never issued cannot
#     be forged by anything else posting through the same account.
# (3) The claim-scanning fetch was a single fixed-size page (limit=10),
#     which could silently miss a claim if more than 10 messages landed in
#     one 20s poll interval — the oldest of those would scroll past the
#     window and LAST_TS jumping to the newest would skip it permanently,
#     with nothing surfaced. Fixed to page backward (bounded, so a burst
#     can't stall the guard) until the oldest fetched event is already
#     older than LAST_TS.
#
# Watches an identity's own home room for a claim of having used Super, Coder, Muse, or the
# real-render capability (LESSONS_LEARNED.md §2g-§2i, "the phantom Weaver" — repeated
# confirmed fabricated-success episodes, including a false authorship line written into a
# real deliverable's own docstring, for calls that never reached hermes-router or the broker
# at all). Cross-checks each claim against hermes-router's own real-time FleetOps notices
# (text models) or a real delivered image (rendering); if neither exists in the window
# before the claim, posts a correction into the same room, in the identity's own voice —
# same pattern as session-guardian.sh, which already alerts into these rooms using each
# node's own Matrix credential. One instance runs per identity (VAULT_NODE=sintra|amy),
# each under that identity's own scoped systemd service.
#
# This does not prevent fabrication — nothing at the prompt level reliably does
# (LESSONS_LEARNED.md §2f). It interrupts it while it's still happening, rather than only
# being detectable after the fact by someone checking FleetOps by hand.
#
# Requires: VAULT_NODE (sintra|amy) or /etc/hermes/vault-node-name, tools/vault-get-secret.sh,
# jq, curl, sudo, systemctl. matrix-fleetops must be readable — same vault item the broker
# and router already use.
#
# Circuit breaker: a first version of this guard posted its own corrections as Sintra's own
# identity, and the correction text itself contained "Weaver"/"Muse" — so each correction
# looked like a fresh claim on the next poll, and it corrected itself in a live feedback loop.
# 25 messages landed in her home room before this was caught. That specific bug is fixed (the
# guard now excludes its own prior corrections from claim detection), but the general risk —
# any future bug producing runaway posts into a live conversation — deserves its own backstop
# independent of whatever the specific cause turns out to be. CIRCUIT_MAX corrections within
# CIRCUIT_WINDOW_SECONDS and the guard stops posting (still detects and logs, just doesn't post)
# until the window ages out on its own — no manual reset required, but no unbounded spam either.
set -uo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
MATRIX_URL="${MATRIX_URL:-http://127.0.0.1:6167}"
POLL_SECONDS="${POLL_SECONDS:-20}"
CLAIM_WINDOW_SECONDS="${CLAIM_WINDOW_SECONDS:-180}"  # how far back a real notice must be to count
CIRCUIT_MAX="${CIRCUIT_MAX:-3}"
CIRCUIT_WINDOW_SECONDS="${CIRCUIT_WINDOW_SECONDS:-600}"
STATE_DIR="${STATE_DIR:-$HOME/.hermes}"
STATE_FILE="$STATE_DIR/fabrication-guard-state.json"

NODE="${VAULT_NODE:-}"
if [ -z "$NODE" ] && [ -f /etc/hermes/vault-node-name ]; then
  NODE="$(cat /etc/hermes/vault-node-name)"
fi
: "${NODE:?Set VAULT_NODE (sintra) or create /etc/hermes/vault-node-name}"

case "$NODE" in
  sintra) HOME_ROOM="!teSvzXTJKwZyuh8QK8:spark"; AGENT_ID="@sintra:spark" ;;
  amy)    HOME_ROOM="!KvSV6SCscjEO8QWjuP:spark"; AGENT_ID="@amy:spark" ;;
  *) echo "[fabrication-guard] Unknown node '$NODE' — no home room mapping" >&2; exit 1 ;;
esac

log() { echo "[fabrication-guard] $*" >&2; }

# Emits a curl -K config snippet putting the Authorization header on stdin
# instead of argv, so the live Matrix token is never visible via `ps`/
# `/proc/<pid>/cmdline` for the life of the call.
_auth_header_stdin() { printf 'header = "Authorization: Bearer %s"\n' "$1"; }

# Percent-encodes $1 for safe use in a URL path segment (jq's @uri).
_urlenc() { jq -rn --arg s "$1" '$s|@uri'; }

# Fetches room messages backward from "now", paging (bounded by
# MSG_FETCH_MAX_PAGES) as long as the oldest event fetched so far is still
# newer than $since_ts — see session-guardian.sh's own copy of this
# function for the full rationale (a single fixed-size page can silently
# miss a claim under enough room traffic in one poll interval).
MSG_FETCH_PAGE_LIMIT="${MSG_FETCH_PAGE_LIMIT:-50}"
MSG_FETCH_MAX_PAGES="${MSG_FETCH_MAX_PAGES:-5}"

fetch_messages_since() {
  local room="$1" token="$2" since_ts="$3"
  local from="" all="[]" page=0 resp chunk oldest_ts got next_from url
  while [ "$page" -lt "$MSG_FETCH_MAX_PAGES" ]; do
    url="$MATRIX_URL/_matrix/client/v3/rooms/$(_urlenc "$room")/messages?dir=b&limit=$MSG_FETCH_PAGE_LIMIT"
    [ -n "$from" ] && url="${url}&from=${from}"
    resp="$(_auth_header_stdin "$token" | curl -s -K - "$url")"
    chunk="$(echo "$resp" | jq -c '.chunk // []')"
    all="$(jq -c -n --argjson a "$all" --argjson b "$chunk" '$a + $b')"
    got="$(echo "$chunk" | jq 'length')"
    oldest_ts="$(echo "$chunk" | jq '[.[] | select(.type=="m.room.message") | .origin_server_ts] | min // 0')"
    next_from="$(echo "$resp" | jq -r '.end // empty')"
    page=$((page + 1))
    if [ -z "$next_from" ] || [ "$got" -lt "$MSG_FETCH_PAGE_LIMIT" ] || { [ "$oldest_ts" != "0" ] && [ "$oldest_ts" -le "$since_ts" ]; }; then
      break
    fi
    from="$next_from"
  done
  jq -c -n --argjson chunk "$all" '{chunk: $chunk}'
}

MATRIX_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" "matrix-$NODE" password)"
FLEETOPS_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" matrix-fleetops password)"
FLEETOPS_ROOM="$("$REPO_DIR/tools/vault-get-secret.sh" matrix-fleetops room)"
if [ -z "$MATRIX_TOKEN" ] || [ -z "$FLEETOPS_TOKEN" ] || [ -z "$FLEETOPS_ROOM" ]; then
  log "ERROR: missing matrix-$NODE or matrix-fleetops credentials, exiting"
  exit 1
fi

mkdir -p "$STATE_DIR"
LAST_TS=0
CORRECTION_TIMES="[]"
GUARD_EVENT_IDS="[]"
if [ -f "$STATE_FILE" ]; then
  LAST_TS="$(jq -r '.last_ts // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
  CORRECTION_TIMES="$(jq -c '.correction_times // []' "$STATE_FILE" 2>/dev/null || echo '[]')"
  GUARD_EVENT_IDS="$(jq -c '.guard_event_ids // []' "$STATE_FILE" 2>/dev/null || echo '[]')"
fi

# Claim pattern: any mention of "super", "coder", "muse" (the three real delegation targets —
# see skills/model-delegation/SKILL.md), or image/render language at all. Deliberately excludes
# "nano"/"omni" (each persona's own default model, never a delegation target), same precedent
# the original script set by never including "core"/"vision" either. A narrower version tied to
# specific completion-claim verbs ("wrote", "executed", "engaged"...) was tried first and missed
# a real, ongoing fabricated narrative that used different phrasing entirely ("Editing
# weaver_de...", "the issue persists", "let me run the demo again") — none of which contain a
# recognizable completion verb even though it's the same fabrication. Image/render words added
# when this guard was extended to cover Amy's direct-render capability (§2h/§2i precedent:
# text-model and image-render claims are the same failure mode, just a different tool). A
# false-positive correction is harmless (it just asks her to confirm); a missed fabrication is
# not. Bias all the way toward broad.
CLAIM_RE='super|coder|muse|dispatch|render|rendered|rendering|image|picture'

while true; do
  resp="$(fetch_messages_since "$HOME_ROOM" "$MATRIX_TOKEN" "$LAST_TS")"

  # Oldest-first so corrections post in order if several claims landed since last poll.
  # Excludes the guard's own prior corrections by event_id, not by content — they're
  # posted as $AGENT_ID (same credential-reuse pattern as session-guardian.sh), and a
  # content-prefix check alone isn't tied to real provenance: anything that got the
  # persona to emit text starting with the same marker string would be silently
  # exempted too, while still asserting a real fabrication. GUARD_EVENT_IDS instead
  # tracks the actual event_id returned by each correction PUT this guard itself made —
  # not forgeable by anything else posting through the same account. (The content
  # marker below is retained as a human-readable label in the posted text itself, not
  # as a security check.) Original bug this guards against: corrections literally
  # contained the words "Weaver"/"Muse", which without any exclusion made each
  # correction look like a fresh claim on the next poll — 25 messages posted into her
  # home room before that was caught and fixed.
  new_events="$(echo "$resp" | jq -c --arg sender "$AGENT_ID" --argjson since "$LAST_TS" --argjson guard_ids "$GUARD_EVENT_IDS" \
    '[.chunk[] | select(.sender == $sender and .origin_server_ts > $since and .content.msgtype == "m.text"
       and (.event_id as $id | ($guard_ids | index($id)) == null))] | sort_by(.origin_server_ts)')"

  count="$(echo "$new_events" | jq 'length')"
  if [ "$count" -gt 0 ]; then
    for i in $(seq 0 $((count - 1))); do
      event="$(echo "$new_events" | jq -c ".[$i]")"
      body="$(echo "$event" | jq -r '.content.body // ""')"
      ts="$(echo "$event" | jq -r '.origin_server_ts')"
      event_id="$(echo "$event" | jq -r '.event_id')"

      if echo "$body" | grep -qEi "$CLAIM_RE"; then
        window_start_ms=$(( ts - CLAIM_WINDOW_SECONDS * 1000 ))
        notices="$(_auth_header_stdin "$FLEETOPS_TOKEN" | curl -s -K - \
          "$MATRIX_URL/_matrix/client/v3/rooms/$(_urlenc "$FLEETOPS_ROOM")/messages?dir=b&limit=20")"
        # A real match is either a router text-model notice (super/coder/muse) or a real
        # delivered image from the broker (m.image) — the capabilities this guard covers.
        matched="$(echo "$notices" | jq --argjson start "$window_start_ms" --argjson end "$ts" \
          '[.chunk[] | select(.origin_server_ts >= $start and .origin_server_ts <= $end and
             ((.content.msgtype == "m.notice" and (.content.body | test("router.*(super|coder|muse|dispatch) called"; "i")))
              or .content.msgtype == "m.image"))] | length')"

        if [ "$matched" -eq 0 ]; then
          log "fabrication suspected: event $event_id claims Super/Coder/Muse use with no matching FleetOps notice in the prior ${CLAIM_WINDOW_SECONDS}s"

          now_ms=$(( $(date +%s) * 1000 ))
          circuit_start_ms=$(( now_ms - CIRCUIT_WINDOW_SECONDS * 1000 ))
          CORRECTION_TIMES="$(echo "$CORRECTION_TIMES" | jq -c --argjson start "$circuit_start_ms" '[.[] | select(. >= $start)]')"
          recent_count="$(echo "$CORRECTION_TIMES" | jq 'length')"

          if [ "$recent_count" -ge "$CIRCUIT_MAX" ]; then
            log "CIRCUIT OPEN: $recent_count corrections already posted in the last ${CIRCUIT_WINDOW_SECONDS}s (max $CIRCUIT_MAX) — skipping post for event $event_id, detection continues"
          else
            correction="SYSTEM (fabrication-guard, automated): the message just above claimed Super, Coder, or Muse was used, but no matching call reached hermes-router in the prior ${CLAIM_WINDOW_SECONDS}s (checked FleetOps directly). Stop and either make the real call via hermes-model-call.sh, or tell The Boss plainly that you have not actually used it yet."
            txn="fabguard-$(date +%s%N)"
            post_resp="$(_auth_header_stdin "$MATRIX_TOKEN" | curl -s -K - -X PUT \
              "$MATRIX_URL/_matrix/client/v3/rooms/$(_urlenc "$HOME_ROOM")/send/m.room.message/$txn" \
              -H "Content-Type: application/json" \
              -d "$(jq -n --arg body "$correction" '{msgtype: "m.text", body: $body}')")"
            new_event_id="$(echo "$post_resp" | jq -r '.event_id // empty')"
            if [ -n "$new_event_id" ]; then
              # Bounded to the last 50 so this can't grow without limit across a long
              # uptime -- LAST_TS already prevents re-scanning anything old enough to
              # need entries beyond that.
              GUARD_EVENT_IDS="$(echo "$GUARD_EVENT_IDS" | jq -c --arg id "$new_event_id" '(. + [$id])[-50:]')"
            else
              log "WARNING: correction posted but no event_id in response — cannot self-exclude it next poll: $post_resp"
            fi
            CORRECTION_TIMES="$(echo "$CORRECTION_TIMES" | jq -c --argjson t "$now_ms" '. + [$t]')"
            log "correction posted for event $event_id ($((recent_count + 1))/$CIRCUIT_MAX in current window)"
          fi
        else
          log "event $event_id claims Super/Coder/Muse use — matching FleetOps notice found, no action"
        fi
      fi
      LAST_TS="$ts"
    done
    jq -n --argjson last_ts "$LAST_TS" --argjson corrections "$CORRECTION_TIMES" --argjson guard_ids "$GUARD_EVENT_IDS" \
      '{last_ts: $last_ts, correction_times: $corrections, guard_event_ids: $guard_ids}' > "$STATE_FILE"
  fi

  sleep "$POLL_SECONDS"
done
