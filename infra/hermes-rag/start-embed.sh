#!/usr/bin/env bash
# Phase 30a — RAG query-time embedding backend (Qwen3-Embedding-0.6B-Q8_0).
# Resident on the Spark alongside nano/super (spark) and coder/muse/omni (spark-2), own port so no existing
# backend's traffic is affected. Verified against a live HF listing before download
# (Qwen/Qwen3-Embedding-0.6B-GGUF, raw API JSON, not a summarized page) and load-tested
# against this host's actual llama.cpp build before being wired into any systemd unit —
# both hard gates from IMPLEMENTATION_PLAN.md's Phase 30 entry.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /mnt/hermes-data/models/Qwen3-Embedding-0.6B-Q8_0.gguf \
  --embedding --pooling last \
  --host 127.0.0.1 --port 8092 \
  --n-gpu-layers 99 \
  --ctx-size 2048 --ubatch-size 512
