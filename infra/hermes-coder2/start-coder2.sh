#!/usr/bin/env bash
# coder2 - Muse Glimmer 30B (Meta, stock, Apache-2.0, on-demand second coding backend, spark-2).
# 2026-09-05, direct operator request: a real bake-off showed coder (Qwen3.8-27B-abliterated) and
# Muse Glimmer are asymmetric, not redundant -- coder wins ifeval/mmlu_pro decisively, Muse Glimmer
# wins BFCL function-calling decisively (92.00% vs 37.00%) -- the actual case for a second coder
# used for cross-review, not a replace-and-retire swap. See tools/hermes-dualcoder.py.
#
# Base flags copied verbatim from spark's own live start-coder.sh (--host/--n-gpu-layers/--ctx-size
# shape) -- only --model and --port changed. Deliberately on spark-2, not spark: coder2's own
# hermes-router.py entry is cross-node (muse/omni's dual-branch ROLES shape), so the two coding
# backends never contend for the same node's memory bandwidth during a long back-and-forth review.
#
# NOT copying coder's own `--reasoning off` flag -- that's tied to Qwen3.8's specific think-tag
# behavior, not a generic requirement, and Muse Glimmer is a different architecture with its own
# documented multi-step-reasoning design. Verify live whether Muse Glimmer needs an equivalent
# flag (or none at all) before assuming this is final -- don't copy it on faith.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/Muse-Glimmer-30B-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8099 \
  --n-gpu-layers 99 \
  --ctx-size 65536
