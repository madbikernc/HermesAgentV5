#!/usr/bin/env bash
# Version: 1.1.0
#
# 1.1.0 (2026-09-03) — real week-long outage found and root-caused: hermes-rag-discovery-portal.service
# failed once at boot (2026-08-27 22:21:03) because RequiresMountsFor=/mnt/hermes-data wasn't satisfied yet
# at that exact moment, and Restart=always never covers a failed *dependency* -- only a service that started
# and later died. The unit sat silently `inactive (dead)`, zero log output, for a full week until manually
# restarted. Every unit sharing this same RequiresMountsFor is equally exposed -- hermes-broker,
# hermes-buzz, hermes-memory, hermes-guard, hermes-rag-discovery-portal, confirmed by grepping
# `RequiresMountsFor=/mnt/hermes-data` across every infra/*.service file in this repo, not assumed.
# hermes-broker only survived this same race because someone happened to restart it separately before this
# was found; nothing was actually protecting it either. This script already runs after every reboot for the
# mount itself, so it's now also the one place that re-kicks any of those units left stranded by this race
# -- on both branches (already-mounted and freshly-unlocked), since the failed start job can predate this
# script running at all. Each restart is conditional on the unit existing on this host (spark and spark-2
# don't share the same unit set) and not already active, so a routine idempotent re-run of this script never
# disrupts a service that's already healthy.
#
# Unlocks and mounts the encrypted Hermes data container (a file-backed LUKS2 volume, no crypttab
# entry by design — see infra/spark2-disk-encryption/README.md §"Manual unlock after every reboot").
# Run after every reboot on spark or spark-2; idempotent (a no-op if already mounted).
#
# Ported into this repo 2026-08-28: previously only lived as an untracked
# /usr/local/bin/hermes-unlock.sh on spark (and had no copy at all on spark-2) — a real gap surfaced
# by a live outage where nano/super/embedding/broker/buzz all crash-looped after an unexpected
# reboot because nobody had a tracked copy of the one script that fixes it. Content unchanged from
# spark's original.
set -euo pipefail

LUKS_IMAGE=/opt/hermes-data.img
MAPPER_NAME=hermes-data
MOUNT_POINT=/mnt/hermes-data

# Every unit declaring RequiresMountsFor=/mnt/hermes-data (verified via grep across infra/*.service,
# 2026-09-03) -- if a new one is added, add it here too, or it inherits this exact stranding risk silently.
DEPENDENT_UNITS=(
  hermes-broker.service
  hermes-buzz.service
  hermes-memory.service
  hermes-guard.service
  hermes-rag-discovery-portal.service
)

restart_stranded_units() {
  for unit in "${DEPENDENT_UNITS[@]}"; do
    if ! systemctl cat "$unit" >/dev/null 2>&1; then
      continue  # not installed on this node -- spark and spark-2 don't share one unit set
    fi
    if systemctl is-active --quiet "$unit"; then
      continue  # already healthy -- a routine re-run must never disrupt a running service
    fi
    echo "Restarting $unit (found inactive/failed -- likely stranded by the mount-dependency race)"
    sudo systemctl restart "$unit" || echo "WARNING: failed to restart $unit -- check it by hand" >&2
  done
}

if mountpoint -q "$MOUNT_POINT"; then
  echo "Already unlocked and mounted at $MOUNT_POINT"
  restart_stranded_units
  exit 0
fi

sudo cryptsetup open "$LUKS_IMAGE" "$MAPPER_NAME"
sudo mount /dev/mapper/"$MAPPER_NAME" "$MOUNT_POINT"
echo "Unlocked and mounted at $MOUNT_POINT"
restart_stranded_units
