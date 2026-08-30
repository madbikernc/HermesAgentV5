# hermes-minecraft-backup-pull — recreate checklist

**Version:** 1.0.1

Daily pull (`tools/hermes-minecraft-backup-pull.py`) of Minecraft world backups from the muncraft
box (`192.168.1.221`) to NAS2. Sibling to `../hermes-zomboid-backup-pull/` (Phase 27) — same box,
same credential, same mechanism, sharing `tools/hermes_game_backup_common.py`'s connect/pull/prune
logic rather than duplicating it.

Phase 28 (`IMPLEMENTATION_PLAN.md` §7), direct follow-up question: "are minecraft backups setup the
same as zomboid, and being copied to Synology?" — the on-box side (`/opt/minecraft/backup.sh` +
`minecraft-backup.timer`) predates this project entirely and was already exactly the style
Zomboid's Phase 27 backup was modeled on, but nothing was pulling its output to NAS2 — Zomboid's
was the only one covered. This closes that gap. **Unlike Zomboid's on-box half, nothing here
needed a manual install step** — Minecraft's backup mechanism already existed, so this tool only
had to add the missing NAS-pull half, and unlike Phase 27's pull side too, there was nothing new to
build there either: same shared module, same credential, same NFS mount.

## Install

```bash
sudo cp hermes-minecraft-backup-pull.service hermes-minecraft-backup-pull.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-minecraft-backup-pull.timer
```

Runs at 04:05 — five minutes after `hermes-zomboid-backup-pull.timer`'s 04:00, deliberately
staggered: a Minecraft pull moves ~6.3GB across 10 files in one run (vs. Zomboid's single ~6MB
file), so the two shouldn't be pulling from the same box at the same instant.

## Manual trigger (testing)

```bash
sudo -u pmoney /usr/bin/python3 /home/pmoney/HermesAgentV5/tools/hermes-minecraft-backup-pull.py --verbose
```

No email — same tier as `hermes-zomboid-backup-pull.timer` and `hermes-nfs-backup.timer`; a broken
timer shows up via `hermes-node-health.py`'s own "Failed units" check.

## Verify

```bash
systemctl list-timers hermes-minecraft-backup-pull.timer
journalctl -u hermes-minecraft-backup-pull.service --no-pager
ls -la /mnt/nas2-hermes-backup/GameServerBackups/Minecraft/
```

## Requires

- `tools/hermes-minecraft-backup-pull.py`, `tools/hermes_game_backup_common.py` on the Spark, plus
  the system `python3-paramiko` package (already installed).
- Vault item `Zomboid Admin - muncraft` — same credential the Zomboid pull and
  `hermes-game-server-monitor.py` already use; despite the name, it's a real SSH login for the
  whole box, not scoped to Zomboid specifically, and reading `/opt/minecraft/backups/` needs
  nothing more privileged than that account already has.
- The Phase 12 NFS mount (`mnt-nas2-hermes-backup.automount` → `/mnt/nas2-hermes-backup`).

## Design notes

- Destination `/mnt/nas2-hermes-backup/GameServerBackups/Minecraft/`, sibling to `.../Zomboid/`.
- Same 30-day NAS-side retention as the Zomboid pull, independently more generous than the source
  box's own 7-day prune — the NAS copy is the actual disaster-recovery copy.
- Pull/prune/idempotency logic is entirely `hermes_game_backup_common.py`'s — this script is just
  its per-game configuration (`REMOTE_BACKUP_DIR`, `FILENAME_PREFIX`, `DEST_DIR`).

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-12 | Initial version — Phase 28. Verified live: a real first run pulled all 10 existing Minecraft world backups (~6.3GB), confirmed present on NAS2 afterward. |
