# hermes-minecraft-bots-history

**Version:** 1.0.0

The privileged half of the Minecraft bots page's "Show last 500" button
(`hermes-fleetops-ui.py` 2.27.0's `/minecraft/history` route). Every 15 seconds it reads
`~/.hermes/state/minecraft-bots/history-requests.json`, runs the real `journalctl` query for any
record still `pending`, and writes the fetched actions back to the same file.

**Why a separate process, not a change to `hermes-fleetops-ui.py` itself:** that service's own
sandbox (`ProtectSystem=strict`, `NoNewPrivileges=true`, no subprocess or SSH anywhere in that
file, enforced by its own `check_write_surface()`/`check_unit_sandbox()`) is a deliberate, already
-documented house rule — see that file's "SCOPE" comment and
`infra/hermes-fleetops-ui/README.md`'s "Scope" section. The UI route only ever validates a bot
name and writes a pending record; it never gained the ability to run a command, and does not need
to — this script does that instead, as its own unsandboxed, separately-reasoned-about process, the
same split `hermes-minecraft-bots-control.py` (Stop/Start/Restart) and
`hermes-minecraft-bots-status.py` (the one-minute snapshot) already use.

| | |
|---|---|
| Script | `tools/hermes-minecraft-bots-history.py` |
| Units | `hermes-minecraft-bots-history.service` (oneshot) + `.timer` (every 15s), spark only |
| Reads/writes | `~/.hermes/state/minecraft-bots/history-requests.json` (`MC_HISTORY_PATH`), replaced atomically |
| Remote hosts | `MC_HISTORY_REMOTES` (default `spark2`, pmoney's own SSH alias) |

## What a request looks like

`hermes-fleetops-ui.py` writes one record per bot (overwriting any earlier one for the same bot —
see below for why this differs from `hermes-minecraft-bots-control.py`'s own request file):

```json
{"dale": {"status": "pending", "requested_at": 1732471234.5, "requested_by": "Paul <p@x>",
          "actions": null, "detail": null, "completed_at": null}}
```

This script finds every record still `status: "pending"`, re-validates the bot name against
**its own**, freshly-discovered roster (`systemctl list-unit-files minecraft-bot-*.service`,
locally and over SSH to each `MC_HISTORY_REMOTES` host — never trusting the less-privileged UI
process's own write, the same discipline `hermes-minecraft-bots-control.py` already follows),
runs `journalctl` for up to 500 `OUTCOME` lines on whichever host actually has that unit (locally,
or wrapped in `ssh` for a remote one), and sets `status: "done"`, `result: "ok"`/`"error"`,
`actions` (the parsed list, newest first, same shape `hermes-minecraft-bots-status.py`'s own
`actions` field already uses) or `detail` (stderr/exception, truncated) and `completed_at`.

**No `--since` window**, unlike the one-minute snapshot's own 7-day cap (chosen there to stay
cheap on every single run): a request a human clicked and is waiting on asks for the last 500
actions, not the last 500 within some arbitrary recent window.

**Keyed by bot name, not an append-only list.** `hermes-minecraft-bots-control.py`'s own
`control-requests.json` is a real audit trail — who clicked stop/start/restart, and when, is
worth keeping for `MC_CONTROL_MAX_KEPT` clicks. A fetched action list has no such value once a
newer click for the same bot exists, so `hermes-fleetops-ui.py` simply replaces the old record
rather than appending beside it — the file's size is naturally bounded by the bot count, not the
click count.

## Install (spark)

```bash
sudo cp infra/hermes-minecraft-bots-history/hermes-minecraft-bots-history.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hermes-minecraft-bots-history.timer
```

Needs the same `ssh`-to-`spark2` access `pmoney` already has for
`hermes-minecraft-bots-status.py`/`hermes-minecraft-bots-control.py` — no `sudo` needed here,
since reading a unit's own journal needs no elevated privilege the way `systemctl stop/start/
restart` does. Nothing new to provision.

## Tests

```bash
python3 infra/hermes-minecraft-bots-history/tests/test_history.py
```

Offline checks: `systemctl`, `ssh` and `journalctl` are stubbed, nothing here touches a real bot
or host.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-24 | Initial version, direct operator request ("add a 'Show last 500' button per bot") to the Minecraft bots page's action-history section — the privileged executor half, since that service's own sandbox cannot run `journalctl` itself. |
