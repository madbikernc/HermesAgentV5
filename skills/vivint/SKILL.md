---
name: vivint
description: "Check real status and control a Vivint home security system — arm state, sensors, locks, garage door, lights/switches, thermostat, camera metadata. Locks and the garage door require an explicit reply from The Boss before anything happens."
version: 1.0.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [vivint, security, locks, garage, smart-home]
prerequisites:
  commands: [python3, curl, jq]
---

# Vivint Home Security

**Version:** 1.0.0

Status and control for the Vivint home security system, via Vivint's cloud API. Ported from v1
(`../HermesAgent/scripts/vivint-*.py`).

## How to use it

```bash
tools/hermes-vivint.py status                        # full system report: arm state, sensors, locks, garage, thermostat, cameras
tools/hermes-vivint.py list                           # controllable devices only
tools/hermes-vivint.py on "<name>" [brightness]       # light/switch on — direct, no confirmation
tools/hermes-vivint.py off "<name>"                   # light/switch off — direct, no confirmation
tools/hermes-vivint.py dim "<name>" <0-100>           # brightness — direct, no confirmation
tools/hermes-vivint.py therm status|cool <F>|heat <F>|mode <off|heat|cool|heat-cool>|setpoints
tools/hermes-vivint.py lock "<name>"|all              # GATED — see below
tools/hermes-vivint.py unlock "<name>"|all            # GATED — see below
tools/hermes-vivint.py garage status|open|close|toggle ["<name>"]   # open/close/toggle GATED
```

Credentials and the live session come from Vaultwarden (item `Hermes Vivint`) — never ask The Boss
to paste a password.

## The confirmation gate — lock, unlock, and garage open/close/toggle only

These are real physical-security actions (who can get into the house), so unlike every other
command here, **they don't execute immediately.** Calling one posts a request to your own home
room and blocks for up to 5 minutes, waiting for The Boss to reply there with the exact code shown
(`confirm <code>`). Only a genuine matching reply from The Boss's real account authorizes the
action — nothing you do yourself can satisfy this. If the reply doesn't come in time, the command
reports that plainly and exits without touching the device.

This is real, not decorative: **do not try to work around it, guess the code, or find another way
to hit the Vivint API directly if a gated command times out or is denied.** That defeats the entire
reason this project rebuilt this integration — v1's version issued lock and garage commands with no
confirmation step of any kind, and that's the incident this design exists to not repeat
(`LESSONS_LEARNED.md` §1).

`garage status` and everything under `light`/`switch`/`therm` are **not** gated — treat those like
any other direct device control.

## One-time setup (needs The Boss present)

Vivint requires interactive MFA on a new session. Run this once, live, with The Boss there to relay
the code Vivint texts/emails — two calls, since a terminal-tool invocation can't hold a live prompt
open across a human relaying a code from their phone:

```bash
tools/hermes-vivint.py --setup                    # triggers the MFA challenge
tools/hermes-vivint.py --setup --mfa-code <code>   # completes it once The Boss has the code
```

This writes the resulting session straight to the `Hermes Vivint` Vaultwarden item — never to a
local file. If a gated or direct command ever fails because Vivint is asking for a fresh MFA
challenge again, that's a real signal this needs to be re-run with The Boss, not something to solve
alone.

## Rules

- **No arm/disarm control** — this tool doesn't have it (v1 never built it either). Say so plainly
  if asked.
- **No live camera feed or snapshot** — only camera metadata (online/offline, signal). Same
  ceiling Wyze hit — don't improvise a way around it.
- If a call fails, report the real error from the tool's own output. Don't describe a status or an
  action as if it had actually happened.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-08 | Initial version. Phase 22 (`IMPLEMENTATION_PLAN.md` §7, the last item on the 11-22 roadmap) ported from v1, adding the confirmation gate v1 never had for locks/garage via the new `tools/hermes-confirm-gate.sh`. See the Phase 22 roadmap row for the full reasoning. |
