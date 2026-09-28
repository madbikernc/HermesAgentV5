#!/usr/bin/env bash
# Version: 1.4.0
#
# 1.4.0 (2026-09-27, HermesAgentV5 S19b, pre-node) — `--type mesh`. TRELLIS.2 is image-to-3D, so a
# mesh job carries `source_job` (a finished render job) rather than an image: with --source-job the
# mesh job uses that render; without it, this first submits a render steered toward what image-to-3D
# needs (MESH_RENDER_STYLE) and chains its id in. Two ordinary broker jobs, no new transport. Also
# --keep-largest (passed through to hermes-mesh-repair.py), an unknown --type is now refused instead
# of silently submitted, and BROKER_TOKEN from the environment overrides the vault lookup. The mesh
# poll budget is PROVISIONAL (3600s) until S19 exit gate 2 measures a real job. Output contract is
# unchanged: artifact path, then sha256.
#
# 1.3.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default repointed from
# HermesAgentV4 to HermesAgentV5 as part of consolidating the fleet's tools/skills/infra
# into the new HermesAgentV5 repo.
#
# 1.3.0 (HermesAgentV4) — added --engine sdxl|flux2, threaded through to
# amy-generate-image.sh's new engine choice via hermes-render-worker.py's own validated
# passthrough (IMPLEMENTATION_PLAN.md §6 Stage 3/6). Only meaningful for --type render;
# harmless if set on a video job, since hermes-generate-video.sh ignores unknown flags.
#
# Client-side submission tool for the fleet's job broker (IMPLEMENTATION_PLAN.md §4c,
# infra/hermes-broker/README.md). Submits a render/video job and waits for it to finish, printing
# the real artifact path and sha256 on success, or the real error on failure — never fabricates a
# result.
#
# This is the correct way to request a ComfyUI render from any node that isn't HomeD13 itself —
# in particular, from the Spark, where Amy's gateway now runs (migration Stage 2).
# tools/amy-generate-image.sh talks to 127.0.0.1:8188 and 127.0.0.1:8081 and stops/starts
# llama-amy-core.service — all of which only exist on HomeD13. Calling it from anywhere else
# fails in two different ways (wrong host, wrong sudo scope) rather than one obvious way — see
# LESSONS_LEARNED.md §7 for the real incident. hermes-render-worker on HomeD13 still invokes that
# script directly and unchanged; this tool is what everything else should call instead.
#
# Stage 6 (2026-08-09) generalized this from render-only to a --type flag (default "render",
# also accepts "video"), matching hermes-render-worker.py's own JOB_TYPE generalization — no
# broker-side change was needed since the broker already treated `type` as an opaque string.
# Video jobs get a longer default poll budget, matching the video worker's JOB_TIMEOUT (raised
# 2026-08-10 from 1200s to 1800s once real measurement showed a 121-frame/~5s clip takes ~1415s,
# exceeding the original 1200s — see tools/hermes-generate-video.sh's own header for the full
# measured frame-count-vs-time table before assuming a longer --frames value is safe).
#
# Usage (positional): hermes-render-request.sh "<prompt>" ["<negative prompt>"] ["<room-id>"]
# Usage (flags, matching amy-generate-image.sh's syntax so nothing new has to be guessed):
#   hermes-render-request.sh --prompt "<text>" [--style "<text>"] [--negative "<text>"]
#                             [--resolution WxH] [--room <id>] [--type render|video|mesh] [--frames N]
#                             [--engine sdxl|flux2] [--source-job <render-job-id>] [--keep-largest]
#
# Room defaults to FleetOps (!dWwEG90OYi7hvMugzS:spark) — the broker delivers there as itself,
# never as the calling persona (IMPLEMENTATION_PLAN.md §4c point 3).
#
# Requires: tools/vault-get-secret.sh (for the broker-token vault item), curl, jq.
set -euo pipefail

DEFAULT_NEGATIVE="blurry, low quality, low resolution, worst quality, jpeg artifacts, bad anatomy, extra limbs, missing limbs, extra fingers, mutated hands, poorly drawn face, deformed, disfigured, ugly, watermark, signature, text, username, logo, cropped, out of frame, duplicate, oversaturated, overexposed, underexposed"

# S19: mesh jobs. Image-to-3D wants one whole object, isolated, evenly lit — steer the source render.
MESH_RENDER_STYLE="single object, whole object fully in frame, centered, three-quarter view, plain white background, soft even lighting, no shadows"
MESH_RENDER_NEGATIVE="multiple objects, busy background, scenery, cut off, partial view, harsh shadows"
SOURCE_JOB=""
KEEP_LARGEST=false

if [ "${1:-}" != "" ] && [[ "$1" == --* ]]; then
  PROMPT=""
  STYLE=""
  NEGATIVE="$DEFAULT_NEGATIVE"
  ROOM_ID="!dWwEG90OYi7hvMugzS:spark"
  RESOLUTION=""
  JOB_TYPE="render"
  FRAMES=""
  ENGINE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --prompt) PROMPT="$2"; shift 2 ;;
      --style) STYLE="$2"; shift 2 ;;
      --negative) NEGATIVE="$2"; shift 2 ;;
      --room) ROOM_ID="$2"; shift 2 ;;
      --resolution) RESOLUTION="$2"; shift 2 ;;
      --type) JOB_TYPE="$2"; shift 2 ;;
      --source-job) SOURCE_JOB="$2"; shift 2 ;;
      --keep-largest) KEEP_LARGEST=true; shift ;;
      --frames) FRAMES="$2"; shift 2 ;;
      --engine)
        ENGINE="$2"
        [ "$ENGINE" = "sdxl" ] || [ "$ENGINE" = "flux2" ] || {
          echo "[hermes-render-request] ERROR: --engine must be 'sdxl' or 'flux2', got '$2'" >&2
          exit 1
        }
        shift 2 ;;
      *) shift ;;
    esac
  done
  [ -n "$STYLE" ] && PROMPT="$PROMPT, $STYLE"
  : "${PROMPT:?usage: hermes-render-request.sh --prompt \"<text>\" [--style ...] [--negative ...] [--room ...] [--resolution WxH] [--type render|video|mesh] [--frames N] [--engine sdxl|flux2] [--source-job ID] [--keep-largest]}"
else
  PROMPT="${1:?usage: hermes-render-request.sh <prompt> [negative prompt] [room-id]}"
  NEGATIVE="${2:-$DEFAULT_NEGATIVE}"
  ROOM_ID="${3:-!dWwEG90OYi7hvMugzS:spark}"
  RESOLUTION=""
  JOB_TYPE="render"
  FRAMES=""
  ENGINE=""
fi

BROKER_URL="${BROKER_URL:-http://10.129.1.15:8100}"
REPO_DIR="${HERMES_REPO_DIR:-$HOME/HermesAgentV5}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
RENDER_POLL_TRIES=60
case "$JOB_TYPE" in
  render) POLL_TRIES="${POLL_TRIES:-$RENDER_POLL_TRIES}" ;;
  video) POLL_TRIES="${POLL_TRIES:-360}" ;;   # 360*5s = 1800s, matches the video worker's JOB_TIMEOUT
  # PROVISIONAL, not measured: 720*5s = 3600s, matching hermes-generate-mesh.py's own provisional
  # MESH_COMFY_TIMEOUT. S19 exit gate 2 replaces both with a real measurement — do not tune by guess.
  mesh) POLL_TRIES="${POLL_TRIES:-720}" ;;
  *) echo "[hermes-render-request] ERROR: --type must be render, video or mesh, got '$JOB_TYPE'" >&2; exit 1 ;;
esac

log() { echo "[hermes-render-request] $*" >&2; }

# BROKER_TOKEN from the environment wins, for callers that already hold it (the S19 end-to-end test
# against a throwaway broker); otherwise the vault, as before.
TOKEN="${BROKER_TOKEN:-$("$REPO_DIR/tools/vault-get-secret.sh" broker-token password)}"

# submit_and_wait <type> <payload-json> <poll-tries>: sets DONE_JOB_ID/ARTIFACT/SHA, or returns 1
# having logged the real reason.
submit_and_wait() {
  local type="$1" payload="$2" budget="$3" resp job state tries=0
  resp="$(curl -s -X POST "$BROKER_URL/jobs" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "$(jq -n --argjson payload "$payload" --arg type "$type" '{type: $type, payload: $payload}')")"
  DONE_JOB_ID="$(echo "$resp" | jq -r '.id // empty')"
  if [ -z "$DONE_JOB_ID" ]; then
    log "ERROR: broker rejected $type submission: $resp"
    return 1
  fi
  log "Submitted $type job as $DONE_JOB_ID, waiting..."
  while [ "$tries" -lt "$budget" ]; do
    job="$(curl -s "$BROKER_URL/jobs/$DONE_JOB_ID" -H "Authorization: Bearer $TOKEN")"
    state="$(echo "$job" | jq -r '.state')"
    case "$state" in
      done)
        ARTIFACT="$(echo "$job" | jq -r '.artifact')"
        SHA="$(echo "$job" | jq -r '.sha256')"
        log "Done. Artifact: $ARTIFACT"
        return 0
        ;;
      dead)
        log "ERROR: $type job $DONE_JOB_ID dead-lettered: $(echo "$job" | jq -r '.error')"
        return 1
        ;;
    esac
    sleep "$POLL_INTERVAL"
    tries=$((tries + 1))
  done
  log "ERROR: $type job $DONE_JOB_ID did not finish within $((budget * POLL_INTERVAL))s — check status with: curl -s $BROKER_URL/jobs/$DONE_JOB_ID -H \"Authorization: Bearer \$TOKEN\""
  return 1
}

render_payload() {
  jq -n --arg p "$1" --arg n "$2" --arg r "$ROOM_ID" --arg res "$RESOLUTION" --arg f "$FRAMES" --arg e "$ENGINE" \
    '{prompt: $p, negative: $n, room: $r} + (if $res != "" then {resolution: $res} else {} end) + (if $f != "" then {frames: $f} else {} end) + (if $e != "" then {engine: $e} else {} end)'
}

if [ "$JOB_TYPE" = "mesh" ]; then
  # TRELLIS.2 is image-to-3D (S19b): a mesh job names a finished render job's image. Without
  # --source-job, render one first, steered toward what image-to-3D needs — one whole object on a
  # plain background — then hand that job's id to the mesh job.
  if [ -z "$SOURCE_JOB" ]; then
    RENDER_PROMPT="$PROMPT, $MESH_RENDER_STYLE"
    submit_and_wait render "$(render_payload "$RENDER_PROMPT" "$NEGATIVE, $MESH_RENDER_NEGATIVE")" "$RENDER_POLL_TRIES" || exit 1
    SOURCE_JOB="$DONE_JOB_ID"
  fi
  MESH_PAYLOAD="$(jq -n --arg p "$PROMPT" --arg s "$SOURCE_JOB" --argjson k "$KEEP_LARGEST" \
    '{prompt: $p, source_job: $s} + (if $k then {keep_largest: true} else {} end)')"
  submit_and_wait mesh "$MESH_PAYLOAD" "$POLL_TRIES" || exit 1
else
  submit_and_wait "$JOB_TYPE" "$(render_payload "$PROMPT" "$NEGATIVE")" "$POLL_TRIES" || exit 1
fi
echo "$ARTIFACT"
echo "$SHA"
