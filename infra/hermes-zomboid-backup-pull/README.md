# hermes-zomboid-backup-pull — recreate checklist

**Version:** 1.1.1

Daily pull (`tools/hermes-zomboid-backup-pull.py`) of Project Zomboid world backups from the
muncraft box (`192.168.1.221`) to NAS2, so the only copy of the world save doesn't live solely on
the single box that also runs the server — the same "get it off the source box" reasoning as
Phase 12's NFS backup, applied to the muncraft box's game data instead of the Spark's own
`~/.hermes`.

Phase 27 (`IMPLEMENTATION_PLAN.md` §7), second half of "setup a backup for Zomboid... setup a time
for the Firmament to pull those backups and stash them in Synology NFS target." Unlike the on-box
backup script itself (`../zomboid-backup/`, which needed a human to install — see that README),
this half runs entirely on the Spark as `pmoney`, which already has everything it needs, and was
fully built, installed, and verified live in the same pass. `../zomboid-backup/zomboid-backup.timer`
was subsequently installed by The Boss directly (confirmed live afterward: `active`/`enabled`).

**Phase 28 follow-up:** once `../hermes-minecraft-backup-pull/` needed the identical connect/pull/
prune logic for a second game, that logic moved into `tools/hermes_game_backup_common.py` — this
script is now that shared module plus its own per-game config, not a standalone implementation.
Re-verified live after the refactor: a real pull still confirmed correctly idempotent.

## Install

```bash
sudo cp hermes-zomboid-backup-pull.service hermes-zomboid-backup-pull.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-zomboid-backup-pull.timer
```

Runs at 04:00 — after `zomboid-backup.timer`'s 03:10 on-box run, before the 06:xx report jobs.

## Manual trigger (testing)

```bash
sudo -u pmoney /usr/bin/python3 /home/pmoney/HermesAgentV5/tools/hermes-zomboid-backup-pull.py --verbose
```

No email — this is infra plumbing, same tier as `hermes-nfs-backup.timer` and
`hermes-botnet-intel-sync.timer`; a broken timer shows up via `hermes-node-health.py`'s own "Failed
units" check like anything else.

## Verify

```bash
systemctl list-timers hermes-zomboid-backup-pull.timer
journalctl -u hermes-zomboid-backup-pull.service --no-pager
ls -la /mnt/nas2-hermes-backup/GameServerBackups/Zomboid/
```

## Requires

- `tools/hermes-zomboid-backup-pull.py` on the Spark, plus the system `python3-paramiko` package
  (already installed — same one `hermes-game-server-monitor.py` uses).
- Vault item `Zomboid Admin - muncraft` — the same read-only-sufficient credential
  `hermes-game-server-monitor.py` uses; pulling already-created backup files needs nothing more
  privileged than that account already has.
- The Phase 12 NFS mount (`mnt-nas2-hermes-backup.automount` → `/mnt/nas2-hermes-backup`).
- **`../zomboid-backup/zomboid-backup.timer` must actually be installed and have produced at least
  one backup file** for this to have anything to pull — see that directory's own README for the
  one manual step it needs.

## Design notes

- Destination `/mnt/nas2-hermes-backup/GameServerBackups/Zomboid/` — a new folder; no existing
  game-server-backup convention was found on NAS2 to match (the existing `Backups/` folder there
  turned out to be router/network config only, unrelated).
- Pulls by filename+size comparison (SFTP `listdir_attr` against what's already on NAS2) — a file
  already present at the same size is skipped, not re-downloaded.
- **Retention is deliberately more generous on NAS2 (30 days) than the source box's own 7-day
  prune** (`zomboid-backup.sh`) — the NAS copy is the actual disaster-recovery copy if the muncraft
  box's disk dies, so it should outlive the source's rolling window. Old NAS copies age out on this
  script's own 30-day sweep, independent of what still exists on the source at pull time — nothing
  is ever deleted here just because the source already pruned it.
- Partial/failed transfers land as `.tar.gz.partial` and are cleaned up rather than left as a
  corrupt same-named file that a size check might otherwise treat as "already present."

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.1.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-12 | Initial version — Phase 27. Verified live end to end: a real backup file pulled and confirmed byte-identical on NAS2 (6,247,299 bytes both sides), and a re-run confirmed correctly idempotent (skipped, not re-downloaded). |
| 1.1.0 | 2026-08-12 | Phase 28: refactored to share `tools/hermes_game_backup_common.py` with the new `hermes-minecraft-backup-pull.py`. No behavior change — re-verified live post-refactor. |
