# zomboid-backup — recreate checklist

**Version:** 1.0.1

**Status: fully installed and live.** The Boss installed `zomboid-backup.service`/
`zomboid-backup.timer` directly (confirmed 2026-08-12: `systemctl is-active`/`is-enabled` both
`active`/`enabled`, next run scheduled 03:10). The section below is kept as the recreate checklist
for this host, not a still-open task.

Nightly Project Zomboid world backup on the muncraft box (`192.168.1.221`), styled directly on
that same box's existing `/opt/minecraft/backup.sh` + `minecraft-backup.timer` (03:00, 7-day
prune). This is a **remote-box script**, like Minecraft's own `backup.sh` — it lives on
`192.168.1.221`, not in this repo's `tools/`, and is tracked here only as a reference copy plus
its own recreate checklist, the same way `infra/vaultwarden/README.md` documents Vaultwarden's own
setup without Vaultwarden itself being code in this repo.

Phase 27 (`IMPLEMENTATION_PLAN.md` §7), direct request: "setup a backup for Zomboid, in the same
style as the minecraft backups."

## ⚠ One step here needs a human with real root/muncraft access — this could not be fully
## automated by Hermes

**What's already done, verified live, 2026-08-12:** `zomboid-backup.sh` was written to
`/opt/zomboid/server/zomboid-backup.sh` and actually run, for real, under Hermes's own
`Zomboid Admin - muncraft` service-account credential (that account has write access to
`/opt/zomboid/server/` — confirmed `775`, group-writable — which is all the script itself needs).
The run produced a real 6.2MB archive containing 5989 real files, including `players.db` —
confirmed by listing the tar's actual contents, not just checking that a file appeared.

**What still needs a human:** installing `zomboid-backup.service` + `zomboid-backup.timer` into
`/etc/systemd/system/` and running `systemctl daemon-reload && systemctl enable --now
zomboid-backup.timer`. Hermes's `Zomboid Admin - muncraft` account cannot do this — its sudo grant,
confirmed live via `sudo -l`, is scoped to exactly:

```
(root) NOPASSWD: /usr/bin/systemctl start zomboid.service, /usr/bin/systemctl stop zomboid.service,
                  /usr/bin/systemctl restart zomboid.service, /usr/bin/systemctl status zomboid.service*,
                  /usr/bin/systemctl is-active zomboid.service, /usr/bin/journalctl -u zomboid.service*
```

Nothing in that list can write to `/etc/systemd/system/` or run `systemctl daemon-reload`/`enable`
for a *new* unit. This is presumably deliberate scoping (the same least-privilege pattern this
project uses for its own `sintra`/`amy` Unix users) — not a bug to route around. `hermes-game-
server-monitor.py` reports `Zomboid backups: CRITICAL — no backup files found` until this step is
done (see its own README), so the gap stays visible rather than silently assumed complete.

## Install (run as root or muncraft on 192.168.1.221)

```bash
sudo cp zomboid-backup.sh /opt/zomboid/server/zomboid-backup.sh
sudo chown muncraft:muncraft /opt/zomboid/server/zomboid-backup.sh
sudo chmod 755 /opt/zomboid/server/zomboid-backup.sh
sudo cp zomboid-backup.service zomboid-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zomboid-backup.timer
```

The script that's already live at `/opt/zomboid/server/zomboid-backup.sh` (owned by
`zomboid-admin` from the verification run above) can be left in place or overwritten by the `cp`
above — same content, only the ownership changes to match Minecraft's own `User=muncraft` pattern.

Runs at 03:10, ten minutes after Minecraft's own 03:00 backup, so the two don't `tar` at the exact
same instant on the same box.

## Manual trigger (testing)

```bash
sudo -u muncraft /opt/zomboid/server/zomboid-backup.sh
```

## Verify

```bash
systemctl list-timers zomboid-backup.timer
journalctl -u zomboid-backup.service --no-pager
ls -la /opt/zomboid/server/backups/
```

## Design notes

- **No save-off/save-on pair, unlike Minecraft.** Project Zomboid's console has no documented
  equivalent to Minecraft's `save-off`/`save-all flush`/`save-on` sequence — only a plain `save`
  command (same one `hermes-zomboid-admin.sh`'s `save` subcommand sends). This is the standard
  approach PZ server admins use in the absence of a save-lock; PZ's save writes are chunk-based and
  generally safe to `tar` without one.
- Sent via the same FIFO console mechanism `zomboid.service`/`hermes-zomboid-admin.sh` already use
  (`/opt/zomboid/server/console.fifo`) — `echo 'save' > $FIFO`, no RCON involved (Zomboid's own
  RCON is disabled on this install — blank `RCONPassword`).
- Same 7-day local prune window as Minecraft's `backup.sh`. The NAS2 copy
  (`tools/hermes-zomboid-backup-pull.py`, see `../hermes-zomboid-backup-pull/README.md`) keeps a
  longer, independent 30-day retention — it's the actual disaster-recovery copy if this box's disk
  dies, so it shouldn't mirror the source's short rolling window.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-08-12 | Initial version — Phase 27. Backup script written and verified live under the `zomboid-admin` account; systemd unit install left as a documented manual step (that account's sudo grant doesn't cover it). |
| 1.0.1 | 2026-08-12 | The Boss installed the timer directly — confirmed live (`active`/`enabled`, next run 03:10). Status line updated; no content change to the install steps themselves. |
