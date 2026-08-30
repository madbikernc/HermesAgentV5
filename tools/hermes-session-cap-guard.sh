#!/usr/bin/env bash
# Version: 1.4.1
#
# 1.4.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.4.0 — closes the state.db gap LESSONS_LEARNED.md flags (superseded
# session rows from this script's own rotations never got ended_at/
# end_reason populated, unlike the two historical human-triggered resets).
# Root cause was never pinned down (a framework async-cleanup step that
# didn't fire for bot-sender rotations, per the original write-up) — rather
# than wait on that, this script now writes those two fields itself right
# after triggering !new, since it already knows exactly which row it just
# closed. Checked the real schema and real historical values first rather
# than guessing a format: both columns are REAL (Unix epoch, e.g.
# 1785783977.26656), not TEXT/ISO8601, and every real historical row uses
# the literal end_reason 'session_reset' regardless of trigger source — this
# reuses that exact literal rather than inventing a new value some other
# query might not expect. Idempotent and harmless if the framework's own
# cleanup does eventually fire for a row this already touched: the WHERE
# clause only ever matches while ended_at is still NULL, and a redundant
# second write of the same fact isn't a conflict.
#
# 1.3.0 — security-review follow-up: the room ID is now percent-encoded
# (jq's @uri) before being embedded in the Matrix API URL.
#
# 1.2.0 — Matrix bearer tokens (both the identity's own and hermes-ops-ctl's)
# no longer transit curl's argv — were visible via `ps`/`/proc/<pid>/cmdline`
# for the life of each call. Moved to a `curl -K -` stdin config; verified
# live the header still sends correctly and the token no longer appears in
# the process's own argv.
#
# 1.1.0 — the !new trigger now posts as @hermes-ops-ctl:spark (vault item
# matrix-ops-ctl), not the identity's own account. A controlled test of 1.0.0
# posted both the summary and !new successfully (confirmed via raw Matrix
# query), but state.db never showed the session ending. Root cause: the
# Matrix platform adapter drops any event whose sender matches the gateway's
# own logged-in user_id, unconditionally, before any command parsing
# (plugins/platforms/matrix/adapter.py _is_self_sender / _on_room_message —
# an anti-echo-loop guard, issue #15763). Posting !new as the identity's own
# credential meant the gateway never saw it at all; journalctl showing
# nothing for that window was accurate, not a buffering artifact. The two
# prior working resets in this project were sent by @phone1:spark, a
# different sender, which is why they worked and this didn't.
# hermes-ops-ctl is a dedicated, low-privilege control identity (same "never
# the persona" pattern as @fleetops:spark for the render broker) joined only
# to Sintra's and Amy's home rooms, used for nothing but issuing trusted
# commands like !new. The summary text still posts as the identity's own
# account -- that part never needed the gateway to *act* on it, only to be
# left in the room transcript for context, and self-sent messages are fine
# for that.
#
# Stage 5, IMPLEMENTATION_PLAN.md §6: hard caps on session length, with automatic rotation and
# a carried-forward summary. Prevention, not cleanup — distinct from session-guardian.sh, which
# only ever acts on an already-stuck session and only with The Boss's explicit consent. This runs
# unattended, because its whole job is to keep a session from ever reaching the point
# session-guardian exists to detect.
#
# The incident this exists for: LESSONS_LEARNED.md §2d — a real session reached 424 messages and
# ~48,569 tokens, well past the point compression could reliably keep up, and stalled rather than
# erroring cleanly. Checked first whether Hermes Agent's own `session_reset` config could do this
# natively — it can't: it only supports idle/daily time-based resets (gateway/config.py), no
# turn/token threshold and no carried-forward summary, just a blank wipe. Rather than depend on
# Hermes's own compression (the thing that was actually failing at scale in the original
# incident), this generates the summary independently via a raw Core completion through
# hermes-router — a mechanism already proven solid all day — then triggers the same `!new` reset
# already used manually throughout this project, with the summary posted immediately before it so
# the fresh session starts with real context instead of nothing.
#
# Requires: VAULT_NODE (sintra|amy) or /etc/hermes/vault-node-name, tools/vault-get-secret.sh,
# jq, curl, sqlite3, sudo, systemctl.
set -uo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
MATRIX_URL="${MATRIX_URL:-http://127.0.0.1:6167}"
ROUTER_URL="${ROUTER_URL:-http://127.0.0.1:8080}"
POLL_SECONDS="${POLL_SECONDS:-120}"
MAX_MESSAGES="${MAX_MESSAGES:-200}"
MAX_TOKENS="${MAX_TOKENS:-20000}"
STATE_DB="${STATE_DB:-$HOME/.hermes/state.db}"
STATE_DIR="${STATE_DIR:-$HOME/.hermes}"
STATE_FILE="$STATE_DIR/session-cap-guard-state.json"

NODE="${VAULT_NODE:-}"
if [ -z "$NODE" ] && [ -f /etc/hermes/vault-node-name ]; then
  NODE="$(cat /etc/hermes/vault-node-name)"
fi
: "${NODE:?Set VAULT_NODE (sintra|amy) or create /etc/hermes/vault-node-name}"

case "$NODE" in
  sintra) HOME_ROOM="!teSvzXTJKwZyuh8QK8:spark" ;;
  amy)    HOME_ROOM="!KvSV6SCscjEO8QWjuP:spark" ;;
  *) echo "[session-cap-guard] Unknown node '$NODE' — no home room mapping" >&2; exit 1 ;;
esac

log() { echo "[session-cap-guard] $*" >&2; }

MATRIX_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" "matrix-$NODE" password)"
if [ -z "$MATRIX_TOKEN" ]; then
  log "ERROR: could not fetch matrix-$NODE token, exiting"
  exit 1
fi

# Dedicated control identity for the !new trigger only -- see 1.1.0 note above.
OPS_CTL_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" matrix-ops-ctl password)"
if [ -z "$OPS_CTL_TOKEN" ]; then
  log "ERROR: could not fetch matrix-ops-ctl token, exiting"
  exit 1
fi

mkdir -p "$STATE_DIR"
LAST_ROTATED_SESSION=""
[ -f "$STATE_FILE" ] && LAST_ROTATED_SESSION="$(jq -r '.last_rotated_session // ""' "$STATE_FILE" 2>/dev/null || echo "")"

# Emits a curl -K config snippet putting the Authorization header on stdin
# instead of argv, so the live Matrix token is never visible via `ps`/
# `/proc/<pid>/cmdline` for the life of the call.
_auth_header_stdin() { printf 'header = "Authorization: Bearer %s"\n' "$1"; }

# Percent-encodes $1 for safe use in a URL path segment (jq's @uri).
_urlenc() { jq -rn --arg s "$1" '$s|@uri'; }

post_message() {
  local body="$1"
  local token="${2:-$MATRIX_TOKEN}"
  local txn="capguard-$(date +%s%N)"
  _auth_header_stdin "$token" | curl -s -K - -X PUT \
    "$MATRIX_URL/_matrix/client/v3/rooms/$(_urlenc "$HOME_ROOM")/send/m.room.message/$txn" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg body "$body" '{msgtype: "m.text", body: $body}')" >/dev/null
}

while true; do
  row="$(sqlite3 -separator '|' "$STATE_DB" \
    "SELECT id, message_count, (input_tokens + output_tokens) FROM sessions
     WHERE source='matrix' AND chat_id='$HOME_ROOM' AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1;" 2>/dev/null)"

  if [ -n "$row" ]; then
    session_id="$(echo "$row" | cut -d'|' -f1)"
    msg_count="$(echo "$row" | cut -d'|' -f2)"
    tok_count="$(echo "$row" | cut -d'|' -f3)"

    if [ "$session_id" != "$LAST_ROTATED_SESSION" ] && \
       { [ "${msg_count:-0}" -ge "$MAX_MESSAGES" ] || [ "${tok_count:-0}" -ge "$MAX_TOKENS" ]; }; then
      log "cap reached: session $session_id at $msg_count messages / $tok_count tokens (caps: $MAX_MESSAGES / $MAX_TOKENS) — rotating"

      transcript="$(sqlite3 -separator ' :: ' "$STATE_DB" \
        "SELECT role, substr(coalesce(content,''),1,2000) FROM messages
         WHERE session_id='$session_id' AND active=1 AND role IN ('user','assistant')
         ORDER BY timestamp ASC;" 2>/dev/null)"

      if [ -n "$transcript" ]; then
        summary_prompt="Summarize the key facts, decisions, ongoing tasks, and context from the conversation below in a tight paragraph, written so a fresh session with no memory of it can continue seamlessly. Do not narrate that you are summarizing; just produce the summary itself.

$transcript"
        summary="$("$REPO_DIR/tools/hermes-model-call.sh" core "$summary_prompt" 2>/dev/null)"
      else
        summary=""
      fi

      if [ -n "$summary" ]; then
        post_message "SYSTEM (session-cap-guard, automated): this session reached ${msg_count} messages / ${tok_count} tokens and is rotating to stay well clear of the stall this cap exists to prevent (LESSONS_LEARNED.md §2d). Carried-forward summary before reset: ${summary}"
      else
        post_message "SYSTEM (session-cap-guard, automated): this session reached ${msg_count} messages / ${tok_count} tokens and is rotating. Summary generation failed — starting fresh with no carried context; check the log."
        log "summary generation failed for session $session_id"
      fi

      sleep 2
      # Posted as hermes-ops-ctl, not the identity's own account -- the gateway
      # drops self-sent events before command parsing (see 1.1.0 note above),
      # so !new from the identity itself is silently a no-op.
      post_message "!new" "$OPS_CTL_TOKEN"
      log "rotation triggered for session $session_id"

      # Closes the state.db gap in LESSONS_LEARNED.md: the framework's own
      # async cleanup doesn't reliably populate these for a bot-sender
      # rotation (root cause never pinned down), so write them directly --
      # same literal end_reason every real historical human-triggered reset
      # uses, guarded so a later framework write of the same fact is a
      # harmless no-op, not a conflict.
      sqlite3 "$STATE_DB" \
        "UPDATE sessions SET ended_at=$(date +%s.%N), end_reason='session_reset' WHERE id='$session_id' AND ended_at IS NULL;" \
        2>/dev/null || log "WARNING: could not write ended_at/end_reason for session $session_id"

      LAST_ROTATED_SESSION="$session_id"
      jq -n --arg s "$LAST_ROTATED_SESSION" '{last_rotated_session: $s}' > "$STATE_FILE"
    fi
  fi

  sleep "$POLL_SECONDS"
done
