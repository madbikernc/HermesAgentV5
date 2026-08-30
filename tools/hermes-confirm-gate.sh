#!/usr/bin/env bash
# Version: 1.3.1
#
# 1.3.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.3.0 — security-review follow-up: room IDs are now percent-encoded
# (jq's @uri) before being embedded in Matrix API URLs.
#
# 1.2.0 — the poll loop's message fetch (limit=20) is now bounded pagination
# instead of a single fixed-size page — a busy room could otherwise scroll
# The Boss's own confirmation reply past the window between polls, same fix
# already applied to session-guardian.sh/hermes-fabrication-guard.sh.
#
# 1.1.0 — the Matrix bearer token no longer transits curl's argv — visible
# via `ps`/`/proc/<pid>/cmdline` for the life of each call, notably during
# the poll loop's repeated GETs while a confirmation is pending. Moved to a
# `curl -K -` stdin config; verified live the header still sends correctly
# and the token no longer appears in the process's own argv.
#
# Reusable code-level confirmation gate (Phase 22, IMPLEMENTATION_PLAN.md §7 —
# built for Vivint's lock/garage commands, but deliberately Vivint-agnostic so any
# future phase needing constraint 5's gate can reuse it instead of reinventing the
# same Matrix-poll logic). Modeled directly on tools/session-guardian.sh's own
# post_message/check_for_cleanup_reply pair, which is this project's one existing,
# proven "requires an explicit reply from The Boss's real Matrix account" pattern —
# not a new design.
#
# Posts a request (with a random, single-use confirmation code embedded) to a
# Matrix room, then blocks, polling for a reply from The Boss's real sender ID
# matching that exact code. Exits 0 only on a genuine matching reply — this is
# the actual security boundary (only The Boss's real Matrix session can produce
# a matching event), not a prompt-level instruction an agent could talk itself
# past. The caller is responsible for only proceeding on exit 0.
#
# Usage:
#   hermes-confirm-gate.sh <room_id> "<human-readable action description>" [timeout_seconds]
#
# Requires: VAULT_NODE (sintra|amy) or /etc/hermes/vault-node-name,
# tools/vault-get-secret.sh, jq, curl.
set -uo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
MATRIX_URL="${MATRIX_URL:-https://spark.tail1a534.ts.net}"
BOSS_USER_ID="${BOSS_USER_ID:-@phone1:spark}"
POLL_SECONDS="${POLL_SECONDS:-5}"

ROOM_ID="${1:?usage: hermes-confirm-gate.sh <room_id> \"<action description>\" [timeout_seconds]}"
DESCRIPTION="${2:?usage: hermes-confirm-gate.sh <room_id> \"<action description>\" [timeout_seconds]}"
TIMEOUT_SECONDS="${3:-300}"

NODE="${VAULT_NODE:-}"
if [ -z "$NODE" ] && [ -f /etc/hermes/vault-node-name ]; then
  NODE="$(cat /etc/hermes/vault-node-name)"
fi
: "${NODE:?Set VAULT_NODE (sintra|amy) or create /etc/hermes/vault-node-name}"

log() { echo "[confirm-gate] $*" >&2; }

MATRIX_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" "matrix-$NODE" password)"
if [ -z "$MATRIX_TOKEN" ]; then
  log "ERROR: could not fetch matrix-$NODE token"
  exit 1
fi

CODE="$(tr -dc 'a-z0-9' </dev/urandom | head -c6)"
START_TS_MS="$(($(date +%s%N) / 1000000))"

# Emits a curl -K config snippet putting the Authorization header on stdin
# instead of argv, so the live Matrix token is never visible via `ps`/
# `/proc/<pid>/cmdline` for the life of the call.
_auth_header_stdin() { printf 'header = "Authorization: Bearer %s"\n' "$1"; }

# Percent-encodes $1 for safe use in a URL path segment (jq's @uri, since jq
# is already a hard dependency here — avoids a room ID containing `?`/`#`/
# extra path segments altering the request target).
_urlenc() { jq -rn --arg s "$1" '$s|@uri'; }

# Fetches room messages backward from "now", paging (bounded by
# MSG_FETCH_MAX_PAGES) as long as the oldest event fetched so far is still
# newer than $since_ts — see session-guardian.sh's own copy of this function
# for the full rationale.
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

post_message() {
  local body="$1"
  _auth_header_stdin "$MATRIX_TOKEN" | curl -s -K - -X PUT \
    "$MATRIX_URL/_matrix/client/v3/rooms/$(_urlenc "$ROOM_ID")/send/m.room.message/confirm-gate-$(date +%s%N)" \
    -H "Content-Type: application/json" \
    --data "$(jq -n --arg body "$body" '{msgtype: "m.text", body: $body}')" >/dev/null
}

minutes=$((TIMEOUT_SECONDS / 60))
post_message "🔒 CONFIRMATION NEEDED: $DESCRIPTION — reply here with \`confirm $CODE\` within ${minutes} minute(s) to authorize. Otherwise nothing happens."
log "Posted confirmation request to $ROOM_ID, code=$CODE, waiting up to ${TIMEOUT_SECONDS}s"

elapsed=0
while [ "$elapsed" -lt "$TIMEOUT_SECONDS" ]; do
  resp="$(fetch_messages_since "$ROOM_ID" "$MATRIX_TOKEN" "$START_TS_MS")"

  match="$(echo "$resp" | jq -r --arg boss "$BOSS_USER_ID" --argjson since "$START_TS_MS" --arg code "$CODE" '
    [.chunk[]? | select(.type=="m.room.message" and .sender==$boss and .origin_server_ts>=$since)
      | select(.content.body | test("^\\s*confirm\\s+" + $code + "\\s*$"; "i"))]
    | length
  ')"

  if [ "$match" -gt 0 ]; then
    log "Confirmed by $BOSS_USER_ID (code=$CODE)"
    post_message "✅ Confirmed — proceeding."
    exit 0
  fi

  sleep "$POLL_SECONDS"
  elapsed=$((elapsed + POLL_SECONDS))
done

log "Timed out after ${TIMEOUT_SECONDS}s with no matching confirmation"
post_message "⏱️ No confirmation received within ${minutes} minute(s) — not proceeding."
exit 1
