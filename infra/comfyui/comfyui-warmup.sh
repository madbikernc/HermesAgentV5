#!/usr/bin/env bash
# Version: 1.0.0
#
# Preloads the SDXL checkpoint into VRAM right after ComfyUI starts, so the first real render
# doesn't pay a cold-load penalty. Run as ExecStartPost from comfyui-homed13.service.
#
# Safe to run unconditionally: submits a throwaway 1-step, 64x64 generation and does not wait
# for or check its result — the point is only to force CheckpointLoaderSimple to run once.
# Migration Stage 3 (IMPLEMENTATION_PLAN.md §6 3g) — ComfyUI is this node's only GPU consumer
# now, so there is nothing to contend with and no VRAM-swap dance needed before doing this.
set -euo pipefail

COMFY_URL="http://127.0.0.1:8188"

for _ in $(seq 1 60); do
  curl -sf "$COMFY_URL/system_stats" >/dev/null 2>&1 && break
  sleep 1
done

curl -s -X POST "$COMFY_URL/prompt" -H "Content-Type: application/json" --data '{
  "prompt": {
    "3": {"class_type": "KSampler", "inputs": {"cfg": 7.0, "denoise": 1.0, "latent_image": ["5", 0], "model": ["4", 0], "negative": ["7", 0], "positive": ["6", 0], "sampler_name": "euler", "scheduler": "normal", "seed": 0, "steps": 1}},
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {"batch_size": 1, "height": 64, "width": 64}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 1], "text": "warmup"}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 1], "text": ""}},
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
    "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "warmup", "images": ["8", 0]}}
  }
}' >/dev/null
