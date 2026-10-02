# minecraft-bots-mobcap — recreate checklist

**Version:** 1.0.0

Every 15 minutes on muncraft, `mobcap.sh` clears dropped eggs in the bot world and thins chickens
above `CHICKEN_CAP` (150) at random, over RCON 25581. On 2026-09-27 2,853 chickens and 1,356
dropped items had gathered around the bots' base and the server fell to ~8 ticks/s; nobody had
thrown an egg or bred a chicken (per-player stats), they came in with loaded chunks and followed
the seed-carrying farming bots. Only loaded entities are ever counted or touched.

## Install (on muncraft, as pmoney)

```bash
sudo cp mobcap.sh /home/zomboid-admin/minecraft-bots/mobcap.sh
sudo chown zomboid-admin:zomboid-admin /home/zomboid-admin/minecraft-bots/mobcap.sh
sudo chmod +x /home/zomboid-admin/minecraft-bots/mobcap.sh
sudo cp minecraft-bots-mobcap.service minecraft-bots-mobcap.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-bots-mobcap.timer
```

## Verify

```bash
sudo systemctl start minecraft-bots-mobcap.service && journalctl -u minecraft-bots-mobcap -n 3
systemctl list-timers minecraft-bots-mobcap.timer
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-27 | Initial version. |
