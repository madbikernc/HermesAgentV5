#!/usr/bin/env bash
# Coder - Huihui-Qwen3.8-27B-abliterated (dense, on-demand coding backend, spark-2).
# Won a real, execution-verified bake-off against Qwen3-Coder-Next-abliterated (MoE, formerly
# spark-2): Coder-Next crashed with a real TypeError on its own generated LRU-cache demos code
# (tuple-unpack mismatch), Qwen3.8 passed all 12 independent correctness checks. Slower
# (12.2 tok/s vs 53.9 tok/s) but coding tasks are latency-tolerant in a way chat roles are not --
# on-demand, not always-resident, so the speed cost is paid only while actively in use.
#
# Moved here from spark 2026-10-07 (fleet-health investigation: spark was chronically at ~97%
# memory/swapping; coder was its single largest avoidable resident consumer, and the plan's own
# target table always intended this role on spark-2, not spark -- see
# IMPLEMENTATION_PLAN.md S1 note on why coder originally moved to spark in the first place
# (the winning bake-off candidate was already downloaded there), and hermes-router.py 2.14.0's
# changelog for this reversal).
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf \
  --host 0.0.0.0 --port 8094 \
  --n-gpu-layers 99 \
  --ctx-size 65536 \
  --reasoning off
