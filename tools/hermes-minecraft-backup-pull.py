#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-minecraft-backup-pull.py — Daily pull of Minecraft world backups
from the muncraft box (192.168.1.221) to NAS2, so the only copy of the
world doesn't live solely on the box that also runs the server.

Phase 28 (IMPLEMENTATION_PLAN.md §7), direct follow-up: "are minecraft
backups setup the same as zomboid, and being copied to Synology?" — the
on-box backup mechanism (backup.sh/minecraft-backup.timer) predates this
project entirely and was already exactly the style Zomboid's was modeled
on, but nothing was pulling its output to NAS2. Sibling to
hermes-zomboid-backup-pull.py (Phase 27) — same box, same credential
(the underlying account is a real SSH login for the whole box, not
Zomboid-specific), same mechanism, sharing hermes_game_backup_common.py's
connect/pull/prune logic rather than duplicating it. Unlike Zomboid's
on-box half, nothing here needed a manual install step: Minecraft's own
backup.sh/minecraft-backup.timer already existed, so this tool only had to
add the missing NAS-pull half, fully buildable and installable from the
Spark alone.

Usage:
  hermes-minecraft-backup-pull.py             # real run
  hermes-minecraft-backup-pull.py --verbose   # also print when nothing changed
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_game_backup_common import run_pull_job  # noqa: E402

REMOTE_BACKUP_DIR = "/opt/minecraft/backups"
FILENAME_PREFIX = "world_"
DEST_DIR = Path("/mnt/nas2-hermes-backup/GameServerBackups/Minecraft")
NAS_RETENTION_DAYS = 30


def main() -> int:
    parser = argparse.ArgumentParser(description="Pull Minecraft world backups to NAS2")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()
    return run_pull_job(REMOTE_BACKUP_DIR, FILENAME_PREFIX, DEST_DIR, NAS_RETENTION_DAYS, args.verbose)


if __name__ == "__main__":
    sys.exit(main())
