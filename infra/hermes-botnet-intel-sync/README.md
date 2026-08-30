# hermes-botnet-intel-sync — recreate checklist

**Version:** 1.0.1

Refreshes the local botnet/C2 threat-intel cache (`tools/hermes_botnet_intel.py` +
`tools/hermes-botnet-intel-sync.py`) every 6 hours from four public feeds — Spamhaus DROP/DROPv6
(hijacked netblocks), abuse.ch Feodo Tracker (active botnet C2 IPs), and TweetFeed (community
OSINT). No email — this is infra plumbing, same tier as `hermes-nfs-backup.timer`; a broken timer
shows up via `hermes-node-health.py`'s own "Failed units" check like anything else.

Phase 25 (`IMPLEMENTATION_PLAN.md` §7). v1 documented this exact design across several SKILL.md
files but the actual sync/query scripts were never committed anywhere and left no trace on the
Spark's filesystem either — rebuilt from the documented spec, not ported, since there was no code
left to port. The cache is consumed by `hermes-canary-report.py` (are known-bad IPs hitting the
honeypot) and `hermes-pfsense-report.py` (are known-bad IPs attacking the WAN, or is anything on
the LAN reaching one) — see those tools' own changelog entries for the integration details.

## Install

```bash
sudo cp hermes-botnet-intel-sync.service hermes-botnet-intel-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-botnet-intel-sync.timer
```

Runs at :20 past every 6th hour (00:20, 06:20, 12:20, 18:20), ahead of the 06:00/06:15 pfSense and
fleet-health jobs so a fresh cache is in place before either report runs.

## Manual trigger (testing)

```bash
sudo -u pmoney /usr/bin/python3 /home/pmoney/HermesAgentV5/tools/hermes-botnet-intel-sync.py --verbose
```

Ad hoc lookup, same pattern v1's `botnet_query.py` was meant to provide:

```bash
python3 -c "
import sys; sys.path.insert(0, '/home/pmoney/HermesAgentV5/tools')
from hermes_botnet_intel import lookup_ip
print(lookup_ip('SUSPECTED_IP'))
"
```

## Verify

```bash
systemctl list-timers hermes-botnet-intel-sync.timer
journalctl -u hermes-botnet-intel-sync.service --no-pager
sqlite3 ~pmoney/.hermes/data/botnet/botnet_cache.db 'SELECT source, entry_count, last_success_utc FROM sync_log'
```

## Requires

- `tools/hermes_botnet_intel.py`, `tools/hermes-botnet-intel-sync.py` on the Spark. Standard
  library only (`sqlite3`, `ipaddress`, `urllib`) — no venv, no credentials (all four sources are
  public and keyless).

## Real tuning notes from live verification (2026-08-12)

- The live Spamhaus DROP feed had one CIDR (`62.60.226.0/24`) listed twice under two different SBL
  reference IDs on separate lines — a real upstream data quirk, not a parsing bug, confirmed by
  fetching and diffing the raw feed directly. The sync deduplicates by key before inserting
  (last occurrence wins; multiple tags for the same key are joined, not dropped) — first found as
  a real `UNIQUE constraint failed` crash on the very first live sync attempt.
- abuse.ch URLhaus was deliberately not ingested — it's a feed of malicious URLs/hostnames
  (v1's own doc already labels it "Plaintext/URLs only"), not IPs, so most entries can't be
  usefully cross-referenced against an IP-keyed firewall log or honeypot connection source.
- TweetFeed entries are tagged `confidence: community` in the cache, distinct from Spamhaus/Feodo's
  `high` — it's unvetted crowd-sourced OSINT, not a curated feed, and this project has hit real
  false positives before from treating every heuristic signal as equally certain everywhere it's
  used (the CDN-backscatter finding in `hermes-pfsense-report.py`). Consuming reports should say
  which tier a match came from, not flatten them into one undifferentiated "botnet match."

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: Usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-12 | Initial version — Phase 25, rebuilt from v1's documented (but never committed) design. |
