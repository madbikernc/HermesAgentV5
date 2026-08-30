#!/usr/bin/env bash
# Version: 1.2.1
#
# 1.2.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.2.0 — real bug found live, 2026-08-17, same night as 1.1.0: even with
# `send`'s argument validation in place, some of Amy's `send "<long
# message>"` calls still failed -- not from anything in this script, but
# from the framework's own text-completion tool-call parser corrupting the
# argument *before* this script ever runs (confirmed by reading the raw
# stored tool_calls JSON directly: a literal `</command><tool_call>...`
# fragment was already baked into the "command" string). Root cause: the
# model emitted two tool calls back to back in one completion (a `send`
# with a long, quote-containing argument, immediately followed by a
# `poll`), and the parser lost the boundary between them. That parser
# lives in the installed framework, not here, and is out of scope to patch
# blind -- but the trigger (a long, punctuation-and-quote-heavy string
# surviving as a single terminal-command argument) is avoidable from this
# side. Added `send-file <path>`: the message body never has to survive as
# a quoted command-line argument at all -- it's written to a file first
# (a plain, structured `write_file` call, nothing fragile to mis-parse)
# and read straight off disk here. `send` itself is unchanged and still
# correct for short messages; `send-file` is the preferred path for
# anything long enough to have caused trouble before. See
# LESSONS_LEARNED.md's dated §7/§8 rows for the full incident.
#
# 1.1.0 — real bug found live, 2026-08-17: Amy guessed a plausible-looking
# but nonexistent flag syntax, `send --to sintra --body "..."`, instead of
# the real single-quoted-argument form. `send` had zero argument
# validation -- $1 becomes the body unconditionally, so "--to" itself was
# silently sent as the entire message, reported success, and neither Amy
# nor a casual glance at the tool's own output caught it (the JSON result
# doesn't echo back what was actually sent). Fixed by rejecting a
# dash-prefixed $1 and any extra trailing args up front, loudly, with the
# correct usage -- "validate at the boundary" for exactly this reason: a
# CLI invoked by an LLM's guessed tool call is untrusted input, same as
# this project's `sandboxvar` RCE lesson (allowlist the shape, don't trust
# it silently). See LESSONS_LEARNED.md's dated §7 row.
#
# Client tool for hermes-buzz (IMPLEMENTATION_PLAN.md §7 Phase 32,
# infra/hermes-buzz/README.md) — dedicated inter-agent communication for
# Sintra and Amy. Mirrors tools/hermes-render-request.sh's shape: fetch the
# token via vault-get-secret.sh, curl the API directly, no new dependency.
#
# Identity is auto-detected the same way vault-get-secret.sh resolves its own
# node — VAULT_NODE if set, else /etc/hermes/vault-node-name — so neither
# persona has to name itself or the other one explicitly. With exactly two
# known agents, "send" always means "to whichever of {sintra,amy} I am not."
#
# Usage:
#   hermes-buzz.sh send "<message>"
#   hermes-buzz.sh send-file <path>                  # message body read from a file instead --
#                                                     # prefer this for anything long/complex;
#                                                     # write the message with write_file first
#   hermes-buzz.sh poll [--since N] [--limit N]     # messages addressed to me, since cursor N
#   hermes-buzz.sh history [--limit N]               # last N messages, both directions
#
# poll's output includes the highest seq seen — pass that back as --since next
# time to avoid re-reading the same messages. seq 0 (the default) means
# "everything ever sent to me."
#
# Requires: tools/vault-get-secret.sh (for the buzz-token vault item), curl, jq.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
BUZZ_URL="${BUZZ_URL:-http://10.129.1.15:8101}"

log() { echo "[hermes-buzz] $*" >&2; }

ME="${VAULT_NODE:-}"
if [ -z "$ME" ] && [ -f /etc/hermes/vault-node-name ]; then
  ME="$(cat /etc/hermes/vault-node-name)"
fi
case "$ME" in
  sintra) OTHER="amy" ;;
  amy) OTHER="sintra" ;;
  *) log "ERROR: could not determine identity — set VAULT_NODE (sintra|amy) or create /etc/hermes/vault-node-name"; exit 1 ;;
esac

TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" buzz-token password)"

do_send() {
  local msg="$1" resp seq
  resp="$(curl -s -X POST "$BUZZ_URL/messages" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg f "$ME" --arg t "$OTHER" --arg b "$msg" '{from:$f,to:$t,body:$b}')")"
  seq="$(echo "$resp" | jq -r '.seq // empty')"
  if [ -z "$seq" ]; then
    log "ERROR: send rejected: $resp"
    exit 1
  fi
  log "Sent to $OTHER as message $seq."
}

CMD="${1:-}"
shift || true

case "$CMD" in
  send)
    if [ $# -eq 0 ] || [[ "$1" == -* ]]; then
      log "ERROR: usage: hermes-buzz.sh send \"<message>\" — there are no flags; pass the whole message as one quoted argument (got: $*)"
      exit 1
    fi
    MSG="$1"
    shift
    if [ $# -gt 0 ]; then
      log "ERROR: send takes exactly one argument (the message, quoted) — got extra: $* — if your message has quotes or special characters, wrap the whole thing in one pair of quotes instead, or use send-file"
      exit 1
    fi
    do_send "$MSG"
    ;;

  send-file)
    if [ $# -eq 0 ] || [[ "$1" == -* ]]; then
      log "ERROR: usage: hermes-buzz.sh send-file <path> (got: $*)"
      exit 1
    fi
    FILE="$1"
    shift
    if [ $# -gt 0 ]; then
      log "ERROR: send-file takes exactly one argument (the file path) — got extra: $*"
      exit 1
    fi
    if [ ! -f "$FILE" ]; then
      log "ERROR: file not found: $FILE"
      exit 1
    fi
    MSG="$(cat "$FILE")"
    if [ -z "$MSG" ]; then
      log "ERROR: file is empty: $FILE"
      exit 1
    fi
    do_send "$MSG"
    ;;

  poll)
    SINCE=0
    LIMIT=50
    while [ $# -gt 0 ]; do
      case "$1" in
        --since) SINCE="$2"; shift 2 ;;
        --limit) LIMIT="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    curl -s -H "Authorization: Bearer $TOKEN" \
      "$BUZZ_URL/messages/poll?agent=$ME&since=$SINCE&limit=$LIMIT"
    ;;

  history)
    LIMIT=100
    while [ $# -gt 0 ]; do
      case "$1" in
        --limit) LIMIT="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    curl -s -H "Authorization: Bearer $TOKEN" "$BUZZ_URL/messages?limit=$LIMIT"
    ;;

  *)
    log "usage: hermes-buzz.sh {send \"<message>\" | send-file <path> | poll [--since N] [--limit N] | history [--limit N]}"
    exit 1
    ;;
esac
