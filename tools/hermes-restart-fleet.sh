#!/usr/bin/env bash
# Version: 3.0.1
#
# 3.0.1 (2026-08-30) — HermesAgentV5 consolidation: PMONEY_REPO repointed from
# HermesAgentV4 to HermesAgentV5.
#
# 3.0.0 (HermesAgentV5 S13/S14) — full retarget for the V5 dispatcher/presenter topology, real,
# substantive changes, not a rename pass. Everything 2.0.0 restarted no longer exists (Sintra's and
# Amy's gateways/guard daemons were stopped and disabled at S8) and several real V5 services this
# script never knew about have existed since S2-S12 without ever being in a coordinated restart:
#
# - **New spark stack, dependency-ordered:** Matrix first (presenter/broker post to it) -> the
#   `dispatch` role's own resident backend -> the broker (LUKS-dependent) -> the wake worker (needs
#   the broker) -> Buzz and hermes-memory (everything downstream needs both up) -> guard -> the
#   router (proxies to every model backend) -> hermes-dispatch (needs Buzz/memory/guard/router) ->
#   hermes-presenter (needs Buzz/memory/dispatch/Matrix). `super` and `coder` are both on-demand
#   (checked, not assumed — see below) and no longer include `nano`, retired at S13.
#
# - **New spark-2 stack:** `omni` and `muse` -> spark-2's own router -> `hermes-media` (S10, needs
#   Watch's Buzz/memory/broker/guard). No more Amy-specific units — confirmed live (`systemctl cat`
#   on spark-2) that every one of these already runs as `User=pmoney`, not `amy`. The `spark2-amy`
#   SSH alias (`ssh amy@spark-2` via a dedicated key) is retired from this script's own use; a new
#   plain `spark2` alias (`ssh pmoney@spark-2` via the S1 node-to-node key,
#   `~/.ssh/spark2_access`) replaces it. `hermes-repo-sync.sh` may still reference the old alias for
#   its own now-inert Sintra/Amy-specific sync paths — untouched here, out of this script's scope.
#
# - **`llama-super.service`/`llama-coder.service` restarted only if already active, never
#   unconditionally.** Both are on-demand by design — a bare `systemctl restart` on a stopped unit
#   starts it, which would silently wake a large model this script has no business waking. Checked,
#   not assumed, same discipline 2.0.0 already established for `super` — now applied to `coder` too
#   (moved to spark and gained its own idle-sleep timer since 2.0.0 was written).
#
# - **The sudoers gap 2.0.0 flagged (`/etc/sudoers.d/amy-repo-sync`, scoped to three guard-daemon
#   commands and nothing else on spark-2) is moot, not fixed forward.** This script uses pmoney's
#   own general passwordless sudo on spark-2 (confirmed live, pre-existing, unrelated to the narrow
#   amy-repo-sync grant) — there was never a real gap here once the target user is `pmoney`, only
#   when it was `amy`. The old amy-specific grant is a separate, real leftover (Amy's OS account
#   still has passwordless root on 8 units, including shared `hermes-router.service`) — closed in
#   IMPLEMENTATION_PLAN.md S14, not by this script.
#
# hermes-restart-fleet.sh — restart the fleet's core service stack, in dependency order, from the
# pmoney account on spark.
#
# Scope: the standing daemons the fleet actually depends on — Matrix, both nodes' resident model
# backends, the broker/wake-worker, Buzz, hermes-memory, hermes-guard, both nodes' routers,
# hermes-dispatch, hermes-presenter, hermes-media — plus HomeD13's render workers over SSH.
# Deliberately does NOT touch the periodic timers (RAG ingest, news digest, usage/pfsense reports,
# backups, canary/game-server monitors, etc.) — those are one-shot jobs, not services a restart
# order matters for.
#
# Two safety behaviours are carried over from real incidents already found in this project, not
# invented here:
#   - Services restart ONE AT A TIME with a pause between each, never in a single
#     `systemctl restart a b c`. hermes-repo-sync.sh found that several of an identity's services
#     restarting together each call vault-get-secret.sh -> `bw login` at startup, and concurrent
#     logins trip Vaultwarden's own rate limiter. See LESSONS_LEARNED.md.
#   - HomeD13's render workers are never restarted blind. hermes-repo-sync.sh established that
#     restarting hermes-render-worker(-video).service mid-job kills a real in-progress render/video
#     job (broker requeues it, but a 20+ minute job is real lost time). This script checks the
#     broker for an in-flight job of that worker's type first and skips (with a warning) rather
#     than restarting through it. --force skips this check.
#
# Service names cross-checked live (`systemctl list-units --all --type=service`) on both nodes
# before this rewrite, not re-guessed from old docs — see IMPLEMENTATION_PLAN.md S13/S14 for the
# actual live inventory this was built from. If any restart below 404s, confirm the live name with:
#   systemctl list-units --all --type=service | grep -i hermes    (on spark)
#   ssh spark2 'systemctl list-units --all --type=service | grep -i hermes'   (on spark-2)
# before assuming this script is wrong.
set -uo pipefail

PAUSE_SECONDS="${PAUSE_SECONDS:-10}"
BROKER_URL="${BROKER_URL:-http://10.129.1.15:8100}"
PMONEY_REPO="/home/pmoney/HermesAgentV5"
HOMED13_SSH="homed13"
SPARK2_SSH="spark2"
FORCE=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Usage: $0 [--force] [--dry-run]" >&2; exit 2 ;;
  esac
done

log() { echo "[hermes-restart-fleet] $*"; }

exit_code=0

# Spark services, in the order they actually depend on each other: Matrix first (presenter/broker
# post to it) -> dispatch's own resident backend -> the broker (needs the LUKS-container mount) ->
# the wake worker (needs the broker) -> Buzz and hermes-memory (everything downstream needs both
# up) -> guard -> spark's own router (proxies to every model backend) -> hermes-dispatch (needs
# Buzz/memory/guard/router) -> hermes-presenter (needs Buzz/memory/dispatch/Matrix). `super` and
# `coder` are both on-demand, handled separately below.
SPARK_SERVICES=(
  continuwuity.service
  llama-dispatch.service
  hermes-broker.service
  hermes-model-wake-worker.service
  hermes-buzz.service
  hermes-memory.service
  hermes-guard.service
  hermes-router.service
  hermes-dispatch.service
  hermes-presenter.service
)

# spark-2 services, same dependency-order logic: omni (vision/audio, always resident) -> muse
# (always resident) -> spark-2's own router -> hermes-media (S10, needs Watch's Buzz/memory/broker/
# guard). Restarted over SSH via the plain `spark2` alias (pmoney, S1's node-to-node key) — every
# one of these runs as User=pmoney (confirmed live), so no sudo/elevated grant is needed at all.
SPARK2_SERVICES=(
  llama-omni.service
  llama-muse.service
  hermes-router.service
  hermes-media.service
)

# llama-dispatch.service and hermes-broker.service both live inside the LUKS container at
# /mnt/hermes-data, which is never auto-mounted (IMPLEMENTATION_PLAN.md §3a: "The Spark's LUKS
# container is never auto-mounted"). If it's not mounted, systemd's RequiresMountsFor makes both
# units wait and retry harmlessly rather than crash-loop -- not fatal, but worth surfacing rather
# than silently restarting into a wait state.
check_luks_mount() {
  if ! mountpoint -q /mnt/hermes-data 2>/dev/null; then
    log "WARNING: /mnt/hermes-data is not mounted. llama-dispatch.service and"
    log "  hermes-broker.service will start but sit waiting on the mount rather"
    log "  than come up. Run hermes-unlock.sh first if this is a post-reboot restart."
  fi
}

restart_unit() {
  local svc="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY RUN: would restart $svc"
    return 0
  fi
  if sudo systemctl restart "$svc"; then
    log "restarted $svc"
  else
    log "ERROR: restart failed for $svc — check: systemctl status $svc"
    exit_code=1
    return 1
  fi
}

restart_spark2_unit() {
  local svc="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY RUN: would restart spark-2:$svc"
    return 0
  fi
  # pmoney's own passwordless sudo on spark-2 (confirmed live, general, not the narrow
  # amy-repo-sync grant) covers this — no per-unit allowlist to maintain here.
  if ssh "$SPARK2_SSH" "sudo systemctl restart $svc"; then
    log "restarted spark-2:$svc"
  else
    log "ERROR: restart failed for spark-2:$svc — check: ssh $SPARK2_SSH systemctl status $svc"
    exit_code=1
    return 1
  fi
}

# True if the broker has a job of $1 (render|video) in state 'running'.
# Fails safe: broker/token unreachable is treated as busy (skip), same
# convention as hermes-repo-sync.sh's broker_job_type_running().
broker_job_type_running() {
  local jtype="$1" token resp count
  token="$("$PMONEY_REPO/tools/vault-get-secret.sh" broker-token 2>/dev/null)"
  if [ -z "$token" ]; then
    log "WARNING: could not fetch broker-token to check homed13's $jtype queue -- treating as busy (fail safe)"
    return 0
  fi
  resp="$(printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -s -K - --max-time 15 "$BROKER_URL/jobs" 2>/dev/null)"
  count="$(echo "$resp" | jq -e --arg t "$jtype" '[.jobs[]? | select(.type==$t and .state=="running")] | length' 2>/dev/null)"
  if [ -z "$count" ]; then
    log "WARNING: could not read broker /jobs to check homed13's $jtype queue -- treating as busy (fail safe)"
    return 0
  fi
  [ "$count" -gt 0 ]
}

restart_homed13_unit() {
  local svc="$1" jtype="${2:-}"
  if [ -n "$jtype" ] && [ "$FORCE" -eq 0 ] && broker_job_type_running "$jtype"; then
    log "SKIPPED $svc: a $jtype job is in flight on the broker — rerun with --force to override"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY RUN: would restart homed13:$svc"
    return 0
  fi
  if ssh "$HOMED13_SSH" "sudo systemctl restart $svc"; then
    log "restarted homed13:$svc"
  else
    log "ERROR: restart failed for homed13:$svc — check: ssh $HOMED13_SSH systemctl status $svc"
    exit_code=1
    return 1
  fi
}

log "== Spark: core service stack =="
check_luks_mount
for svc in "${SPARK_SERVICES[@]}"; do
  restart_unit "$svc"
  sleep "$PAUSE_SECONDS"
done

# On-demand — restart only if it's actually running right now. A bare `systemctl restart` on a
# stopped unit starts it, which would wake a model this script has no business waking.
for svc in llama-super.service llama-coder.service; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    restart_unit "$svc"
  else
    log "$svc is not active (on-demand, normal) — not restarting/waking it"
  fi
done

log "== Spark-2: model backends + router + media (over SSH) =="
for svc in "${SPARK2_SERVICES[@]}"; do
  restart_spark2_unit "$svc"
  sleep "$PAUSE_SECONDS"
done

log "== HomeD13: render workers (over SSH) =="
# comfyui-homed13.service first -- both render workers declare
# After=comfyui-homed13.service in their unit files.
restart_homed13_unit comfyui-homed13.service
sleep "$PAUSE_SECONDS"
restart_homed13_unit hermes-render-worker.service render
sleep "$PAUSE_SECONDS"
restart_homed13_unit hermes-render-worker-video.service video

if [ "$exit_code" -eq 0 ]; then
  log "done — all restarts succeeded (skips from --force checks are not failures)"
else
  log "done — one or more restarts FAILED, see ERROR lines above"
fi
exit "$exit_code"
