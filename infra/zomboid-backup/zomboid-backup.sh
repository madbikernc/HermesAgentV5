#!/bin/bash
# Version: 1.1.1
#
# 1.1.1 (2026-08-30) — HermesAgentV5 consolidation: Cross-reference comment pointing at
# hermes-zomboid-backup-pull.py repointed from HermesAgentV4 to HermesAgentV5.
#
# 1.1.0 — real bug found live, 2026-08-17, via a direct "check the muncraft
# server health" request: this backup had been silently failing every
# night since it was first installed (2026-08-12) and reporting SUCCESS
# the whole time. Root cause, confirmed on the live box: zomboid-
# backup.service runs as User=muncraft, but $BACKUP_DIR was owned
# zomboid-admin:zomboid-admin, mode 775 -- muncraft wasn't in that group,
# so `tar` failed with Permission denied creating the new archive. Because
# this script never had `set -e`, that failure didn't stop it -- execution
# fell through to the final `find ... -delete`, which exits 0 trivially
# whenever nothing is old enough to prune yet, and *that* exit code is what
# systemd saw. The one backup file that did exist (2026-08-12) turned out
# to be owned by zomboid-admin, meaning it was a manual run, not the
# automated timer, which had likely never actually worked. Fixed two
# ways, deliberately not just one: `usermod -aG zomboid-admin muncraft`
# closes the actual permission gap (done live, verified — a real new
# muncraft-owned archive landed), and `set -e` here closes the *class* of
# bug, not just this one instance of it — any future failure in this
# script now stops it and surfaces as a real, visible systemd failure
# instead of hiding behind an unrelated trailing command's success.
#
# Nightly Project Zomboid world backup, styled directly on this box's own
# /opt/minecraft/backup.sh (same structure: console flush -> tar -> age-
# based prune). Zomboid has no save-off/save-on pair the way Minecraft
# does (no equivalent console command exists), so this only issues a
# single "save" flush before archiving -- the standard approach PZ server
# admins use in the absence of a save-lock, and PZ's save writes are
# chunk-based and generally safe to tar without one.
#
# HermesAgentV5/tools/hermes-zomboid-backup-pull.py pulls whatever lands
# in $BACKUP_DIR to NAS2 daily -- see that tool's own docstring and
# ../hermes-zomboid-backup-pull/README.md.
set -euo pipefail

BACKUP_DIR=/opt/zomboid/server/backups
SAVE_ROOT=/home/muncraft/Zomboid/Saves/Multiplayer
SAVE_NAME=zomboid
FIFO=/opt/zomboid/server/console.fifo
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)

mkdir -p "$BACKUP_DIR"

if [ -p "$FIFO" ]; then
  echo 'save' > "$FIFO"
  sleep 5
else
  echo "WARNING: $FIFO not found -- zomboid.service may not be running; backing up on-disk state as-is" >&2
fi

tar -czf "$BACKUP_DIR/zomboid_$TIMESTAMP.tar.gz" -C "$SAVE_ROOT" "$SAVE_NAME"

# Same 7-day window as /opt/minecraft/backup.sh. NAS2 (see
# hermes-zomboid-backup-pull.py) keeps a longer 30-day copy independently.
find "$BACKUP_DIR" -name 'zomboid_*.tar.gz' -mtime +7 -delete
