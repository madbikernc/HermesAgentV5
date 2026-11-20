#!/usr/bin/env bash
# Coder - Qwen3-Coder-Next-UD-Q4_K_M (MoE, on-demand coding backend, spark-2).
# Promoted 2026-11-19 over Huihui-Qwen3.8-27B-abliterated: direct operator request to find a more
# capable coding backend for self-repair, whose real production numbers showed 5 of 7 fix
# attempts never even producing a usable draft (FLEET_SELFREPAIR_DESIGN.md Phase 6/7) -- a
# non-convergence problem, not a prompting one. The S39 bake-off (this file's history below, and
# infra/model-benchmark/spark2-candidate-results.md Phase 7) ran this exact candidate once before
# (2026-08-26) and picked Qwen3.8-27B over it on a different, narrower bake-off; re-run against
# fleet_coder_fix/fleet_coder_build specifically, it has zero timeouts on both suites vs.
# Qwen3.8-27B's 4/10 and 4/8, and ties/beats it on fixture-correctness -- reliability is exactly
# the axis self-repair's real failure mode needed fixed. Needed freeing `omni`'s resident
# footprint on spark-2 first (hermes-router.py 2.22.0, hermes-model-wake-worker.py 1.10.0) -- the
# new model's 45.92GiB didn't fit with every spark-2 backend pinned up.
#
# Earlier history: moved here from spark 2026-10-07 (fleet-health investigation: spark was
# chronically at ~97% memory/swapping; coder was its single largest avoidable resident consumer,
# and the plan's own target table always intended this role on spark-2, not spark -- see
# IMPLEMENTATION_PLAN.md S1 note on why coder originally moved to spark in the first place (the
# 2026-08-26 bake-off's winning candidate was already downloaded there), and hermes-router.py
# 2.14.0's changelog for this reversal). That 2026-08-26 bake-off itself picked Qwen3.8-27B over
# this exact model after Coder-Next crashed with a real TypeError on its own generated LRU-cache
# demo code (tuple-unpack mismatch) -- a different, narrower test than fleet_coder_fix/
# fleet_coder_build, not contradicted by this promotion so much as superseded by a more directly
# relevant one.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/Qwen3-Coder-Next-UD-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8094 \
  --n-gpu-layers 99 \
  --ctx-size 65536 \
  --reasoning off
