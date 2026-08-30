---
name: render-request
description: "Submit a real image or video render to the fleet's job broker and get back a real artifact path and checksum. Use this when The Boss wants an actual image or video, not just a description of one."
version: 1.4.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [ComfyUI, SDXL, Wan2.1, image-generation, video-generation, job-broker, Matrix, NAS]
prerequisites:
  commands: [curl, jq]
---

# Render Request

**Version:** 1.4.0

The fleet's real image/video-rendering hardware is on HomeD13 (a render-worker node, reached only
through the job broker — see `IMPLEMENTATION_PLAN.md` §4c). This is the only real way to produce
an actual image or video. There is no direct capability to render one yourself, and nothing about
generating descriptive or "blueprint" text produces a real file — only a real broker job does.

## How to use it

Image (default):

```bash
~/HermesAgentV5/tools/hermes-render-request.sh "<prompt>" ["<negative prompt>"] ["<room-id>"]
```

or the flag form:

```bash
~/HermesAgentV5/tools/hermes-render-request.sh --prompt "<text>" [--style "<text>"] \
  [--negative "<text>"] [--resolution WxH] [--room <id>] [--engine sdxl|flux2]
```

**`--engine` defaults to `sdxl`** — the long-proven checkpoint, unchanged. `--engine flux2` is a
real, working alternative (FLUX.2 Klein 4B, verified end-to-end 2026-08-21: real image, 78s,
~7.4GB peak GPU) but is opt-in, not the default, since that verification was one synthetic test
image, not a track record across real requests. Reach for it only when actually asked to try it or
compare — don't switch a normal request to it unprompted.

Video (Stage 6, 2026-08-09 — Wan2.1 T2V 1.3B, 832x480, ~24fps .webm):

```bash
~/HermesAgentV5/tools/hermes-render-request.sh --prompt "<text>" --type video \
  [--frames N] [--negative "<text>"] [--room <id>]
```

`--frames` defaults to 33 (~1.4s of clip) if omitted. Video jobs are far slower than image jobs,
and cost grows **faster than proportionally** with length — real, directly measured times:

| `--frames` | clip length | real time |
|---|---|---|
| 33 (default) | 1.4s | ~4 min |
| 65 | 2.7s | ~9 min |
| 121 | 5.0s | ~24 min — confirmed practical maximum |

Going meaningfully beyond 121 frames is unverified and risks exceeding the pipeline's own timeout
— the cost curve keeps accelerating (33→65 cost 2.4x the time for 2x the length; 65→121 cost 2.6x
the time for only 1.9x the length), so don't assume linear scaling to estimate a longer clip's
cost. **Pass a generous timeout to your terminal tool for video** (e.g. `timeout=1800`) — the
default poll budget for `--type video` is already sized to that.

Room defaults to `FleetOps` (`!dWwEG90OYi7hvMugzS:spark`); the broker delivers the finished
artifact there itself, as `@fleetops:spark` — never as you, so it lands even if your own turn ends
first. If The Boss should see it somewhere else, pass `--room` with that room's ID.

This blocks until the render finishes (or times out). On success it prints the real artifact path
and its sha256 to stdout. On failure or dead-letter, it prints the real error and exits non-zero —
there is no result to report if it doesn't print one.

## Rules

- **If this fails or times out, report the real error and stop — never describe an image or video
  as if it exists, never write your own placeholder generation script, and never claim a render
  happened without a real artifact path and checksum to point to.** This fleet was rebuilt
  specifically because an earlier version of this project had agents narrate fabricated renders
  that never happened — see `LESSONS_LEARNED.md` §2a and §2g-§2i for the full, repeated history
  of exactly this failure mode. A missing or failing tool is something to report, not something
  to fake.
- Amy's own image-generation path (`tools/amy-generate-image.sh`) and the video equivalent
  (`tools/hermes-generate-video.sh`) are HomeD13-only scripts belonging to `hermes-render-worker`
  and its video-typed second instance — don't invoke either directly; this tool is the correct
  entrypoint from anywhere else, including from here.
- **Video is real generative output, not stock footage or a template** — same honesty standard as
  images. A short clip at modest resolution (832x480, ~5s practical maximum) is by design (§6
  Stage 6's own scope: "this makes video *possible*," not cinema-quality) — don't imply otherwise.
- **If asked for a clip longer than ~5 seconds (121 frames), say plainly that today's real ceiling
  is around there — don't attempt it.** A longer `--frames` value may still technically generate
  given enough time, but the real fleet pipeline's timeout was sized against the measured 121-frame
  cost specifically; going past it risks a job that gets killed mid-generation and reads as a
  failure, or in a worse case, silently exceeds resources in a way not yet characterized.

## Finding a render from a past turn

Not the one you just made — the command above already told you that path. For anything earlier,
check the NAS archive, not the broker's own storage:

```bash
ls -lat /mnt/nas2-hermes-backup/Private/Hermes/Images/
```

Every real render gets a best-effort archived copy there. Filenames are sequential
(`amy_gen_NNNNN_.png`) and tell you nothing about content or who requested it — sort by
modification time (`-t`), not name, to find a specific past one.

**The broker's own artifact directory (`/mnt/hermes-data/broker/artifacts/`) is not reachable by
you at all** — its parent directory is permission-restricted to the broker's own process, by
design, not a bug to work around. Don't spend a turn debugging permission errors there; the NAS
archive above is the real, working answer.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.4.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-01 | Initial version. `tools/hermes-render-request.sh` already existed (built for Amy's own Stage 3f post-migration fix) and was already proven working end to end; this skill just makes it a real, discoverable capability for Sintra too, closing a gap where she had no verified way to produce an actual image at all. |
| 1.1.0 | 2026-08-09 | Stage 6 (video generation): adds `--type video`/`--frames`. Real model (Wan2.1 T2V 1.3B) verified against a live Hugging Face listing and ComfyUI's own official example workflow before downloading anything; generation graph verified field-by-field against the live ComfyUI instance's `/object_info` schema. Verified end to end through the real broker, not just directly against ComfyUI — see `IMPLEMENTATION_PLAN.md` §6 Stage 6 for the full account. |
| 1.2.0 | 2026-08-10 | Direct question ("what is the longest video that can be made") led to real frame-count-vs-time measurement: 33/65/121 frames took ~4/~9/~24 min, an accelerating (not linear) cost curve. 121 frames (~1415s) exceeded the then-current 1200s worker timeout — raised to 1800s, with the poll budgets here and in `hermes-generate-video.sh` raised to match. Documented 121 frames (~5s) as the confirmed practical maximum; going meaningfully beyond it is unverified. |
| 1.3.0 | 2026-08-14 | Added "Finding a render from a past turn" (NAS archive lookup, broker artifact dir off-limits), consolidated here from duplicated copies in both `DesignFiles/*/SOUL.md`, which had grown this as live-prompt text instead of a shared skill pointer. |
| 1.4.0 | 2026-08-21 | Documented `--engine sdxl\|flux2` (`tools/amy-generate-image.sh` 3.0.0, `tools/hermes-render-request.sh` 1.3.0, `tools/hermes-render-worker.py` 1.3.0) — FLUX.2 Klein is real and verified end-to-end, but stays opt-in behind an explicit flag rather than becoming the default; SDXL's long track record is why. |
