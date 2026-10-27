#!/usr/bin/env bash
# muse - NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning (stock, persona/override-resistance backend,
# spark-2), loaded text-only -- no --mmproj. 2026-10-27, IMPLEMENTATION_PLAN.md S44: replaces
# Huihui-Qwen3.6-35B-A3B-abliterated. S39's dedicated fleet_muse_contract suite measured this
# candidate at 0.963 (26/27, override 8/9) against the abliterated incumbent's 0.704 (override
# 3/9, corrected baseline) -- the largest gap found across the whole S39 run.
#
# Live-verified 2026-10-27: deployed first WITHOUT --reasoning off, on the theory that this
# candidate's own "-Reasoning" name designated the mechanism S39's winning fleet_muse_contract
# score depended on. A real test call ("describe a sunset, one sentence") disproved that in
# production: the correct complete sentence landed entirely in `reasoning_content`, and `content`
# itself came back truncated mid-word ("...slipped behind the") once max_tokens ran out --
# precisely the reasoning-token-bloat failure mode Muse Glimmer's and gemma's own scripts already
# documented, now confirmed here too despite the "-Reasoning" branding. `--reasoning off` added
# for exactly that reason. Not yet re-verified against the fleet_muse_contract suite itself with
# reasoning off -- if override-resistance measurably regresses there, that's a real open question
# this swap's own benchmark basis would need revisiting, not something to assume away.
#
# --parallel 4 and --ctx-size 65536 copied verbatim from the incumbent's own start-muse.sh -- same
# node, same concurrency shape, nothing else changed.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8090 \
  --n-gpu-layers 99 \
  --ctx-size 65536 \
  --parallel 4 \
  --reasoning off
