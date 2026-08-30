---
name: botnet-intel
description: "Check whether an IP address is known botnet/C2 infrastructure using the fleet's local threat-intel cache (Spamhaus DROP/DROPv6, abuse.ch Feodo Tracker, TweetFeed). Also runs automatically: cross-referenced into the canary honeypot report and the daily pfSense digest."
version: 1.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [security, botnet, threat-intel, canary, pfsense, spamhaus, feodo]
prerequisites:
  commands: [python3]
---

# Botnet/C2 Threat-Intel Lookup

**Version:** 1.0.0

A local, offline-queryable cache of known botnet/C2 and hijacked-netblock IPs, refreshed every 6h
from four public feeds — Spamhaus DROP (hijacked netblocks), Spamhaus DROPv6, abuse.ch Feodo
Tracker (currently-active botnet C2 IPs), and TweetFeed (community-sourced OSINT). Rebuilt from
v1's documented design (`../../HermesAgent/skills/pfsense-network/references/
public_cc_spam_sources.md` and others) — the actual v1 scripts were never committed anywhere and
left no trace on disk, so this is a fresh build from the spec, not a port.

## How to use it

```bash
python3 -c "
import sys; sys.path.insert(0, '/home/pmoney/HermesAgentV5/tools')
from hermes_botnet_intel import lookup_ip
print(lookup_ip('SUSPECTED_IP'))
"
```

Returns a list of matches (empty = clean): each match names which feed matched, its tag (e.g. an
SBL reference ID, or "active C2"), and a confidence tier — `high` for Spamhaus/Feodo (curated,
purpose-built, low false-positive), `community` for TweetFeed (crowd-sourced OSINT, unvetted).
**Treat a `community`-only match as worth a second look, not an automatic verdict** — weigh a
`high` match far more heavily, and say which tier a finding came from rather than presenting all
matches as equally certain.

**This also runs automatically, cross-referenced into two existing reports:**
- `hermes-canary-report.py` — every distinct honeypot connection source IP is checked; a match is
  called out explicitly, separate from the generic scanning-activity summary.
- `hermes-pfsense-report.py` — two directions, both real questions this integration exists to
  answer: **(a) are known-bad IPs attacking us** (WAN-inbound blocked/sensitive-port source IPs
  checked against the cache) and **(b) is anything inside the LAN reaching OUT to known-bad
  infrastructure** (WAN-inbound *passed* traffic — return traffic for a LAN-initiated session — and
  LAN-to-external *blocked* attempts, both checked; a `passed` match means a LAN device
  successfully exchanged traffic with a listed C2, the more serious of the two).

Before running raw port scans or `hermes-node-probe`/`hermes-security-scan` against a suspicious
source IP found some other way, check it against this cache first — same escalation order v1's
docs specified.

## Rules

- **A cache that hasn't synced recently should not produce a false "clean" verdict.** Check
  `cache_age_hours()` before trusting an empty lookup result if the sync timer might be down —
  don't report "no botnet match" as if it were verified when the underlying data could be stale
  or entirely absent (first run, or the timer failing). See `../../infra/hermes-botnet-intel-sync/`
  for how to verify the timer is actually running.
- **URLhaus is deliberately not in this cache** — it's a feed of malicious URLs/hostnames, not
  IPs (v1's own doc already labels it "Plaintext/URLs only"), so it can't be usefully
  cross-referenced against an IP-keyed firewall log or connection source. Don't assume it's
  covered.
- If asked to add a new feed, keep the confidence-tier distinction — don't blend a new
  crowd-sourced/unvetted source into `high` alongside Spamhaus/Feodo.
- See `../../IMPLEMENTATION_PLAN.md` §7 Phase 25 for the full build/porting account, including a
  real upstream data-quality bug (a duplicate CIDR in the live Spamhaus DROP feed) found and fixed
  on the very first live sync.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-12 | Initial version. Phase 25 (`IMPLEMENTATION_PLAN.md` §7) built — rebuilt from v1's documented-but-never-committed design, integrated into both the canary and pfSense reports. |
