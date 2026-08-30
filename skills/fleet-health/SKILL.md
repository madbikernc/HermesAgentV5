---
name: fleet-health
description: "Check this node's own health (services, compute, storage, security posture) or both Synology NAS devices' health (storage, SMART) with a real command. Use this when The Boss asks how the node/fleet/NAS is doing, not as a substitute for the daily fleet-wide report, which neither persona can trigger."
version: 1.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Health, Monitoring, NAS, Synology, Observability]
prerequisites:
  commands: [python3]
  files:
    - ~/HermesAgentV5/tools/hermes-node-health.py
    - ~/HermesAgentV5/tools/hermes-synology-health.py
---

# Fleet Health

**Version:** 1.0.0

Two real, independent checks — neither is a substitute for the other, and neither is the daily
fleet-wide report.

## Checking this node

```bash
python3 ~/HermesAgentV5/tools/hermes-node-health.py
```

Runs per identity (per `HERMES_HOME`), not per physical node — this checks your own services,
compute, storage, network, and security posture, not the other persona's. Report the real
numbers it prints, not a vague summary.

## Checking NAS storage

```bash
python3 ~/HermesAgentV5/tools/hermes-synology-health.py
```

Queries both Synology NAS devices live over the DSM API — system health, storage volumes, SMART
status. Takes no arguments; always checks both devices.

## Rules

- **Run via the terminal tool with a generous timeout** — both scripts do live network/API work,
  and the default timeout can cut them off before they finish.
- Report exactly what the tool prints — the specific numbers, not a paraphrase.
- **Neither script reaches the other identity's health, HomeD13, the broker, or the honeypot** —
  those are rolled into the separate fleet-wide report below.

## What you cannot do

**Neither Sintra nor Amy can trigger the daily fleet-wide report themselves.**
`hermes-fleet-health.py` aggregates both identities' node reports plus HomeD13, inter-node comms,
and broker queue depth into one view, and emails it automatically once a day — but it runs as
`pmoney` with `sudo -u <identity>` access to both identities' home directories, a scope neither
persona holds. If asked to run or trigger that report, say so plainly rather than attempting it or
describing having run it.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-14 | Initial version — extracted from duplicated content in both `DesignFiles/*/SOUL.md` files, which had grown a live-prompt copy of these commands instead of a shared skill pointer. |
