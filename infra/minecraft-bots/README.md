# minecraft-bots — recreate checklist

**Version:** 1.4.0

Ordered steps to install the Minecraft bot orchestrator (`services/minecraft-bots/`) as
process-supervised systemd services, so a crash or a reboot doesn't leave a bot silently offline
the way plain `nohup` did during initial development. Nine units: five on `spark` (Babs_Miner,
Amy_Builder, Mark_Soldier, Luke_Soldier, Mayor_Leader) and four on `spark2` (Bob_Farmer,
Nell_Artist, Wade_Explorer, Dale_Herder) — the split is memory headroom, not design. Unit
filenames and `MC_BOT_PERSONA` stay the plain lowercase name (`babs`, `mark`, ...) even though
each bot's in-game `MC_BOT_USERNAME` became Name_Role 2026-11-26 — see `MINECRAFT_BOTS_DESIGN.md`
for the full design and `infra/minecraft-bots-backup/` for the sibling recipe this was built
alongside.

## 1. Prerequisites already in place

- `services/minecraft-bots/` checked out under `~/HermesAgentV5` on the target host, `npm install`
  run there at least once (installs `mineflayer`/`mineflayer-pathfinder`).
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

A brand-new bot needs more than a unit file — Buzz `KNOWN_AGENTS` (bots coordinate with each
other only over Buzz) and **a server op grant in `ops.json`**, without which its `/tp`
self-rescue fails silently forever. No Matrix account: the per-bot Matrix room watcher is legacy
from before Buzz, and a bot without a token runs fully. Full checklist: `MINECRAFT_BOTS_DESIGN.md`
§1.

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

## 7. Firmament observability: per-bot Prometheus metrics

Direct request 2026-11-28 ("have prometheus record... mobs killed/blocks placed/blocks destroyed/
steps traveled/items created... by bot"). Every bot now exposes its own action counters
(`metrics.js`) on a dedicated HTTP listener, one port per bot (never shared with the game
connection or with `hermes-router.py`'s own `9101` metrics port on the same host):

| Bot | Host | Port |
|---|---|---|
| Babs_Miner | dgx-spark | 9110 |
| Amy_Builder | dgx-spark | 9111 |
| Mark_Soldier | dgx-spark | 9112 |
| Luke_Soldier | dgx-spark | 9113 |
| Mayor_Leader | dgx-spark | 9114 |
| Bob_Farmer | dgx-spark2 | 9115 |
| Nell_Artist | dgx-spark2 | 9116 |
| Wade_Explorer | dgx-spark2 | 9117 |
| Dale_Herder | dgx-spark2 | 9118 |

Bound `0.0.0.0` (Prometheus runs on HomeD13, not co-located with any bot host) -- firewall scoped
with one ranged `ufw` rule per host, matching every other cross-host-reachable port in this fleet:

```bash
# on dgx-spark
sudo ufw allow from 10.129.1.16 to any port 9110:9114 proto tcp comment 'FIRMAMENT_OBSERVABILITY: HomeD13 Prometheus -> Minecraft bot metrics'
# on dgx-spark2
sudo ufw allow from 10.129.1.16 to any port 9115:9118 proto tcp comment 'FIRMAMENT_OBSERVABILITY: HomeD13 Prometheus -> Minecraft bot metrics'
```

`services/minecraft-bots/README.md`'s own status line governs which of these are actually
scraped: only `Babs_Miner`/`Amy_Builder` are running as of this writing, so
`infra/firmament-observability/prometheus/prometheus.yml`'s `minecraft_bots` job lists only those
two targets. Every other persona's port is reserved and firewalled ahead of time (the unit file
and `ufw` rule already cover it), but **not** added as a Prometheus target until its bot is
actually relaunched -- a permanently-down target would either sit as constant Grafana/alert noise
or force the `FirmamentTargetDown` alert to special-case it, neither of which is better than
adding one `static_configs` line when the persona comes back.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-06 | Initial version -- replaces the bare `nohup` processes used during initial development. |
| 1.1.0 | 2026-09-24 | Updated from the original two-bot (Babs/Amy, spark-only) install to the real nine-unit, two-host layout; added the op-grant/Buzz/Matrix onboarding pointer and the warning that `active` does not mean connected. |
| 1.2.0 | 2026-11-04 | Matrix dropped as a bot prerequisite and onboarding step: the per-bot Matrix room watcher is legacy from before Buzz; bots coordinate over Buzz only and run fully without a Matrix token. |
| 1.3.0 | 2026-11-26 | Direct request ("rename the bots to be name-<role>"): each bot's in-game `MC_BOT_USERNAME` became Name_Role; unit filenames and `MC_BOT_PERSONA` stay the original lowercase name. Updated this file's roster prose to the new display names. |
| 1.4.0 | 2026-11-28 | Direct request: new §7, the per-bot `MC_BOT_METRICS_PORT` roster (services/minecraft-bots/metrics.js) and the ranged `ufw` rule each host needs -- only the two currently-running bots are wired into Prometheus's scrape config, by design (see §7's own note). |
