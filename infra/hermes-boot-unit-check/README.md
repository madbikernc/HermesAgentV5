# hermes-boot-unit-check — recreate checklist

**Version:** 1.0.0

The generic check IMPLEMENTATION_PLAN.md S32 item (a) calls for: every enabled, non-oneshot
systemd unit (`.service` and `.timer`) should be `active`, and this flags any that aren't.
Deployed per-node (`spark`, `spark-2`, `HomeD13`) — `tools/hermes-boot-unit-check.py`.

**Why it exists.** On 2026-10-11 a failed LUKS mount took seven core services down via
`Dependency failed`; `Restart=always` never retries a start job that failed on a dependency, so
the mount came back and the services didn't. Four self-healed 41 hours later via
`hermes-unlock.sh`'s own restart list; three ("the stragglers") were still down at 51 hours
because that list was missing them. This tool doesn't care *why* a unit isn't active — mount
race, a typo'd restart list, anything else — it just notices and says so.

**Why a timer, not a true one-shot boot check.** The fleet's LUKS container is unlocked by hand
after every reboot (see `infra/spark2-disk-encryption/README.md`), at whatever time someone gets
to it — a check that only ran once at boot would false-alarm on every single reboot before that
happens. `OnBootSec=5min OnUnitActiveSec=15min` covers the boot-time intent and keeps checking
afterward, so it also catches a unit that dies later for an unrelated reason.

**Alerting is deduplicated across ticks**, not once per process: each run diffs the current
failing-unit set against `~/.hermes/state/boot-unit-check/state.json` and alerts (email +
Matrix, via `tools/hermes_alert_common.py`) only on a unit newly failing or newly recovered. A
unit that's been down for three ticks in a row produces exactly one alert, not three.

## Install

```bash
sudo cp hermes-boot-unit-check.service hermes-boot-unit-check.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-boot-unit-check.timer
```

Deploy on all three nodes — this is generic, not role-specific.

## Manual trigger (testing)

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-boot-unit-check.py
```

Exits 0 if every enabled non-oneshot unit is active, 1 otherwise. Safe to run repeatedly — it's
read-only against systemd (`list-unit-files`/`show`), the only write is its own state file.

## Verify

```bash
systemctl list-timers hermes-boot-unit-check.timer
journalctl -u hermes-boot-unit-check.service --no-pager
cat ~pmoney/.hermes/state/boot-unit-check/state.json
```

**S32's own exit gate**, item 3: `sudo systemctl stop hermes-buzz`, then run the tool by hand (or
wait for the next tick) and confirm one alert naming `hermes-buzz.service`; run it again and
confirm no second alert; `sudo systemctl start hermes-buzz`, run once more, confirm one recovery
notice.

## Requires

- `tools/hermes-boot-unit-check.py`, `tools/hermes_alert_common.py` on the node. Standard library
  only — no venv needed.
- `EMAIL_PASSWORD` / `FLEETOPS_MATRIX_TOKEN` / `FLEETOPS_ROOM` in the environment for alerts to
  actually send — same vars `hermes-router.py` already reads via the same module. Without them
  the tool still runs and still exits non-zero on a real problem; it just can't send the email/
  Matrix side of the alert (a one-time warning per process, same convention
  `hermes_alert_common.py` already follows).

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-16 | Initial version — S32 item (a). Offline-tested (`tests/test_offline.py`, 21 checks: oneshot/template exclusion, real-failure detection, and the full alert-dedup lifecycle across four simulated runs) against mocked `systemctl` output; not yet deployed to any live node. |
