#!/usr/bin/env bash
# Phase 30c — bulk-ingestion embedding backend on HomeD13 (x86_64+CUDA, RTX 3060).
# Same model as the Spark's query-time backend (Qwen3-Embedding-0.6B-Q8_0), but a
# separate llama.cpp build (this host is x86_64, the Spark is aarch64) and a
# separate resident instance — deliberately not called over the network from
# HomeD13's worker, so bulk podcast-archive embedding compute never touches the
# Spark's shared 273GB/s bus during live conversation (IMPLEMENTATION_PLAN.md
# Phase 30's own rationale for routing this through the broker in the first place).
# Consumed only by tools/hermes-embed-worker.py, never called directly by either
# persona.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /opt/llama.cpp/models/Qwen3-Embedding-0.6B-Q8_0.gguf \
  --embedding --pooling last \
  --host 127.0.0.1 --port 8092 \
  --n-gpu-layers 99 \
  --ctx-size 2048 --ubatch-size 512
