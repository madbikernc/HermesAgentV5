# hermes-minecraft-bots-status

**Version:** 1.0.0

Every minute, writes one JSON snapshot of the Minecraft bots for hermes-fleetops-ui's `/minecraft`
tab. For each bot it records:
- whether its unit is running, and since when;
- its current goal (`goal.json`);
- its latest log lines;
- its last 20 actions with their result.

It runs on spark as `pmoney`. The bots run on spark and spark-2, and the UI's sandbox can't reach
either (no subprocess or SSH in that service), so this collects and the UI only reads the file.

| | |
|---|---|
| Script | `tools/hermes-minecraft-bots-status.py` |
| Units | `hermes-minecraft-bots-status.service` (oneshot) + `.timer` (every minute), spark only |
| Writes | `~/.hermes/state/minecraft-bots/status.json` (`MC_STATUS_PATH`), replaced atomically |
| Remote hosts | `MC_STATUS_REMOTES` (default `spark2`, pmoney's SSH alias), each running the same script with `--local` from its own checkout |

## Where each field comes from

| Field | Source |
|---|---|
| roster, running/stopped, since, restarts | `systemctl list-unit-files minecraft-bot-*.service`, then `systemctl show`. Discovered every run, so a new bot needs no change here |
| current goal | `/mnt/hermes-data/minecraft-memory/bots/<name>/goal.json`. `goals.js` deletes it when a goal ends, so no file means no goal. A stopped bot keeps the goal it stopped with |
| actions | the journal's `OUTCOME {...}` lines from `actions.js` `logOutcome()`, one per action. These are the same lines triage and `tests/baseline.mjs` count. Result is `ok`, `cancelled`, `refused` or `failed`, with the bot's reason on a failure |
| latest | the newest three journal lines, skipping pathfinder chatter, memory stats and `OUTCOME` lines |
| last goal event | the newest journal line mentioning a goal (started, resumed, paused, given up, a step's result) |
| role | `services/minecraft-bots/roles.js` |

The journal is read with `_SYSTEMD_UNIT=`, not `-u`, so a stopped bot shows its own last lines
rather than systemd's "Stopped …" messages about it.

If a remote host can't be reached, the snapshot records it with its error and the page names the
missing host. The host is never silently dropped.

## Install (spark)

```bash
sudo cp infra/hermes-minecraft-bots-status/hermes-minecraft-bots-status.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hermes-minecraft-bots-status.timer
```

spark-2 needs nothing installed. It only has to have the repo checked out at `~/HermesAgentV5`,
which the normal deploy pull already provides.

## Tests

```bash
python3 infra/hermes-minecraft-bots-status/tests/test_status.py
```

28 offline checks. systemctl, journalctl and ssh are stubbed with output in the real shapes.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-11 | Initial version, for fleetops-ui's new `/minecraft` tab (direct operator request). |
