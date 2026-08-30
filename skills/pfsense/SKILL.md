---
name: pfsense
description: "Check real status for the fleet's pfSense firewall/gateway — system uptime, WAN/LAN interface health, gateway status, DHCP leases, recent firewall log — plus a daily automated security digest emailed to The Boss. Read-only monitoring — cannot change rules, aliases, or services, and cannot reboot it."
version: 2.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [pfsense, network, firewall, gateway, monitoring, security-report]
prerequisites:
  commands: [python3]
---

# pfSense Firewall/Gateway Status Monitor

**Version:** 2.0.0

Real status for the fleet's own gateway/firewall (`10.129.1.1`) via pfSense's REST API v2 package
(`pfSense-pkg-RESTAPI`). Ported conceptually from v1 (`../HermesAgent/skills/pfsense-network/`),
which used root-over-SSH with password auth and a plaintext credentials file — neither carried
forward here.

## How to use it

```bash
python3 ~/HermesAgentV5/tools/hermes-pfsense.py                # system + interfaces + gateways
python3 ~/HermesAgentV5/tools/hermes-pfsense.py --leases        # + DHCP leases
python3 ~/HermesAgentV5/tools/hermes-pfsense.py --logs [N]      # + last N firewall log entries (default 20)
python3 ~/HermesAgentV5/tools/hermes-pfsense.py --json          # raw JSON dump
```

Credentials come from Vaultwarden (item `Hermes pfSense`, custom field `api_key`) via
`tools/vault-get-secret.sh` — never ask The Boss to paste a key, and never write one to a local
file. Standard library only — no venv needed, unlike Generac/Moen Flo/Wyze. Shared HTTP/auth
plumbing lives in `tools/hermes_pfsense_common.py`.

**A daily automated digest also runs on its own** (`tools/hermes-pfsense-report.py`, via
`hermes-pfsense-report.timer` at 06:15 — see `infra/hermes-pfsense-report/`): pulls every firewall
log entry since the last run, buckets it deterministically (WAN inbound blocked/passed, sensitive-
port hits, LAN hosts blocked reaching an unusually large number of external destinations, known-
benign broadcast noise counted but not itemized), and emails The Boss a plain-English brief via the
router (`model: "super"`). Trigger it by hand the same way:

```bash
python3 ~/HermesAgentV5/tools/hermes-pfsense-report.py             # real run: emails + advances state
python3 ~/HermesAgentV5/tools/hermes-pfsense-report.py --dry-run   # prints instead of emailing
```

## Rules

- **Read-only, and deliberately not gated instead of ungated.** This tool cannot create, modify,
  or apply any firewall rule, alias, or service change, and cannot reboot the box — none of that
  was ported, and unlike Phase 22's Vivint lock/garage gate, no confirmation-gated actuation path
  was built for pfSense either. This is the fleet's own network boundary: a bad change or a reboot
  here can cut off remote access to every other node, a materially worse failure mode than
  anything Phase 22 gates. If asked to change a rule, add an alias, or reboot pfSense, say plainly
  this tool can't do it — don't improvise a way to hit the API directly.
- If a call fails, report the real error from the tool's own output. Don't describe a status as if
  the tool had returned one.
- **The `WIFI` interface (`rtwn0_wlan0`) reporting `down` is expected.** The Boss confirmed
  2026-08-09 it's intentionally disabled, not a fault — `hermes_pfsense_common.py`'s
  `EXPECTED_DOWN_INTERFACES` excludes it from the "!" flag. If a *different* interface goes down,
  that's still real and should be reported.
- **The daily digest's risk framing leans on device hostnames from live DHCP leases** to judge
  whether high outbound connection-fanout is plausible (a streaming box or tablet talking to many
  destinations is normal; the same pattern from a printer/NAS/IoT device is not). An unidentified
  device with no lease hostname is itself worth mentioning if it shows up in a report.
- See `../../IMPLEMENTATION_PLAN.md` §7 Phase 23 for the full scope decision and how this fits the
  wider fleet.

## Revision History

| Version | Date | Change |
|---|---|---|
| 2.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 2.0.0 | 2026-08-21 | Ported from `HermesAgentRedo` 1.1.0 — repo path updated, and the daily digest's router call updated from `model: "weaver"` to `model: "super"` (a general-reasoning/summarization task, not a coding one — found in the same honest-delegation sweep that caught `hermes-fabrication-guard.sh`'s stale role names, not by the original migration audit). No other behavior changes. |
