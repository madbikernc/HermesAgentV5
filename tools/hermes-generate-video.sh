#!/usr/bin/env bash
# Version: 1.2.0
#
# 1.2.0 — security-review fix: --frames now validates it's digits-only before
# being spliced unquoted into the ComfyUI JSON workflow below — a crafted
# value could otherwise alter the request structure. hermes-render-worker.py
# already validates this before invoking this script; checked again here too
# since it's also directly invokable.
#
# HomeD13's real ComfyUI video-generation step (migration §6 Stage 6,
# IMPLEMENTATION_PLAN.md), invoked by hermes-render-worker's video-typed
# instance — never directly by an identity. Submits a real Wan2.1 T2V 1.3B
# generation to ComfyUI and prints the resulting artifact's path, mirroring
# tools/amy-generate-image.sh's contract exactly (sha256 on one line, real
# artifact path on the last line of stdout).
#
# Usage (flags, matching amy-generate-image.sh's syntax):
#   hermes-generate-video.sh --prompt "<text>" [--negative "<text>"]
#                             [--frames N] [--room <id, accepted/unused>]
#
# Model: Wan2.1 T2V 1.3B — the smaller of the two candidate families named in
# IMPLEMENTATION_PLAN.md §6 Stage 6 (LTX-Video was the other; Wan2.1 chosen
# for native, custom-node-free ComfyUI support). Graph and exact filenames
# verified against ComfyUI's own official example workflow
# (github.com/comfyanonymous/ComfyUI_examples/wan/text_to_video_wan.json)
# and the live ComfyUI instance's own /object_info schema for each node
# (UNETLoader, CLIPLoader, VAELoader, EmptyHunyuanLatentVideo, ModelSamplingSD3,
# SaveWEBM) — the same "verify against a live listing before downloading
# anything" gate Stage 4 used for Weaver/Muse, applied here to a node graph
# instead of a model ID.
#
# Real change from the stock example workflow: outputs a real .webm (SaveWEBM,
# vp9) instead of the example's default animated WEBP (SaveAnimatedWEBP,
# disabled here) — the broker's matrix_deliver() already mime-sniffs
# "video/*" to msgtype m.video, which a WEBP wouldn't get.
#
# Model files (~9.8GB total, downloaded and sha256-verified 2026-08-09):
#   models/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors  (2,838,303,560 bytes)
#   models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
#   models/vae/wan_2.1_vae.safetensors
#
# Requires: comfyui-homed13.service, jq, curl. Same NAS2 archive-copy
# best-effort pattern as amy-generate-image.sh.
#
# Real measured generation time vs --frames (2026-08-10, direct ComfyUI runs,
# 832x480 fixed shape) — cost grows faster than linearly, not proportionally:
#   33 frames  (1.4s @ 24fps, the default): ~4 min  (213-238s measured)
#   65 frames  (2.7s):                      ~9 min  (538s measured)
#   121 frames (5.0s):                      ~24 min (1415s measured — this
#     EXCEEDS the pre-1.1.0 worker JOB_TIMEOUT of 1200s; raised to 1800s
#     specifically so this length has real margin. See infra/comfyui/README.md
#     for the full account.)
# Frame counts well beyond 121 are unverified and risk exceeding even the
# raised timeout, given the accelerating cost curve — don't assume linear
# scaling holds.
set -euo pipefail

FRAMES=33
WIDTH=832
HEIGHT=480
DEFAULT_NEGATIVE="色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"

PROMPT=""
NEGATIVE="$DEFAULT_NEGATIVE"
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt) PROMPT="$2"; shift 2 ;;
    --negative) NEGATIVE="$2"; shift 2 ;;
    --frames)
      # Spliced unquoted into the JSON workflow below ("length": $FRAMES) --
      # a crafted non-numeric value could alter the request structure sent
      # to ComfyUI, found in a security review. hermes-render-worker.py
      # already validates this before invoking this script; checked again
      # here too since this script is also directly invokable. log() isn't
      # defined until later in the file, so plain stderr echo, not a
      # forward reference.
      [[ "$2" =~ ^[0-9]+$ ]] || {
        echo "[hermes-generate-video] ERROR: --frames must be a positive integer, got '$2'" >&2
        exit 1
      }
      FRAMES="$2"; shift 2 ;;
    --room) shift 2 ;;  # accepted, unused — same reasoning as amy-generate-image.sh
    --style) PROMPT="$PROMPT, $2"; shift 2 ;;
    --resolution) shift 2 ;;  # video resolution is fixed at 832x480 for this model; ignored
    *) shift ;;
  esac
done
: "${PROMPT:?usage: hermes-generate-video.sh --prompt \"<text>\" [--negative ...] [--frames N]}"

COMFY_URL="http://127.0.0.1:8188"
NAS_IMAGES_DIR="${NAS_IMAGES_DIR:-/mnt/nas2-hermes-images}"

log() { echo "[hermes-generate-video] $*" >&2; }

# 1. Submit the generation. Node graph verified against the live /object_info
#    schema for each node type — see header. Seed uses bash's $RANDOM (0-32767),
#    same source of randomness amy-generate-image.sh already relies on.
WORKFLOW=$(cat <<JSON
{
  "prompt": {
    "37": {"class_type": "UNETLoader", "inputs": {"unet_name": "wan2.1_t2v_1.3B_fp16.safetensors", "weight_dtype": "default"}},
    "48": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["37", 0], "shift": 8}},
    "38": {"class_type": "CLIPLoader", "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan", "device": "default"}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["38", 0], "text": $(jq -Rn --arg t "$PROMPT" '$t')}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["38", 0], "text": $(jq -Rn --arg t "$NEGATIVE" '$t')}},
    "40": {"class_type": "EmptyHunyuanLatentVideo", "inputs": {"width": $WIDTH, "height": $HEIGHT, "length": $FRAMES, "batch_size": 1}},
    "3": {"class_type": "KSampler", "inputs": {"cfg": 6, "denoise": 1, "latent_image": ["40", 0], "model": ["48", 0], "negative": ["7", 0], "positive": ["6", 0], "sampler_name": "uni_pc", "scheduler": "simple", "seed": $RANDOM, "steps": 30}},
    "39": {"class_type": "VAELoader", "inputs": {"vae_name": "wan_2.1_vae.safetensors"}},
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["39", 0]}},
    "47": {"class_type": "SaveWEBM", "inputs": {"images": ["8", 0], "filename_prefix": "video_gen", "codec": "vp9", "fps": 24, "crf": 32}}
  }
}
JSON
)
log "Submitting video generation ($FRAMES frames @ ${WIDTH}x${HEIGHT})..."
RESP="$(curl -s -X POST "$COMFY_URL/prompt" -H "Content-Type: application/json" --data "$WORKFLOW")"
PROMPT_ID="$(echo "$RESP" | jq -r '.prompt_id')"
if [ "$PROMPT_ID" = "null" ] || [ -z "$PROMPT_ID" ]; then
  log "ERROR: ComfyUI rejected the workflow: $RESP"
  exit 1
fi
log "Queued as $PROMPT_ID, waiting for completion..."

# 2. Poll for completion. Video generation is much slower than a 20-step SDXL
#    image, and cost grows faster than linearly with --frames — real measured:
#    33 frames ~4min, 65 frames ~9min, 121 frames ~24min (infra/comfyui/README.md
#    has the full table). 1200 tries * 2s = 40 minutes ceiling, kept well above
#    the worker's own JOB_TIMEOUT (1800s/30min) so that timeout is what actually
#    bounds a real job, not a premature local giveup here.
tries=0
VIDEO_FILENAME=""
while [ "$tries" -lt 1200 ]; do
  HIST="$(curl -s "$COMFY_URL/history/$PROMPT_ID")"
  VIDEO_FILENAME="$(echo "$HIST" | jq -r --arg pid "$PROMPT_ID" '.[$pid].outputs["47"].images[0].filename // empty' 2>/dev/null || true)"
  if [ -n "$VIDEO_FILENAME" ]; then break; fi
  sleep 2; tries=$((tries + 1))
done
if [ -z "$VIDEO_FILENAME" ]; then
  log "ERROR: generation did not complete in time"
  exit 1
fi
VIDEO_PATH="/opt/comfyui/output/$VIDEO_FILENAME"
log "Generated: $VIDEO_PATH"

# 2b. Best-effort archive copy to NAS2 — never fatal, same pattern as amy-generate-image.sh.
if mountpoint -q "$NAS_IMAGES_DIR" 2>/dev/null; then
  if cp "$VIDEO_PATH" "$NAS_IMAGES_DIR/$VIDEO_FILENAME" 2>/dev/null; then
    log "Archived to $NAS_IMAGES_DIR/$VIDEO_FILENAME"
  else
    log "WARNING: NAS archive copy failed (mounted but write failed) — continuing"
  fi
else
  log "WARNING: $NAS_IMAGES_DIR not mounted — skipping NAS archive copy"
fi

# 3. Report the real artifact — same contract as amy-generate-image.sh (sha256 line,
# then path as the final stdout line, which hermes-render-worker parses).
SHA256="$(sha256sum "$VIDEO_PATH" | cut -d' ' -f1)"
log "sha256: $SHA256"
echo "$SHA256"
echo "$VIDEO_PATH"
