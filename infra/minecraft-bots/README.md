# minecraft-bots — recreate checklist

**Version:** 1.0.0

Ordered steps to install the Minecraft bot orchestrator (`services/minecraft-bots/`) as
process-supervised systemd services on spark, so a crash or a reboot doesn't leave Babs/Amy
silently offline the way plain `nohup` did during initial development. See
`MINECRAFT_BOTS_DESIGN.md` for the full design and `infra/minecraft-bots-backup/` /
`infra/minecraft-bots-monitor/` for the sibling recipes this build was done alongside.

## 1. Prerequisites already in place

- `services/minecraft-bots/` checked out under `~/HermesAgentV5` on spark, `npm install` run
  there at least once (installs `mineflayer`/`mineflayer-pathfinder`).
- `~/.hermes/minecraft-matrix.env` exists (root-owned/`pmoney`-owned, `600`) with each bot's
  Matrix access token -- see `services/minecraft-bots/README.md`'s own note on why this isn't
  in Vaultwarden yet.
- `memory-token` and `buzz-token` Vaultwarden items reachable via `tools/vault-get-secret.sh`
  (already true for every other fleet service on this node).

## 2. Install the units

```bash
sudo cp infra/minecraft-bots/minecraft-bot-babs.service /etc/systemd/system/
sudo cp infra/minecraft-bots/minecraft-bot-amy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-bot-babs.service
sudo systemctl enable --now minecraft-bot-amy.service
```

## 3. Verify

```bash
sudo systemctl status minecraft-bot-babs.service minecraft-bot-amy.service
sudo journalctl -u minecraft-bot-babs.service -n 20
```

Expect `active (running)` for both, and each unit's own `[<Name>] spawned at ...` line in its
journal. `Restart=always`/`StartLimitIntervalSec=0` means a crash restarts unconditionally,
same shape `minecraft-bots.service` (the game server itself) already uses.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-06 | Initial version -- replaces the bare `nohup` processes used during initial development. |
