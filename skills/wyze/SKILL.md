---
name: wyze
description: "Check real status for Wyze smart-home devices — plugs, bulbs, switches, cameras, locks/safe, watch, vacuum, thermostat, motion/entry sensors. Read-only monitoring — cannot turn anything on/off, change bulb settings, run the vacuum, set the thermostat, or lock/unlock."
version: 1.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [wyze, smart-home, iot]
prerequisites:
  commands: [python3]
  venv: /opt/hermes/venvs/wyze/
---

# Wyze Device Monitor

**Version:** 1.0.0

Real status for Wyze smart-home devices via the Wyze Cloud API (`wyze-sdk`). Ported from v1
(`../HermesAgent/skills/wyze/`), scoped to status/monitoring only.

## How to use it

Use the **shared venv's** `python3`, not the system one:

```bash
/opt/hermes/venvs/wyze/bin/python3 ~/HermesAgentV5/tools/hermes-wyze.py list [--type plug|bulb|switch|camera|lightstrip|lock|watch]
/opt/hermes/venvs/wyze/bin/python3 ~/HermesAgentV5/tools/hermes-wyze.py plug status --device "NAME"
/opt/hermes/venvs/wyze/bin/python3 ~/HermesAgentV5/tools/hermes-wyze.py switch status --device "NAME"
/opt/hermes/venvs/wyze/bin/python3 ~/HermesAgentV5/tools/hermes-wyze.py bulb status --device "NAME"
/opt/hermes/venvs/wyze/bin/python3 ~/HermesAgentV5/tools/hermes-wyze.py lock --device "NAME" --history [--hours N]
/opt/hermes/venvs/wyze/bin/python3 ~/HermesAgentV5/tools/hermes-wyze.py vacuum status --device "NAME"
/opt/hermes/venvs/wyze/bin/python3 ~/HermesAgentV5/tools/hermes-wyze.py sensor-motion --device "NAME"
/opt/hermes/venvs/wyze/bin/python3 ~/HermesAgentV5/tools/hermes-wyze.py sensor-entry --device "NAME"
/opt/hermes/venvs/wyze/bin/python3 ~/HermesAgentV5/tools/hermes-wyze.py thermostat status --device "NAME"
/opt/hermes/venvs/wyze/bin/python3 ~/HermesAgentV5/tools/hermes-wyze.py camera --device "NAME"
/opt/hermes/venvs/wyze/bin/python3 ~/HermesAgentV5/tools/hermes-wyze.py watch --device "NAME"
/opt/hermes/venvs/wyze/bin/python3 ~/HermesAgentV5/tools/hermes-wyze.py safe --device "NAME"
```

`--device` matches a case-insensitive substring of the device's nickname; if more than one device
matches, the first is used and every match is printed so you know it happened.

Credentials (account email/password, developer API key + key ID) come from Vaultwarden (item
`Hermes Wyze`) — never ask The Boss to paste a password. Unlike other cloud-device tools in this
fleet, this one **caches its login token in Vaultwarden itself** (a custom field on the same item)
rather than re-authenticating on every call, because Wyze rate-limits repeated logins. That's
handled automatically — the tool tries the cached token first and only does a real login if it's
missing or a call fails.

**Wyze's API host has an incomplete TLS chain.** `api.wyzecam.com` doesn't serve a root that this
host's system CA bundle trusts (confirmed live with `openssl s_client`/`curl`, independent of
Python) — the tool points `REQUESTS_CA_BUNDLE` at a supplemental bundle
(`/opt/hermes/venvs/wyze/ca-bundle.pem`) instead. See the exact rebuild commands in
`tools/hermes-wyze.py`'s module docstring if that file is ever missing (e.g. the venv gets
recreated) — this is a real external gap, not something a fresh install fixes on its own.

## Rules

- **Read-only.** This tool cannot turn any device on/off, change a bulb's brightness/color/away
  mode, run the vacuum, set the thermostat, or lock/unlock the safe — all deliberately left
  unported. Every one of those is a physical action that needs its own code-level confirmation gate
  under `IMPLEMENTATION_PLAN.md` §5 constraint 5, which doesn't exist yet. If asked to control a
  device, say plainly that this tool can't do it — don't improvise a way to hit the SDK directly.
- If login or an API call fails, report the real error from the tool's own output. Don't describe a
  status as if the tool had returned one.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-07 | Initial version. Phase 21 (`IMPLEMENTATION_PLAN.md` §7) ported from v1's `skills/wyze/`, scoped to status/monitoring only — see the Phase 21 roadmap row for the full reasoning, including the Vaultwarden-cached-token auth model (a change from how Generac/Moen Flo authenticate). |
