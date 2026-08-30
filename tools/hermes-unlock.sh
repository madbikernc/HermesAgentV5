#!/usr/bin/env bash
# Version: 1.0.0
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

if mountpoint -q "$MOUNT_POINT"; then
  echo "Already unlocked and mounted at $MOUNT_POINT"
  exit 0
fi

sudo cryptsetup open "$LUKS_IMAGE" "$MAPPER_NAME"
sudo mount /dev/mapper/"$MAPPER_NAME" "$MOUNT_POINT"
echo "Unlocked and mounted at $MOUNT_POINT"
