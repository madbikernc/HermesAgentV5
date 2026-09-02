---
name: reolink-camera
description: "Check a Reolink camera via chat -- pulls a live snapshot and describes what's in frame. Read-only. Person/vehicle/pet detection alerts are delivered by email, not chat."
version: 1.0.0
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [reolink, camera, smart-home]
prerequisites:
  commands: [python3]
  venv: /opt/hermes/venvs/reolink/
---

# Reolink Camera Monitor

**Version:** 1.0.0

On-demand camera snapshot + description via Reolink's local CGI API (`tools/hermes-reolink.py`,
Buzz `reolink` topic), plus an independent AI-detection alert path. Built 2026-09-02 as the direct
follow-on to researching outdoor/battery/solar camera options for this skill — see
`infra/hermes-reolink/README.md` for the full picture, including a real, load-bearing caveat:
**this has not been live-tested end to end.** No test unit existed when it was built. Run the
README's Verification steps before trusting any of this in practice.

## How to use it

In the Matrix chat room, just ask naturally:

> "check the camera"
> "what does the driveway camera see right now"

You'll get back a real, current description of what's in frame, or an honest failure (camera
unreachable, capture failed, vision model unreachable) — never an invented status.

## What this can't do

- **No video, no continuous feed.** Every request is one still frame pulled fresh from the
  camera's local snapshot command — there is no "watch the stream" mode.
- **No PTZ, no two-way audio, no actuation of any kind**, even on hardware that supports it — not
  built, not requested. Read-only, same posture as `skills/wyze/SKILL.md`.
- **Person/vehicle/pet alerts arrive by email, not this chat.** Same scoping decision already made
  for `skills/nest-camera/SKILL.md`: the fleet has no existing mechanism to push an unprompted
  message into a Matrix room.
- **Single camera only, for now.** No device-name resolution ("front door" vs. "driveway") the way
  `skills/nest-camera/SKILL.md` needed — add that only once a second physical camera actually
  exists; premature to build against one test unit.
- Detection is polled every few seconds (Reolink's own webhook/HTTPS push is documented as
  unreliable for AI events), not instant — a real, small delay between an event and the alert is
  expected, not a bug.

## Rules

- **Read-only.** Nothing here can control, reposition, or otherwise act on the camera — only look.
- If a capture or description fails, report the real error from the tool's own output. Don't
  describe a camera view as if a description had actually come back.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-02 | Initial version. Built after real hardware/API research (ruling out UniFi Protect for lacking a solar option, and Wyze/Nest for real API gaps already found this session) picked Reolink for this skill, and speccing the build around `reolink_aio` before any test hardware existed. |
