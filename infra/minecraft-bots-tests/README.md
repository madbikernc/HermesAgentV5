# minecraft-bots-tests — install checklist

**Version:** 2.0.0

Daily run of the Minecraft bot test system (`services/minecraft-bots/tests/`, see its README).
Reports land in `/mnt/hermes-data/minecraft-memory/test-reports/`, and a failing/timed-out phase
leaves its own unit `failed` in `systemctl --failed`.

- **spark:** runs everything, as a chain of four units, each triggering the next via
  `OnSuccess=`/`OnFailure=` (so a failure or timeout in one phase still lets the next phase run —
  only the phase that actually hit trouble shows up `failed`):
  `minecraft-bots-tests-fast` (unit+triage+ragserver) ->
  `minecraft-bots-tests-live` (`MBTester` scenarios) ->
  `minecraft-bots-tests-livebot` (full-bot `MBProbe` scenarios) ->
  `minecraft-bots-tests-baseline` (spark's own baseline + monitoring coverage).
  Only `-fast.timer` is installed/enabled on spark — it's the chain's entry point.
- **spark2:** runs `minecraft-bots-tests-baseline.service` only, via its own standalone
  `-baseline.timer` — one live tester per day (on spark) is enough. No `sed`/override needed:
  spark2 just never installs the `-fast`/`-live`/`-livebot` units or `-fast.timer`.

Each phase's `TimeoutStartSec` is sized to what that phase actually takes, not one shared number
for the whole run — see each `.service` file's own comment for the measurement it's based on.

```bash
# spark: full chain, entry point is -fast.timer
sudo cp infra/minecraft-bots-tests/minecraft-bots-tests-{fast,live,livebot,baseline}.service \
  infra/minecraft-bots-tests/minecraft-bots-tests-fast.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-bots-tests-fast.timer

# spark2: baseline only, entry point is -baseline.timer
sudo cp infra/minecraft-bots-tests/minecraft-bots-tests-baseline.service \
  infra/minecraft-bots-tests/minecraft-bots-tests-baseline.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-bots-tests-baseline.timer
```

Run the whole spark chain once by hand with
`sudo systemctl start minecraft-bots-tests-fast.service`, then read each phase's result with
`journalctl -u minecraft-bots-tests-{fast,live,livebot,baseline}.service -n 50`. To run just one
phase ad hoc without triggering the next, use `systemctl start` on that phase's unit directly, or
just call `tests/run.sh <suite>` by hand (see `services/minecraft-bots/tests/README.md`).

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-24 | Initial daily test timer. |
| 1.1.0 | 2026-10-07 | `TimeoutStartSec` 15min -> 30min — spark's `all` suite now runs live's 23 scenarios plus 7 livebot scenarios plus baseline, and was being SIGTERM'd mid-run (found via a Critical fleet-health rollup: unit+rag+live+2/7 livebot scenarios all passed before the kill at 15:00 exactly). |
| 1.2.0 | 2026-10-28 | `TimeoutStartSec` 30min -> 60min — same shape as 1.1.0's bump, found the same way: a Critical fleet-health rollup showed the run still in the live phase, hadn't even reached baseline, when systemd killed it at 30min. A conservative doubling, not a measured figure at the time. |
| 2.0.0 | 2026-11-07 | S47 fleet-health investigation: the single shared 60min budget had already been outgrown too (live measured 40-45min and growing, livebot 15-20min and growing, together leaving no slack for baseline). Replaced the single `minecraft-bots-tests.service`/`.timer` with a four-unit chain (`-fast`/`-live`/`-livebot`/`-baseline`), each with its own measured timeout and `OnSuccess=`/`OnFailure=` both chaining to the next, so baseline always runs regardless of an earlier phase's outcome and a timeout is attributed to the actual phase. Also found spark2's `MB_TEST_SUITE=baseline` override -- a manual `sed` patch on the deployed file, never in git -- had been silently clobbered back to `all` by an earlier deploy that `cp`'d the raw template over spark2's live unit, so spark2 had been redundantly running the full live+livebot suite too. The new `-baseline.timer` gives spark2 its own standalone entry point, removing the sed-hack (and the class of bug it enabled) entirely. |
