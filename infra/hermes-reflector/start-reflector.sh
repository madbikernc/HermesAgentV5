#!/usr/bin/env bash
# reflector - GLM-5.3-Flash-Q2-DGX-Spark (stock), loaded on spark-2, on-demand. HermesAgentV6
# IMPLEMENTATION_PLAN.md GLM-5.3-Flash Paradigm A, Phase 2: the already-downloaded checkpoint
# S31 already ran once as `super` and returned NO-GO (6.1-6.8 tok/s contended, template defaults
# reasoning_effort=max) -- placed here instead as a GEPA reflection/candidate-generator role, a
# background-batch job, not an interactive tier S31's NO-GO still governs.
#
# Model: two-shard split GGUF, byte-verified 44,984,916,000 + 39,944,534,144 = 84,929,450,144
# bytes (79.10 GiB) -- pass only the first shard, llama.cpp auto-loads
# GLM-5.3-Flash-Q2-DGX-Spark-00002-of-00002.gguf alongside it (standard -NNNNN-of-NNNNN split
# naming, same mechanism GGUF-split models elsewhere already rely on).
#
# reasoning_effort mechanism -- resolved live 2026-11-16, not assumed: llama-server exposes both
# a CLI default (`--reasoning-effort LEVEL`) AND a genuine per-request JSON override on
# /v1/chat/completions. Tested directly against this exact checkpoint on this exact port:
#   - no override: 300 max_tokens, reasoning_content ate ~1332 chars, content truncated mid-word,
#     ~18.2s wall / 300 tok ~= 16.5 tok/s generation (matches S31's own 16.5-16.6 tok/s isolated
#     figure) -- reproduces S31's NO-GO failure mode exactly.
#   - `"reasoning_effort": "low"` in the request body: reasoning_content empty, content complete
#     and well-formed, 32 tok in 2.36s; a longer 201-token completion measured the same ~16.4
#     tok/s raw generation rate -- confirming reasoning_effort doesn't change raw speed, it
#     eliminates the hidden-reasoning token burn that was causing truncation.
# tools/hermes_coder_fix_common.py / hermes_coder_build_common.py's call_backend() already sends
# this field via its extra_body hook (Phase 1) -- so no CLI-level --reasoning-effort default is
# set here. This role is called only by direct --endpoint from the GEPA harness (never through
# the router's own chat path), and the harness is the only caller that needs it set.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/glm-5.3-flash-bakeoff/GLM-5.3-Flash-Q2-DGX-Spark-00001-of-00002.gguf \
  --host 0.0.0.0 --port 8093 \
  --n-gpu-layers 99 \
  --ctx-size 65536 \
  --parallel 4
