#!/usr/bin/env bash
# coder2 - GLM-4.7-Flash-Q4_K_M (stock, on-demand dualcoder-review backend, spark-2).
# 2026-10-27, IMPLEMENTATION_PLAN.md S44: replaces Muse Glimmer 30B. S39's dedicated
# fleet_dualcoder_precision suite measured this candidate at 1.000 (6/6) against the retired
# Muse-Glimmer-30B incumbent's 0.000 (0/4, 2 of 6 timed out) -- a direct, task-specific result
# superseding the 2026-09-05 BFCL function-calling proxy that originally justified Muse Glimmer
# (see this file's own prior revision / git history for that reasoning). Same port, same node, same
# tools/hermes-dualcoder.py caller -- only the model changed.
#
# --flash-attn off --reasoning off copied verbatim from spark's own start-super.sh: this is the
# exact same GLM-4.7-Flash-Q4_K_M base checkpoint `super` already runs (Huihui-GLM-4.7-Flash-
# abliterated is a fine-tune of it), so Muse Glimmer's own reasoning-token-bloat lesson applies in
# reverse here -- verify live that these flags are still correct for this specific checkpoint rather
# than assuming the family match makes it automatic.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/GLM-4.7-Flash-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8099 \
  --n-gpu-layers 99 \
  --ctx-size 65536 \
  --flash-attn off \
  --reasoning off
