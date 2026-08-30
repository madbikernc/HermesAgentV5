#!/usr/bin/env bash
# Version: 1.3.1
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
#                             [--resolution WxH] [--room <id>] [--type render|video] [--frames N]
#                             [--engine sdxl|flux2]
#
# Room defaults to FleetOps (!dWwEG90OYi7hvMugzS:spark) — the broker delivers there as itself,
# never as the calling persona (IMPLEMENTATION_PLAN.md §4c point 3).
#
# Requires: tools/vault-get-secret.sh (for the broker-token vault item), curl, jq.
set -euo pipefail

DEFAULT_NEGATIVE="blurry, low quality, low resolution, worst quality, jpeg artifacts, bad anatomy, extra limbs, missing limbs, extra fingers, mutated hands, poorly drawn face, deformed, disfigured, ugly, watermark, signature, text, username, logo, cropped, out of frame, duplicate, oversaturated, overexposed, underexposed"

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
  : "${PROMPT:?usage: hermes-render-request.sh --prompt \"<text>\" [--style ...] [--negative ...] [--room ...] [--resolution WxH] [--type render|video] [--frames N] [--engine sdxl|flux2]}"
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
if [ "$JOB_TYPE" = "video" ]; then
  POLL_TRIES="${POLL_TRIES:-360}"    # 360*5s = 1800s, matches the video worker's JOB_TIMEOUT
else
  POLL_TRIES="${POLL_TRIES:-60}"
fi
POLL_INTERVAL="${POLL_INTERVAL:-5}"

log() { echo "[hermes-render-request] $*" >&2; }

TOKEN="$("$REPO_DIR/tools/vault-get-secret.sh" broker-token password)"

PAYLOAD="$(jq -n --arg p "$PROMPT" --arg n "$NEGATIVE" --arg r "$ROOM_ID" --arg res "$RESOLUTION" --arg f "$FRAMES" --arg e "$ENGINE" \
  '{prompt: $p, negative: $n, room: $r} + (if $res != "" then {resolution: $res} else {} end) + (if $f != "" then {frames: $f} else {} end) + (if $e != "" then {engine: $e} else {} end)')"

RESP="$(curl -s -X POST "$BROKER_URL/jobs" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --argjson payload "$PAYLOAD" --arg type "$JOB_TYPE" '{type: $type, payload: $payload}')")"

JOB_ID="$(echo "$RESP" | jq -r '.id // empty')"
if [ -z "$JOB_ID" ]; then
  log "ERROR: broker rejected submission: $RESP"
  exit 1
fi
log "Submitted as $JOB_ID, waiting..."

tries=0
while [ "$tries" -lt "$POLL_TRIES" ]; do
  JOB="$(curl -s "$BROKER_URL/jobs/$JOB_ID" -H "Authorization: Bearer $TOKEN")"
  STATE="$(echo "$JOB" | jq -r '.state')"
  case "$STATE" in
    done)
      ARTIFACT="$(echo "$JOB" | jq -r '.artifact')"
      SHA="$(echo "$JOB" | jq -r '.sha256')"
      log "Done. Artifact: $ARTIFACT"
      echo "$ARTIFACT"
      echo "$SHA"
      exit 0
      ;;
    dead)
      ERR="$(echo "$JOB" | jq -r '.error')"
      log "ERROR: job dead-lettered: $ERR"
      exit 1
      ;;
  esac
  sleep "$POLL_INTERVAL"
  tries=$((tries + 1))
done
log "ERROR: job $JOB_ID did not finish within $((POLL_TRIES * POLL_INTERVAL))s — check status with: curl -s $BROKER_URL/jobs/$JOB_ID -H \"Authorization: Bearer \$TOKEN\""
exit 1
