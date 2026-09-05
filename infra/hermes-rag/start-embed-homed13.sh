#!/usr/bin/env bash
# Phase 30c — bulk-ingestion embedding backend on HomeD13 (x86_64+CUDA, RTX 3060).
# Consumed only by tools/hermes-embed-worker.py, never called directly by either persona —
# deliberately not called over the network from the Spark, so bulk podcast-archive embedding
# compute never touches the Spark's shared bus during live conversation (IMPLEMENTATION_PLAN.md
# Phase 30's own rationale for routing this through the broker in the first place).
#
# 2026-09-04 — moved to Qwen3-Embedding-8B-Q8_0, matching the Spark's query-time swap
# (start-embed.sh). **Must track that file's model choice exactly** — this and the Spark's
# instance embed into the same vectors.db/vec_chunks space; if they ever run different
# checkpoints or dimensions, every retrieval becomes a comparison across two incompatible vector
# spaces, not just a lower-quality one.
#
# **CPU, not GPU — real hardware conflict, not a default left unexamined.** An 8B model at Q8_0 is
# ~8.5GB; ComfyUI's own resident SDXL checkpoint already holds ~6.8GB of this card's 12GB
# permanently (infra/comfyui/README.md). The two don't fit together, and this backend is the one
# with headroom to give: it's an offline bulk-ingestion job with no latency requirement (unlike
# the Spark's query-time instance, which stays on GPU), so `--n-gpu-layers 0` trades ingest
# throughput for correctness/no-OOM instead of fighting ComfyUI for VRAM. Not yet measured live —
# expect bulk podcast-archive ingestion to take noticeably longer per run than the 0.6B model did;
# revisit if that turns out to matter in practice.
exec /opt/llama.cpp/build/bin/llama-server \
  --model /opt/llama.cpp/models/Qwen3-Embedding-8B-Q8_0.gguf \
  --embedding --pooling last \
  --host 127.0.0.1 --port 8092 \
  --n-gpu-layers 0 \
  --ctx-size 2048 --ubatch-size 512
