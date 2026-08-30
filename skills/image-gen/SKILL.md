---
name: image-gen
description: "Request a render from the fleet's job broker and get back a real artifact path and checksum. Use this for an actual delegated rendering request in this fleet, not general ComfyUI workflow work."
version: 2.3.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [ComfyUI, SDXL, image-generation, Matrix, job-broker]
prerequisites:
  commands: [curl, jq]
---

# Fleet Image Generation

**Version:** 2.3.0

**Renamed from `amy-image-gen` (HermesAgentV5 S14).** Amy is retired (S8) — this skill has
described a persona-agnostic, broker-mediated path since the 2.0.0 reversal below, only the name
and title still said otherwise. No procedural change from 2.2.0.

**History, kept for context:** this skill used to point directly at what was then called
`tools/amy-generate-image.sh` (now `tools/hermes-generate-image.sh`), which talks to
`127.0.0.1:8188` and `127.0.0.1:8081` and stops/starts a local LLM — all of which only exist on
HomeD13. Once Amy's gateway moved to the Spark (migration Stage 2), that script could no longer
work when invoked from here: wrong host (no local ComfyUI, no local LLM to swap) *and* wrong sudo
scope. This is exactly what happened — see `LESSONS_LEARNED.md` §7.

**Use `tools/hermes-render-request.sh` instead.** It submits to the fleet's job broker over
HTTP and waits for a real result — no VRAM swap, no local ComfyUI, no HomeD13-specific
anything, so it works from wherever this is invoked from. The broker forwards the job to
HomeD13's `hermes-render-worker`, which calls `hermes-generate-image.sh` there — that part of the
pipeline didn't move, only where *you* submit from. As of migration Stage 3 that script was
also rewritten (2.0.0): no VRAM swap (ComfyUI is HomeD13's only GPU consumer now that its LLM
is gone) and no Matrix delivery of its own (the broker delivers into `FleetOps` as itself). Both
changes are internal to the worker pipeline and don't change anything about how you call
`hermes-render-request.sh`.

## How to use it

```bash
~/HermesAgentV5/tools/hermes-render-request.sh "<prompt>" ["<negative prompt>"] ["<room-id>"]
```

or the flag form:

```bash
~/HermesAgentV5/tools/hermes-render-request.sh --prompt "<text>" [--style "<text>"] \
  [--negative "<text>"] [--resolution WxH] [--room <id>] [--engine sdxl|flux2]
```

`--engine` defaults to `sdxl` (unchanged, long-proven). `--engine flux2` is real and verified
end-to-end (2026-08-21) but opt-in — reach for it only when actually asked, not by default.

Same syntax as the old script, deliberately — nothing new to guess. Room defaults to
`FleetOps` (`!dWwEG90OYi7hvMugzS:spark`); the broker delivers there as itself, never as you, so
the image lands in the room even if your own turn ends first.

This blocks until the job finishes (or a bounded timeout) — **pass a generous timeout to your
terminal tool** (e.g. `timeout=300`). On success it prints the real artifact path and its
sha256 to stdout. On failure or dead-letter, it prints the real error and exits non-zero —
there is no result to report if it doesn't print one.

## Relationship to the builtin `comfyui` skill and to `hermes-generate-image.sh`

The builtin `comfyui` skill (`hermes skills inspect comfyui`) is still the right reference for
general workflow authoring. **Don't call ComfyUI's `/prompt` endpoint directly, and don't
invoke `tools/hermes-generate-image.sh` yourself** — that script is HomeD13-only now; it belongs
to `hermes-render-worker`, not to you.

## Rules

- **If `hermes-render-request.sh` fails or times out, report the real error and stop — never
  write a replacement script, and never call ComfyUI or the old script directly as a
  workaround.** A missing or failing tool is something to report, not something to fake or route
  around. (Same rule as before, same reason: a fake placeholder was nearly run as a real tool
  once — see `LESSONS_LEARNED.md` §2b.)

## Revision History

| Version | Date | Change |
|---|---|---|
| 2.3.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-07-28 | Initial version, written after `tools/amy-generate-image.sh` was built and verified end to end (Phase 10) — manual invocation confirmed the full swap-generate-swap-deliver sequence works on the first try. |
| 1.1.0 | 2026-07-28 | Noted the NAS2 archive copy added to the script (best-effort, non-fatal) — every generated image now also lands in `PMoney/Private/Hermes/Images`. |
| 1.2.0 | 2026-07-28 | Documented the flag-style syntax and symlinked paths added after a real recurrence of the fake-tool fabrication incident (see `IMPLEMENTATION_PLAN.md` §3h). Added an explicit rule against writing a placeholder replacement when the real script fails. |
| 1.2.1 | 2026-07-30 | Cross-reference fix only: pointers into `IMPLEMENTATION_PLAN.md`'s former per-phase progress logs now point at `LESSONS_LEARNED.md`, which holds that content after the 4.0.0 restructure. No procedural change. |
| 2.0.0 | 2026-07-31 | **Reversal.** This doc pointed Amy at direct invocation of `tools/amy-generate-image.sh` for over a day after her gateway moved to the Spark in migration Stage 2, and it went unnoticed until a real request failed live: wrong host (no local ComfyUI/LLM), wrong sudo scope (`systemctl stop llama-amy-core` refused). Rewritten to point at the new `tools/hermes-render-request.sh` broker client instead. Full incident in `LESSONS_LEARNED.md` §7. |
| 2.1.0 | 2026-07-31 | Noted `tools/amy-generate-image.sh`'s own Stage 3e rewrite (2.0.0): no VRAM swap, no Matrix delivery of its own. Internal to the worker pipeline — doesn't change how `hermes-render-request.sh` is called. |
| 2.2.0 | 2026-08-21 | Documented `--engine sdxl\|flux2` (`tools/amy-generate-image.sh` 3.0.0) — FLUX.2 Klein is real and verified end-to-end, but stays opt-in behind an explicit flag, not the default. |
| 2.3.0 | 2026-08-29 | HermesAgentV5 S14: skill directory renamed `amy-image-gen` → `image-gen`, title and frontmatter `name` updated to match. Amy is retired (S8); no procedural change — this skill's actual behavior has been persona-agnostic since the 2.0.0 reversal. References to the underlying script updated to its new name, `hermes-generate-image.sh` (renamed same stage). |
