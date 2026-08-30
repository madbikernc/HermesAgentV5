#!/usr/bin/env bash
# Version: 1.0.1
#
# 1.0.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default and the
# status-exchange prompt's tool paths repointed from HermesAgentV4 to HermesAgentV5.
#
# hermes-status-exchange-trigger.sh — real, external "hourly cross-node status check" trigger
# (IMPLEMENTATION_PLAN.md Stage 10, direct request). Distinct from hermes-buzz-checkin-trigger.sh's
# softer, 4-hourly "feel free to check in" nudge: this one is a structured, expected exchange —
# Sintra on the hour, Amy on the half hour — where each identity states her own status (including
# her real git commit — trivial to look up, not something she needs to reason about, since
# hermes-repo-autopull already keeps it correct) and asks the other for hers over Buzz.
#
# Same "never the persona, real inbound Matrix event, no special invocation path" pattern as
# hermes-wiki-checkin-trigger.sh and hermes-buzz-checkin-trigger.sh, posted as @hermes-ops-ctl:spark.
# Sets m.mentions.user_ids (MSC3952) — hermes-buzz-watch.sh 1.2.0 found this required for these same
# home rooms; reused, not rediscovered.
#
# Deliberately does NOT tell her how to fix anything found unhealthy — that's
# skills/self-remediate/SKILL.md's job, referenced in the prompt below, so the actual remediation
# logic (allowlist, throttle, escalation) lives in exactly one place.
#
# Meant to be run by a pmoney-owned systemd timer, one instance per identity, on the hour (sintra)
# and half hour (amy) — see infra/hermes-remediate/hermes-status-exchange-sintra.timer and
# hermes-status-exchange-amy.timer.
#
# Usage: hermes-status-exchange-trigger.sh <sintra|amy>
# Requires: tools/vault-get-secret.sh, jq, curl.
set -euo pipefail

REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
MATRIX_URL="${MATRIX_URL:-http://127.0.0.1:6167}"

ME="${1:?usage: hermes-status-exchange-trigger.sh <sintra|amy>}"
case "$ME" in
  sintra) OTHER="Amy";    HOME_ROOM="!teSvzXTJKwZyuh8QK8:spark" ;;
  amy)    OTHER="Sintra"; HOME_ROOM="!KvSV6SCscjEO8QWjuP:spark" ;;
  *) echo "[status-exchange-trigger] Unknown identity '$ME' — no home room mapping" >&2; exit 1 ;;
esac

log() { echo "[status-exchange-trigger:$ME] $*" >&2; }

OPS_CTL_TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" matrix-ops-ctl password)"
if [ -z "$OPS_CTL_TOKEN" ]; then
  log "ERROR: could not fetch matrix-ops-ctl token, exiting"
  exit 1
fi

PROMPT="SYSTEM (status-exchange, automated, hourly): a real external trigger, sent by a systemd timer outside your own control, not something you polled for. This is the scheduled cross-node status exchange: (1) state your own current git commit (~/HermesAgentV5/tools/vault-get-secret.sh isn't needed for this -- just \`git -C ~/HermesAgentV5 log -1 --format=%H\` -- hermes-repo-autopull already keeps this current, you're just reporting it, not fixing it), and briefly note anything you've genuinely noticed wrong with your own services today. (2) Ask ${OTHER} over Buzz for her own status (~/HermesAgentV5/tools/hermes-buzz.sh send \"...\" -- see skills/buzz/SKILL.md) and wait for her reply (poll with a generous timeout). (3) If you or she reports something genuinely broken that's a real service/daemon problem: see skills/self-remediate/SKILL.md for exactly what you may fix yourself (restarts, nudges, via hermes-remediate.sh) versus what needs root-causing and Boss approval first -- follow that skill's process precisely, don't improvise a different one. If everything's healthy, a short confirmation is enough; you don't need to manufacture something to report."

txn="statusexchange-$(date +%s%N)"
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
log "status-exchange prompt posted to $ME's home room ($HOME_ROOM), event $(echo "$resp" | jq -r '.event_id')"
