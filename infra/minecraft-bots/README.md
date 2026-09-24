# minecraft-bots — recreate checklist

**Version:** 1.1.0

Ordered steps to install the Minecraft bot orchestrator (`services/minecraft-bots/`) as
process-supervised systemd services, so a crash or a reboot doesn't leave a bot silently offline
the way plain `nohup` did during initial development. Nine units: five on `spark` (Babs, Amy,
Mark, Luke, Mayor) and four on `spark2` (Bob, Nell, Wade, Dale) — the split is memory headroom,
not design. See `MINECRAFT_BOTS_DESIGN.md` for the full design and `infra/minecraft-bots-backup/`
for the sibling recipe this was built alongside.

## 1. Prerequisites already in place

- `services/minecraft-bots/` checked out under `~/HermesAgentV5` on the target host, `npm install`
  run there at least once (installs `mineflayer`/`mineflayer-pathfinder`).
- `~/.hermes/minecraft-matrix.env` exists (`600`) with each bot's Matrix access token -- see
  `services/minecraft-bots/README.md`'s own note on why this isn't in Vaultwarden yet.
- `memory-token` and `buzz-token` Vaultwarden items reachable via `tools/vault-get-secret.sh`
  (already true for every other fleet service on this node).

## 2. Install the units

```bash
# on spark: babs amy mark luke mayor   |   on spark2: bob nell wade dale
for b in babs amy mark luke mayor; do
  sudo cp infra/minecraft-bots/minecraft-bot-$b.service /etc/systemd/system/
  sudo systemctl enable --now minecraft-bot-$b.service
done
sudo systemctl daemon-reload
```

A brand-new bot needs more than a unit file — Buzz `KNOWN_AGENTS`, a Matrix account, and **a
server op grant in `ops.json`**, without which its `/tp` self-rescue fails silently forever. Full
checklist: `MINECRAFT_BOTS_DESIGN.md` §1.

## 3. Verify

```bash
sudo systemctl status 'minecraft-bot-*.service'
sudo journalctl -u minecraft-bot-babs.service -n 20
```

Expect `active (running)`, and each unit's own `[<Name>] spawned at ...` line in its journal.
`Restart=always`/`StartLimitIntervalSec=0` means a crash restarts unconditionally, the same shape
`minecraft-bots.service` (the game server itself) already uses.

`active` is **not** proof a bot is actually in the world — a disconnected process keeps logging
plausible activity. Only RCON `list` settles it.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-06 | Initial version -- replaces the bare `nohup` processes used during initial development. |
| 1.1.0 | 2026-09-24 | Updated from the original two-bot (Babs/Amy, spark-only) install to the real nine-unit, two-host layout; added the op-grant/Buzz/Matrix onboarding pointer and the warning that `active` does not mean connected. |
