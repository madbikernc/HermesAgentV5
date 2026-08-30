#!/usr/bin/env bash
# Version: 1.3.2
#
# 1.3.2 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.3.1 (2026-08-22, found live during a stuck-session incident on Sintra's
# node): fetch_messages_since() passed the growing `all` array to jq as a
# --argjson command-line argument, both in its per-page accumulation and
# in its final `{chunk: $chunk}` wrap. Once a flooded room pushed that
# JSON past Linux's ~128KB single-argument limit, execve failed with
# E2BIG ("Argument list too long"), jq never ran, and the function's
# output silently degraded to empty/invalid JSON instead of erroring
# loudly. That cascaded into check_for_cleanup_reply(): `newest_ts` came
# back as an empty string rather than "0", the `!= "0"` guard didn't catch
# it, and `[ "$newest_ts" -gt "$last_ts" ]` died with "integer expression
# expected" every poll cycle — meaning the guardian was never successfully
# reading Boss cleanup replies for however long the room stayed flooded.
# Fixed the root cause at both call sites by routing the JSON through
# stdin (no size limit) instead of argv, and independently hardened the
# newest_ts check so a future upstream jq failure degrades safely instead
# of erroring every cycle.
#
# 1.3.0 — security-review follow-up: room IDs are now percent-encoded
# (jq's @uri) before being embedded in Matrix API URLs, closing a
# defense-in-depth gap (a room ID containing `?`/`#`/extra path segments
# could otherwise alter the request target).
#
# 1.2.0 — the Matrix bearer token no longer transits curl's argv. It used to
# be passed as a literal `-H "Authorization: Bearer $TOKEN"` argument, which
# is visible to any other local user via `ps`/`/proc/<pid>/cmdline` for the
# life of each call — exactly the exposure class §2b already redesigned
# vault-set-secret.sh around ("never a CLI argument"), just never applied
# here. Fixed by passing the header through `curl -K -` (config read from
# stdin) instead of `-H` — verified live that curl still sends the header
# correctly and that the token never appears in the process's own argv.
#
# Watches this node's hermes-gateway for the "stuck session" failure mode
# (context permanently exceeded, compression can't recover — see
# LESSONS_LEARNED.md §2d/§3c for the real incidents this is built from)
# and alerts The Boss in this node's own home room, with the exact reply
# syntax to trigger cleanup. Cleanup only ever runs on an explicit reply
# from The Boss (phone1) — never autonomously, matching both agents'
# existing "destructive actions need explicit confirmation" guardrail.
#
# Runs as a persistent systemd service (session-guardian.service), not a
# timer — the Matrix token is fetched once at startup and reused, rather
# than round-tripping Vaultwarden on every poll cycle.
#
# Requires: VAULT_NODE (sintra|amy) or /etc/hermes/vault-node-name,
# tools/vault-get-secret.sh, jq, curl, hermes CLI, sudo, systemctl.
set -uo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
MATRIX_URL="${MATRIX_URL:-https://spark.tail1a534.ts.net}"
POLL_SECONDS="${POLL_SECONDS:-180}"
BURST_THRESHOLD="${BURST_THRESHOLD:-3}"
BURST_WINDOW_MIN="${BURST_WINDOW_MIN:-5}"
DEBOUNCE_MIN="${DEBOUNCE_MIN:-30}"
BOSS_USER_ID="${BOSS_USER_ID:-@phone1:spark}"
STATE_DIR="${STATE_DIR:-$HOME/.hermes}"
STATE_FILE="$STATE_DIR/session-guardian-state.json"

NODE="${VAULT_NODE:-}"
if [ -z "$NODE" ] && [ -f /etc/hermes/vault-node-name ]; then
  NODE="$(cat /etc/hermes/vault-node-name)"
fi
: "${NODE:?Set VAULT_NODE (sintra|amy) or create /etc/hermes/vault-node-name}"

case "$NODE" in
  sintra) HOME_ROOM="!teSvzXTJKwZyuh8QK8:spark" ;;
  amy)    HOME_ROOM="!KvSV6SCscjEO8QWjuP:spark" ;;
  *) echo "[session-guardian] Unknown node '$NODE' — no home room mapping" >&2; exit 1 ;;
esac

log() { echo "[session-guardian] $*" >&2; }

mkdir -p "$STATE_DIR"
if [ ! -f "$STATE_FILE" ]; then
  # Start last_event_ts at "now" (Matrix epoch-ms), not 0 — otherwise a fresh
  # start would treat every old message in the room's recent history as new,
  # including any stale cleanup command from a past test.
  now_ms="$(($(date +%s%N) / 1000000))"
  jq -n --argjson ts "$now_ms" '{alerted_id: null, alerted_at: 0, last_event_ts: $ts}' > "$STATE_FILE"
fi

MATRIX_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" "matrix-$NODE" password)"
if [ -z "$MATRIX_TOKEN" ]; then
  log "ERROR: could not fetch matrix-$NODE token, exiting"
  exit 1
fi

# Emits a curl -K config snippet putting the Authorization header on stdin
# instead of argv, so the live Matrix token is never visible via `ps`/
# `/proc/<pid>/cmdline` for the life of the call. $1 must not itself contain
# a double quote or backslash (Matrix access tokens don't).
_auth_header_stdin() { printf 'header = "Authorization: Bearer %s"\n' "$1"; }

# Percent-encodes $1 for safe use in a URL path segment (jq's @uri).
_urlenc() { jq -rn --arg s "$1" '$s|@uri'; }

post_message() {
  local body="$1"
  _auth_header_stdin "$MATRIX_TOKEN" | curl -s -K - -X PUT \
    "$MATRIX_URL/_matrix/client/v3/rooms/$(_urlenc "$HOME_ROOM")/send/m.room.message/guardian-$(date +%s%N)" \
    -H "Content-Type: application/json" \
    --data "$(jq -n --arg body "$body" '{msgtype: "m.text", body: $body}')" >/dev/null
}

# Fetches room messages backward from "now", paging (bounded by
# MSG_FETCH_MAX_PAGES) as long as the oldest event fetched so far is still
# newer than $since_ts. A single fixed-size page could otherwise miss an
# event entirely if more than MSG_FETCH_PAGE_LIMIT messages land in one poll
# interval — the oldest of those new messages (potentially The Boss's own
# cleanup reply) would scroll past the window, and last_event_ts jumping to
# the newest seen would permanently skip them with no error surfaced.
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
    # Concatenate via stdin, not --argjson: `all` grows every page and a
    # flooded room can push it past Linux's ~128KB single-argv-string
    # limit, which fails execve with E2BIG rather than a jq error. Piping
    # both values in through `jq -s` has no such ceiling.
    all="$(printf '%s\n%s\n' "$all" "$chunk" | jq -c -s 'add')"
    got="$(echo "$chunk" | jq 'length')"
    oldest_ts="$(echo "$chunk" | jq '[.[] | select(.type=="m.room.message") | .origin_server_ts] | min // 0')"
    next_from="$(echo "$resp" | jq -r '.end // empty')"
    page=$((page + 1))
    if [ -z "$next_from" ] || [ "$got" -lt "$MSG_FETCH_PAGE_LIMIT" ] || { [ "$oldest_ts" != "0" ] && [ "$oldest_ts" -le "$since_ts" ]; }; then
      break
    fi
    from="$next_from"
  done
  # Same argv-size hazard as the accumulation above (and the same fix):
  # pipe `all` in rather than pass it as --argjson.
  printf '%s' "$all" | jq -c '{chunk: .}'
}

check_for_stuck_session() {
  # Two distinct failure signatures found in real incidents (LESSONS_LEARNED.md §2d/§3c):
  # (1) Amy's hard overflow — context genuinely exceeds the model's limit, compression can't recover.
  # (2) Sintra's large-context slowness — her bigger context window doesn't hard-fail the same way,
  #     it just gets so large that inference stalls for 15+ minutes and streams get killed/superseded.
  local overflow_count stale_count reason=""
  overflow_count="$(journalctl -u hermes-gateway --since "${BURST_WINDOW_MIN} minutes ago" --no-pager 2>/dev/null \
    | grep -c "Cannot compress further" || true)"
  stale_count="$(journalctl -u hermes-gateway --since "${BURST_WINDOW_MIN} minutes ago" --no-pager 2>/dev/null \
    | grep -cE "Stream stale for|Streaming attempt superseded" || true)"

  if [ "$overflow_count" -ge "$BURST_THRESHOLD" ]; then
    reason="context exceeded repeatedly ($overflow_count times in the last ${BURST_WINDOW_MIN}m) and compression can't recover it"
  elif [ "$stale_count" -ge "$BURST_THRESHOLD" ]; then
    reason="responses are stalling/getting superseded repeatedly ($stale_count times in the last ${BURST_WINDOW_MIN}m) — likely an oversized context making inference too slow"
  else
    return 0
  fi

  local alerted_id alerted_at now
  alerted_id="$(jq -r '.alerted_id' "$STATE_FILE")"
  alerted_at="$(jq -r '.alerted_at' "$STATE_FILE")"
  now="$(date +%s)"

  local list_line candidate_id candidate_title
  list_line="$(hermes sessions list --limit 1 2>/dev/null | tail -1)"
  candidate_id="$(echo "$list_line" | awk '{print $NF}')"
  candidate_title="$(echo "$list_line" | cut -c1-50 | sed 's/[[:space:]]*$//')"

  if [ -z "$candidate_id" ]; then
    log "Detected a failure burst ($reason) but couldn't identify a session"
    return 0
  fi

  # Debounce: don't re-alert for the same session within DEBOUNCE_MIN.
  if [ "$alerted_id" = "$candidate_id" ] && [ $((now - alerted_at)) -lt $((DEBOUNCE_MIN * 60)) ]; then
    return 0
  fi

  log "Stuck session detected: $candidate_id ($candidate_title) — $reason"
  post_message "⚠️ Session \`$candidate_id\` (\"$candidate_title\") looks stuck — $reason. Reply here with \`cleanup $candidate_id\` (no leading slash — some clients intercept /-commands locally and never send them) to clear it."

  jq --arg id "$candidate_id" --argjson at "$now" '.alerted_id=$id | .alerted_at=$at' "$STATE_FILE" > "$STATE_FILE.tmp" \
    && mv "$STATE_FILE.tmp" "$STATE_FILE"
}

run_cleanup() {
  local session_id="$1" delete_ok=1
  log "Running Boss-authorized cleanup for $session_id"
  post_message "🧹 Clearing session \`$session_id\`..."
  sudo systemctl stop hermes-gateway
  if ! hermes sessions delete "$session_id" --yes >/dev/null 2>&1; then
    delete_ok=0
  fi
  sudo systemctl start hermes-gateway
  local tries=0
  while [ "$tries" -lt 40 ]; do
    [ "$(systemctl is-active hermes-gateway 2>/dev/null)" = "active" ] && break
    sleep 3; tries=$((tries + 1))
  done
  sleep 5  # let the wrapper finish its secret-injection startup
  if [ "$delete_ok" -eq 1 ]; then
    post_message "✅ Cleared session \`$session_id\`. Gateway is back up."
    jq '.alerted_id=null | .alerted_at=0' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
  else
    post_message "❌ Couldn't delete session \`$session_id\` — check it's the right ID (\`hermes sessions list\` on the node). Gateway is back up either way."
  fi
}

check_for_cleanup_reply() {
  local last_ts resp
  last_ts="$(jq -r '.last_event_ts' "$STATE_FILE")"
  resp="$(fetch_messages_since "$HOME_ROOM" "$MATRIX_TOKEN" "$last_ts")"

  local newest_ts
  newest_ts="$(echo "$resp" | jq -r '[.chunk[]? | select(.type=="m.room.message") | .origin_server_ts] | max // 0')"

  echo "$resp" | jq -c --arg boss "$BOSS_USER_ID" --argjson since "$last_ts" \
    '.chunk[]? | select(.type=="m.room.message" and .sender==$boss and .origin_server_ts>$since) | {body: .content.body, ts: .origin_server_ts}' \
    | while read -r line; do
        local body sid
        body="$(echo "$line" | jq -r '.body')"
        if [[ "$body" =~ ^[Cc]leanup[[:space:]]+([^[:space:]]+) ]]; then
          sid="${BASH_REMATCH[1]}"
          run_cleanup "$sid"
        fi
      done

  # Regex guard, not just "!= 0": an upstream jq failure (e.g. the E2BIG
  # case above) can leave newest_ts as an empty string, which the old
  # "!= 0" check let through into a `-gt` comparison that bash then
  # errors on ("integer expression expected") every single poll cycle.
  if [[ "$newest_ts" =~ ^[0-9]+$ ]] && [ "$newest_ts" -gt "$last_ts" ]; then
    jq --argjson ts "$newest_ts" '.last_event_ts=$ts' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
  fi
}

log "Started for node=$NODE, home_room=$HOME_ROOM, polling every ${POLL_SECONDS}s"
while true; do
  check_for_stuck_session
  check_for_cleanup_reply
  sleep "$POLL_SECONDS"
done
