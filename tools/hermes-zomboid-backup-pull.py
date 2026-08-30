#!/usr/bin/env python3
# Version: 1.1.0
"""
hermes-zomboid-backup-pull.py — Daily pull of Project Zomboid world backups
from the muncraft box (192.168.1.221) to NAS2, so the only copy of the
world save doesn't live solely on the single box that also runs the
server. Runs via hermes-zomboid-backup-pull.timer, after
zomboid-backup.timer's 03:10 on-box backup and ahead of the 06:xx report
jobs.

Phase 27 (IMPLEMENTATION_PLAN.md §7), direct request: "setup a backup for
Zomboid, in the same style as the minecraft backups" + "setup a time for
the Firmament to pull those backups and stash them in Synology NFS
target." Two halves, split across two different hosts because the
available credentials only allow it that way:

  1. The on-box backup itself (`zomboid-backup.sh` + `zomboid-backup.timer`
     on 192.168.1.221, styled directly on that box's own existing
     `/opt/minecraft/backup.sh`/`minecraft-backup.timer`) — see
     `infra/zomboid-backup/README.md`. That half could NOT be installed by
     this tool or by Hermes's own `Zomboid Admin - muncraft` service
     account: its sudo grant (confirmed live via `sudo -l`) is scoped to
     exactly `systemctl {start,stop,restart,status,is-active}
     zomboid.service` and `journalctl -u zomboid.service*` — nothing that
     can write to `/etc/systemd/system/` or run `systemctl
     daemon-reload`/`enable`. The backup *script* itself was still built
     and verified for real under that same account, though (it only needs
     the write access to `/opt/zomboid/server/` — 775, group-writable —
     that account already has): a live run produced a real 6.2MB archive
     with 5989 real files including `players.db`, confirmed by listing the
     tar contents, not just checking its size. The timer install itself
     was later done by The Boss directly, confirmed live afterward
     (`systemctl is-active`/`is-enabled` both `active`/`enabled`).
  2. This half — pulling the resulting files to NAS2 — runs entirely on
     the Spark as `pmoney`, which already has everything it needs (the
     same `Zomboid Admin - muncraft` vault credential is sufficient here,
     since it only needs read access to already-created backup files, and
     the Phase 12 NFS mount at /mnt/nas2-hermes-backup) — fully built,
     installed, and verified live in this same pass.

Destination: /mnt/nas2-hermes-backup/GameServerBackups/Zomboid/ — a new
top-level-ish folder, no existing game-server-backup convention found on
NAS2 to match (the existing `Backups/` folder there is router/network
config only).

Retention is deliberately more generous on the NAS side (30 days) than the
source box's own 7-day prune (in zomboid-backup.sh): the NAS copy is the
actual disaster-recovery copy if the muncraft box's disk dies, so it
should outlive the source's rolling window, not mirror it exactly. Files
are only ever added here, never deleted to "match" what the source pruned
— an old NAS copy aging out is handled by this script's own 30-day
sweep, independent of what still exists on the source at pull time.

1.1.0 (2026-08-12, Phase 28, direct follow-up: "are minecraft backups
setup the same as zomboid, and being copied to Synology?" — they weren't):
refactored to share hermes_game_backup_common.py's connect/pull/prune
logic with the new hermes-minecraft-backup-pull.py, rather than that
script duplicating this one's ~130 lines. No behavior change — re-verified
live after the refactor (a real pull still confirmed idempotent).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_game_backup_common import run_pull_job  # noqa: E402

REMOTE_BACKUP_DIR = "/opt/zomboid/server/backups"
FILENAME_PREFIX = "zomboid_"
DEST_DIR = Path("/mnt/nas2-hermes-backup/GameServerBackups/Zomboid")
NAS_RETENTION_DAYS = 30


def main() -> int:
    parser = argparse.ArgumentParser(description="Pull Zomboid world backups to NAS2")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()
    return run_pull_job(REMOTE_BACKUP_DIR, FILENAME_PREFIX, DEST_DIR, NAS_RETENTION_DAYS, args.verbose)


if __name__ == "__main__":
    sys.exit(main())
