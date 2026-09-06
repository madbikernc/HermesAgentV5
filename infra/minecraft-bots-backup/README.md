# minecraft-bots-backup — recreate checklist

**Version:** 1.0.0

Nightly backup for the bot Minecraft world (`firmament-bots`, on muncraft), styled directly on
`/opt/minecraft/backup.sh`'s own pattern (7-day retention, one gzipped tar per night) --
`backup.sh`'s own header explains the two real differences from that script (no RCON
save-pause; only one directory to tar, not three).

## Install (on muncraft, as root or via pmoney's sudo)

```bash
sudo cp backup.sh /home/zomboid-admin/minecraft-bots/backup.sh
sudo chown zomboid-admin:zomboid-admin /home/zomboid-admin/minecraft-bots/backup.sh
sudo chmod +x /home/zomboid-admin/minecraft-bots/backup.sh

sudo cp minecraft-bots-backup.service minecraft-bots-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-bots-backup.timer
```

## Verify

```bash
sudo systemctl list-timers minecraft-bots-backup.timer
sudo -u zomboid-admin /home/zomboid-admin/minecraft-bots/backup.sh   # run once by hand
ls -la /home/zomboid-admin/minecraft-bots/backups/
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-06 | Initial version. |
