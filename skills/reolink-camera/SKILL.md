---
name: reolink-camera
description: "Reolink camera AI-detection alerts, delivered by email -- the on-demand 'check the camera' chat path is currently unavailable (this camera has no local API without a Reolink Home Hub/NVR, which isn't owned yet)."
version: 2.0.0
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [reolink, camera, smart-home]
prerequisites:
  commands: [python3]
---

# Reolink Camera Monitor

**Version:** 2.0.0

**The on-demand "check the camera" chat path does not work today.** The real camera (online
2026-09-03 at `10.129.1.19`) turned out to be a standalone battery/solar model with no Reolink Home
Hub or NVR — and Reolink's own support documentation confirms standalone battery cameras have no
local web/CGI API at all, by hardware design. `tools/hermes-reolink.py`'s original design (this
whole skill was originally written against) needs a Home Hub/NVR to reach the camera at all; none is
owned, and that purchase has been deliberately deferred. See `infra/hermes-reolink/README.md` for
the full finding.

**What actually works today:** AI-detection alerts (person/vehicle/pet), delivered by email, via
`tools/hermes-reolink-mail-watch.py` — an interim path that watches for the camera's own native
alert emails (no local API needed) instead of polling the camera directly. Set up per
`infra/hermes-reolink/README.md`'s interim-path section (a dedicated mailbox + a Vaultwarden item,
and enabling email alerts in the camera's own app settings).

## How to use it

Nothing to ask for in chat right now — there is no working on-demand path. Alerts arrive by email
on their own when the camera detects something, same as before.

Once a Home Hub/NVR is purchased and `hermes-reolink.py`'s original design is unblocked, this
section will cover asking naturally in the Matrix room ("check the camera") again — that code is
unchanged and ready, just not reachable yet.

## What this can't do

- **No on-demand snapshot or chat query at all, right now.** Needs a Home Hub/NVR the fleet doesn't
  own yet — see above.
- **No video, no continuous feed**, even once unblocked — every on-demand request was designed to
  pull one still frame fresh from the camera's local snapshot command, never a "watch the stream"
  mode.
- **No PTZ, no two-way audio, no actuation of any kind**, even on hardware that supports it — not
  built, not requested. Read-only, same posture as `skills/wyze/SKILL.md`.
- **Person/vehicle/pet alerts arrive by email, not chat.** Same scoping decision already made for
  `skills/nest-camera/SKILL.md`: the fleet has no existing mechanism to push an unprompted message
  into a Matrix room.
- **Single camera only, for now.** No device-name resolution ("front door" vs. "driveway") the way
  `skills/nest-camera/SKILL.md` needed — add that only once a second physical camera actually
  exists; premature to build against one test unit.
- Alert delivery depends on the camera's own native email-on-detection timing, not instant — a real,
  small delay between an event and the alert is expected, not a bug.

## Rules

- **Read-only.** Nothing here can control, reposition, or otherwise act on the camera — only look.
- If a capture or description fails, report the real error from the tool's own output. Don't
  describe a camera view as if a description had actually come back.

## Revision History

| Version | Date | Change |
|---|---|---|
| 2.0.0 | 2026-09-03 | Real camera arrived — turned out to be a standalone battery/solar model with no local API and no owned Home Hub/NVR, blocking the entire on-demand chat path this skill was written around. Rewrote to describe the interim email-alert-only reality (`hermes-reolink-mail-watch.py`) instead of the original, now-unreachable design. |
| 1.0.0 | 2026-09-02 | Initial version. Built after real hardware/API research (ruling out UniFi Protect for lacking a solar option, and Wyze/Nest for real API gaps already found this session) picked Reolink for this skill, and speccing the build around `reolink_aio` before any test hardware existed. |
