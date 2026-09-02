---
name: nest-camera
description: "Check a Nest/Google Home camera via chat -- pulls a live WebRTC snapshot and describes what's in frame. Read-only. Motion/person detection alerts for registered cameras are delivered by email, not chat."
version: 1.0.0
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [nest, google-home, camera, smart-home]
prerequisites:
  commands: [python3]
  venv: /opt/hermes/venvs/nest/
---

# Nest Camera Monitor

**Version:** 1.0.0

On-demand camera snapshot + description via the Google Smart Device Management (SDM) API
(`tools/hermes-nest.py`, Buzz `nest` topic), plus an independent motion/person alert path. Built
2026-09-01 in direct response to "does the fleet have sufficient capability to trigger off camera
motion or camera person, trigger camera Livestream, and strip out a frame for analysis?" — see
`infra/hermes-nest/README.md` for the full design and a real, load-bearing caveat: **this has not
been live-tested end to end**, since no Device Access sandbox existed to test against as of
writing. Run its Verification steps before trusting any of this in practice.

## How to use it

In the Matrix chat room, just ask naturally — the fleet's dispatcher routes it automatically:

> "check the front door camera"
> "what does the driveway camera see right now"

You'll get back a real, current description of what's in frame, or an honest failure (camera not
found, capture failed, vision model unreachable) — never an invented status.

## What this can't do

- **No video, no continuous feed.** Every request is one still frame pulled from a fresh WebRTC
  negotiation — there is no "watch the stream" mode, and there never will be one that streams into
  chat (Matrix has no image/video support in this fleet yet — see `hermes-media.py`'s own scope
  note).
- **No two-way audio, no pan/tilt/zoom, no actuation of any kind.** The SDM API doesn't expose
  these traits for Nest cameras at all (confirmed against the current public API reference) — this
  isn't a deliberately-unported capability the way Wyze's actuation commands are (see
  `skills/wyze/SKILL.md`), it genuinely doesn't exist on Google's side.
- **No still-image/snapshot API exists on Google's side either** — every "snapshot" here is
  actually: negotiate a live WebRTC stream, grab one decoded frame, tear the stream back down. If
  that negotiation fails (camera offline, stream already in use, rate-limited), the request fails
  honestly rather than returning a stale or fabricated description.
- **Motion/person alerts arrive by email, not this chat.** The fleet has no existing mechanism to
  push an unprompted message into a Matrix room — that was an explicit scoping decision for this
  build, not an oversight. If you want a proactive Matrix alert on motion, that's a real follow-up
  capability, not something this skill currently does.
- One camera capture in flight at a time (`MAX_CONCURRENT_CAPTURES`, default 1) — a second request
  while one is running gets an honest "already in progress" message.

## Rules

- **Read-only.** Nothing here can control, reposition, or otherwise act on a camera — only look.
- If a capture or description fails, report the real error from the tool's own output. Don't
  describe a camera view as if a description had actually come back.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-01 | Initial version. Built after confirming live that no Nest/Google Home capability existed anywhere in this fleet, researching the Device Access/SDM API's real (and missing) capabilities, and confirming with the operator that motion/person alerts should ship over email rather than building a new proactive-Matrix-push mechanism. |
