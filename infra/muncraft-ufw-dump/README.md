# muncraft-ufw-dump — recreate checklist

**Version:** 1.0.1

Root-owned periodic dump of `ufw status verbose` on the muncraft box (`192.168.1.221`), so
`hermes-game-server-monitor.py`'s `check_firewall()` can actually review the ruleset. This is a
**remote-box script**, like `../zomboid-backup/` — it lives on `192.168.1.221`, not in this repo's
`tools/`, tracked here only as a reference copy plus its own recreate checklist.

Phase 29 follow-up (`IMPLEMENTATION_PLAN.md` §7), direct request: "can you just run the zomboid and
minecraft checks in a root-owned process, to get visibility to ufw?" `zomboid-admin` (the only
credential Hermes holds for this box) has zero UFW access — confirmed live three ways: no sudo
grant for `ufw` at all, `ufw` itself refuses non-root outright, and `/etc/ufw/user.rules` is `640
root:root`. Rather than widen that service account's own sudo grant or add a new broad `muncraft`
credential to Vaultwarden (both offered, both declined), this dumps the ruleset to a file the
existing account can already read via its `muncraft` group membership — root-owned process, no new
capability granted to `zomboid-admin`, just read visibility into config text.

## ⚠ Needs a human with real root/muncraft access — same as `../zomboid-backup/`

`ufw-status-dump.sh` and its systemd unit could not be installed by Hermes itself, for the same
reason `zomboid-backup.timer` needed a manual step: nothing available to Hermes can write to
`/etc/systemd/system/` or run `systemctl daemon-reload`/`enable` on this box.

**What's already done, verified, 2026-08-12:** the parsing/evaluation logic in `check_firewall()`
was tested end to end against two realistic mock `ufw status verbose` payloads (uploaded directly to
`/opt/zomboid/server/.ufw-status.txt` via `zomboid-admin`'s existing write access there, then
removed once confirmed) — a compliant case (SSH restricted to `10.129.1.0/24`, RCON restricted to a
Tailscale IP, all four game ports open globally as expected, including a v6 rule for the Minecraft
port) correctly reported `OK`; a violating case (RCON and SSH — via UFW's `OpenSSH` app-name form —
both open to `Anywhere`) correctly reported `CRITICAL` naming exactly those two ports, while still
correctly exempting the game ports. Until the timer below is installed, `check_firewall()` reports
`[WARN] cannot verify` (the dump file doesn't exist yet).

## Install (run as root or muncraft on 192.168.1.221)

```bash
sudo cp ufw-status-dump.sh /opt/zomboid/server/ufw-status-dump.sh
sudo chmod 755 /opt/zomboid/server/ufw-status-dump.sh
sudo cp ufw-status-dump.service ufw-status-dump.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ufw-status-dump.timer
```

Runs every 15 minutes. First run creates `/opt/zomboid/server/.ufw-status.txt` (`640 root:muncraft`)
— `hermes-game-server-monitor.py`'s next run will pick it up automatically, no restart needed there.

## Manual trigger (testing)

```bash
sudo /opt/zomboid/server/ufw-status-dump.sh
cat /opt/zomboid/server/.ufw-status.txt
```

## Verify

```bash
systemctl list-timers ufw-status-dump.timer
journalctl -u ufw-status-dump.service --no-pager
ls -la /opt/zomboid/server/.ufw-status.txt   # should show root:muncraft, mode 640
```

Then from the Spark, confirm the monitor picks it up:

```bash
sudo -u pmoney /usr/bin/python3 /home/pmoney/HermesAgentV5/tools/hermes-game-server-monitor.py --dry-run
```

## Design notes

- **15-minute cadence, 45-minute staleness threshold in `check_firewall()`** — 3x the dump interval,
  so one missed run doesn't flip the check to "stale" over ordinary timer jitter; genuinely means
  the timer is down.
- **`640 root:muncraft`, not world-readable** — `zomboid-admin` can read it via its existing
  secondary `muncraft` group membership; no other account on the box gains anything new.
- Atomic write (`ufw status verbose > file.tmp; mv file.tmp file`) — the monitor never reads a
  truncated mid-write file.
- If UFW is ever disabled entirely, the dump still succeeds (it's just `ufw status`, not a
  UFW-dependent action) and `check_firewall()` reports `CRITICAL: UFW is not active` rather than a
  parse error.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-12 | Initial version — Phase 29 follow-up. Parsing logic verified end to end against mock data; the dump mechanism itself awaits the one-time root install above. |
