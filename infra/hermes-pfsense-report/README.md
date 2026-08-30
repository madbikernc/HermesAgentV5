# hermes-pfsense-report — recreate checklist

**Version:** 1.0.1

Daily digest of the fleet's own pfSense firewall log (`tools/hermes-pfsense-report.py`), emailed to
The Boss. Deterministically parses and buckets every `filterlog` entry since the last run (WAN
inbound blocked/passed, sensitive-port hits, LAN-to-external blocks flagged for high fanout,
known-benign broadcast noise counted but not itemized), then asks the fleet's own router
(`model: "super"`) for a concise brief on anything actually worth a look. Same tier as
`hermes-fleet-health.timer` and `hermes-nfsensei-watch.timer`.

Built in direct response to: "schedule a daily check of the pfsense, and draft a report of ANY
potential concerning connections or trends" (2026-08-09).

## Install

```bash
sudo cp hermes-pfsense-report.service hermes-pfsense-report.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-pfsense-report.timer
```

Runs at 06:15, right after the 06:00 `hermes-fleet-health.timer` and before the 07:30
`hermes-nfsensei-watch.timer`. Adjust `OnCalendar` if a different time is wanted — nothing else
depends on the specific hour.

## Manual trigger (testing)

```bash
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-pfsense-report.py --dry-run
sudo -u pmoney /home/pmoney/HermesAgentV5/tools/hermes-pfsense-report.py
```

`--dry-run` prints the report instead of emailing it and leaves the state file untouched — safe to
run repeatedly while testing. A real run takes roughly 20-25 seconds (dominated by the firewall-log
fetch — a full day's worth is 20k+ entries) and only advances the state marker if the email actually
sends, so a failed send gets retried over the same window next time rather than silently skipped.

## Verify

```bash
systemctl list-timers hermes-pfsense-report.timer
journalctl -u hermes-pfsense-report.service --no-pager
cat ~pmoney/.hermes/state/pfsense-report-state.json
```

## Requires

- `tools/hermes-pfsense-report.py`, `tools/hermes_pfsense_common.py`, `tools/vault-get-secret.sh` on
  the Spark. Standard library only — no venv needed.
- `hermes-router.service` running and reachable at `127.0.0.1:8080`.
- Vault items `Hermes pfSense` (custom field `api_key`) and `email-sintra` (already provisioned —
  same one `hermes-fleet-health.py` and `hermes-nfsensei-watch.py` use).

## Real tuning notes from live verification (2026-08-09)

- A naive "N distinct WAN dst_ports from one external source = scan-like" heuristic produced a real
  false positive on the first live run: real Google/YouTube CDN IPs (`172.217.x.x`, `64.233.x.x`,
  `142.251.x.x`) touching many distinct *high ephemeral* ports, which is the normal signature of
  NAT/state-timeout backscatter from this LAN's own outbound QUIC/UDP-443 traffic — not scanning. Fixed
  to only count distinct ports **below 1024** (real named services) toward the "PROBE-LIKE" signal;
  the original any-port count is still shown for context but explicitly labeled non-alarming.
- DHCP leases are pulled each run to label LAN source IPs with real hostnames (e.g.
  `10.129.1.21 (rokuultralr)`), and the LLM prompt explicitly asks it to weigh high-fanout findings
  against what the hostname implies — a streaming box or tablet reaching many destinations is
  ordinary; the same fanout from a printer/NAS/IoT device would not be. Without this, the first live
  run rated a Roku streaming device "Medium risk, possible reconnaissance."

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-09 | Initial version. Built for Phase 23's follow-up ask (daily pfSense check + concerning-trends report). Verified live: real email delivered to `notifications@canislupisnc.net`, one real false-positive heuristic found and fixed before shipping (see above). |
