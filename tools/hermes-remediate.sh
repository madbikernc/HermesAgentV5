#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# hermes-remediate.sh — request an allowlisted self-remediation action (a service restart, or a
# nudge to the other identity) without needing sudo/systemctl access yourself. Submits a real job to
# hermes-broker (type `remediate-<identity>`) and waits for the result — hermes-remediate-worker.py,
# already privileged as `pmoney`, does the actual restart after checking it against
# infra/hermes-remediate/allowlist.json. Mirrors hermes-render-request.sh's shape: submit, poll,
# print the real outcome, never fabricate one.
#
# This is a mechanical action, not a task delegation — no session, no persona spawned. It either
# restarts something real and reports back, or refuses/fails and says why.
#
# Throttling (max 3 attempts per target, then an automatic email + FleetOps escalation instead of a
# 4th try) lives in the worker, not here — repeated calls for the same already-exhausted target will
# just keep coming back refused; that's not a bug to route around.
#
# Usage:
#   hermes-remediate.sh restart-service <exact-unit-name>
#   hermes-remediate.sh send-nudge <other-identity> ["<message>"]
#
# Identity is taken from `whoami` (sintra or amy) unless HERMES_IDENTITY is set — matches the
# VAULT_NODE-inference convention every other identity-aware tool in this fleet already uses.
#
# Requires: tools/vault-get-secret.sh, curl, jq.
set -euo pipefail

USAGE="usage: hermes-remediate.sh restart-service <unit>, or hermes-remediate.sh send-nudge <identity> [message]"
ACTION="${1:?$USAGE}"
TARGET="${2:?$USAGE}"
BODY="${3:-}"

IDENTITY="${HERMES_IDENTITY:-$(whoami)}"
case "$IDENTITY" in
  sintra|amy) ;;
  *) echo "[hermes-remediate] ERROR: unknown identity '$IDENTITY' — set HERMES_IDENTITY to sintra or amy" >&2; exit 1 ;;
esac

BROKER_URL="${BROKER_URL:-http://10.129.1.15:8100}"
REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
POLL_TRIES="${POLL_TRIES:-20}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"

log() { echo "[hermes-remediate] $*" >&2; }

TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" broker-token password)"
if [ -z "$TOKEN" ]; then
  log "ERROR: could not fetch broker-token from vault"
  exit 1
fi

PAYLOAD="$(jq -n --arg id "$IDENTITY" --arg a "$ACTION" --arg t "$TARGET" --arg b "$BODY" \
  '{identity: $id, action: $a, target: $t} + (if $b != "" then {body: $b} else {} end)')"

RESP="$(curl -s -X POST "$BROKER_URL/jobs" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --argjson payload "$PAYLOAD" --arg type "remediate-$IDENTITY" '{type: $type, payload: $payload}')")"

JOB_ID="$(echo "$RESP" | jq -r '.id // empty')"
if [ -z "$JOB_ID" ]; then
  log "ERROR: broker rejected submission: $RESP"
  exit 1
fi
log "Submitted as $JOB_ID ($ACTION $TARGET), waiting..."

tries=0
while [ "$tries" -lt "$POLL_TRIES" ]; do
  JOB="$(curl -s "$BROKER_URL/jobs/$JOB_ID" -H "Authorization: Bearer $TOKEN")"
  STATE="$(echo "$JOB" | jq -r '.state')"
  case "$STATE" in
    done)
      log "Done: $ACTION $TARGET succeeded."
      exit 0
      ;;
    dead)
      ERR="$(echo "$JOB" | jq -r '.error')"
      log "REFUSED or FAILED: $ERR"
      exit 1
      ;;
  esac
  sleep "$POLL_INTERVAL"
  tries=$((tries + 1))
done
log "ERROR: job $JOB_ID did not finish within $((POLL_TRIES * POLL_INTERVAL))s — check status with: curl -s $BROKER_URL/jobs/$JOB_ID -H \"Authorization: Bearer \$TOKEN\""
exit 1
