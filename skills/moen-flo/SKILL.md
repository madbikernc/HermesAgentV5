---
name: moen-flo
description: "Check real status, valve state, flow/pressure, battery, water consumption, and alarms for a Moen Flo smart water shutoff / leak detector. Read-only monitoring — cannot open/close the valve or run a health test."
version: 1.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [moen-flo, water, leak-detection, smart-home]
prerequisites:
  commands: [python3]
  venv: /opt/hermes/venvs/moen-flo/
---

# Moen Flo Water Shutoff / Leak Detector Monitor

**Version:** 1.0.0

Real status for a Moen Flo smart water shutoff valve and/or leak-detector puck via the Flo Cloud
API — there's no local/LAN API, this always goes over the internet. Ported from v1
(`../HermesAgent/skills/moen-flo/`). Auto-discovers every location and device on the account.

## How to use it

Use the **shared venv's** `python3`, not the system one — `aioflo` isn't an apt package:

```bash
/opt/hermes/venvs/moen-flo/bin/python3 ~/HermesAgentV5/tools/hermes-moen-flo.py            # quick status
/opt/hermes/venvs/moen-flo/bin/python3 ~/HermesAgentV5/tools/hermes-moen-flo.py --detail    # + today's consumption
/opt/hermes/venvs/moen-flo/bin/python3 ~/HermesAgentV5/tools/hermes-moen-flo.py --alerts    # active alarms
/opt/hermes/venvs/moen-flo/bin/python3 ~/HermesAgentV5/tools/hermes-moen-flo.py --json      # raw JSON
```

Credentials come from Vaultwarden (item `Hermes Moen Flo`) via `tools/vault-get-secret.sh` —
never ask The Boss to paste a password, and never write one to a local file.

## Rules

- **Read-only.** This tool cannot open/close the shutoff valve or run a health test — that
  capability was deliberately left unported. Closing the valve cuts water to the whole house, and
  it's a real physical action that needs its own code-level confirmation gate under
  `IMPLEMENTATION_PLAN.md` §5 constraint 5, which doesn't exist yet. If asked to shut off water or
  run a health test, say plainly that this tool can't do it — don't improvise a way to hit the API
  directly.
- **This account is on the legacy "Flo by Moen" app.** If this tool starts failing auth with no
  code changes, the account may have been migrated to the newer "Moen Smart Water Network" app —
  check that before assuming it's a credentials problem. There's no automatic fallback; a migrated
  account needs a different integration entirely (see `../HermesAgent/skills/moen-flo/references/api-notes.md`
  for what that would involve).
- If login or the API call fails, report the real error from the tool's own output. Don't describe
  a status as if the tool had returned one.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-07 | Initial version. Phase 20 (`IMPLEMENTATION_PLAN.md` §7) ported from v1's `skills/moen-flo/`, scoped to status/monitoring only per an explicit scoping decision this session — see the Phase 20 roadmap row for the full reasoning. |
