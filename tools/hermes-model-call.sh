#!/usr/bin/env bash
# Version: 2.0.0
#
# A raw model call to one of the fleet's other resident backends, via hermes-router
# (IMPLEMENTATION_PLAN.md §4, §6 Stage 2). No session, no persona, no Matrix — just a single
# completion, same as calling any other tool.
#
# 2.0.0: role names changed from HermesAgentRedo's core/weaver/muse/vision to
# nano/super/coder/muse/omni (IMPLEMENTATION_PLAN.md §1, §2c) — every role is now a capability
# endpoint reachable by either persona's own local router, not owned by one persona. `super`
# is on-demand: this call may take noticeably longer than the others (up to ~150s) the first
# time it's used after being idle, while hermes-router.py wakes it via a broker job — that is
# expected, not a hang.
#
# Usage: hermes-model-call.sh <role> "<prompt>" ["<system prompt>"]
#   role: nano | super | coder | muse | omni   (omni also needs an image — not this script's job)
#
# Prints only the completion text to stdout. Prints the real error and exits non-zero on
# failure — never fabricates a response.
set -euo pipefail

ROLE="${1:?usage: hermes-model-call.sh <role> \"<prompt>\" [\"<system prompt>\"]}"
PROMPT="${2:?usage: hermes-model-call.sh <role> \"<prompt>\" [\"<system prompt>\"]}"
SYSTEM="${3:-}"

ROUTER_URL="${ROUTER_URL:-http://127.0.0.1:8080}"

log() { echo "[hermes-model-call] $*" >&2; }

MESSAGES="$(jq -n --arg sys "$SYSTEM" --arg user "$PROMPT" '
  (if $sys != "" then [{role: "system", content: $sys}] else [] end)
  + [{role: "user", content: $user}]
')"

BODY="$(jq -n --arg role "$ROLE" --argjson messages "$MESSAGES" \
  '{model: $role, messages: $messages, stream: false}')"

RESP="$(curl -s --max-time 180 -X POST "$ROUTER_URL/v1/chat/completions" \
  -H 'Content-Type: application/json' -d "$BODY")"

ERR="$(echo "$RESP" | jq -r '.error.message // empty')"
if [ -n "$ERR" ]; then
  log "ERROR: $ERR"
  exit 1
fi

CONTENT="$(echo "$RESP" | jq -r '.choices[0].message.content // empty')"
if [ -z "$CONTENT" ]; then
  log "ERROR: no content in response: $RESP"
  exit 1
fi

printf '%s\n' "$CONTENT"
