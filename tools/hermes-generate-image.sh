#!/usr/bin/env bash
# Version: 3.1.0
#
# 3.1.0 (HermesAgentV5 S14) — renamed from amy-generate-image.sh. Amy is retired (S8); this
# script's own logic was already persona-agnostic (Migration Stage 3's rewrite, see 46-53 below —
# it hasn't reported to any persona's own delivery path in over a year), only the filename and log
# prefix still said otherwise. `skills/amy-image-gen/` renamed to `skills/image-gen/` in the same
# pass. `hermes-render-worker.py`'s `GENERATE_SCRIPT` default updated to match (S14) — every other
# caller (`hermes-render-request.sh`, `hermes-generate-video.sh`, `hermes-model-archive.py`, and
# the READMEs) references this script only in prose/comments, not a literal invoked path; left
# alone rather than touched file-by-file for a pure rename with no functional effect there.
#
# 3.0.0 (HermesAgentV4) — added --engine flux2 as a real, callable alternative to SDXL
# (IMPLEMENTATION_PLAN.md §6 Stage 3, verified end-to-end 2026-08-21: real image, 78s,
# ~7.4GB peak GPU). **SDXL stays the default** — deliberately not switched, even though FLUX.2
# is verified working, because that one verification was a single synthetic test image, not
# real production traffic, and this is the fleet's actual live image-generation path. Node IDs in the
# FLUX.2 graph were chosen to match the SDXL graph's own convention (`SaveImage` is node `9` in
# both) specifically so the polling/completion-detection code below needs zero changes between
# engines. FLUX.2's real model files (`flux-2-klein-4b-fp8.safetensors`,
# `qwen_3_4b_fp4_flux2.safetensors`, `flux2-vae.safetensors`) are the ones actually downloaded
# and byte-verified this session, not the Mistral-Small-3 text encoder an earlier pass
# mistakenly assumed Klein needed — see `infra/comfyui/flux2-klein-api-workflow.json`, which
# this inline graph mirrors.
#
# 2.1.0 — security-review fix: --resolution now validates WIDTH/HEIGHT are
# digits-only before they're spliced unquoted into the ComfyUI JSON workflow
# below — a crafted value could otherwise alter the request structure.
# hermes-render-worker.py already validates this before invoking this
# script; checked again here too since it's also directly invokable.
#
# HomeD13's real ComfyUI generation step, invoked by hermes-render-worker (never
# directly by an identity — see IMPLEMENTATION_PLAN.md §4c and skills/image-gen/SKILL.md).
# Submits a real SDXL (default) or FLUX.2 Klein (--engine flux2) generation to ComfyUI and
# prints the resulting artifact's path.
#
# Usage (positional): hermes-generate-image.sh "<prompt>" ["<negative prompt>"] ["<room-id>"]
# Usage (flags, also accepted):
#   hermes-generate-image.sh --prompt "<text>" [--style "<text>"] [--negative "<text>"]
#                          [--resolution WxH] [--engine sdxl|flux2] [--output <ignored, cosmetic>] [--room <id>]
# --style text is appended to the prompt. --room/positional room-id is accepted but unused —
# hermes-render-worker always passes it because the broker's job payload carries a room, but
# delivery is the broker's job now (see below), not this script's. --engine is flags-only —
# no positional equivalent, since the positional form predates FLUX.2 and SDXL stays its
# implicit default regardless.
#
# Defaults: negative prompt is a general-purpose SDXL negative prompt covering the common
# failure modes (see DEFAULT_NEGATIVE below) — pass --negative/a second positional arg to
# override for a specific request.
#
# Requires: comfyui-homed13.service, jq, curl, and the NAS2 NFS export mounted at
# /mnt/nas2-hermes-images (see /etc/fstab and LESSONS_LEARNED.md §7 — the NAS copy is
# best-effort, never fatal; a `hard` mount would block this script forever if NAS2 went away).
#
# Migration Stage 3 (2026-07-31) rewrite — reversal of 1.x behaviour:
#   - No VRAM dual-mode swap. ComfyUI is this node's only GPU consumer now that its
#     reasoning layer (llama-amy-core) is gone; there is nothing to free or wait on.
#   - No Matrix delivery. hermes-render-worker reports the artifact back to the broker,
#     which delivers it into FleetOps as itself — see LESSONS_LEARNED.md §2/§4b for why an
#     LLM-adjacent script is not the thing that should report work happened.
#   - No Vaultwarden access needed by this script at all as a result (was matrix-amy only).
# Full detail: IMPLEMENTATION_PLAN.md §6 Stage 3e.
set -euo pipefail

WIDTH=1024
HEIGHT=1024
DEFAULT_NEGATIVE="blurry, low quality, low resolution, worst quality, jpeg artifacts, bad anatomy, extra limbs, missing limbs, extra fingers, mutated hands, poorly drawn face, deformed, disfigured, ugly, watermark, signature, text, username, logo, cropped, out of frame, duplicate, oversaturated, overexposed, underexposed"

ENGINE="sdxl"

if [ "${1:-}" != "" ] && [[ "$1" == --* ]]; then
  PROMPT=""
  STYLE=""
  NEGATIVE="$DEFAULT_NEGATIVE"
  while [ $# -gt 0 ]; do
    case "$1" in
      --prompt) PROMPT="$2"; shift 2 ;;
      --style) STYLE="$2"; shift 2 ;;
      --negative) NEGATIVE="$2"; shift 2 ;;
      --engine)
        ENGINE="$2"
        [ "$ENGINE" = "sdxl" ] || [ "$ENGINE" = "flux2" ] || {
          echo "[hermes-generate-image] ERROR: --engine must be 'sdxl' or 'flux2', got '$2'" >&2
          exit 1
        }
        shift 2 ;;
      --room) shift 2 ;;  # accepted, unused — see header
      --resolution)
        # Both digit-only after the split -- these get spliced unquoted into
        # a JSON workflow request below, so a crafted value (e.g. `1024,
        # "extra_node": {...}`) could otherwise alter the request structure
        # sent to ComfyUI. hermes-render-worker.py already validates this
        # before ever invoking this script; checked again here too, since
        # this script is also directly invokable.
        WIDTH="${2%x*}"; HEIGHT="${2#*x}"
        # log() isn't defined until later in the file (this arg-parsing block
        # runs before it) -- plain stderr echo here, not a forward reference.
        [[ "$WIDTH" =~ ^[0-9]+$ && "$HEIGHT" =~ ^[0-9]+$ ]] || {
          echo "[hermes-generate-image] ERROR: --resolution must be WIDTHxHEIGHT (digits only), got '$2'" >&2
          exit 1
        }
        shift 2 ;;
      --output) shift 2 ;;  # cosmetic only — the real output naming is automatic
      *) shift ;;
    esac
  done
  [ -n "$STYLE" ] && PROMPT="$PROMPT, $STYLE"
  : "${PROMPT:?usage: hermes-generate-image.sh --prompt \"<text>\" [--style ...] [--negative ...] [--room ...] [--resolution WxH]}"
else
  PROMPT="${1:?usage: hermes-generate-image.sh <prompt> [negative prompt] [room-id]}"
  NEGATIVE="${2:-$DEFAULT_NEGATIVE}"
  # $3 (room-id) accepted, unused — see header
fi

COMFY_URL="http://127.0.0.1:8188"
NAS_IMAGES_DIR="${NAS_IMAGES_DIR:-/mnt/nas2-hermes-images}"

log() { echo "[hermes-generate-image] $*" >&2; }

# 1. Submit the generation. Node "9" (SaveImage) is deliberately the same id in both graphs —
# see 3.0.0 header note — so the polling step below needs no engine-specific branch.
if [ "$ENGINE" = "flux2" ]; then
  log "Engine: flux2 (FLUX.2 Klein 4B fp8 + Qwen3-4B fp4 text encoder)"
  WORKFLOW=$(cat <<JSON
{
  "prompt": {
    "70": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux-2-klein-4b-fp8.safetensors", "weight_dtype": "default"}},
    "71": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_4b_fp4_flux2.safetensors", "type": "flux2"}},
    "72": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae.safetensors"}},
    "67": {"class_type": "CLIPTextEncode", "inputs": {"text": $(jq -Rn --arg t "$NEGATIVE" '$t'), "clip": ["71", 0]}},
    "74": {"class_type": "CLIPTextEncode", "inputs": {"text": $(jq -Rn --arg t "$PROMPT" '$t'), "clip": ["71", 0]}},
    "62": {"class_type": "Flux2Scheduler", "inputs": {"steps": 20, "width": $WIDTH, "height": $HEIGHT}},
    "63": {"class_type": "CFGGuider", "inputs": {"cfg": 5, "model": ["70", 0], "positive": ["74", 0], "negative": ["67", 0]}},
    "61": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
    "73": {"class_type": "RandomNoise", "inputs": {"noise_seed": $RANDOM}},
    "66": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": $WIDTH, "height": $HEIGHT, "batch_size": 1}},
    "64": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["73", 0], "guider": ["63", 0], "sampler": ["61", 0], "sigmas": ["62", 0], "latent_image": ["66", 0]}},
    "65": {"class_type": "VAEDecode", "inputs": {"samples": ["64", 0], "vae": ["72", 0]}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["65", 0], "filename_prefix": "hermes_gen"}}
  }
}
JSON
)
else
  log "Engine: sdxl"
  WORKFLOW=$(cat <<JSON
{
  "prompt": {
    "3": {"class_type": "KSampler", "inputs": {"cfg": 7.0, "denoise": 1.0, "latent_image": ["5", 0], "model": ["4", 0], "negative": ["7", 0], "positive": ["6", 0], "sampler_name": "euler", "scheduler": "normal", "seed": $RANDOM, "steps": 20}},
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {"batch_size": 1, "height": $HEIGHT, "width": $WIDTH}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 1], "text": $(jq -Rn --arg t "$PROMPT" '$t')}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 1], "text": $(jq -Rn --arg t "$NEGATIVE" '$t')}},
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
    "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "hermes_gen", "images": ["8", 0]}}
  }
}
JSON
)
fi
log "Submitting generation..."
RESP="$(curl -s -X POST "$COMFY_URL/prompt" -H "Content-Type: application/json" --data "$WORKFLOW")"
PROMPT_ID="$(echo "$RESP" | jq -r '.prompt_id')"
if [ "$PROMPT_ID" = "null" ] || [ -z "$PROMPT_ID" ]; then
  log "ERROR: ComfyUI rejected the workflow: $RESP"
  exit 1
fi
log "Queued as $PROMPT_ID, waiting for completion..."

# 2. Poll for completion.
tries=0
IMAGE_FILENAME=""
while [ "$tries" -lt 120 ]; do
  HIST="$(curl -s "$COMFY_URL/history/$PROMPT_ID")"
  IMAGE_FILENAME="$(echo "$HIST" | jq -r --arg pid "$PROMPT_ID" '.[$pid].outputs["9"].images[0].filename // empty' 2>/dev/null || true)"
  if [ -n "$IMAGE_FILENAME" ]; then break; fi
  sleep 2; tries=$((tries + 1))
done
if [ -z "$IMAGE_FILENAME" ]; then
  log "ERROR: generation did not complete in time"
  exit 1
fi
IMAGE_PATH="/opt/comfyui/output/$IMAGE_FILENAME"
log "Generated: $IMAGE_PATH"

# 2b. Best-effort archive copy to NAS2 — never fatal.
if mountpoint -q "$NAS_IMAGES_DIR" 2>/dev/null; then
  if cp "$IMAGE_PATH" "$NAS_IMAGES_DIR/$IMAGE_FILENAME" 2>/dev/null; then
    log "Archived to $NAS_IMAGES_DIR/$IMAGE_FILENAME"
  else
    log "WARNING: NAS archive copy failed (mounted but write failed) — continuing"
  fi
else
  log "WARNING: $NAS_IMAGES_DIR not mounted — skipping NAS archive copy"
fi

# 3. Report the real artifact. hermes-render-worker reads the LAST stdout line as the
# path and computes its own sha256 from the file — print the checksum first (for a human
# reading the log/worker stdout) and the path last, so the worker's parsing is unaffected.
SHA256="$(sha256sum "$IMAGE_PATH" | cut -d' ' -f1)"
log "sha256: $SHA256"
echo "$SHA256"
echo "$IMAGE_PATH"
