# hermes-minecraft-bots-control

**Version:** 1.0.0

The privileged half of the Minecraft bots page's Stop/Start/Restart buttons
(`hermes-fleetops-ui.py` 2.26.0's `/minecraft/control` route). Every 15 seconds it reads
`~/.hermes/state/minecraft-bots/control-requests.json`, runs the real `systemctl` action for any
request still `pending`, and writes the result back to the same file.

**Why a separate process, not a change to `hermes-fleetops-ui.py` itself:** that service's own
sandbox (`ProtectSystem=strict`, `NoNewPrivileges=true`, no subprocess or SSH anywhere in that
file, enforced by its own `check_write_surface()`/`check_unit_sandbox()`) is a deliberate, already
-documented house rule — see that file's "SCOPE" comment and
`infra/hermes-fleetops-ui/README.md`'s "Scope" section. The UI route only ever validates and
appends a pending record; it never gained the ability to run a command, and does not need to —
this script does that instead, as its own unsandboxed, separately-reasoned-about process, the same
split `hermes-minecraft-bots-status.py` already uses for reading what the UI's sandbox can't reach.

| | |
|---|---|
| Script | `tools/hermes-minecraft-bots-control.py` |
| Units | `hermes-minecraft-bots-control.service` (oneshot) + `.timer` (every 15s), spark only |
| Reads/writes | `~/.hermes/state/minecraft-bots/control-requests.json` (`MC_CONTROL_PATH`), replaced atomically |
| Remote hosts | `MC_CONTROL_REMOTES` (default `spark2`, pmoney's own SSH alias) |

## What a request looks like

`hermes-fleetops-ui.py` appends one JSON object per click:

```json
{"id": "...", "bot": "dale", "action": "restart", "requested_at": 1732471234.5,
 "requested_by": "Paul <p@x>", "status": "pending", "result": null, "detail": null,
 "completed_at": null}
```

This script finds every `status: "pending"` record, re-validates `bot`/`action` against **its
own**, freshly-discovered roster (`systemctl list-unit-files minecraft-bot-*.service`, locally and
over SSH to each `MC_CONTROL_REMOTES` host, exactly as `hermes-minecraft-bots-status.py` already
discovers the roster) — never trusting the less-privileged UI process's own write — runs `sudo
systemctl <action> minecraft-bot-<name>.service` on whichever host actually has that unit, and
sets `status: "done"`, `result: "ok"`/`"error"`, `detail` (stderr/exception, truncated) and
`completed_at`. A request for a bot that no host currently has a unit for fails the same way, named
plainly rather than silently retried forever.

The oldest 50 (`hermes-fleetops-ui.py`'s own `MC_CONTROL_MAX_KEPT`) records are kept; the UI itself
trims the file on write, so this script never needs to.

## Install (spark)

```bash
sudo cp infra/hermes-minecraft-bots-control/hermes-minecraft-bots-control.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hermes-minecraft-bots-control.timer
```

Needs the same passwordless `sudo systemctl <verb> minecraft-bot-*` access `pmoney` already has on
both spark and spark2 (confirmed live — the fleet's own deploy steps already run `sudo systemctl
restart 'minecraft-bot-*'` over SSH with no password prompt) and the existing `spark2` SSH alias.
Nothing new to provision.

## Tests

```bash
python3 infra/hermes-minecraft-bots-control/tests/test_control.py
```

Offline checks: `systemctl` and `ssh` are stubbed, nothing here touches a real bot or host.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-11-24 | Initial version, direct operator request ("Build the real thing") to add Stop/Start/Restart buttons to fleetops-ui's `/minecraft` tab — the privileged executor half, since that service's own sandbox cannot run a command itself. |
