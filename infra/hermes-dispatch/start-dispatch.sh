#!/usr/bin/env bash
# Dispatch - Qwen3.6-35B-A3B, stock weights (hard requirement, never abliterated -- target
# architecture §12.1: the dispatcher reads user text and decides routing; injectable routing is
# the highest-leverage compromise in this architecture). Q4_K_M for now, not the target's
# proposed Q8 -- already on disk from an earlier evaluation, zero download cost, sufficient to
# build and verify the real S6 pipeline. Upgrading to Q8 (or benchmarking Q4 vs Q8 quality) is a
# follow-up, not a blocker for this stage.
exec /opt/llama.cpp/build/bin/llama-server   --model /mnt/hermes-data/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf   --host 0.0.0.0 --port 8097   --n-gpu-layers 99   --ctx-size 65536   --parallel 4   --reasoning off
