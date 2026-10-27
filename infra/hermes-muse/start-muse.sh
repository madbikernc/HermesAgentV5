#!/usr/bin/env bash
# muse - NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning (stock, persona/override-resistance backend,
# spark-2), loaded text-only -- no --mmproj. 2026-10-27, IMPLEMENTATION_PLAN.md S44: replaces
# Huihui-Qwen3.6-35B-A3B-abliterated. S39's dedicated fleet_muse_contract suite measured this
# candidate at 0.963 (26/27, override 8/9) against the abliterated incumbent's 0.704 (override
# 3/9, corrected baseline) -- the largest gap found across the whole S39 run.
#
# Deliberately NOT forcing --reasoning off, unlike every other backend on this fleet: this
# candidate's own name designates it the "-Reasoning" variant, and S39's winning score was
# measured against that variant, not a hypothetical reasoning-off run of it. Suppressing it could
# be removing exactly the mechanism that won fleet_muse_contract's override-resistance cases. This
# is the one S44 swap with a live downstream consumer outside the benchmark suite (Minecraft bot
# in-character chat) -- verify live that real replies carry non-empty `content` (not just
# `reasoning_content`, the exact failure mode omni's own gemma swap hit) and that latency stays
# acceptable for synchronous chat before trusting this as final. Flip to --reasoning off if either
# check fails, and re-verify against the fleet_muse_contract suite before keeping it that way.
#
# --parallel 4 and --ctx-size 65536 copied verbatim from the incumbent's own start-muse.sh -- same
# node, same concurrency shape, nothing else changed.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8090 \
  --n-gpu-layers 99 \
  --ctx-size 65536 \
  --parallel 4
