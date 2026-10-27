#!/usr/bin/env bash
# omni - NVIDIA-Nemotron-3.5-Bolt-74B-A9B (stock, vision-judge backend, spark-2).
# 2026-10-27, IMPLEMENTATION_PLAN.md S44: replaces gemma-4-26B-A4B-it. S39's dedicated
# fleet_vision_judge suite measured this candidate at precision 0.897, recall 0.963,
# false_fail_rate 0.037, against the incumbent's precision 0.846, recall 0.407,
# false_fail_rate 0.593 -- the incumbent's 0.593 false-fail rate meant most good renders were
# getting needlessly regenerated. Also this S39 run's best fleet_muse_contract score (0.852) of
# the three Phase 4 candidates, though that is not why it's deployed here -- see
# infra/hermes-muse/README.md for the actual muse-role winner.
#
# --reasoning off copied from the incumbent's own start-omni.sh, same reason that comment gave:
# a reasoning-capable model without it can spend the caller's entire max_tokens budget in
# reasoning_content and return an EMPTY content string -- confirmed live for gemma-4-it, and this
# candidate is not confirmed immune. Verify live before trusting this as final rather than
# assuming the flag transfers cleanly across architectures.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf \
  --mmproj /mnt/hermes-data/models/mmproj-NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf \
  --host 0.0.0.0 --port 8091 \
  --n-gpu-layers 99 \
  --ctx-size 65536 \
  --reasoning off
