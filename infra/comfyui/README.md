# ComfyUI setup — recreate checklist

**Version:** 2.2.0

Ordered steps to stand up HomeD13's image-generation stack (originally Phase 9). For the full narrative —
why ComfyUI/SDXL over the alternatives, the reasoning behind the firewall approach — see
`IMPLEMENTATION_PLAN.md` §3a and `LESSONS_LEARNED.md` §3b in the repo root. This file is the recipe; those
sections are the reasoning.

Runs on the render-worker node (HomeD13, RTX 3060, 12GB VRAM) only.

**Migration Stage 3 (2026-07-31) superseded the VRAM dual-mode swap section that used to be here.** HomeD13
no longer runs a reasoning model (`llama-amy-core` was removed in Stage 3a) — ComfyUI is this node's only
GPU consumer now, so there is nothing to swap with. The checkpoint stays resident permanently instead, per
step 6 below. Full detail in `IMPLEMENTATION_PLAN.md` §6 Stage 3g and `LESSONS_LEARNED.md` §3b (kept there
as history — the bug it describes was real and is not being erased, just no longer operative).

## 1. Install ComfyUI

```bash
sudo mkdir -p /opt/comfyui && sudo chown pmoney:pmoney /opt/comfyui
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI /opt/comfyui
cd /opt/comfyui

sudo apt-get install -y python3.13-venv   # or whatever venv package matches this node's python3 --version
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124  # match this node's CUDA version
pip install -r requirements.txt
```

## 2. Download the SDXL base checkpoint

```bash
mkdir -p /opt/comfyui/models/checkpoints
curl -fL -o /opt/comfyui/models/checkpoints/sd_xl_base_1.0.safetensors \
  "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors"
# Expect exactly 6938078334 bytes.
```

## 3. Install and start the service

```bash
sudo cp comfyui-homed13.service /etc/systemd/system/comfyui-homed13.service
sudo systemctl daemon-reload
sudo systemctl enable --now comfyui-homed13.service
journalctl -u comfyui-homed13 -n 20 --no-pager   # expect "To see the GUI go to: http://0.0.0.0:8188"
```

## 4. Make the checkpoint resident (Stage 3g)

`comfyui-homed13.service`'s `ExecStartPost` runs `comfyui-warmup.sh`, which submits a throwaway 1-step,
64×64 generation right after ComfyUI comes up — forcing the SDXL checkpoint into VRAM before the first real
request arrives, rather than paying that cold-load cost on someone's actual job. Verify it worked from raw
output, not from the unit just being active:

```bash
sudo systemctl restart comfyui-homed13.service
sleep 10   # give the warmup a moment to land
nvidia-smi --query-gpu=memory.used --format=csv   # expect several GB used, with no real job submitted yet
```

## 5. Scope the firewall

Same pattern as every other service in this project — LAN-only by default, no app-level auth exists so this
is the actual access control:

```bash
sudo ufw allow from 10.129.1.0/24 to any port 8188 comment "ComfyUI"
```

`ComfyUI` binds `0.0.0.0` deliberately (needed so The Boss can reach the GUI from elsewhere on the LAN, per
the Phase 9 subgoal) — `ufw` is what actually restricts who can reach it, not the bind address.

## 6. Verify

```bash
curl -s http://<homed13-LAN-IP>:8188/api/system_stats   # real JSON with comfyui_version
```

Submit a minimal SDXL text-to-image workflow to `POST /prompt` and confirm a real image lands in
`/opt/comfyui/output/`.

## 7. Video generation (Stage 6, 2026-08-09) — Wan2.1 T2V 1.3B

Native ComfyUI support — no custom node needed, unlike LTX-Video (the other candidate named in
`IMPLEMENTATION_PLAN.md` §6 Stage 6), which typically wants Lightricks' own custom-node repo for
full functionality. Filenames and the node graph were verified against a live listing before
downloading anything — same discipline as Stage 4's model-ID gate, applied here to a model file
listing and a workflow graph instead of an LLM repo:

```bash
mkdir -p models/diffusion_models models/text_encoders models/vae   # already existed on this node
curl -fL -o models/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors \
  "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors"
# Expect exactly 2838303560 bytes.
curl -fL -o models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors \
  "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
# Expect exactly 6735906897 bytes. (The fp16 text encoder is 11.4GB and unnecessarily large for a
# 12GB card — fp8 is what ComfyUI's own official example workflow uses too.)
curl -fL -o models/vae/wan_2.1_vae.safetensors \
  "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors"
# Expect exactly 253815318 bytes.
```

The generation graph (`tools/hermes-generate-video.sh`) was built from ComfyUI's own official
example (`github.com/comfyanonymous/ComfyUI_examples/wan/text_to_video_wan.json`), with every node's
exact input keys confirmed against the live instance's own `/object_info` schema before writing any
request code — not assumed from the UI-format JSON's positional `widgets_values`. One real change
from the stock example: it outputs `SaveWEBM` (a real `.webm`, `vp9`) instead of the example's
default `SaveAnimatedWEBP` — the broker's `matrix_deliver()` mime-sniffs `video/*` to `msgtype:
m.video`, which a WEBP wouldn't get.

**Real finding, confirmed live: the resident SDXL checkpoint does NOT coexist with the video model.**
§4 above made the checkpoint resident (~6.8GB of 12GB) specifically to avoid reload latency for
image jobs. A live video generation run measured **11,280 MiB used, GPU at 100%**, and the journal
showed ComfyUI's own internal model manager evicting nothing manually configured — it requested and
fully loaded `WanTEModel` (6,419 MB) then `WAN21` (2,706 MB) on its own, the same automatic eviction
behavior `IMPLEMENTATION_PLAN.md`'s Stage 3e purge notes already relied on ("ComfyUI evicts
internally when it needs to"). No `/free` call or other manual coordination was needed or added —
but the practical consequence is real: an image job immediately after a video job pays the SDXL
cold-load cost again (~13s per the `comfyui-warmup.sh` measurement), until the warmup path reloads
it. This was an open question before Stage 6 was built; it's now measured, not assumed.

**Real generation time, measured 2026-08-09:** 33 frames at 832x480, 30 steps — **3m33s** direct
against ComfyUI, **3m55s** through the full broker round-trip (submit → claim → generate → upload →
checksum → Matrix delivery).

**Real frame-count-vs-time scaling, measured 2026-08-10 (direct question: "what is the longest
video that can be made"):** cost grows **faster than linearly** with `--frames`, not
proportionally:

| `--frames` | clip length @ 24fps | real generation time |
|---|---|---|
| 33 (default) | 1.4s | 3m33s – 3m58s (213-238s) |
| 65 | 2.7s | 8m58s (538s) |
| 121 | 5.0s | **23m35s (1415s)** |

Going 33→65 frames (2.0x the length) cost 2.4x the time; 65→121 (1.9x the length) cost 2.6x the
time — the exponent itself is increasing, consistent with attention cost over the temporal
dimension dominating more as the sequence grows. **121 frames is the confirmed practical
maximum** against the current timeout; frame counts meaningfully beyond that are unverified and
should not be assumed safe by extrapolating linearly. VRAM was not the limiting factor at any
tested point (comfortable headroom below the 12GB ceiling throughout) — time is.

This directly caused a real, found-live bug: the original `JOB_TIMEOUT` (1200s) was sized against
only the 33-frame measurement, and 121 frames (1415s) would have been killed mid-job through the
real broker/worker path — a false failure on a generation that actually succeeds given enough
time. **Raised to 1800s** (`hermes-render-worker-video.service`), with `hermes-generate-video.sh`'s
own internal poll ceiling raised in step (1200 tries × 2s = 40min, kept safely above the worker
timeout so that timeout — not a premature local giveup — is what actually bounds a real job) and
`hermes-render-request.sh`'s client-side poll budget raised to match (360 tries × 5s = 1800s).

## History: the VRAM dual-mode swap (superseded by Stage 3, no longer operative)

**This section describes a real bug from when this node also ran a reasoning model (`llama-amy-core`,
removed in migration Stage 3a). Kept for history; nothing here should be acted on anymore** — ComfyUI is
this node's only GPU consumer now, so there is no swap to perform. See §4 above for the current model
(resident checkpoint, warmed at startup).

Amy's `SOUL.md` already documented the *first* direction of this constraint (stop the LLM, wait for VRAM to
actually clear, before loading the diffusion model) as a known v1 failure mode. Standing this up for real
surfaced the **second, previously-undocumented direction**: ComfyUI does **not** release a loaded checkpoint
from VRAM on its own after a job finishes — it stays resident indefinitely. Restarting `llama-amy-core`
without accounting for that reproduced the exact same crash-loop v1 hit (`cudaMalloc failed: out of memory`,
`Restart=always` retrying every 5s, forever) — just triggered from the opposite direction.

**The fix at the time**: explicitly tell ComfyUI to release VRAM before handing control back to the LLM —

```bash
curl -s -X POST http://<homed13-LAN-IP>:8188/free -H "Content-Type: application/json" \
  -d '{"unload_models": true, "free_memory": true}'
```

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-07-28 | Initial version, written after Phase 9's ComfyUI+SDXL stack was installed and verified end to end on HomeD13, including the VRAM dual-mode swap bug found and fixed along the way. |
| 1.0.1 | 2026-07-30 | Cross-reference fix only: pointers into `IMPLEMENTATION_PLAN.md`'s former per-phase progress logs now point at `LESSONS_LEARNED.md`, which holds that content after the 4.0.0 restructure. No procedural change. |
| 2.0.0 | 2026-07-31 | **Reversal.** Migration Stage 3 removed the reasoning model this node used to share the GPU with, so the VRAM dual-mode swap section is no longer operative — marked as history rather than left to be found wrong later (§7 standing rule). Added §4: the checkpoint now stays resident, warmed at startup by the new `comfyui-warmup.sh` via `ExecStartPost`. |
| 2.1.0 | 2026-08-09 | Added §7: Stage 6 video generation (Wan2.1 T2V 1.3B), native ComfyUI support, exact model filenames/sizes verified against a live Hugging Face listing, node graph verified against the live `/object_info` schema. Real finding: the resident SDXL checkpoint does not coexist with the video model on this 12GB card — ComfyUI's own internal model manager evicts it automatically (no manual coordination needed), confirmed from real `nvidia-smi` and journal output, not assumed. Real generation time recorded: 3m33s direct, 3m55s through the full broker round-trip. |
| 2.2.0 | 2026-08-10 | Direct question ("what is the longest video that can be made") answered with real measurement, not assumption: 33/65/121-frame runs took ~4/~9/~24 min — an accelerating cost curve, not linear. 121 frames (1415s) exceeded the original 1200s `JOB_TIMEOUT`, a real bug that would have silently killed a legitimate ~5s generation through the real pipeline — raised to 1800s with matching poll-budget increases in `hermes-generate-video.sh` and `hermes-render-request.sh`. Documented 121 frames (~5s) as the confirmed practical maximum. |
