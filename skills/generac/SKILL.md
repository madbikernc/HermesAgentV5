---
name: generac
description: "Check real status, battery, fuel, weather, and alerts for the Generac Guardian standby generator (Ironwood). Read-only monitoring — cannot start, stop, or test the generator."
version: 1.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [generac, generator, monitoring, playwright]
prerequisites:
  commands: [python3]
  venv: /opt/hermes/venvs/generac/
---

# Generac Generator Monitor

**Version:** 1.0.0

Real status for the Generac Guardian 22kW standby generator ("Ironwood") via the Mobile Link Cloud
API — there's no local web UI, the WiFi module only talks to Generac's cloud, so this always goes
over the internet. Ported from v1 (`../HermesAgent/skills/generac/`).

## How to use it

Use the **shared venv's** `python3`, not the system one — Chromium has no ARM64 apt package and
this is the only tool in the fleet that needs Playwright:

```bash
/opt/hermes/venvs/generac/bin/python3 ~/HermesAgentV5/tools/hermes-generac.py            # quick status
/opt/hermes/venvs/generac/bin/python3 ~/HermesAgentV5/tools/hermes-generac.py --detail    # full report
/opt/hermes/venvs/generac/bin/python3 ~/HermesAgentV5/tools/hermes-generac.py --alerts    # active alerts
/opt/hermes/venvs/generac/bin/python3 ~/HermesAgentV5/tools/hermes-generac.py --json      # raw JSON
```

**This drives a real headless Chromium browser through an OAuth login and a WAF challenge —
pass a generous terminal timeout (e.g. `timeout=90`).** It normally takes 30-60 seconds; anything
that kills it earlier will look like a login failure that isn't one.

Credentials come from Vaultwarden (item `Hermes Generac`) via `tools/vault-get-secret.sh` — never
ask The Boss to paste a password, and never write one to a local file.

## Rules

- **Read-only.** This tool cannot start, stop, or run a test cycle on the generator — that
  capability was deliberately left unported (v1 never got it reliably working, and it's a real
  physical action that needs its own code-level confirmation gate under
  `IMPLEMENTATION_PLAN.md` §5 constraint 5, which doesn't exist yet). If asked to run a test cycle
  or otherwise control the generator, say plainly that this tool can't do it — don't improvise a
  way to hit the API directly.
- If the login or the API call fails, report the real error from the tool's own output. Don't
  describe a status as if the tool had returned one.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-06 | Initial version. Phase 19 (`IMPLEMENTATION_PLAN.md` §7) ported from v1's `skills/generac/`, scoped to status/monitoring only per an explicit scoping decision this session — see the Phase 19 roadmap row for the full reasoning. |
