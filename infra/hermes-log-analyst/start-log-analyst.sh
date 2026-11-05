#!/usr/bin/env bash
# log-analyst - NousResearch Hermes-4.3-36B-Q4_K_M (stock, on-demand log-analysis backend, spark).
# 2026-10-27, IMPLEMENTATION_PLAN.md S44: new role, split off `super`'s own log-analyst duty.
# S39's dedicated fleet_log_analyst suite (18 cases across pfSense/canary/gameabuse shapes --
# hermes-logs.py's own real problem domain) measured this candidate at accuracy 0.750 (9/12),
# fact-extraction 0.960, against `super`'s 0.375 (3/8), fact-extraction 0.880 on the identical
# suite. See hermes-logs.py's own 1.6.0 changelog for the abliteration-status caveat: this
# checkpoint is NOT one of this fleet's `Huihui-*-abliterated` forks, unlike the model it replaces
# for this one duty -- `super` itself is untouched and still the fallback if real refusal gaps
# show up on live payload/exploit content.
#
# 2026-11-04: --ctx-size 65536 -> 16384 with q8_0 K/V cache (q8_0 V needs flash attention on).
# The 64k convention put a 16GiB f16 KV cache (64 layers x 8 KV heads x 128 dims) on top of
# 20.27GiB of weights -- ~37GiB, which never fit on spark, so this role never once started.
# hermes-logs.py's real budget is ~20k input chars plus up to 20 history turns and max_tokens=800,
# well inside 16k. ~2.1GiB KV now; the wake worker still has to displace super to fit it
# (hermes-model-wake-worker.py 1.7.0). --reasoning off follows the same default every non-"-Reasoning"-branded backend on
# this fleet uses; this checkpoint is not confirmed immune to the gemma-style empty-content bug
# other scripts' comments describe -- verify live before trusting this as final.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/NousResearch_Hermes-4.3-36B-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8098 \
  --n-gpu-layers 99 \
  --ctx-size 16384 \
  --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 \
  --reasoning off
