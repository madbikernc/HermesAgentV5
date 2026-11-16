#!/usr/bin/env bash
# Version: 1.0.0
#
# Initial version (2026-11-16) — HermesAgentV6 IMPLEMENTATION_PLAN.md GLM-5.3-Flash Paradigm A,
# Phase 2 prerequisite: a reusable stop/start for all 9 Minecraft bots, instead of doing this by
# hand again every time spark-2 needs to be fully disrupted for a benchmark campaign. Orchestrated
# centrally from spark (dgx-spark), SSHing to spark-2 for its own four bots — same shape
# hermes-restart-fleet.sh already uses for its own SPARK2_SERVICES, not reinvented here.
#
# Bots cross-checked live (`systemctl list-units --type=service --all | grep minecraft-bot`) on
# both nodes 2026-11-16: spark runs amy/babs/luke/mark/mayor, spark-2 runs bob/dale/nell/wade. 9
# total. `start` runs one bot at a time with a pause between each — run-bot.sh calls
# tools/vault-get-secret.sh (`bw login`) at startup, the same concurrent-Vaultwarden-login hazard
# LESSONS_LEARNED.md already documents for identity services; `stop` has no such hazard but uses
# the same one-at-a-time shape for consistency.
#
# Usage: hermes-minecraft-bots-stop-all.sh <stop|start> [--dry-run]
set -uo pipefail

PAUSE_SECONDS="${PAUSE_SECONDS:-5}"
SPARK2_SSH="spark2"
DRY_RUN=0

SPARK_BOTS=(minecraft-bot-amy minecraft-bot-babs minecraft-bot-luke minecraft-bot-mark minecraft-bot-mayor)
SPARK2_BOTS=(minecraft-bot-bob minecraft-bot-dale minecraft-bot-nell minecraft-bot-wade)

log() { echo "[hermes-minecraft-bots-stop-all] $*"; }

MODE="${1:-}"
case "$MODE" in
  stop|start) shift ;;
  *) echo "Usage: $0 <stop|start> [--dry-run]" >&2; exit 2 ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Usage: $0 <stop|start> [--dry-run]" >&2; exit 2 ;;
  esac
done

ACTION="systemctl $MODE"
VERB="stopping"; [ "$MODE" = "start" ] && VERB="starting"
exit_code=0

for unit in "${SPARK_BOTS[@]}"; do
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would run: sudo $ACTION ${unit}.service (spark, local)"
  else
    log "$VERB ${unit}.service (spark, local)"
    sudo systemctl "$MODE" "${unit}.service" || exit_code=1
    sleep "$PAUSE_SECONDS"
  fi
done

for unit in "${SPARK2_BOTS[@]}"; do
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would run: ssh $SPARK2_SSH sudo $ACTION ${unit}.service"
  else
    log "$VERB ${unit}.service (spark-2, via ssh $SPARK2_SSH)"
    ssh "$SPARK2_SSH" "sudo systemctl $MODE ${unit}.service" || exit_code=1
    sleep "$PAUSE_SECONDS"
  fi
done

log "done (mode=$MODE, dry_run=$DRY_RUN, exit=$exit_code)"
exit "$exit_code"
