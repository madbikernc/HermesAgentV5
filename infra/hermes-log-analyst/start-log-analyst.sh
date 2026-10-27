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
# Base flags match the fleet-wide convention (--n-gpu-layers 99, --ctx-size 65536) rather than
# tuning down to hermes-logs.py's own modest actual budget (max_tokens=800, ~20k input chars) --
# consistency with every other backend's resource footprint, not a measured requirement specific
# to this role. --reasoning off follows the same default every non-"-Reasoning"-branded backend on
# this fleet uses; this checkpoint is not confirmed immune to the gemma-style empty-content bug
# other scripts' comments describe -- verify live before trusting this as final.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/NousResearch_Hermes-4.3-36B-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8098 \
  --n-gpu-layers 99 \
  --ctx-size 65536 \
  --reasoning off
